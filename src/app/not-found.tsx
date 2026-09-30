import Link from "next/link";

export default function NotFound() {
  return (
    <div className="shell narrow">
      <h1 style={{ marginTop: 48 }}>Not found</h1>
      <p className="lede">This page doesn't exist, or you don't have access to it.</p>
      <Link className="btn" href="/">
        Back to Today
      </Link>
    </div>
  );
}
