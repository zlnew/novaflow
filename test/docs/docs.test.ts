import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOC_EXTENSIONS,
  indexDocs,
  resolveDocReferences,
  DocReferenceError,
} from "../../src/docs.ts";

/**
 * FR-WS-04 (srs, Should Have), quoted verbatim:
 *
 *   "Knowledge Document Indexing — The system shall index text/markdown
 *    files placed in the `docs/` directory for task prompt context
 *    injection.
 *    1. Parses `.md`, `.txt`, `.rst` files in `<workspace_root>/docs/`.
 *    2. Exposes indexed documents as selectable prompt injection options
 *       in task definitions."
 *
 * The scan happens at task-creation time — no watcher, no daemon state
 * (the "index" is the directory listing, computed when asked). AC2 is
 * served by `nova docs list` (the selectable list) plus task creation
 * accepting `docs/<name>` references that resolve to the SAME
 * `tasks.context_files_json` machinery the rest of the engine injects
 * through — never a second injection path (FR-TSK-04's one source).
 */

const EXT = DOC_EXTENSIONS;

test("DOC_EXTENSIONS is exactly .md/.txt/.rst (the FR's list, nothing more)", () => {
  assert.deepEqual([...EXT], [".md", ".txt", ".rst"]);
});

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "novaflow-docs-"));
}

test("indexDocs parses .md/.txt/.rst under <root>/docs and skips every other extension", () => {
  const root = fresh();
  try {
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "spec.md"), "# Spec\n");
    writeFileSync(join(docs, "notes.txt"), "notes\n");
    writeFileSync(join(docs, "guide.rst"), "Guide\n=====\n");
    writeFileSync(join(docs, "image.png"), "not text\n");
    writeFileSync(join(docs, "data.json"), "{}\n");
    writeFileSync(join(docs, "README"), "no extension\n");
    writeFileSync(join(docs, "UP.MD"), "shouty\n"); // case-sensitive: not .md

    const index = indexDocs(root);
    assert.deepEqual(
      index.map((d) => d.path).sort(),
      ["docs/guide.rst", "docs/notes.txt", "docs/spec.md"].sort(),
      "exactly the three indexed extensions",
    );
    const spec = index.find((d) => d.path === "docs/spec.md")!;
    assert.equal(spec.absolute_path, join(root, "docs", "spec.md"));
    assert.equal(spec.extension, ".md");
    assert.equal(spec.size_bytes, Buffer.byteLength("# Spec\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexDocs is deterministic and sorted; nested docs are included with their relative path", () => {
  const root = fresh();
  try {
    const docs = join(root, "docs");
    mkdirSync(join(docs, "guides"), { recursive: true });
    writeFileSync(join(docs, "z.md"), "z\n");
    writeFileSync(join(docs, "a.md"), "a\n");
    writeFileSync(join(docs, "guides", "b.txt"), "b\n");
    const first = indexDocs(root).map((d) => d.path);
    const second = indexDocs(root).map((d) => d.path);
    assert.deepEqual(first, second, "a scan is stable across calls");
    assert.deepEqual(first, ["docs/a.md", "docs/guides/b.txt", "docs/z.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing docs directory is an honest empty list, never an error or a throw", () => {
  const root = fresh();
  try {
    assert.deepEqual(indexDocs(root), []);
    // and the empty shape is the SAME shape a real scan returns
    mkdirSync(join(root, "docs"));
    assert.deepEqual(indexDocs(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable docs directory is an honest empty list too (never-crash, the list just cannot see it)", () => {
  const root = fresh();
  try {
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "a.md"), "a\n");
    // simulate an unreadable listing by removing the directory under the walk
    const index = indexDocs(root);
    assert.equal(index.length, 1);
    rmSync(docs, { recursive: true, force: true });
    assert.deepEqual(indexDocs(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked doc that escapes the docs tree is NOT indexed (the index never advertises an escape)", () => {
  const root = fresh();
  try {
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(root, "secret.md"), "top secret\n");
    symlinkSync(join(root, "secret.md"), join(docs, "leak.md"));
    writeFileSync(join(docs, "real.md"), "real\n");
    const index = indexDocs(root);
    assert.deepEqual(index.map((d) => d.path), ["docs/real.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDocReferences maps docs/<name> to the SAME context-file form the engine injects", () => {
  const root = fresh();
  try {
    const docs = join(root, "docs");
    mkdirSync(join(docs, "guides"), { recursive: true });
    writeFileSync(join(docs, "spec.md"), "# Spec\n");
    writeFileSync(join(docs, "guides", "how.md"), "how\n");

    // the FR-WS-04 accept forms: docs/-prefixed, bare name, "./" spelling
    const out = resolveDocReferences(root, ["docs/spec.md", "guides/how.md", "./docs/spec.md"]);
    assert.deepEqual(out.contextFiles, ["docs/spec.md", "docs/guides/how.md"]);
    assert.deepEqual(
      out.docs.map((d) => d.path),
      ["docs/spec.md", "docs/guides/how.md"],
      "each resolved reference reports the indexed doc it came from",
    );
    // duplicates collapse (a repeated reference is one injection)
    const dup = resolveDocReferences(root, ["docs/spec.md", "docs/spec.md"]);
    assert.deepEqual(dup.contextFiles, ["docs/spec.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDocReferences refuses a reference outside the docs index, naming it (no traversal)", () => {
  const root = fresh();
  try {
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "spec.md"), "# Spec\n");
    writeFileSync(join(root, "outside.md"), "nope\n");

    const cases = ["docs/missing.md", "outside.md", "docs/../outside.md", "../../etc/passwd", "/etc/passwd"];
    for (const ref of cases) {
      assert.throws(
        () => resolveDocReferences(root, [ref]),
        (err: unknown) => {
          assert.ok(err instanceof DocReferenceError, `${ref} → DocReferenceError`);
          assert.match(err.message, new RegExp(escapeRe(ref)), "the refusal names the reference");
          return true;
        },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDocReferences reports the available documents when a reference misses (an actionable error)", () => {
  const root = fresh();
  try {
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "spec.md"), "# Spec\n");
    try {
      resolveDocReferences(root, ["docs/nope.md"]);
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(err instanceof DocReferenceError);
      assert.match(err.message, /docs\/spec\.md/, "the error lists what IS available");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-.md/.txt/.rst file in docs is refused as a reference (the index's filter is the contract)", () => {
  const root = fresh();
  try {
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "sheet.csv"), "a,b\n");
    assert.throws(
      () => resolveDocReferences(root, ["docs/sheet.csv"]),
      (err: unknown) => {
        assert.ok(err instanceof DocReferenceError);
        assert.match(err.message, /\.md.*\.txt.*\.rst/s, "the refusal names the accepted extensions");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
