"use client";

import { ArrowLeft, DownloadSimple, Trash } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { usePlayback } from "@/components/player/playback-provider";
import { clearLocalDataForUser } from "@/lib/offline-library";
import { SKIP_CHOICES_MS } from "@/lib/preferences";

export function SettingsClient({ email }: { email: string }) {
  const router = useRouter();
  const playback = usePlayback();
  const { preferences, updatePreferences, userId } = playback;
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeleteError(null);
    const confirmEmail = String(new FormData(event.currentTarget).get("confirmEmail") || "");
    const currentPassword = String(new FormData(event.currentTarget).get("currentPassword") || "");
    if (confirmEmail.trim().toLowerCase() !== email.toLowerCase()) {
      setDeleteError("Type your account email exactly to confirm.");
      return;
    }
    setDeleting(true);
    const response = await fetch("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmEmail, currentPassword }),
    }).catch(() => null);
    if (!response?.ok) {
      setDeleting(false);
      setDeleteError("The account could not be deleted. Check your connection and try again.");
      return;
    }
    try {
      await clearLocalDataForUser(userId);
    } catch {
      setDeleting(false);
      setDeleteError(
        "Your account was deleted, but this browser could not clear every local audio file. Clear Hark's website data in browser settings.",
      );
      return;
    }
    router.replace("/register");
    router.refresh();
  }

  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <div className="settings-heading">
        <Link href="/library" className="icon-text-button">
          <ArrowLeft size={19} aria-hidden="true" />
          <span>Library</span>
        </Link>
        <p className="library-kicker">Your account</p>
        <h1 id="settings-title">Settings</h1>
        <p className="settings-email">{email}</p>
      </div>

      <section className="settings-group" aria-labelledby="settings-playback-title">
        <h2 id="settings-playback-title">Playback</h2>
        <div className="settings-fields">
          <label>
            <span>Skip back</span>
            <select
              value={preferences.skipBackMs}
              onChange={(event) => updatePreferences({ skipBackMs: Number(event.target.value) })}
            >
              {SKIP_CHOICES_MS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000} seconds
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Skip forward</span>
            <select
              value={preferences.skipForwardMs}
              onChange={(event) => updatePreferences({ skipForwardMs: Number(event.target.value) })}
            >
              {SKIP_CHOICES_MS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000} seconds
                </option>
              ))}
            </select>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={preferences.smartRewind}
              onChange={(event) => updatePreferences({ smartRewind: event.target.checked })}
            />
            <span>
              Smart rewind
              <small>Back up a few seconds when you return after a break.</small>
            </span>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={preferences.autoplayNextInCollection}
              onChange={(event) =>
                updatePreferences({ autoplayNextInCollection: event.target.checked })
              }
            />
            <span>
              Play the next book in a collection
              <small>When a book ends, continue with the next one in its collection.</small>
            </span>
          </label>
        </div>
        <p className="details-hint">
          Changes apply immediately on this device and sync to your other devices.
        </p>
      </section>

      <section className="settings-group" aria-labelledby="settings-data-title">
        <h2 id="settings-data-title">Your data</h2>
        <p className="details-hint">
          Download a JSON copy of your books&apos; metadata, chapters, progress, playback history,
          legacy saved positions, collections, and listening sessions. Your MP3 files are your own
          originals and are not included.
        </p>
        <a className="secondary-button" href="/api/account/export" download>
          <DownloadSimple size={17} aria-hidden="true" />
          Export my data
        </a>
      </section>

      <section className="settings-group danger-zone" aria-labelledby="settings-delete-title">
        <h2 id="settings-delete-title">Delete account</h2>
        <p className="details-hint">
          Permanently deletes your account, books, audio files, progress, playback history, and
          downloads on this device. This cannot be undone.
        </p>
        <form onSubmit={deleteAccount} className="delete-account-form">
          <label>
            <span>Type your email to confirm</span>
            <input name="confirmEmail" type="email" autoComplete="off" placeholder={email} />
          </label>
          <label>
            <span>Current password</span>
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" className="danger-button" disabled={deleting}>
            <Trash size={17} aria-hidden="true" />
            {deleting ? "Deleting account" : "Delete my account"}
          </button>
          {deleteError && (
            <p role="alert" className="form-error">
              {deleteError}
            </p>
          )}
        </form>
      </section>
    </section>
  );
}
