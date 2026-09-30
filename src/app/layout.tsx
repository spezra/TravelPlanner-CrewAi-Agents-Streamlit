import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Travel Platform", template: "%s · Travel Platform" },
  description: "Operating environment for luxury travel experts: agents do the work, experts keep the judgment.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
