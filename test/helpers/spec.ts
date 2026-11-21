import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Spec-set access for golden tests. The frozen spec set is truth
 * (novaflow-v1, pinned manifest). Override its location with
 * NOVAFLOW_SPEC_DIR; default is the workspace path on this machine.
 */
export const SPEC_DIR =
  process.env["NOVAFLOW_SPEC_DIR"] ??
  "/home/nova/www/personal/odd/specs/novaflow-v1";

export function specFile(name: string): string {
  const p = join(SPEC_DIR, name);
  if (!existsSync(p)) {
    throw new Error(
      `spec file not found: ${p} — set NOVAFLOW_SPEC_DIR to the novaflow-v1 spec set`,
    );
  }
  return readFileSync(p, "utf8");
}

/** The first (and normative) ```sql block in data.md — the executable DDL. */
export function extractDdl(): string {
  const m = specFile("data.md").match(/```sql\n([\s\S]*?)```/);
  if (!m || !m[1]) throw new Error("no ```sql block found in data.md");
  return m[1].trimEnd() + "\n";
}

/** The §4.2 profile.json JSON Schema block, parsed live from data.md. */
export function extractProfileSchema(): Record<string, unknown> {
  const text = specFile("data.md");
  const start = text.indexOf(
    "### 4.2 Agent Profile Configuration Schema (profile.json)",
  );
  if (start < 0) {
    throw new Error("profile schema section (§4.2) not found in data.md");
  }
  const m = text.slice(start).match(/```json\n([\s\S]*?)```/);
  if (!m || !m[1]) {
    throw new Error("no ```json block found in data.md §4.2");
  }
  return JSON.parse(m[1]) as Record<string, unknown>;
}

const CANONICAL_STATES = [
  "draft",
  "queued",
  "running",
  "awaiting_gate",
  "validating",
  "completed",
  "changes_requested",
  "failed",
  "cancelled",
] as const;

export type CanonicalState = (typeof CANONICAL_STATES)[number];

export const canonicalStates: readonly string[] = CANONICAL_STATES;

export type MatrixRow = {
  state: CanonicalState;
  trigger: string;
  target: CanonicalState;
  gate: string;
};

/** The 8.1 transition matrix table rows, parsed live from architecture.md. */
export function extractMatrix(): MatrixRow[] {
  const text = specFile("architecture.md");
  const start = text.indexOf("| current state | trigger condition | target state | validation gate |");
  const end = text.indexOf("Fallback label mapping", start);
  if (start < 0 || end < 0) throw new Error("matrix table not found in architecture.md");
  const rows: MatrixRow[] = [];
  for (const line of text.slice(start, end).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length !== 6) continue; // header + separator + table rows have 4 cells
    const [state, trigger, target, gate] = [cells[1], cells[2], cells[3], cells[4]];
    if (!canonicalStates.includes(state)) continue;
    if (!canonicalStates.includes(target)) {
      throw new Error(`non-canonical target state in matrix row: ${target}`);
    }
    rows.push({
      state: state as CanonicalState,
      trigger,
      target: target as CanonicalState,
      gate,
    });
  }
  return rows;
}

/** The fallback-label table: prose label -> canonical storage rule (verbatim prose). */
export function extractFallbackMap(): Record<string, string> {
  const text = specFile("architecture.md");
  const start = text.indexOf("| prose label | canonical storage |");
  const end = text.indexOf("\n\n", start);
  if (start < 0) throw new Error("fallback label table not found in architecture.md");
  const map: Record<string, string> = {};
  for (const line of text.slice(start, end < 0 ? undefined : end).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length !== 4) continue;
    const [label, canonical] = [cells[1], cells[2]];
    if (label === "prose label" || label.startsWith("---")) continue;
    if (!label) continue;
    map[label] = canonical;
  }
  return map;
}
