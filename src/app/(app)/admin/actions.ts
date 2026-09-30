"use server";

import { z } from "zod";
import { getDb, requireMember } from "@/lib/server";
import { retryJob, updateSettings } from "@/modules/ops/admin";
import { requestExport } from "@/modules/ops/exports";
import { act, formObject, optionalText, uuid } from "@/modules/ops/forms";
import { fulfilAccess, fulfilDeletion, recordRequest, rejectRequest, requestWorkspaceDeletion } from "@/modules/ops/privacy";
import { blobs } from "@/server/storage";

const ADMINS = ["owner", "admin"] as const;
const days = z.coerce.number().int("Whole days").min(1, "At least 1 day").max(3650, "At most 3650 days");

export async function updateSettingsAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember([...ADMINS]);
  await act(
    "/admin",
    async () => {
      const f = z
        .object({
          name: z.string().trim().min(2, "Workspace name is too short").max(200),
          dataRegion: z.enum(["us", "eu"]),
          bookPortability: z.enum(["advisor_owns", "agency_owns", "shared"]),
          sourceTextDays: days,
          rawAudioDays: days,
        })
        .parse(formObject(form));
      await updateSettings(await getDb(), tenant, { ...f, retention: { sourceTextDays: f.sourceTextDays, rawAudioDays: f.rawAudioDays } });
    },
    { ok: "Settings saved", revalidate: ["/admin", "/settings", "/clients"] },
  );
}

export async function retryJobAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember([...ADMINS]);
  await act("/admin/jobs", async () => retryJob(await getDb(), tenant, z.coerce.number().int().positive().parse(form.get("jobId")), new Date()), { ok: "Queued for retry" });
}

export async function requestExportAction(): Promise<void> {
  const { tenant } = await requireMember([...ADMINS]);
  await act("/admin/exports", async () => requestExport(await getDb(), tenant, new Date()), { ok: "Export queued. It appears here when ready" });
}

export async function recordRequestAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember([...ADMINS]);
  await act(
    "/admin/privacy",
    async () => {
      const f = z
        .object({
          subject: z.string().regex(/^(client|party_member|person):[0-9a-f-]{36}$/i, "Choose who the request is about"),
          kind: z.enum(["access", "deletion"]),
          receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "When was it received?"),
          note: optionalText,
        })
        .parse(formObject(form));
      const [type, id] = f.subject.split(":") as ["client" | "party_member" | "person", string];
      await recordRequest(await getDb(), tenant, { subjectType: type, subjectId: id, kind: f.kind, receivedAt: `${f.receivedAt}T12:00:00Z`, note: f.note });
    },
    { ok: "Request recorded" },
  );
}

export async function fulfilAccessAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember([...ADMINS]);
  await act("/admin/privacy", async () => fulfilAccess(await getDb(), tenant, uuid.parse(form.get("requestId")), new Date()), {
    ok: "Preparing the subject's export. Download it from Data export when ready",
  });
}

export async function fulfilDeletionAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember([...ADMINS]);
  await act(
    "/admin/privacy",
    async () => {
      const f = z.object({ requestId: uuid, confirm: z.literal("on", { message: "Confirm the erasure" }) }).parse(formObject(form));
      await fulfilDeletion(await getDb(), blobs(), tenant, f.requestId, new Date());
    },
    { ok: "Personal data erased; tombstone recorded", revalidate: ["/admin/privacy", "/clients"] },
  );
}

export async function rejectRequestAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember([...ADMINS]);
  await act("/admin/privacy", async () => rejectRequest(await getDb(), tenant, uuid.parse(form.get("requestId")), String(form.get("reason") ?? "").slice(0, 1000), new Date()));
}

export async function deleteWorkspaceAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner"]);
  await act("/admin/delete", async () => requestWorkspaceDeletion(await getDb(), tenant, String(form.get("confirmName") ?? ""), new Date()), {
    ok: "Deletion started. Everyone in this workspace, including you, will be signed out of it shortly",
  });
}
