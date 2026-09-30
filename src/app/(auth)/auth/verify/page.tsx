import { verifyLink } from "../../actions";

export const metadata = { title: "Confirm sign-in" };

/** GET only renders a button: link scanners that prefetch URLs can't consume the token. */
export default async function Verify({ searchParams }: { searchParams: Promise<{ token?: string; next?: string }> }) {
  const { token, next } = await searchParams;
  return (
    <main>
      <h1>Confirm sign-in</h1>
      {!token ? (
        <p className="notice error">This link is missing its token. Request a new one.</p>
      ) : (
        <form action={verifyLink}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="next" value={next ?? "/"} />
          <button className="btn primary" type="submit">
            Continue
          </button>
        </form>
      )}
    </main>
  );
}
