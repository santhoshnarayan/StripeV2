import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Player Pool — NBA Playoffs",
    short_name: "Player Pool",
    description: "Blind playoff auctions and draft rooms for NBA playoff player pools.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    categories: ["sports", "games"],
    icons: [
      {
        // Next.js serves apps/web/app/icon.png from /icon.png automatically,
        // but we still need to declare it here so the PWA manifest advertises
        // a concrete icon for installation.
        src: "/icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/apple-icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
