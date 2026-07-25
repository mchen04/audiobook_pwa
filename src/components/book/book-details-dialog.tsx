"use client";

import { ArrowCounterClockwise, CheckCircle, Trash, X } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

import { useDeleteBook } from "@/components/book/use-delete-book";
import { usePlayback } from "@/components/player/playback-provider";
import { formatDurationRounded } from "@/lib/format-time";
import { replayQueuedMutations } from "@/lib/offline-sync";
import { listMirrorCollections } from "@/lib/offline/mirror";
import {
  commitArchiveChange,
  commitCollectionEdge,
  commitMetadataEdit,
  commitTagList,
} from "@/lib/offline/outbox";
import { getDeviceId } from "@/lib/playback-core";
import { isCollectionPayload, readJson, type CollectionSummary } from "@/lib/wire";

export type BookDetails = {
  id: string;
  title: string;
  author: string;
  narrator: string | null;
  description: string | null;
  series: string | null;
  seriesPosition: string | null;
  archivedAt: string | null;
  chapterDiagnostic: string | null;
  tags: string[];
  recentSessions: Array<{ id: string; startedAt: string; listenedMs: number }>;
};

export function BookDetailsDialog({
  details,
  open,
  onClose,
}: {
  details: BookDetails;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const playback = usePlayback();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; queued: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [archived, setArchived] = useState(!!details.archivedAt);
  const [tags, setTags] = useState(details.tags);
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const { deleteBook, deleting, deleteLabel } = useDeleteBook(
    playback.userId,
    details.id,
    setError,
  );
  function origin() {
    return { userId: playback.userId, deviceId: getDeviceId() };
  }

  /**
   * Every edit below is journalled in the outbox and projected into this
   * device's mirror, so it is already saved by the time this returns — the
   * server hears about it on the next drain, which is now if the network is
   * there and on reconnect if it is not.
   */
  function settled(message: string) {
    setError(null);
    setNotice({ message, queued: !navigator.onLine });
    void replayQueuedMutations(playback.userId).catch(() => undefined);
    // A refresh is a *read*, and the only reader that could answer it is the
    // server. Asking with the network down would fail for nothing: the mirror
    // this edit just patched is what the library reads from either way.
    if (navigator.onLine) router.refresh();
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setError(null);
      setNotice(null);
      void listMirrorCollections(playback.userId, details.id)
        .then(setCollections)
        .catch(() => setCollections(null));
    }
    if (!open && dialog.open) dialog.close();
  }, [details.id, open, playback.userId]);

  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const seriesPositionRaw = String(data.get("seriesPosition") || "").trim();
    const fields = {
      title: String(data.get("title") || "").trim(),
      author: String(data.get("author") || "").trim(),
      narrator: String(data.get("narrator") || "").trim() || null,
      description: String(data.get("description") || "").trim() || null,
      series: String(data.get("series") || "").trim() || null,
      seriesPosition: seriesPositionRaw ? Number(seriesPositionRaw) : null,
    };
    const nextTags = String(data.get("tags") || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!fields.title || !fields.author) {
      setError("Title and author are required.");
      setSaving(false);
      return;
    }
    try {
      await commitMetadataEdit(origin(), details.id, fields);
      await commitTagList(origin(), details.id, tags, nextTags);
    } catch {
      setSaving(false);
      setError("This device could not record the change. Try again.");
      return;
    }
    setTags(nextTags);
    setSaving(false);
    settled("Saved to this device.");
  }

  async function toggleArchived() {
    const next = !archived;
    try {
      await commitArchiveChange(origin(), details.id, next);
    } catch {
      setError("This device could not record the change. Try again.");
      return;
    }
    setArchived(next);
    settled(next ? "Archived." : "Moved back into the library.");
  }

  async function toggleCollection(collection: CollectionSummary, include: boolean) {
    try {
      await commitCollectionEdge(origin(), collection.id, details.id, include);
    } catch {
      setError("This device could not record the change. Try again.");
      return;
    }
    setCollections(
      (current) =>
        current?.map((entry) =>
          entry.id === collection.id ? { ...entry, includesBook: include } : entry,
        ) ?? null,
    );
    settled(include ? `Added to ${collection.name}.` : `Removed from ${collection.name}.`);
  }

  /**
   * The one action here that genuinely cannot be queued.
   *
   * Every other edit names something that already exists; a new collection has
   * no id until the server mints one, and there is no queued mutation that can
   * carry "a collection whose id I do not know yet". So this one asks the
   * network, and says so plainly when the network is not there — rather than
   * failing with the same wording as an edit that was in fact saved.
   */
  async function createCollection(event: FormEvent) {
    event.preventDefault();
    const name = newCollectionName.trim();
    if (!name) return;
    const response = await fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    const payload = response ? await readJson(response, isCollectionPayload) : null;
    if (!payload) {
      setError(
        response
          ? "The collection could not be created."
          : "A brand-new collection needs a connection, because only the server can name it. " +
              "The collections you already have can be changed offline.",
      );
      return;
    }
    setNewCollectionName("");
    setCollections((current) => [...(current || []), payload.collection]);
    await toggleCollection(payload.collection, true);
  }

  return (
    <dialog
      ref={dialogRef}
      className="book-details-dialog"
      aria-labelledby="book-details-title"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // A click on the ::backdrop targets the dialog element itself, but so
        // does one on the dialog's own padding — check the geometry.
        const dialog = dialogRef.current;
        if (!dialog || event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const inside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;
        if (!inside) onClose();
      }}
    >
      <div className="dialog-head">
        <h2 id="book-details-title">Book details</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details">
          <X size={19} />
        </button>
      </div>

      <div className="dialog-columns">
        <form onSubmit={saveDetails} className="details-form">
          <label>
            <span>Title</span>
            <input name="title" defaultValue={details.title} maxLength={300} required />
          </label>
          <label>
            <span>Author</span>
            <input name="author" defaultValue={details.author} maxLength={240} required />
          </label>
          <label>
            <span>Narrator</span>
            <input name="narrator" defaultValue={details.narrator || ""} maxLength={240} />
          </label>
          <div className="field-row">
            <label>
              <span>Series</span>
              <input name="series" defaultValue={details.series || ""} maxLength={240} />
            </label>
            <label>
              <span>Series no.</span>
              <input
                name="seriesPosition"
                type="number"
                min={0}
                max={999999}
                step="0.1"
                defaultValue={details.seriesPosition ? Number(details.seriesPosition) : ""}
              />
            </label>
          </div>
          <label>
            <span>Description</span>
            <textarea name="description" defaultValue={details.description || ""} rows={3} />
          </label>
          <label>
            <span>Tags (comma separated)</span>
            <input
              key={tags.join(",")}
              name="tags"
              defaultValue={tags.join(", ")}
              maxLength={400}
            />
          </label>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "Saving" : "Save changes"}
          </button>
        </form>

        <div className="details-side">
          <section aria-labelledby="details-state-title">
            <h3 id="details-state-title">Book state</h3>
            <div className="details-actions">
              <button type="button" className="secondary-button" onClick={playback.markFinished}>
                <CheckCircle size={17} aria-hidden="true" />
                Mark finished
              </button>
              <button type="button" className="secondary-button" onClick={playback.restart}>
                <ArrowCounterClockwise size={17} aria-hidden="true" />
                Restart from beginning
              </button>
              <button type="button" className="secondary-button" onClick={toggleArchived}>
                {archived ? "Unarchive" : "Archive"}
              </button>
            </div>
            <p className="details-hint">
              Archived books stay searchable under the Archived filter and keep their progress.
            </p>
          </section>

          <section aria-labelledby="details-collections-title">
            <h3 id="details-collections-title">Collections</h3>
            {collections === null && (
              <p className="details-hint">This device&apos;s collections could not be read.</p>
            )}
            {collections?.length === 0 && (
              <p className="details-hint">
                Group series into an ordered collection to play them in order.
              </p>
            )}
            {!!collections?.length && (
              <ul className="collection-list">
                {collections.map((collection) => {
                  const included = collection.includesBook;
                  return (
                    <li key={collection.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => toggleCollection(collection, !included)}
                        />
                        <span>{collection.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <form onSubmit={createCollection} className="collection-create">
              <input
                value={newCollectionName}
                onChange={(event) => setNewCollectionName(event.target.value)}
                placeholder="New collection name"
                maxLength={120}
                aria-label="New collection name"
              />
              <button type="submit" className="secondary-button">
                Create
              </button>
            </form>
          </section>

          {details.recentSessions.length > 0 && (
            <section aria-labelledby="details-history-title">
              <h3 id="details-history-title">Recent listening</h3>
              <ul className="session-list">
                {details.recentSessions.map((session) => (
                  <li key={session.id}>
                    <span>{new Date(session.startedAt).toLocaleDateString()}</span>
                    <span>{formatDurationRounded(session.listenedMs)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="details-delete-title" className="danger-zone">
            <h3 id="details-delete-title">Delete book</h3>
            <p className="details-hint">
              Deleting removes the MP3, chapters, progress, playback history, and any offline
              download on this device. This cannot be undone.
            </p>
            <button
              type="button"
              className="danger-button"
              onClick={() => void deleteBook()}
              disabled={deleting}
            >
              <Trash size={17} aria-hidden="true" />
              {deleteLabel}
            </button>
          </section>
        </div>
      </div>

      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      {!error && notice && (
        <p role="status" className="dialog-notice" data-queued={notice.queued || undefined}>
          {notice.message}
          {notice.queued && " Your other devices get it when this one reconnects."}
        </p>
      )}
    </dialog>
  );
}
