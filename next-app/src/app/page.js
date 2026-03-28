export default function Home() {
  return (
    <main style={{ fontFamily: "Segoe UI, Arial, sans-serif", padding: "48px" }}>
      <h1 style={{ marginBottom: "8px" }}>Pontis Next.js</h1>
      <p style={{ marginTop: 0, color: "#475569" }}>
        Unified frontend and backend stack.
      </p>
      <ul style={{ marginTop: "24px", paddingLeft: "18px" }}>
        <li><a href="/booking">Booking</a></li>
        <li><a href="/interview">Interview</a></li>
      </ul>
    </main>
  );
}
