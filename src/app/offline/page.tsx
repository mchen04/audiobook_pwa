import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import { LibraryClient } from "@/components/library/library-client";
import { OfflineRedirect } from "@/components/offline-redirect";

export const metadata: Metadata = { title: "Library" };

/**
 * The last-resort document.
 *
 * There is no second library UI — this route renders the same shell and the
 * same `LibraryClient` as `/library`, reading the same local mirror. It exists
 * as its own URL only because `public/sw.js` precaches exactly one navigation
 * fallback and serves it for any navigation the network cannot answer. Because
 * it renders no user data on the server, it is the user-agnostic shell of
 * `docs/local-first.md` section 8 and is safe to keep cached across accounts.
 *
 * Reaching it directly is redirected into `/library`, so the two-screen split
 * is gone from the user's view as well as from the code.
 */
export default function OfflinePage() {
  return (
    <AppShell>
      <OfflineRedirect />
      <Suspense>
        <LibraryClient />
      </Suspense>
    </AppShell>
  );
}
