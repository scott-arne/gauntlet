import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { findCard, loadAllCards } from "../../src/cards/store";
import { ErrorLog } from "../../src/util/error-log";
import { gauntletPath } from "../../src/paths";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function cardMd(id: string, title: string, extraFields: string[] = []): string {
  const lines = [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "status: draft",
    ...extraFields,
    "---",
    "",
    "Body text.",
    "",
    "## Acceptance Criteria",
    "- Works",
    "",
  ];
  return lines.join("\n");
}

describe("findCard", () => {
  let projectRoot: string;
  let storiesDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-store-find-"));
    storiesDir = gauntletPath(projectRoot, "stories");
    mkdirSync(storiesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("fast path: <id>.md returns without scanning the directory", () => {
    // If the fast path is working, we can put a malformed card alongside
    // the target and findCard should STILL succeed — because it never
    // looked at the other file. If the scan were happening, the malformed
    // card would throw (parseStoryCard is unguarded at module scope).
    writeFileSync(join(storiesDir, "story-001.md"), cardMd("story-001", "Test"));
    writeFileSync(join(storiesDir, "broken.md"), "not frontmatter at all");

    const entry = findCard(projectRoot, "story-001");
    expect(entry).toBeDefined();
    expect(entry!.card.id).toBe("story-001");
    expect(entry!.filename).toBe("story-001.md");
  });

  test("fallback scan: resolves cards with non-<id> filenames", () => {
    // Fanout writes cards as `${parent}-${letter}.md`, so `story-001-a.md`
    // has id `story-001-a` but the filename doesn't match a direct hit
    // on `story-001-a.md`... actually it does. Let's make a true fallback:
    // the frontmatter id doesn't match the filename stem.
    writeFileSync(
      join(storiesDir, "legacy-filename.md"),
      cardMd("story-xyz", "Legacy card"),
    );

    const entry = findCard(projectRoot, "story-xyz");
    expect(entry).toBeDefined();
    expect(entry!.card.id).toBe("story-xyz");
    expect(entry!.filename).toBe("legacy-filename.md");
  });

  test("returns undefined when no card matches", () => {
    writeFileSync(join(storiesDir, "story-001.md"), cardMd("story-001", "Test"));
    expect(findCard(projectRoot, "story-999")).toBeUndefined();
  });

  test("returns undefined when stories dir doesn't exist", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "gauntlet-store-empty-"));
    try {
      expect(findCard(emptyRoot, "anything")).toBeUndefined();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test("direct-hit parse failure throws", () => {
    // Caller asked for `broken` specifically and we found broken.md —
    // silently skipping would be a lie. Throw.
    writeFileSync(join(storiesDir, "broken.md"), "not a valid card");
    expect(() => findCard(projectRoot, "broken")).toThrow();
  });

  test("direct-hit id mismatch falls through to scan", () => {
    // File at story-001.md has a mismatched frontmatter id. Someone
    // renamed the file without updating the id. Scan should still find
    // the real story-001 living elsewhere.
    writeFileSync(
      join(storiesDir, "story-001.md"),
      cardMd("wrong-id", "Mislabeled"),
    );
    writeFileSync(
      join(storiesDir, "correct.md"),
      cardMd("story-001", "Correct"),
    );

    const entry = findCard(projectRoot, "story-001");
    expect(entry).toBeDefined();
    expect(entry!.card.id).toBe("story-001");
    expect(entry!.filename).toBe("correct.md");
  });

  test("fallback scan: malformed sibling doesn't hide a valid match", () => {
    // Direct hit misses (no `target.md`), fallback engages. One file in
    // the scan is broken — it must be skipped, not propagate.
    writeFileSync(join(storiesDir, "broken.md"), "garbage");
    writeFileSync(
      join(storiesDir, "legacy.md"),
      cardMd("target", "Target card"),
    );

    const log = new ErrorLog();
    const entry = findCard(projectRoot, "target", log);
    expect(entry).toBeDefined();
    expect(entry!.card.id).toBe("target");
    expect(log.count()).toBe(1);
    expect(log.entries()[0].source).toBe("cards");
    expect(log.entries()[0].message).toContain("broken.md");
  });
});

describe("loadAllCards", () => {
  let projectRoot: string;
  let storiesDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-store-load-"));
    storiesDir = gauntletPath(projectRoot, "stories");
    mkdirSync(storiesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("returns all parseable cards sorted by filename", () => {
    writeFileSync(join(storiesDir, "b.md"), cardMd("b", "Bee"));
    writeFileSync(join(storiesDir, "a.md"), cardMd("a", "Ay"));
    writeFileSync(join(storiesDir, "c.md"), cardMd("c", "See"));

    const entries = loadAllCards(projectRoot);
    expect(entries.map((e) => e.filename)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("returns empty list when stories dir doesn't exist", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "gauntlet-store-none-"));
    try {
      expect(loadAllCards(emptyRoot)).toEqual([]);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test("skips malformed cards and logs to errorLog", () => {
    writeFileSync(join(storiesDir, "good.md"), cardMd("good", "Good"));
    writeFileSync(join(storiesDir, "broken.md"), "not a card at all");
    writeFileSync(join(storiesDir, "missing-title.md"), "---\nid: x\n---\n");

    const log = new ErrorLog();
    const entries = loadAllCards(projectRoot, log);
    expect(entries.map((e) => e.card.id)).toEqual(["good"]);
    expect(log.count()).toBe(2);
    const messages = log.entries().map((e) => e.message);
    expect(messages.some((m) => m.includes("broken.md"))).toBe(true);
    expect(messages.some((m) => m.includes("missing-title.md"))).toBe(true);
    for (const entry of log.entries()) {
      expect(entry.source).toBe("cards");
    }
  });

  test("works without errorLog (malformed cards just skipped)", () => {
    writeFileSync(join(storiesDir, "good.md"), cardMd("good", "Good"));
    writeFileSync(join(storiesDir, "broken.md"), "garbage");

    const entries = loadAllCards(projectRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].card.id).toBe("good");
  });

  test("ignores non-.md files", () => {
    writeFileSync(join(storiesDir, "a.md"), cardMd("a", "Ay"));
    writeFileSync(join(storiesDir, "notes.txt"), "scratch");
    writeFileSync(join(storiesDir, "README"), "docs");

    const entries = loadAllCards(projectRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe("a.md");
    // Sanity: the other files really are on disk
    expect(readdirSync(storiesDir).sort()).toEqual(["README", "a.md", "notes.txt"]);
  });
});
