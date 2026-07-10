import type { Metadata } from "next";

import { OfflineLibrary } from "@/components/offline/offline-library";

export const metadata: Metadata = { title: "Offline" };

export default function OfflinePage() {
  return <OfflineLibrary />;
}
