"use client";

/**
 * Last-resort boundary for errors in the root layout itself. It replaces the whole document, so it
 * brings its own <html> and <body> and cannot rely on the app's CSS or providers: it uses system
 * colors, which follow the device's light or dark setting.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "1rem",
          fontFamily: "system-ui, sans-serif",
          colorScheme: "light dark",
          background: "Canvas",
          color: "CanvasText",
        }}
      >
        <main style={{ maxWidth: "32rem" }}>
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem" }}>Pulseboard could not load</h1>
          <p style={{ margin: "0 0 1rem", lineHeight: 1.5 }}>
            An unexpected error stopped the app from rendering. Nothing has been changed. Try again; if it keeps happening, reload the page.
          </p>
          {error.digest ? <p style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}>Reference: {error.digest}</p> : null}
          <button
            type="button"
            onClick={reset}
            style={{ minHeight: 44, padding: "0 1rem", font: "inherit", cursor: "pointer", border: "1px solid currentColor", borderRadius: 8, background: "ButtonFace", color: "ButtonText" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
