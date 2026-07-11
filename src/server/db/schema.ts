import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

// Better Auth core tables. Property names intentionally match its adapter contract.
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    ...timestamps,
  },
  (table) => [uniqueIndex("user_email_lower_unique").on(sql`lower(${table.email})`)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    index("session_expiry_idx").on(table.expiresAt),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const rateLimit = pgTable(
  "rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [check("rate_limit_count_nonnegative", sql`${table.count} >= 0`)],
);

export const books = pgTable(
  "books",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 300 }).notNull(),
    author: varchar("author", { length: 240 }).notNull().default("Unknown author"),
    narrator: varchar("narrator", { length: 240 }),
    description: text("description"),
    series: varchar("series", { length: 240 }),
    seriesPosition: numeric("series_position", { precision: 8, scale: 2 }),
    chapterDiagnostic: text("chapter_diagnostic"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("books_owner_updated_idx").on(table.ownerId, table.updatedAt, table.id),
    index("books_owner_created_id_idx").on(table.ownerId, table.createdAt, table.id),
    index("books_owner_title_id_idx").on(table.ownerId, sql`lower(${table.title})`, table.id),
    index("books_owner_author_id_idx").on(table.ownerId, sql`lower(${table.author})`, table.id),
    index("books_search_trgm_idx").using(
      "gin",
      sql`(lower(coalesce(${table.title}, '') || ' ' || coalesce(${table.author}, '') || ' ' || coalesce(${table.narrator}, '') || ' ' || coalesce(${table.series}, ''))) gin_trgm_ops`,
    ),
    check("books_title_not_blank", sql`length(trim(${table.title})) > 0`),
  ],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    originalFilename: varchar("original_filename", { length: 512 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    fingerprintKind: varchar("fingerprint_kind", {
      length: 20,
      enum: ["sample-v1", "sha256-v1"],
    })
      .default("sample-v1")
      .notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("media_assets_book_unique").on(table.bookId),
    uniqueIndex("media_assets_owner_sha256_unique")
      .on(table.ownerId, table.fingerprintKind, table.fingerprint)
      .where(sql`${table.fingerprintKind} = 'sha256-v1'`),
    check("media_assets_byte_size_positive", sql`${table.byteSize} > 0`),
    check("media_assets_duration_positive", sql`${table.durationMs} > 0`),
  ],
);

export const chapters = pgTable(
  "chapters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("chapters_book_position_unique").on(table.bookId, table.position),
    index("chapters_book_start_idx").on(table.bookId, table.startMs),
    check("chapters_position_nonnegative", sql`${table.position} >= 0`),
    check(
      "chapters_bounds_valid",
      sql`${table.startMs} >= 0 AND ${table.endMs} > ${table.startMs}`,
    ),
  ],
);

export const playbackStates = pgTable(
  "playback_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    positionMs: bigint("position_ms", { mode: "number" }).default(0).notNull(),
    playbackRate: numeric("playback_rate", { precision: 4, scale: 2 }).default("1.00").notNull(),
    completed: boolean("completed").default(false).notNull(),
    deviceId: varchar("device_id", { length: 100 }).notNull(),
    deviceSequence: bigint("device_sequence", { mode: "number" }).default(0).notNull(),
    eventOccurredAt: timestamp("event_occurred_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.bookId] }),
    index("playback_states_user_updated_idx").on(table.userId, table.updatedAt),
    check("playback_position_nonnegative", sql`${table.positionMs} >= 0`),
    check("playback_device_sequence_nonnegative", sql`${table.deviceSequence} >= 0`),
    check(
      "playback_rate_valid",
      sql`${table.playbackRate} >= 0.5 AND ${table.playbackRate} <= 3.0`,
    ),
  ],
);

export const playbackDeviceSequences = pgTable(
  "playback_device_sequences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    deviceId: varchar("device_id", { length: 100 }).notNull(),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.bookId, table.deviceId] }),
    check("playback_device_last_sequence_nonnegative", sql`${table.lastSequence} >= 0`),
  ],
);

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    positionMs: bigint("position_ms", { mode: "number" }).notNull(),
    note: varchar("note", { length: 2000 }),
    // Client-generated id so replaying a queued offline bookmark cannot duplicate it.
    clientId: uuid("client_id"),
    ...timestamps,
  },
  (table) => [
    index("bookmarks_user_book_position_idx").on(table.userId, table.bookId, table.positionMs),
    index("bookmarks_user_id_idx").on(table.userId, table.id),
    uniqueIndex("bookmarks_user_client_unique").on(table.userId, table.clientId),
    check("bookmarks_position_nonnegative", sql`${table.positionMs} >= 0`),
  ],
);

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("collections_user_name_unique").on(table.userId, sql`lower(${table.name})`),
    index("collections_user_id_idx").on(table.userId, table.id),
    check("collections_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const collectionBooks = pgTable(
  "collection_books",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    position: integer("position").default(0).notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.bookId] }),
    index("collection_books_order_idx").on(table.collectionId, table.position, table.bookId),
    index("collection_books_book_collection_idx").on(table.bookId, table.collectionId),
    check("collection_books_position_nonnegative", sql`${table.position} >= 0`),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
  },
  (table) => [
    uniqueIndex("tags_user_name_unique").on(table.userId, sql`lower(${table.name})`),
    index("tags_user_id_idx").on(table.userId, table.id),
    index("tags_name_trgm_idx").using("gin", sql`lower(${table.name}) gin_trgm_ops`),
    check("tags_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const bookTags = pgTable(
  "book_tags",
  {
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.bookId, table.tagId] })],
);

export const listeningSessions = pgTable(
  "listening_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    startPositionMs: bigint("start_position_ms", { mode: "number" }).notNull(),
    endPositionMs: bigint("end_position_ms", { mode: "number" }).notNull(),
    listenedMs: bigint("listened_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    index("listening_sessions_user_started_idx").on(table.userId, table.startedAt),
    index("listening_sessions_user_id_idx").on(table.userId, table.id),
    index("listening_sessions_book_started_idx").on(table.bookId, table.startedAt),
    check("listening_sessions_times_valid", sql`${table.endedAt} >= ${table.startedAt}`),
    check(
      "listening_sessions_positions_nonnegative",
      sql`${table.startPositionMs} >= 0 AND ${table.endPositionMs} >= 0`,
    ),
    check("listening_sessions_duration_nonnegative", sql`${table.listenedMs} >= 0`),
  ],
);

// Skip bounds mirror SKIP_BOUNDS_MS in `lib/preferences.ts`; keep in lockstep.
export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    skipBackMs: integer("skip_back_ms").default(15_000).notNull(),
    skipForwardMs: integer("skip_forward_ms").default(30_000).notNull(),
    smartRewind: boolean("smart_rewind").default(true).notNull(),
    autoplayNextInCollection: boolean("autoplay_next_in_collection").default(false).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "user_preferences_skip_back_valid",
      sql`${table.skipBackMs} >= 5000 AND ${table.skipBackMs} <= 120000`,
    ),
    check(
      "user_preferences_skip_forward_valid",
      sql`${table.skipForwardMs} >= 5000 AND ${table.skipForwardMs} <= 120000`,
    ),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  books: many(books),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const booksRelations = relations(books, ({ one, many }) => ({
  owner: one(user, { fields: [books.ownerId], references: [user.id] }),
  mediaAssets: many(mediaAssets),
  chapters: many(chapters),
  bookmarks: many(bookmarks),
}));

export const schema = {
  user,
  session,
  account,
  verification,
  rateLimit,
  books,
  mediaAssets,
  chapters,
  playbackStates,
  playbackDeviceSequences,
  bookmarks,
  collections,
  collectionBooks,
  tags,
  bookTags,
  listeningSessions,
  userPreferences,
};
