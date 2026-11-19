import type { MetadataRoute } from "next";

// Installing the app (phone home screen, desktop app window) uses these icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LM Data Universe",
    short_name: "LM Data",
    description: "Relational spreadsheets: tables, formulas, linked views, charts and forms.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#5a43d9",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
