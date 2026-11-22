import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

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
 * FR-WS-02 already scatters no docs directory: `scaffoldWorkspaceLayout`
 * creates `<workspace_root>/docs/` at registration (verified by
 * test/daemon/workspaces.test.ts), so this module assumes it may be
 * missing and answers honestly rather than creating it.
 *
 * THE INDEX IS A SCAN, NOT STATE (documented ruling). There is no watcher,
 * no index table, no daemon memory: `indexDocs` walks `<root>/docs` when it
 * is called, which is what "a scan at task-creation time" means. Nothing
 * to invalidate, nothing to go stale, no second source of truth.
 *
 * AC2 is served by TWO surfaces that share this one implementation:
 *   - `nova docs list [<workspace>]` prints the selectable list (the CLI
 *     read verb; the daemon op is `nova_docs_list`);
 *   - task creation accepts doc references (`--context docs/spec.md`) and
 *     resolves them to the workspace-relative `docs/...` paths that
 *     `tasks.context_files_json` already carries — the SAME injection path
 *     composePrompt reads (FR-TSK-04). There is deliberately no second
 *     injection mechanism: an indexed doc reaches a prompt only when a
 *     task names it.
 *
 * Path discipline: the scan never follows a symlink out of the docs tree
 * (a doc whose real path escapes `<root>/docs` is not advertised), and a
 * reference is only accepted when it names an INDEXED doc — so `../`,
 * absolute paths, and non-text extensions are all refused with an
 * actionable error.
 */

/** FR-WS-04 AC1's exact extension list. */
export const DOC_EXTENSIONS = [".md", ".txt", ".rst"] as const;

export type IndexedDoc = {
  /** Workspace-root-relative path, forward-slashed: `docs/spec.md`. */
  path: string;
  /** The doc's absolute path on this host. */
  absolute_path: string;
  extension: (typeof DOC_EXTENSIONS)[number];
  size_bytes: number;
};

/** A refusal naming the offending reference (never a silent skip). */
export class DocReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocReferenceError";
  }
}

function isDocExtension(name: string): name is `${string}${(typeof DOC_EXTENSIONS)[number]}` {
  return (DOC_EXTENSIONS as readonly string[]).includes(extname(name));
}

function docsRoot(rootPath: string): string {
  return join(resolve(rootPath), "docs");
}

/**
 * Walk `<workspace_root>/docs` and return every `.md`/`.txt`/`.rst` file, in
 * a deterministic order (sorted by relative path). A missing or unreadable
 * docs directory is an honest empty list.
 */
export function indexDocs(rootPath: string): IndexedDoc[] {
  const base = docsRoot(rootPath);
  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    return []; // no docs dir (or unreadable): an honest empty index
  }

  type Found = { rel: string; abs: string; size: number };
  const found: Found[] = [];

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // an unreadable subtree contributes nothing (never-crash)
    }
    for (const name of names) {
      const abs = join(dir, name);
      let real: string;
      let stat;
      try {
        real = realpathSync(abs);
        stat = statSync(abs);
      } catch {
        continue; // a dangling symlink or a race: skip it
      }
      // containment: a symlink whose real path leaves the docs tree is not
      // an indexed document (the index never advertises an escape)
      if (real !== realBase && !real.startsWith(realBase + sep)) continue;
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!isDocExtension(name)) continue;
      const rel = relative(resolve(rootPath), abs).split(sep).join("/");
      found.push({ rel, abs, size: stat.size });
    }
  };
  walk(base);

  found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return found.map((f) => {
    const ext = extname(f.abs) as (typeof DOC_EXTENSIONS)[number];
    return { path: f.rel, absolute_path: f.abs, extension: ext, size_bytes: f.size };
  });
}

export type ResolvedDocReferences = {
  /**
   * The workspace-root-relative paths written to `tasks.context_files_json`
   * — exactly the `docs/...` spelling composePrompt resolves under the
   * workspace root (never absolute paths: data.md keeps run state portable).
   */
  contextFiles: string[];
  /** The indexed docs the references resolved to, in reference order. */
  docs: IndexedDoc[];
};

/**
 * FR-WS-04 AC2: resolve operator-written doc references to context files.
 *
 * Accepted spellings (all workspace-relative to the docs index):
 *   `docs/spec.md` · `spec.md` · `./docs/spec.md` · `guides/how.md`
 * Everything else — a missing doc, a non-indexed extension, or any path
 * that leaves the docs tree — throws `DocReferenceError` naming the
 * reference; the error also lists the available documents so the operator
 * can correct the call in one step (NFR-US-03).
 */
export function resolveDocReferences(rootPath: string, refs: readonly string[]): ResolvedDocReferences {
  if (refs.length === 0) return { contextFiles: [], docs: [] };
  const index = indexDocs(rootPath);
  const ctx: string[] = [];
  const docs: IndexedDoc[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    // normalize the accepted spellings to the index's `docs/...` form
    const normalized = (() => {
      if (ref === "") return "";
      const stripped = ref.replace(/^\.\//, "");
      if (stripped.startsWith("docs/")) return stripped;
      if (stripped.startsWith("/") || stripped.split("/").includes("..")) return stripped; // refused below
      return `docs/${stripped}`;
    })();
    const doc = index.find((d) => d.path === normalized);
    if (doc === undefined) {
      const looksNonText = extname(ref) !== "" && !(DOC_EXTENSIONS as readonly string[]).includes(extname(ref));
      const reason = looksNonText
        ? `only ${DOC_EXTENSIONS.join(", ")} files are indexed from <workspace_root>/docs (FR-WS-04)`
        : `no indexed document at "${normalized}" under <workspace_root>/docs`;
      const available = index.length === 0 ? "(the docs directory is empty)" : index.map((d) => d.path).join(", ");
      throw new DocReferenceError(
        `doc reference "${ref}" cannot be injected: ${reason}. Available: ${available}`,
      );
    }
    if (!ctx.includes(doc.path)) {
      ctx.push(doc.path);
      docs.push(doc);
    }
  }
  return { contextFiles: ctx, docs };
}

/** True when the workspace root actually has a docs directory. */
export function hasDocsDir(rootPath: string): boolean {
  return existsSync(docsRoot(rootPath));
}
