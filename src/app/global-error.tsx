"use client";

// Last-resort boundary for errors in the root layout. It replaces the whole
// document, so it carries its own markup and inline styles.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f7f7fa", color: "#1f2330" }}>
        <title>Something went wrong · LM Data Universe</title>
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 440, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 24, textAlign: "center" }}>
            <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: "#4b5563", wordBreak: "break-word", margin: 0 }}>{message}</p>
            <div style={{ marginTop: 20, display: "flex", gap: 8, justifyContent: "center" }}>
              <button
                onClick={() => retry()}
                style={{ height: 36, padding: "0 16px", borderRadius: 6, border: 0, background: "#5a43d9", color: "#fff", fontWeight: 500, cursor: "pointer" }}
              >
                Try again
              </button>
              {/* A full page load on purpose: the root layout itself failed. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                style={{ height: 36, padding: "0 16px", borderRadius: 6, border: "1px solid #d1d5db", color: "#1f2330", display: "inline-flex", alignItems: "center", textDecoration: "none", fontSize: 14 }}
              >
                Home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
