"use client";

import { ArrowLeft, DownloadSimple, Trash } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { usePlayback } from "@/components/player/playback-provider";
import { usePreferences } from "@/components/player/preferences-provider";
import { formatClock } from "@/lib/format-time";
import { purgeAccount } from "@/lib/offline/account-purge";
import { readLatestLocalPlayback } from "@/lib/playback-core";
import { SKIP_CHOICES_MS } from "@/domain/preferences";

export function SettingsClient({ email }: { email: string }) {
  const router = useRouter();
  const { userId } = usePlayback();
  const { preferences, updatePreferences } = usePreferences();
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
    // The whole sweep, not just the audio. `clearLocalDataForUser` covers the
    // downloads, transcripts and cache entries; it does not touch the mirror,
    // the deletion journal, the device sequences, the cached pages or the
    // active-user key. Deleting your account used to leave your entire mirrored
    // library — every book row, chapter, tag and position — readable on this
    // device. `/api/account/delete` ends the session server-side, so none of
    // the auth client's sign-out hooks fire on this path and this is the only
    // place the sweep can be asked for.
    try {
      await purgeAccount(userId);
    } catch {
      setDeleting(false);
      setDeleteError(
        "Your account was deleted, but this browser could not clear every local file. Clear Hark's website data in browser settings.",
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

      <ResumeDiagnostics userId={userId} />

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

/**
 * The provenance of this device's most recent durable position, in plain text.
 *
 * This is a readout, not a feature. It exists so the on-device check in
 * `docs/resume-durability-device-check.md` can be READ rather than inferred: the
 * one open question about resume durability is whether iOS suspends both
 * durable writers at once while a PWA plays in the background, and no
 * instrument on a development machine can answer it. After a backgrounded
 * listen, the writer named here and the age of its write answer it directly.
 *
 * Read on mount only. The record is written by the player, not by this page, so
 * there is nothing here to keep live — and mount is exactly the moment the check
 * asks about, since the user relaunches the app and comes straight here.
 */
function ResumeDiagnostics({ userId }: { userId: string }) {
  // localStorage does not exist during the server render, so the first client
  // render has to match it and the read happens after mount.
  const [readout, setReadout] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Off the effect body, as everywhere else this app reads a client-only
    // store into React state: setting state synchronously in an effect cascades
    // renders, and the value cannot be read during render because it does not
    // exist on the server.
    void Promise.resolve()
      .then(() => {
        if (active) setReadout(describeLatestWrite(userId));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [userId]);

  return (
    <section className="settings-group" aria-labelledby="settings-diagnostics-title">
      <h2 id="settings-diagnostics-title">Resume diagnostics</h2>
      <p className="details-hint">
        The most recent playback position saved on this device, and which part of the app saved it.
      </p>
      <p className="resume-diagnostics">{readout ?? "Reading this device…"}</p>
    </section>
  );
}

function describeLatestWrite(userId: string): string {
  const latest = readLatestLocalPlayback(userId);
  if (!latest) return "No position saved on this device yet.";
  const { positionMs, source, writtenAt } = latest.state;
  return [
    formatClock(positionMs),
    source ? `written by ${source}` : "written by an earlier build, which recorded no writer",
    writtenAt ? formatAge(Date.now() - writtenAt) : "at an unrecorded time",
  ].join(" · ");
}

function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}
