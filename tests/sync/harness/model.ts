/**
 * The ORACLE.
 *
 * This is an independent statement of what the user did, kept in the test
 * process, in the test's own vocabulary: books are identified by the
 * FINGERPRINT the test chose, tags by NAME, collections by the name the test
 * created them under. Nothing here reads the mirror, the outbox, or any
 * structure the implementation wrote.
 *
 * That independence is the whole point. An oracle built by re-reading the
 * mirror would assert only that the app agrees with itself, which is true of an
 * app that drops every write on the floor identically in both places.
 *
 * The model is compared against two places that are not each other:
 *   - Postgres, read over SQL by the test process. This is the only thing that
 *     proves a write left the device at all.
 *   - The device mirror after a fresh pull. This is what the user will see on
 *     the next launch.
 *
 * A write present in the model and absent from Postgres is a LOST WRITE. A
 * write present in Postgres and absent from the mirror after a completed pull
 * is a broken pull. Both are reported per operation, so a failure names the
 * intent that vanished rather than "the states differ".
 */

export type ModelChapter = { position: number; title: string; startMs: number; endMs: number };

export type ModelBook = {
  fingerprint: string;
  title: string;
  author: string;
  durationMs: number;
  chapters: ModelChapter[];
  archived: boolean;
  deleted: boolean;
  tags: Set<string>;
  collections: Set<string>;
  progress: { positionMs: number; completed: boolean } | null;
  /** Mutation ids of history events the user recorded for this book. */
  history: string[];
};

/** One user intent, in oracle vocabulary. `at` is the index in the seed's op list. */
export type Intent =
  | { at: number; kind: "import"; fingerprint: string }
  | { at: number; kind: "rename"; fingerprint: string; title: string; author: string }
  | { at: number; kind: "tag-add"; fingerprint: string; tag: string }
  | { at: number; kind: "tag-remove"; fingerprint: string; tag: string }
  | { at: number; kind: "collection-add"; fingerprint: string; collection: string }
  | { at: number; kind: "collection-remove"; fingerprint: string; collection: string }
  | { at: number; kind: "archive"; fingerprint: string; archived: boolean }
  | { at: number; kind: "progress"; fingerprint: string; positionMs: number; completed: boolean }
  | { at: number; kind: "history"; fingerprint: string; mutationId: string }
  | { at: number; kind: "delete"; fingerprint: string };

export type IntentKind = Intent["kind"];

export class LibraryModel {
  readonly books = new Map<string, ModelBook>();
  /** Collection name → the fingerprints the user put in it. */
  readonly collections = new Map<string, Set<string>>();
  readonly intents: Intent[] = [];

  declareCollection(name: string): void {
    if (!this.collections.has(name)) this.collections.set(name, new Set());
  }

  /**
   * Records one intent and folds it into the expected state.
   *
   * The fold encodes the design contract's own resolution rules and nothing
   * else: last-writer-wins for metadata and archive, set semantics for edges,
   * highest-sequence-wins for progress (which, on one device with monotonically
   * increasing sequences, is simply "the last one"), and a delete that takes
   * the book's children with it.
   */
  apply(intent: Intent, seed?: Omit<ModelBook, "fingerprint">): void {
    this.intents.push(intent);
    if (intent.kind === "import") {
      const existing = this.books.get(intent.fingerprint);
      // Fingerprint-unique: a duplicate registration is a merge, never a
      // second book (design contract sections 7 and 10).
      if (existing && !existing.deleted) return;
      if (!seed) throw new Error("an import intent must carry the book it creates");
      this.books.set(intent.fingerprint, { fingerprint: intent.fingerprint, ...seed });
      return;
    }
    const book = this.books.get(intent.fingerprint);
    if (!book || book.deleted) return;
    switch (intent.kind) {
      case "rename":
        book.title = intent.title;
        book.author = intent.author;
        return;
      case "tag-add":
        book.tags.add(intent.tag);
        return;
      case "tag-remove":
        book.tags.delete(intent.tag);
        return;
      case "collection-add":
        book.collections.add(intent.collection);
        this.collections.get(intent.collection)?.add(intent.fingerprint);
        return;
      case "collection-remove":
        book.collections.delete(intent.collection);
        this.collections.get(intent.collection)?.delete(intent.fingerprint);
        return;
      case "archive":
        book.archived = intent.archived;
        return;
      case "progress":
        book.progress = { positionMs: intent.positionMs, completed: intent.completed };
        return;
      case "history":
        book.history.push(intent.mutationId);
        return;
      case "delete":
        book.deleted = true;
        book.tags.clear();
        book.progress = null;
        book.history.length = 0;
        for (const members of this.collections.values()) members.delete(intent.fingerprint);
        book.collections.clear();
        return;
    }
  }

  live(): ModelBook[] {
    return [...this.books.values()].filter((book) => !book.deleted);
  }

  liveFingerprints(): string[] {
    return this.live()
      .map((book) => book.fingerprint)
      .sort();
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** What the server actually holds, read over SQL by the test process. */
export type ServerState = {
  booksByFingerprint: Map<
    string,
    { bookId: string; title: string; author: string; archived: boolean; chapterCount: number }
  >;
  /** fingerprint → tag names */
  tagsByFingerprint: Map<string, Set<string>>;
  /** collection name → fingerprints */
  collectionMembers: Map<string, Set<string>>;
  /** fingerprint → playback state */
  progressByFingerprint: Map<string, { positionMs: number; completed: boolean }>;
  /** every playback action id recorded for this account */
  historyIds: Set<string>;
};

/** What the device will show on the next launch, read from the mirror. */
export type DeviceState = {
  booksByFingerprint: Map<
    string,
    { bookId: string; title: string; author: string; archived: boolean; chapterCount: number }
  >;
  tagsByFingerprint: Map<string, Set<string>>;
  collectionMembers: Map<string, Set<string>>;
  progressByFingerprint: Map<string, { positionMs: number; completed: boolean }>;
};

export type Divergence = {
  /** Which intent this contradicts, when one can be named. */
  intent: string;
  where: "server" | "device";
  detail: string;
};

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function sameSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Every way the two observed states contradict the model, one line each.
 *
 * Deliberately exhaustive rather than fail-fast: knowing that six seeds all
 * lost exactly the tag-edge writes and nothing else is what turns a red suite
 * into a diagnosis.
 */
export function compare(
  model: LibraryModel,
  server: ServerState,
  device: DeviceState | null,
): Divergence[] {
  const problems: Divergence[] = [];
  const note = (intent: string, where: "server" | "device", detail: string) =>
    problems.push({ intent, where, detail });

  const liveFingerprints = new Set(model.liveFingerprints());

  // 1. Existence. A book the user imported and did not delete must exist
  //    exactly once, and a book the user deleted must be gone.
  for (const fingerprint of server.booksByFingerprint.keys()) {
    if (!liveFingerprints.has(fingerprint)) {
      note(`book ${fingerprint}`, "server", "exists on the server but the user deleted it");
    }
  }
  for (const book of model.live()) {
    const row = server.booksByFingerprint.get(book.fingerprint);
    if (!row) {
      note(`import ${book.fingerprint}`, "server", "the imported book never reached the server");
      continue;
    }
    if (row.title !== book.title || row.author !== book.author) {
      note(
        `rename ${book.fingerprint}`,
        "server",
        `server holds ${JSON.stringify([row.title, row.author])}, the user set ` +
          JSON.stringify([book.title, book.author]),
      );
    }
    if (row.archived !== book.archived) {
      note(
        `archive ${book.fingerprint}`,
        "server",
        `server archived=${row.archived}, the user set archived=${book.archived}`,
      );
    }
    if (row.chapterCount !== book.chapters.length) {
      note(
        `import ${book.fingerprint}`,
        "server",
        `server holds ${row.chapterCount} chapters, the import carried ${book.chapters.length}`,
      );
    }
    const serverTags = server.tagsByFingerprint.get(book.fingerprint) || new Set<string>();
    if (!sameSet(serverTags, book.tags)) {
      note(
        `tags ${book.fingerprint}`,
        "server",
        `server holds [${sorted(serverTags).join(", ")}], the user set ` +
          `[${sorted(book.tags).join(", ")}]`,
      );
    }
    const serverProgress = server.progressByFingerprint.get(book.fingerprint) || null;
    if (book.progress) {
      if (!serverProgress) {
        note(`progress ${book.fingerprint}`, "server", "no playback state reached the server");
      } else if (
        serverProgress.positionMs !== book.progress.positionMs ||
        serverProgress.completed !== book.progress.completed
      ) {
        note(
          `progress ${book.fingerprint}`,
          "server",
          `server holds ${JSON.stringify(serverProgress)}, the user set ` +
            JSON.stringify(book.progress),
        );
      }
    }
    for (const mutationId of book.history) {
      if (!server.historyIds.has(mutationId)) {
        note(
          `history ${book.fingerprint} ${mutationId}`,
          "server",
          "the playback action never reached the server",
        );
      }
    }
  }

  // 2. Collection membership, which the design contract calls out as the case
  //    that only propagates when the parent aggregate's updatedAt is bumped.
  for (const [name, members] of model.collections) {
    const serverMembers = server.collectionMembers.get(name) || new Set<string>();
    if (!sameSet(serverMembers, members)) {
      note(
        `collection "${name}"`,
        "server",
        `server holds [${sorted(serverMembers).join(", ")}], the user set ` +
          `[${sorted(members).join(", ")}]`,
      );
    }
  }

  if (!device) return problems;

  // 3. The device's own copy after a completed pull. This is what the user
  //    sees on the next launch, so a write that reached Postgres and never
  //    came back is just as lost from where the user stands.
  for (const fingerprint of device.booksByFingerprint.keys()) {
    if (!liveFingerprints.has(fingerprint)) {
      note(`book ${fingerprint}`, "device", "still in the mirror after the user deleted it");
    }
  }
  for (const book of model.live()) {
    const row = device.booksByFingerprint.get(book.fingerprint);
    if (!row) {
      note(`import ${book.fingerprint}`, "device", "missing from the mirror after a full pull");
      continue;
    }
    if (row.title !== book.title || row.author !== book.author) {
      note(
        `rename ${book.fingerprint}`,
        "device",
        `mirror holds ${JSON.stringify([row.title, row.author])}, the user set ` +
          JSON.stringify([book.title, book.author]),
      );
    }
    if (row.archived !== book.archived) {
      note(
        `archive ${book.fingerprint}`,
        "device",
        `mirror archived=${row.archived}, the user set archived=${book.archived}`,
      );
    }
    if (row.chapterCount !== book.chapters.length) {
      note(
        `import ${book.fingerprint}`,
        "device",
        `mirror holds ${row.chapterCount} chapters, the import carried ${book.chapters.length}`,
      );
    }
    const deviceTags = device.tagsByFingerprint.get(book.fingerprint) || new Set<string>();
    if (!sameSet(deviceTags, book.tags)) {
      note(
        `tags ${book.fingerprint}`,
        "device",
        `mirror holds [${sorted(deviceTags).join(", ")}], the user set ` +
          `[${sorted(book.tags).join(", ")}]`,
      );
    }
    const deviceProgress = device.progressByFingerprint.get(book.fingerprint) || null;
    if (book.progress) {
      if (!deviceProgress) {
        note(`progress ${book.fingerprint}`, "device", "no playback state in the mirror");
      } else if (
        deviceProgress.positionMs !== book.progress.positionMs ||
        deviceProgress.completed !== book.progress.completed
      ) {
        note(
          `progress ${book.fingerprint}`,
          "device",
          `mirror holds ${JSON.stringify(deviceProgress)}, the user set ` +
            JSON.stringify(book.progress),
        );
      }
    }
  }
  for (const [name, members] of model.collections) {
    const deviceMembers = device.collectionMembers.get(name) || new Set<string>();
    if (!sameSet(deviceMembers, members)) {
      note(
        `collection "${name}"`,
        "device",
        `mirror holds [${sorted(deviceMembers).join(", ")}], the user set ` +
          `[${sorted(members).join(", ")}]`,
      );
    }
  }

  return problems;
}

/** Groups divergences by the intent kind they contradict, for the failure line. */
export function summarize(problems: Divergence[]): string {
  const byKind = new Map<string, number>();
  for (const problem of problems) {
    const kind = `${problem.intent.split(" ")[0]}@${problem.where}`;
    byKind.set(kind, (byKind.get(kind) || 0) + 1);
  }
  return [...byKind.entries()]
    .sort()
    .map(([kind, total]) => `${kind}×${total}`)
    .join(" ");
}
