/**
 * Platform operator tool for the curated network. Not reachable from the web
 * app: admission is decided by the platform, never self-serve.
 *
 *   npx tsx src/modules/network/admit-cli.ts list
 *   npx tsx src/modules/network/admit-cli.ts admit  <workspace-id> --by "<operator>" [--note "<text>"]
 *   npx tsx src/modules/network/admit-cli.ts remove <workspace-id> --by "<operator>" --reason "<text>"
 *
 * Uses DATABASE_URL, or the local PGlite store like `npm run db:migrate`.
 */
import { mkdir } from "node:fs/promises";
import { createPgDb, createPgliteDb } from "@/db/client";
import { admitToNetwork, listApplications, removeFromNetwork } from "./membership";

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, workspaceId, ...rest] = argv;
  const db = process.env.DATABASE_URL
    ? await createPgDb(process.env.DATABASE_URL)
    : await mkdir(".data", { recursive: true }).then(() => createPgliteDb({ dataDir: ".data/pglite" }));
  try {
    if (cmd === "list") {
      const apps = await listApplications(db);
      if (!apps.length) console.log("No pending applications");
      for (const a of apps) console.log(`${a.workspaceId}  ${a.name}  applied ${a.requestedAt?.slice(0, 10) ?? "—"}${a.note ? `  "${a.note}"` : ""}`);
      return 0;
    }
    const by = flag(rest, "by");
    if ((cmd !== "admit" && cmd !== "remove") || !workspaceId || !by) {
      console.error('Usage: admit-cli.ts list | admit <workspace-id> --by "<operator>" [--note ".."] | remove <workspace-id> --by "<operator>" --reason ".."');
      return 2;
    }
    if (cmd === "admit") {
      await admitToNetwork(db, workspaceId, { operator: by, note: flag(rest, "note") }, new Date());
      console.log(`Admitted ${workspaceId}`);
    } else {
      const reason = flag(rest, "reason");
      if (!reason) {
        console.error("--reason is required to remove a workspace");
        return 2;
      }
      await removeFromNetwork(db, workspaceId, { operator: by, reason }, new Date());
      console.log(`Removed ${workspaceId}`);
    }
    return 0;
  } finally {
    await db.close();
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  return 1;
});
