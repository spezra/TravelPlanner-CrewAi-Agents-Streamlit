"use server";

import { z } from "zod";
import { agentsConfigured } from "@/agents/llm";
import { OUTCOME_KINDS } from "@/domain/clientBook";
import { getDb, requireMember } from "@/lib/server";
import {
  acceptSuggestion,
  addPartyMember,
  addStatement,
  createClient,
  deleteClient,
  DIMENSIONS,
  dismissSuggestion,
  promoteStatement,
  reassignClient,
  recordOutcome,
  removePartyMember,
  requestBriefExtraction,
  supersedeStatement,
  updateClient,
} from "@/modules/ops/clients";
import { act, backPath, formObject, optionalText, optionalUuid, uuid } from "@/modules/ops/forms";

const scope = z.enum(["private", "workspace"]);
const evidence = z.enum(["client_said", "expert_inferred"], { message: "Choose whether the client said it or you inferred it" });
const ClientForm = z.object({
  name: z.string().trim().min(2, "Client name is too short").max(200),
  email: optionalText,
  phone: optionalText,
  notes: optionalText,
  scope: scope.optional(),
});

export async function createClientAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await act("/clients", async () => createClient(await getDb(), tenant, ClientForm.parse(formObject(form))), { to: (id) => `/clients/${id}`, revalidate: ["/clients"] });
}

export async function updateClientAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(form.get("clientId"));
  await act(`/clients/${id}`, async () => updateClient(await getDb(), tenant, id, ClientForm.omit({ scope: true }).parse(formObject(form))), { ok: "Saved" });
}

export async function reassignClientAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(form.get("clientId"));
  await act(
    `/clients/${id}`,
    async () => {
      const input = z.object({ ownerId: uuid, scope }).parse(formObject(form));
      await reassignClient(await getDb(), tenant, id, input);
    },
    { ok: "Client moved", revalidate: ["/clients", `/clients/${id}`] },
  );
}

export async function deleteClientAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(form.get("clientId"));
  await act(`/clients/${id}`, async () => deleteClient(await getDb(), tenant, id), { to: "/clients", ok: "Client deleted", revalidate: ["/clients"] });
}

export async function addPartyAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(form.get("clientId"));
  await act(`/clients/${id}`, async () => {
    const input = z.object({ name: z.string().trim().min(1, "Enter a name").max(200), relation: z.string().max(200).default(""), notes: optionalText }).parse(formObject(form));
    await addPartyMember(await getDb(), tenant, id, input);
  });
}

export async function removePartyAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/clients");
  await act(back, async () => removePartyMember(await getDb(), tenant, uuid.parse(form.get("partyMemberId"))));
}

export async function addStatementAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/clients");
  await act(back, async () => {
    const input = z
      .object({
        clientId: uuid,
        tripId: optionalUuid,
        dimension: z.enum(DIMENSIONS as [string, ...string[]]),
        text: z.string().trim().min(3, "Write the statement out").max(2000),
        evidence,
        source: z.string().max(200).default(""),
      })
      .parse(formObject(form));
    await addStatement(await getDb(), tenant, { ...input, dimension: input.dimension as (typeof DIMENSIONS)[number] }, new Date());
  });
}

export async function supersedeStatementAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/clients");
  await act(back, async () => {
    const input = z.object({ statementId: uuid, text: z.string().trim().min(3, "Write the statement out").max(2000), evidence }).parse(formObject(form));
    await supersedeStatement(await getDb(), tenant, input.statementId, input, new Date());
  });
}

export async function promoteStatementAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor"]);
  const back = backPath(form, "/clients");
  await act(back, async () => promoteStatement(await getDb(), tenant, uuid.parse(form.get("statementId")), new Date()), { ok: "Now an enduring preference" });
}

export async function recordOutcomeAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/clients");
  await act(back, async () => {
    const input = z
      .object({ clientId: uuid, tripId: uuid, kind: z.enum(OUTCOME_KINDS), text: z.string().trim().min(3, "Say what it was").max(2000), evidence })
      .parse(formObject(form));
    await recordOutcome(await getDb(), tenant, input, new Date());
  });
}

export async function extractBriefAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/clients");
  await act(
    back,
    async () => {
      const input = z
        .object({ clientId: uuid, tripId: optionalUuid, sourceLabel: z.string().max(200).default(""), text: z.string().min(1, "Paste the call notes or email").max(100_000) })
        .parse(formObject(form));
      await requestBriefExtraction(await getDb(), tenant, input, agentsConfigured());
    },
    { ok: "Extracting. Suggestions appear here when ready" },
  );
}

export async function acceptSuggestionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/clients");
  await act(back, async () => {
    const input = z.object({ suggestionId: uuid, tripId: optionalUuid }).parse(formObject(form));
    await acceptSuggestion(await getDb(), tenant, input.suggestionId, new Date(), input.tripId);
  });
}

export async function dismissSuggestionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = backPath(form, "/clients");
  await act(back, async () => dismissSuggestion(await getDb(), tenant, uuid.parse(form.get("suggestionId")), new Date()));
}
