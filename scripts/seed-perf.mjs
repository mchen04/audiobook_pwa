// Seeds a realistic large library for performance measurement (goal §7):
// 1,000 books with chapters plus ~100,000 progress/bookmark/session rows for
// ONE existing user. Storage objects are not created; media routes are not the
// target of these measurements.
//
// Usage: node scripts/seed-perf.mjs <account-email>

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import postgres from "postgres";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/seed-perf.mjs <account-email>");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const sql = postgres(env.DATABASE_URL, { max: 4 });

const BOOKS = 1000;
const CHAPTERS_PER_BOOK = 20;
const BOOKMARKS_PER_BOOK = 90;
const SESSIONS_PER_BOOK = 9;

const [user] = await sql`SELECT id FROM "user" WHERE lower(email) = ${email.toLowerCase()}`;
if (!user) {
  console.error(`No user with email ${email}. Register the account first.`);
  await sql.end();
  process.exit(1);
}
const userId = user.id;

const adjectives = [
  "Silent",
  "Golden",
  "Broken",
  "Hidden",
  "Last",
  "First",
  "Iron",
  "Silver",
  "Lost",
  "Wild",
];
const nouns = [
  "Empire",
  "Garden",
  "Voyage",
  "Winter",
  "Harbor",
  "Mountain",
  "Letter",
  "Promise",
  "River",
  "Crown",
];
const authors = Array.from({ length: 60 }, (_, index) => `Perf Author ${index + 1}`);

console.time("seed");
let bookmarkTotal = 0;
let sessionTotal = 0;

for (let batchStart = 0; batchStart < BOOKS; batchStart += 100) {
  const books = [];
  const media = [];
  const chapters = [];
  const states = [];
  const bookmarks = [];
  const sessions = [];

  for (let index = batchStart; index < Math.min(batchStart + 100, BOOKS); index += 1) {
    const bookId = randomUUID();
    const durationMs = 3_600_000 + (index % 240) * 60_000;
    const title = `${adjectives[index % 10]} ${nouns[Math.floor(index / 10) % 10]} ${index + 1}`;
    const createdAt = new Date(Date.now() - index * 3_600_000);
    books.push({
      id: bookId,
      owner_id: userId,
      title,
      author: authors[index % authors.length],
      series: index % 5 === 0 ? `Perf Series ${index % 40}` : null,
      status: "ready",
      created_at: createdAt,
      updated_at: createdAt,
    });
    media.push({
      book_id: bookId,
      original_filename: `${title}.mp3`,
      mime_type: "audio/mpeg",
      byte_size: 25_000_000 + index * 1_000,
      sha256: createHash("sha256").update(`perf-${bookId}`).digest("hex"),
      duration_ms: durationMs,
    });
    for (let position = 0; position < CHAPTERS_PER_BOOK; position += 1) {
      const startMs = Math.floor((durationMs / CHAPTERS_PER_BOOK) * position);
      const endMs = Math.floor((durationMs / CHAPTERS_PER_BOOK) * (position + 1));
      chapters.push({
        book_id: bookId,
        position,
        title: `Chapter ${position + 1}`,
        start_ms: startMs,
        end_ms: endMs,
      });
    }
    const positionMs = Math.floor(durationMs * ((index % 97) / 100));
    states.push({
      user_id: userId,
      book_id: bookId,
      position_ms: positionMs,
      playback_rate: "1.25",
      completed: index % 11 === 0,
      device_id: "perf-seed-device",
      device_sequence: index + 1,
      event_occurred_at: new Date(Date.now() - index * 60_000),
    });
    for (let b = 0; b < BOOKMARKS_PER_BOOK; b += 1) {
      bookmarks.push({
        user_id: userId,
        book_id: bookId,
        position_ms: Math.floor((durationMs / BOOKMARKS_PER_BOOK) * b),
        note: b % 7 === 0 ? `Note ${b} for ${title}` : null,
      });
    }
    for (let s = 0; s < SESSIONS_PER_BOOK; s += 1) {
      const started = new Date(Date.now() - (index * 9 + s) * 3_600_000);
      sessions.push({
        user_id: userId,
        book_id: bookId,
        started_at: started,
        ended_at: new Date(started.getTime() + 1_800_000),
        start_position_ms: s * 1_800_000,
        end_position_ms: (s + 1) * 1_800_000,
        listened_ms: 1_800_000,
      });
    }
    bookmarkTotal += BOOKMARKS_PER_BOOK;
    sessionTotal += SESSIONS_PER_BOOK;
  }

  await sql`INSERT INTO books ${sql(books)}`;
  await sql`INSERT INTO media_assets ${sql(media)}`;
  await sql`INSERT INTO chapters ${sql(chapters)}`;
  await sql`INSERT INTO playback_states ${sql(states)}`;
  for (let offset = 0; offset < bookmarks.length; offset += 3000) {
    await sql`INSERT INTO bookmarks ${sql(bookmarks.slice(offset, offset + 3000))}`;
  }
  await sql`INSERT INTO listening_sessions ${sql(sessions)}`;
  console.log(`seeded books ${batchStart + 1}..${batchStart + books.length}`);
}

console.timeEnd("seed");
console.log(
  `Totals: ${BOOKS} books, ${BOOKS * CHAPTERS_PER_BOOK} chapters, ${BOOKS} playback states, ${bookmarkTotal} bookmarks, ${sessionTotal} sessions`,
);
await sql.end();
