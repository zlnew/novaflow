/**
 * A strict, hand-rolled YAML subset parser for chain graph imports
 * (FR-PRJ-04: "JSON or YAML"; data.md §4.3 names the file chain.yaml).
 * NO dependencies, by the repo rule.
 *
 * THE SUBSET (documented — this parser accepts exactly this and
 * REFUSES everything else with a line-numbered error; it never
 * guesses):
 *
 *   - one document, a top-level BLOCK MAP at indent 0;
 *   - block maps: `key: value` and `key:` followed by a nested block;
 *     keys are plain identifiers ([A-Za-z0-9_.-]+), never quoted;
 *   - block sequences: `- scalar` and `- key: value …` items (the
 *     item's further keys align at the dash column + 2); a sequence
 *     may sit at its key's indent or 2 deeper;
 *   - indentation is spaces only, exactly 2 per nesting step (odd or
 *     stray depths refuse); tabs refuse anywhere; CRLF tolerated;
 *   - scalars: plain (typed: true/false, integers, floats — anything
 *     else stays a string), single-quoted ('' escapes a quote), and
 *     double-quoted (escapes \n \t \r \" \\);
 *   - comments: `# …` full-line, or trailing after whitespace — never
 *     inside a quoted scalar; blank lines anywhere.
 *
 * NOT in the subset (each refuses with its line number): flow syntax
 * `{}`/`[]`, anchors `&`, aliases `*`, tags `!`, multi-line strings `|`
 * and `>`, document separators `---`/`...`, duplicate keys, null
 * literals (`~`/`null` — quote a string if a string is meant), and any
 * line shape the grammar above does not cover.
 */

/** A parse failure carrying the 1-based line number. */
export class YamlParseError extends Error {
  constructor(readonly line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = "YamlParseError";
  }
}

type Line = { indent: number; text: string; lineNo: number };

function fail(lineNo: number, message: string): never {
  throw new YamlParseError(lineNo, message);
}

/* ------------------------------ line intake ------------------------------ */

/**
 * The comment end of a text fragment: the first `#` outside quotes
 * that starts the fragment or follows a space. Quoted regions are
 * respected ('' and \" escapes included); null when no comment exists.
 */
function findCommentEnd(text: string): number | null {
  let i = 0;
  let state: "plain" | "single" | "double" = "plain";
  while (i < text.length) {
    const ch = text[i]!;
    if (state === "plain") {
      if (ch === "'" || ch === '"') {
        state = ch === "'" ? "single" : "double";
        i += 1;
      } else if (ch === "#" && (i === 0 || text[i - 1] === " ")) {
        return i;
      } else {
        i += 1;
      }
    } else if (state === "single") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 2; // '' is an escaped quote inside a single-quoted scalar
        } else {
          state = "plain";
          i += 1;
        }
      } else {
        i += 1;
      }
    } else {
      if (ch === "\\") {
        i += 2;
      } else if (ch === '"') {
        state = "plain";
        i += 1;
      } else {
        i += 1;
      }
    }
  }
  return null;
}

function intake(text: string): Line[] {
  const lines: Line[] = [];
  const rawLines = text.split("\n");
  for (let idx = 0; idx < rawLines.length; idx++) {
    let raw = rawLines[idx]!;
    if (raw.endsWith("\r")) raw = raw.slice(0, -1); // CRLF tolerated
    if (raw.includes("\t")) {
      fail(idx + 1, "tabs are not part of the YAML subset — indent with spaces");
    }
    // whitespace-only lines are blank lines (review fix: trailing editor
    // spaces must not trip the indent-parity check on a visually empty line)
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) {
      fail(idx + 1, `unsupported indentation of ${indent} spaces — the subset nests by exactly 2`);
    }
    let content = raw.slice(indent);
    if (content.startsWith("#")) continue; // full-line comment
    const cut = findCommentEnd(content);
    if (cut !== null) content = content.slice(0, cut);
    content = content.replace(/\s+$/, "");
    if (content === "") continue; // blank (or comment-only) line
    if (content === "---" || content === "...") {
      fail(idx + 1, "document separators are not part of the subset — one document per file");
    }
    lines.push({ indent, text: content, lineNo: idx + 1 });
  }
  return lines;
}

/* ------------------------------- scalars --------------------------------- */

const PLAIN_INT = /^-?\d+$/;
const PLAIN_FLOAT = /^-?\d+\.\d+$/;

function isListItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function parseScalar(text: string, lineNo: number): unknown {
  if (text === "") fail(lineNo, "empty value");
  const head = text[0]!;
  if (head === "{") fail(lineNo, "flow maps ({…}) are not part of the subset — use block maps");
  if (head === "[") fail(lineNo, "flow lists ([…]) are not part of the subset — use block lists");
  if (head === "&") fail(lineNo, "anchors (&) are not part of the subset");
  if (head === "*") fail(lineNo, "aliases (*) are not part of the subset");
  if (head === "!") fail(lineNo, "tags (!) are not part of the subset");
  if (head === "|") fail(lineNo, "block scalars (|) — multi-line strings — are not part of the subset; quote a single line");
  if (head === ">") fail(lineNo, "folded scalars (>) — multi-line strings — are not part of the subset; quote a single line");
  if (head === "@" || head === "`") fail(lineNo, `"${head}" is a reserved character in YAML and not part of the subset`);
  // reserved indicators (review fix): a plain scalar beginning with these is
  // ambiguous YAML (nested lists, complex keys, directives, flow separators)
  // — refuse rather than import a value literally named "- x" (allow -<digits>)
  if ((head === "-" && !PLAIN_INT.test(text)) || head === "?" || head === "%" || head === ",") {
    fail(
      lineNo,
      `a plain scalar may not begin with "${head}" (reserved YAML indicator) — quote the value if a string is meant`,
    );
  }
  if (text === "~" || text === "null") {
    fail(lineNo, "the subset defines no null literal — write an explicit quoted string if a string is meant");
  }
  if (head === "'") return parseSingleQuoted(text, lineNo);
  if (head === '"') return parseDoubleQuoted(text, lineNo);
  if (text.includes(": ")) {
    fail(lineNo, `a plain scalar cannot contain ": " — quote the value: ${JSON.stringify(text)}`);
  }
  // plain scalar typing (documented): lowercase booleans, base-10
  // integers and decimal floats become JSON types; everything else —
  // including "True", "1.0.0", "null"-like words — stays a string
  if (text === "true") return true;
  if (text === "false") return false;
  if (PLAIN_INT.test(text)) return Number(text);
  if (PLAIN_FLOAT.test(text)) return Number(text);
  return text;
}

function parseSingleQuoted(text: string, lineNo: number): string {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= text.length) {
      fail(lineNo, "unterminated single-quoted scalar — multi-line strings are not part of the subset");
    }
    const ch = text[i]!;
    if (ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      const tail = text.slice(i + 1);
      if (tail !== "") fail(lineNo, `unexpected content after the closing quote: ${JSON.stringify(tail)}`);
      return out;
    }
    out += ch;
    i += 1;
  }
}

const DOUBLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

function parseDoubleQuoted(text: string, lineNo: number): string {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= text.length) {
      fail(lineNo, "unterminated double-quoted scalar — multi-line strings are not part of the subset");
    }
    const ch = text[i]!;
    if (ch === "\\") {
      const esc = text[i + 1];
      if (esc === undefined || DOUBLE_ESCAPES[esc] === undefined) {
        fail(lineNo, `unsupported escape \\${esc ?? ""} — the subset allows \\n \\t \\r \\" \\\\`);
      }
      out += DOUBLE_ESCAPES[esc]!;
      i += 2;
      continue;
    }
    if (ch === '"') {
      const tail = text.slice(i + 1);
      if (tail !== "") fail(lineNo, `unexpected content after the closing quote: ${JSON.stringify(tail)}`);
      return out;
    }
    out += ch;
    i += 1;
  }
}

/* ------------------------------ key lines -------------------------------- */

const KEY_CHARS = /^[A-Za-z0-9_.-]+$/;

/**
 * Split a `key: value` line (or `key:` with an empty value). The colon
 * must be followed by a space or end-of-line (YAML's rule — `a:b` is a
 * plain scalar, not a mapping). Returns null when no such colon exists.
 */
function matchKeyLine(text: string): { key: string; value: string } | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ":") continue;
    if (i + 1 !== text.length && text[i + 1] !== " ") continue;
    const key = text.slice(0, i);
    if (!KEY_CHARS.test(key)) return null;
    const value = i + 1 === text.length ? "" : text.slice(i + 2).replace(/\s+$/, "");
    return { key, value };
  }
  return null;
}

/* ------------------------------ the grammar ------------------------------ */

function parseMapAt(
  lines: Line[],
  i: number,
  indent: number,
): { map: Record<string, unknown>; next: number } {
  const map: Record<string, unknown> = {};
  let idx = i;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      fail(line.lineNo, `unsupported indentation of ${line.indent} spaces — expected ${indent} for this block`);
    }
    if (isListItem(line.text)) break;
    const pair = matchKeyLine(line.text);
    if (pair === null) {
      fail(line.lineNo, `expected "key: value", got ${JSON.stringify(line.text)}`);
    }
    if (pair.key in map) {
      fail(line.lineNo, `duplicate key "${pair.key}" — the subset refuses silently-overwritten maps`);
    }
    if (pair.value !== "") {
      map[pair.key] = parseScalar(pair.value, line.lineNo);
      idx += 1;
      continue;
    }
    // empty value: a nested block (indent + 2) or a same-indent list
    const next = lines[idx + 1];
    if (next === undefined) {
      fail(line.lineNo, `key "${pair.key}" has no value and no nested block`);
    }
    if (next.indent === indent) {
      if (!isListItem(next.text)) {
        fail(line.lineNo, `key "${pair.key}" has no value and no nested block`);
      }
      const list = parseListAt(lines, idx + 1, indent);
      map[pair.key] = list.items;
      idx = list.next;
      continue;
    }
    if (next.indent === indent + 2) {
      if (isListItem(next.text)) {
        const list = parseListAt(lines, idx + 1, indent + 2);
        map[pair.key] = list.items;
        idx = list.next;
      } else {
        const nested = parseMapAt(lines, idx + 1, indent + 2);
        map[pair.key] = nested.map;
        idx = nested.next;
      }
      continue;
    }
    fail(next.lineNo, `unsupported indentation of ${next.indent} spaces — the subset nests by exactly 2`);
  }
  return { map, next: idx };
}

function parseListAt(
  lines: Line[],
  i: number,
  indent: number,
): { items: unknown[]; next: number } {
  const items: unknown[] = [];
  let idx = i;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (line.indent !== indent || !isListItem(line.text)) break;
    if (line.text === "-") {
      // bare dash: the item is a nested block two steps deeper
      const next = lines[idx + 1];
      if (next === undefined || next.indent !== indent + 2) {
        fail(line.lineNo, "a bare '-' item requires a nested block indented 2 more spaces");
      }
      if (isListItem(next.text)) {
        const list = parseListAt(lines, idx + 1, indent + 2);
        items.push(list.items);
        idx = list.next;
      } else {
        const nested = parseMapAt(lines, idx + 1, indent + 2);
        items.push(nested.map);
        idx = nested.next;
      }
      continue;
    }
    const content = line.text.slice(2);
    if (matchKeyLine(content) !== null) {
      // map item: rewrite the dash line as its content at the content
      // column (dash + 2) and parse the map from there — the array is
      // parser-local, so the one-entry rewrite is safe
      lines[idx] = { indent: indent + 2, text: content, lineNo: line.lineNo };
      const nested = parseMapAt(lines, idx, indent + 2);
      items.push(nested.map);
      idx = nested.next;
      continue;
    }
    items.push(parseScalar(content, line.lineNo));
    idx += 1;
  }
  if (idx < lines.length && lines[idx]!.indent === indent && !isListItem(lines[idx]!.text)) {
    fail(lines[idx]!.lineNo, `a map key appears where a list item is expected: ${JSON.stringify(lines[idx]!.text)}`);
  }
  return { items, next: idx };
}

/**
 * Parse YAML-subset text into a JSON-compatible value. Throws
 * YamlParseError (with the 1-based line) for anything outside the
 * documented subset — never a guess, never a silent fallback.
 */
export function parseYaml(text: string): unknown {
  const kept = intake(text);
  if (kept.length === 0) fail(1, "the document is empty");
  if (kept[0]!.indent !== 0) {
    fail(kept[0]!.lineNo, "the document root must start at indent 0");
  }
  if (isListItem(kept[0]!.text)) {
    fail(kept[0]!.lineNo, "the document root must be a map, not a list");
  }
  const root = parseMapAt(kept, 0, 0);
  if (root.next < kept.length) {
    const leftover = kept[root.next]!;
    fail(leftover.lineNo, `unexpected content outside the document root: ${JSON.stringify(leftover.text)}`);
  }
  return root.map;
}
