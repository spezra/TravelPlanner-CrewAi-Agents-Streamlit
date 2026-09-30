import type { CollaborationState } from "@/domain/collaboration";

export const STATE_LABEL: Record<CollaborationState, string> = {
  requested: "requested",
  brief_shared: "negotiating terms",
  terms_agreed: "terms agreed",
  active: "in progress",
  completed: "completed",
  declined: "declined",
  withdrawn: "withdrawn",
};
