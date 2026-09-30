import type { Db, Queryable } from "./client";

export interface Tenant {
  workspaceId: string;
  memberId: string;
}

/**
 * Runs `fn` in a transaction as the restricted app_user role with the tenant
 * bound, so row-level security applies to every statement inside it. Nothing
 * outside this helper should touch tenant tables.
 */
export function withTenant<T>(db: Db, tenant: Tenant, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("set local role app_user");
    await tx.query("select set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)", [tenant.workspaceId, tenant.memberId]);
    return fn(tx);
  });
}
