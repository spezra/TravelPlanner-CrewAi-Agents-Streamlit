export const dynamic = "force-dynamic";

/**
 * Where Stripe Checkout (setup mode) sends the client afterwards. The client is
 * usually not a member, so this is a plain public page; the card itself is
 * recorded from the webhook, not from this redirect.
 */
export function GET(req: Request) {
  const done = new URL(req.url).searchParams.get("status") === "done";
  const [title, body] = done
    ? ["Card saved securely", "Thank you. Your card is stored with Stripe, our payments provider; your advisor sees only its brand and last four digits. You can close this window."]
    : ["No card saved", "Nothing was saved. If you meant to add a card, open the link from your advisor again."];
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1f1c18;background:#f7f4ef}</style></head>
<body><h1 style="font-weight:500">${title}</h1><p>${body}</p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
