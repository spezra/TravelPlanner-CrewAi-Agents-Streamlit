import { BRAND_NAME } from "@/lib/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell narrow auth-hero">
      <header className="top" style={{ marginBottom: 0 }}>
        <span className="brand">{BRAND_NAME}</span>
      </header>
      {children}
      <footer>For the experts who make travel personal</footer>
    </div>
  );
}
