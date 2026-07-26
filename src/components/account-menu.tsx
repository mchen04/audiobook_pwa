"use client";

import { GearSix, SignOut } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient, takeSignOutReport, type SignOutReport } from "@/lib/auth-client";

type AccountMenuProps = {
  email: string;
};

/**
 * Sign-out does NOT clear `chapterline:active-user` here.
 *
 * That key is the only record of which account this device belongs to, and the
 * purge in `auth-client.ts` reads it to know whose data to remove. Clearing it
 * from the call site raced the purge — and won — leaving the departing
 * account's library, downloads and outbox on the device under the next user's
 * session. The purge owns the key now and removes it as part of the sweep.
 */
export function AccountMenu({ email }: AccountMenuProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [report, setReport] = useState<SignOutReport | null>(null);

  async function signOut() {
    setPending(true);
    // Resolves only once the sweep has finished: `authClient` awaits it on the
    // sign-out path, so nothing below can run while this account's data is
    // still on the device.
    await authClient.signOut();
    const outcome = takeSignOutReport();
    if (outcome && (outcome.undelivered.length > 0 || outcome.purgeFailed)) {
      // Sign-out removes this account from the device, so an undelivered write
      // is gone for good. The user is told before they leave the page — the one
      // thing that must never happen is losing it silently.
      setReport(outcome);
      setPending(false);
      return;
    }
    leave();
  }

  function leave() {
    router.replace("/login");
    router.refresh();
  }

  if (report) {
    return (
      <div className="account-menu">
        <p role="alert" className="form-error">
          {report.undelivered.length > 0
            ? `${report.undelivered.length} ${report.undelivered.length === 1 ? "change" : "changes"} you made on this device (${describeKinds(report.undelivered)}) could not be sent to the server before signing out, and signing out removes this account's data from this device. ${report.undelivered.length === 1 ? "It is" : "They are"} gone.`
            : "Some of this account's data could not be removed from this device. It will be removed the next time an account signs in here."}
        </p>
        <button type="button" className="icon-text-button" onClick={leave}>
          <span>Continue to sign-in</span>
        </button>
      </div>
    );
  }

  return (
    <div className="account-menu">
      <span title={email}>{email}</span>
      <Link href="/settings" className="icon-text-button" prefetch={false}>
        <GearSix size={19} aria-hidden="true" />
        <span>Settings</span>
      </Link>
      <button type="button" className="icon-text-button" onClick={signOut} disabled={pending}>
        <SignOut size={19} aria-hidden="true" />
        <span>{pending ? "Signing out" : "Sign out"}</span>
      </button>
    </div>
  );
}

/** "2 metadata, 1 tag" — enough for the user to know what they lost. */
function describeKinds(undelivered: SignOutReport["undelivered"]): string {
  const counts = new Map<string, number>();
  for (const write of undelivered) counts.set(write.kind, (counts.get(write.kind) || 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
}
