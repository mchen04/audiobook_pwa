import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The sync unit is the book aggregate (`docs/local-first.md` section 3).
 *
 * `chapters`, `book_tags` and `collection_books` carry no `updatedAt` of their
 * own, so a mutation that touches one of them and does not bump its parent is a
 * change no other device can ever observe. It is silent: the route returns 200,
 * the local UI updates, and the write simply never propagates.
 *
 * This is a source-level guard because the failure is an *absence*, and an
 * absence has no runtime behaviour to assert. It is the same technique
 * `service-worker-shell.test.ts` uses on `public/sw.js`.
 */

const API_ROOT = join(process.cwd(), "src/app/api");

const PARENT_OF: Record<string, string> = {
  chapters: "books",
  bookTags: "books",
  collectionBooks: "collections",
};

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

const ROUTES = routeFiles(API_ROOT).map((path) => ({
  path,
  name: path.slice(API_ROOT.length + 1),
  source: readFileSync(path, "utf8"),
}));

function writesChild(source: string, child: string): boolean {
  return new RegExp(`\\.(insert|delete)\\(\\s*${child}\\s*\\)`).test(source);
}

function bumpsParent(source: string, parent: string): boolean {
  // `.update(parent)` ... `updatedAt:` within the same chained statement.
  return new RegExp(`\\.update\\(\\s*${parent}\\s*\\)[\\s\\S]{0,400}?updatedAt:`).test(source);
}

describe("every mutation route bumps its parent aggregate", () => {
  it("finds the mutation routes at all", () => {
    expect(ROUTES.length).toBeGreaterThan(5);
    expect(ROUTES.map((route) => route.name)).toContain("collections/[collectionId]/route.ts");
  });

  it.each(Object.entries(PARENT_OF))(
    "requires a %s write to bump its %s parent",
    (child, parent) => {
      const offenders = ROUTES.filter(
        (route) =>
          writesChild(route.source, child) &&
          // A route that creates the parent in the same request has nothing to
          // bump — the row is new and its `updatedAt` defaults to now.
          !new RegExp(`\\.insert\\(\\s*${parent}\\s*\\)`).test(route.source) &&
          !bumpsParent(route.source, parent),
      );
      expect(offenders.map((route) => route.name)).toStrictEqual([]);
    },
  );

  it("bumps the collection when membership changes, not only when it is renamed", () => {
    const source = ROUTES.find(
      (route) => route.name === "collections/[collectionId]/route.ts",
    )!.source;
    const guard = source.match(/if \(([^)]*)\) \{\s*await transaction\s*\.update\(collections\)/);
    expect(guard, "the collection bump must be guarded").not.toBe(null);
    // Gating the bump on `name` alone is exactly the bug: adding or removing a
    // book would leave `collections.updatedAt` untouched.
    expect(guard![1]).toContain("bookId !== undefined");
  });

  it("keeps the book bump on a metadata or tag edit", () => {
    const source = ROUTES.find((route) => route.name === "books/[bookId]/route.ts")!.source;
    expect(bumpsParent(source, "books")).toBe(true);
  });
});

describe("deletions leave a durable tombstone", () => {
  it("writes the tombstone in the same transaction as the book delete", () => {
    const source = ROUTES.find((route) => route.name === "books/[bookId]/route.ts")!.source;
    const block = source.match(
      /await db\.transaction\(async \(transaction\) => \{[\s\S]*?\n {2}\}\);/g,
    );
    const deleting = block?.find((chunk) => /\.delete\(books\)/.test(chunk));
    expect(deleting, "the delete must run in a transaction").toBeDefined();
    expect(deleting!).toMatch(/\.insert\(bookTombstones\)/);
  });

  it("answers a replayed delete from the tombstone instead of 404", () => {
    const source = ROUTES.find((route) => route.name === "books/[bookId]/route.ts")!.source;
    expect(source).toMatch(/bookTombstones[\s\S]*?alreadyDeleted/);
  });
});
