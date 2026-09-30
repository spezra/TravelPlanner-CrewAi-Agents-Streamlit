export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell narrow">
      <header className="top">
        <span className="brand">Travel Platform</span>
      </header>
      {children}
    </div>
  );
}
