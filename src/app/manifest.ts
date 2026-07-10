import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Chapterline Audiobook Player",
    short_name: "Chapterline",
    description: "A private, offline-ready MP3 audiobook player.",
    start_url: "/library?source=pwa",
    scope: "/",
    display: "standalone",
    background_color: "#f5f7fb",
    theme_color: "#3157d5",
    orientation: "any",
    categories: ["books", "entertainment"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Continue listening",
        short_name: "Continue",
        url: "/library?action=continue",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Import an MP3",
        short_name: "Import",
        url: "/library?action=import",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
