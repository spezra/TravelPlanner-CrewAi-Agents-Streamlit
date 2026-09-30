import { safeLocalPath } from "@/lib/safePath";
import { redirect } from "next/navigation";
import { config } from "@/server/config";
import { currentSession } from "@/server/auth/session";
import { devSignIn, requestLink } from "../actions";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const DEMO_ACCOUNTS = [
  ["marisol@example.com", "Marisol Vega — expert (owner)"],
  ["diego@example.com", "Diego Ortiz — assistant"],
  ["lena@example.com", "Lena Brandt — named backup"],
  ["camille@example.com", "Camille Roux — another workspace"],
] as const;

export default async function Login({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string; next?: string }> }) {
  const { sent, error, next } = await searchParams;
  if (await currentSession()) redirect(safeLocalPath(next));
  const dev = config().ALLOW_DEV_LOGIN === "1" && config().NODE_ENV !== "production";
  return (
    <main>
      <h1>Sign in</h1>
      {error && <p className="notice error">{error}</p>}
      {sent ? (
        <p className="notice">Check your email for a sign-in link. It works once and expires in 15 minutes.</p>
      ) : (
        <form action={requestLink}>
          <input type="hidden" name="next" value={next ?? "/"} />
          <label htmlFor="email">Email</label>
          <input id="email" type="email" name="email" required autoComplete="email" />
          <div className="actions">
            <button className="btn primary" type="submit">
              Email me a sign-in link
            </button>
          </div>
        </form>
      )}
      {dev && (
        <section className="card" style={{ marginTop: 28 }}>
          <h3>Development sign-in</h3>
          <p className="small muted">Enabled by ALLOW_DEV_LOGIN. Never available in production.</p>
          {DEMO_ACCOUNTS.map(([email, label]) => (
            <form key={email} action={devSignIn} style={{ marginTop: 6 }}>
              <input type="hidden" name="email" value={email} />
              <button className="btn" type="submit">
                {label}
              </button>
            </form>
          ))}
        </section>
      )}
    </main>
  );
}
