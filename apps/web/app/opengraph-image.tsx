import { ImageResponse } from "next/og";

export const runtime = "edge";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Player Pool — NBA Playoffs";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 56,
          background: "#0f172a",
          color: "#ffffff",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          padding: "0 96px",
        }}
      >
        {/* Basketball glyph drawn with nested circles + simple seam lines.
            No fetched assets, no fonts — just oklch + basic geometry. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 300,
            height: 300,
            borderRadius: 9999,
            background: "#f97316",
            boxShadow: "inset 0 0 0 6px #0f172a",
          }}
        >
          <div
            style={{
              width: 220,
              height: 220,
              borderRadius: 9999,
              border: "6px solid #0f172a",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                width: 6,
                height: 220,
                background: "#0f172a",
                borderRadius: 3,
              }}
            />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 96, fontWeight: 800, letterSpacing: -3, lineHeight: 1 }}>
            Player Pool
          </div>
          <div
            style={{
              fontSize: 48,
              fontWeight: 700,
              letterSpacing: 2,
              color: "#f97316",
              textTransform: "uppercase",
            }}
          >
            NBA Playoffs
          </div>
          <div style={{ fontSize: 28, color: "#94a3b8", marginTop: 12 }}>
            Blind auctions, projections & league draft rooms.
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
