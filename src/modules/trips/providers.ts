/**
 * Provider registry: which rail executes an item, and the adapters that do it.
 *
 *  - Flights whose permitted channel is Duffel go to the Duffel adapter.
 *  - Everything else (direct to property, DMCs by email or phone, GDS desks run
 *    by people) goes to the manual adapter: submitting opens a confirmation task
 *    and the booking stays outcome-unknown until a person records what the
 *    supplier said. Nothing is ever marked confirmed on hope.
 */
import { randomUUID } from "node:crypto";
import type { MaterialTerms } from "@/domain/approvals";
import type { TripItem } from "@/domain/bookings";
import { DomainError, type Money } from "@/domain/common";
import type { LookupOutcome, ProviderAdapter, ProviderOutcome } from "@/domain/execution";
import type { Db } from "@/db/client";
import * as coreRepo from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { DuffelAdapter, DuffelClient, type TravelerDetails } from "@/providers/duffel";
import { config } from "@/server/config";
import { decryptFor } from "@/server/crypto";
import * as repo from "./repo";

/** A ProviderAdapter that can also re-read terms, cancel, and name the traveler-facing reference. */
export interface ExecutionAdapter extends ProviderAdapter {
  /** Current conditions from the source. Absent for rails where a person confirms them. */
  currentTerms?(approved: MaterialTerms): Promise<MaterialTerms>;
  /** Traveler-facing confirmation number for a provider reference, when it differs. */
  confirmationRef?(providerRef: string): Promise<string | null>;
  cancel(key: string, providerRef: string): Promise<ProviderOutcome>;
  lookupCancellation(key: string, providerRef: string): Promise<LookupOutcome>;
  /** What cancelling would cost now, when the rail can quote it. */
  cancellationCost?(providerRef: string): Promise<Money>;
}

export type ProviderName = "duffel" | "manual";

export interface ProviderDeps {
  db: Db;
  tenant: Tenant;
  /** Duffel client factory; defaults to one built from DUFFEL_ACCESS_TOKEN. Returns null when not configured. */
  duffel?: () => DuffelClient | null;
  /** Test hook: replace the adapter for a provider. */
  override?: (provider: ProviderName, item: TripItem) => ExecutionAdapter | null;
}

export function defaultDuffelClient(): DuffelClient | null {
  const token = config().DUFFEL_ACCESS_TOKEN;
  return token ? new DuffelClient({ accessToken: token }) : null;
}

export function duffelConfigured(deps?: Pick<ProviderDeps, "duffel">): boolean {
  return (deps?.duffel ?? defaultDuffelClient)() !== null;
}

/** Which rail an item books through, from its kind and permitted channel. */
export function providerForItem(item: Pick<TripItem, "kind" | "credentials">): ProviderName {
  const channel = item.credentials?.permittedChannel.toLowerCase() ?? "";
  if (channel.includes("duffel")) {
    if (item.kind !== "flight") throw new DomainError("unsupported_channel", "Duffel is wired for flights only; use a manual channel for this item");
    return "duffel";
  }
  return "manual";
}

export const travelersContext = (itemId: string) => `trip_item:${itemId}:travelers`;

function requireDuffel(deps: ProviderDeps): DuffelClient {
  const client = (deps.duffel ?? defaultDuffelClient)();
  if (!client) throw new DomainError("duffel_not_configured", "Duffel isn't configured (DUFFEL_ACCESS_TOKEN)");
  return client;
}

function wrapDuffel(d: DuffelAdapter): ExecutionAdapter {
  return {
    name: d.name,
    submit: (k, p) => d.submit(k, p),
    lookup: (k) => d.lookup(k),
    currentTerms: (t) => d.currentTerms(t),
    confirmationRef: (r) => d.confirmationRef(r),
    cancel: (k, r) => d.cancel(k, r),
    lookupCancellation: (k, r) => d.lookupCancellation(k, r),
    cancellationCost: async (r) => (await d.cancellationQuote(r)).cost,
  };
}

/** Adapter for booking this item, loaded with whatever the rail needs (offer, travelers). */
export async function adapterForBooking(item: TripItem, deps: ProviderDeps): Promise<ExecutionAdapter> {
  const provider = providerForItem(item);
  const overridden = deps.override?.(provider, item);
  if (overridden) return overridden;
  if (provider === "manual") return new ManualAdapter(deps.db, deps.tenant, item);
  const client = requireDuffel(deps);
  const { offer, travelers } = await withTenant(deps.db, deps.tenant, async (q) => {
    const extras = await repo.getItemExtras(q, item.id);
    if (!extras?.bookingOffer) throw new DomainError("no_offer", "Select a Duffel offer for this flight first");
    if (!extras.bookingRequestEnc) throw new DomainError("no_travelers", "Add traveler details for this flight first");
    const plain = await decryptFor(q, deps.tenant.workspaceId, travelersContext(item.id), extras.bookingRequestEnc);
    return { offer: extras.bookingOffer, travelers: JSON.parse(plain) as TravelerDetails[] };
  });
  return wrapDuffel(new DuffelAdapter(client, { offerId: offer.offerId, travelers }));
}

/** Adapter for reconciling or cancelling through the rail an attempt was recorded against. */
export function adapterForProvider(provider: string, item: TripItem, deps: ProviderDeps): ExecutionAdapter {
  const overridden = deps.override?.(provider as ProviderName, item);
  if (overridden) return overridden;
  if (provider !== "duffel" && provider !== "manual") {
    throw new DomainError("unknown_provider", `Attempts through "${provider}" can't be reconciled here; confirm with the supplier and record it manually`);
  }
  if (provider === "manual") return new ManualAdapter(deps.db, deps.tenant, item);
  return wrapDuffel(new DuffelAdapter(requireDuffel(deps)));
}

/**
 * Suppliers with no API. `submit` opens (or re-opens) a confirmation task for
 * the team and reports `processing`, so the item waits in outcome-unknown
 * rather than being declared booked or failed. `lookup` reads the task: a
 * recorded confirmation number is found, "supplier has no reservation" is
 * absent, and a task still pending is inconclusive.
 */
export class ManualAdapter implements ExecutionAdapter {
  readonly name = "manual";

  constructor(
    private readonly db: Db,
    private readonly tenant: Tenant,
    private readonly item: Pick<TripItem, "id" | "tripId" | "supplierName" | "credentials">,
  ) {}

  private open(key: string, action: "book" | "cancel"): Promise<ProviderOutcome> {
    return withTenant(this.db, this.tenant, async (q) => {
      const existing = await repo.getManualByKey(q, key);
      if (existing?.status === "confirmed") return { kind: "accepted", providerRef: existing.confirmationRef ?? existing.id };
      const task = await repo.openManualTask(q, this.tenant.workspaceId, {
        id: randomUUID(),
        tripId: this.item.tripId,
        itemId: this.item.id,
        action,
        attemptKey: key,
        channel: this.item.credentials?.permittedChannel ?? "Manual",
        supplierName: this.item.supplierName,
      });
      if (!existing || existing.status === "not_found") {
        await coreRepo.audit(q, this.tenant.workspaceId, "agent:booking", `manual_confirmation.${action}_requested`, this.item.id, { taskId: task.id, round: task.rounds });
      }
      return { kind: "processing", error: `Waiting for the supplier to confirm the ${action === "book" ? "reservation" : "cancellation"}` };
    });
  }

  private read(key: string): Promise<LookupOutcome> {
    return withTenant(this.db, this.tenant, async (q) => {
      const task = await repo.getManualByKey(q, key);
      if (!task) return { kind: "absent" };
      if (task.status === "confirmed") return { kind: "found", providerRef: task.confirmationRef ?? task.id };
      if (task.status === "not_found") return { kind: "absent" };
      return { kind: "unknown", error: "Awaiting the supplier's confirmation" };
    });
  }

  submit(key: string): Promise<ProviderOutcome> {
    return this.open(key, "book");
  }

  lookup(key: string): Promise<LookupOutcome> {
    return this.read(key);
  }

  cancel(key: string): Promise<ProviderOutcome> {
    return this.open(key, "cancel");
  }

  lookupCancellation(key: string): Promise<LookupOutcome> {
    return this.read(key);
  }
}

/** Wrap a plain ProviderAdapter (e.g. the simulated supplier) for booking-only use. */
export function bookingOnly(adapter: ProviderAdapter): ExecutionAdapter {
  return {
    name: adapter.name,
    submit: (k, p) => adapter.submit(k, p),
    lookup: (k) => adapter.lookup(k),
    cancel: async () => ({ kind: "rejected", error: `${adapter.name} does not support cancellation` }),
    lookupCancellation: async () => ({ kind: "absent" }),
  };
}
