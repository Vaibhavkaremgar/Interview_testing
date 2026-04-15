import Link from "next/link";

export default function Home() {
  return (
    <main style={{ fontFamily: "Segoe UI, Arial, sans-serif", padding: "48px" }}>
      <h1 style={{ marginBottom: "8px" }}>Pontis Next.js</h1>
      <p style={{ marginTop: 0, color: "#475569" }}>
        Unified frontend and backend stack.
      </p>
      <ul style={{ marginTop: "24px", paddingLeft: "18px" }}>
        <li><Link href="/booking">Booking</Link></li>
        <li><Link href="/interview">Interview</Link></li>
      </ul>
    </main>
  );
}
