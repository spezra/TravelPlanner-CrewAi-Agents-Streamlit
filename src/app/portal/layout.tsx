import type { Metadata } from "next";

// Public, token-authenticated pages for travelers: no app navigation, no session.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell narrow" style={{ maxWidth: 760 }}>
      {children}
    </div>
  );
}
