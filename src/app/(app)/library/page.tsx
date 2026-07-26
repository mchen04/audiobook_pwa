import type { Metadata } from "next";
import { Suspense } from "react";

import { LibraryClient } from "@/components/library/library-client";
import { requireSession } from "@/server/auth-session";

export const metadata: Metadata = { title: "Library" };

/**
 * The library is rendered from this device's mirror, so the server renders no
 * book rows into the HTML (`docs/local-first.md` section 8). The session is
 * still checked here: it is what redirects a signed-out visitor, and it is the
 * only thing this page needs the database for.
 */
export default async function LibraryPage() {
  const session = await requireSession();
  return (
    <Suspense>
      <LibraryClient userId={session.user.id} />
    </Suspense>
  );
}
