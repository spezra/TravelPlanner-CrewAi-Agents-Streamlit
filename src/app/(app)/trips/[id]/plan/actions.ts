"use server";

import { z } from "zod";
import type { CoverageWindow, ResponsePlan, Responder } from "@/domain/responsePlan";
import { getDb, requireMember } from "@/lib/server";
import { act, formObject, optionalUuid, uuid } from "@/modules/ops/forms";
import { acknowledgeEscalation, raiseUnhappyClient, resolveEscalation, saveResponsePlan } from "@/modules/ops/responsePlans";

const DAY_FIELDS = ["p_days1", "p_days2", "b_days1", "b_days2"];
const hour = z.coerce.number().int().min(0, "Hours run 0–24").max(24, "Hours run 0–24");

function windows(f: Record<string, unknown>, prefix: "p" | "b"): CoverageWindow[] {
  const out: CoverageWindow[] = [];
  for (const n of [1, 2]) {
    const days = (f[`${prefix}_days${n}`] as string[]).map(Number);
    if (days.length === 0) continue;
    out.push({ days, startHour: hour.parse(f[`${prefix}_start${n}`] || 0), endHour: hour.parse(f[`${prefix}_end${n}`] || 24) });
  }
  return out;
}

export async function savePlanAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = uuid.parse(form.get("tripId"));
  const back = `/trips/${tripId}/plan`;
  await act(
    back,
    async () => {
      const f = formObject(form, DAY_FIELDS);
      const base = z
        .object({
          primaryId: uuid,
          primaryTz: z.string().trim().min(1, "Primary time zone"),
          backupId: optionalUuid,
          backupTz: z.string().optional(),
          ackDeadlineMinutes: z.coerce.number().int(),
          esc1: optionalUuid,
          esc2: optionalUuid,
          esc3: optionalUuid,
          clientContactPolicy: z.string().max(2000),
        })
        .parse(f);
      const primary: Responder = { memberId: base.primaryId, timeZone: base.primaryTz, coverage: windows(f, "p") };
      const backup: Responder | null = base.backupId ? { memberId: base.backupId, timeZone: (base.backupTz ?? "").trim(), coverage: windows(f, "b") } : null;
      const plan: ResponsePlan = {
        tripId,
        primary,
        backup,
        ackDeadlineMinutes: base.ackDeadlineMinutes,
        escalation: [base.esc1, base.esc2, base.esc3].filter((x): x is string => Boolean(x)),
        clientContactPolicy: base.clientContactPolicy,
      };
      await saveResponsePlan(await getDb(), tenant, plan);
    },
    { ok: "Response plan saved", revalidate: [back, `/trips/${tripId}`] },
  );
}

export async function acknowledgeAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = uuid.parse(form.get("tripId"));
  await act(`/trips/${tripId}/plan`, async () => acknowledgeEscalation(await getDb(), tenant, uuid.parse(form.get("escalationId")), new Date()), { ok: "Acknowledged. Escalation stopped" });
}

export async function resolveAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = uuid.parse(form.get("tripId"));
  await act(`/trips/${tripId}/plan`, async () =>
    resolveEscalation(await getDb(), tenant, uuid.parse(form.get("escalationId")), String(form.get("note") ?? "").slice(0, 2000), new Date()),
  );
}

export async function raiseUnhappyAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = uuid.parse(form.get("tripId"));
  await act(`/trips/${tripId}/plan`, async () => raiseUnhappyClient(await getDb(), tenant, tripId, String(form.get("summary") ?? "").slice(0, 2000), new Date()), {
    ok: "Raised. The responders on the plan are being contacted",
  });
}
