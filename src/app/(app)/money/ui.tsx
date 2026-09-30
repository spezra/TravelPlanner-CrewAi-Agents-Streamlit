import Link from "next/link";
import { formatMoney } from "@/domain/common";
import { currencyExponent, type ReceivableStatus } from "@/domain/money";

const SECTIONS = [
  { href: "/money", label: "Receivables" },
  { href: "/money/terms", label: "Commission & splits" },
  { href: "/money/statements", label: "Statements" },
  { href: "/money/payouts", label: "Payouts" },
  { href: "/money/recipients", label: "Payees" },
  { href: "/money/cards", label: "Cards" },
  { href: "/money/reports", label: "Reports" },
];

export function MoneyNav({ current }: { current: string }) {
  return (
    <nav className="row small" aria-label="Money sections" style={{ marginBottom: 16 }}>
      {SECTIONS.map((s) =>
        s.href === current ? (
          <b key={s.href}>{s.label}</b>
        ) : (
          <Link key={s.href} href={s.href} className="muted">
            {s.label}
          </Link>
        ),
      )}
    </nav>
  );
}

export function Flash({ error, ok }: { error?: string; ok?: string }) {
  return (
    <>
      {error && <p className="notice error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
    </>
  );
}

export const money = (amountMinor: number, currency: string) => formatMoney({ amountMinor, currency });

/** Minor units as a plain number for a form field ("1234.50", or "1500" for JPY). */
export const plainAmount = (amountMinor: number, currency: string) => {
  const exp = currencyExponent(currency);
  return (amountMinor / 10 ** exp).toFixed(exp);
};

export const STATUS_TONE: Record<ReceivableStatus, "" | "ok" | "warn" | "alert"> = {
  expected: "",
  overdue: "alert",
  short: "warn",
  settled: "ok",
  disputed: "alert",
};

export const LINE_TONE: Record<string, "" | "ok" | "warn" | "alert"> = {
  retained: "",
  pending: "",
  approved: "warn",
  sending: "warn",
  instructed: "warn",
  settled: "ok",
  failed: "alert",
  reversed: "alert",
  canceled: "",
};

export const label = (s: string) => s.replace(/_/g, " ");

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" }) : "—");
