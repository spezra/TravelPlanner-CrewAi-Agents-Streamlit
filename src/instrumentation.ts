/** Next.js instrumentation: validate config at boot and log unhandled request errors as structured JSON. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { config } = await import("./server/config");
    config();
  }
}

export async function onRequestError(err: unknown, request: { path: string; method: string }, context: { routePath?: string; routeType?: string }) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log } = await import("./server/log");
  const e = err as Error & { digest?: string };
  log.error({ digest: e.digest, err: e.message, stack: e.stack, method: request.method, path: request.path.split("?")[0], route: context.routePath, type: context.routeType }, "request error");
}
