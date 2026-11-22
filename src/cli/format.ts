/**
 * Human-surface formatters (the non---json output). `--json` output is
 * the op's data envelope, single-line JSON on stdout — one rule for
 * every command (documented per command in the command modules).
 */

export type TableColumn = {
  key: string;
  header: string;
};

/** Aligned text table: header row, no rule line, one row per record. */
export function renderTable(rows: Array<Record<string, unknown>>, columns: TableColumn[]): string {
  const cell = (row: Record<string, unknown>, key: string): string => {
    const v = row[key];
    return v === null || v === undefined ? "" : String(v);
  };
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => cell(r, c.key).length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join(" ").trimEnd();
  const out = [line(columns.map((c) => c.header))];
  for (const row of rows) out.push(line(columns.map((c) => cell(row, c.key))));
  return out.join("\n");
}

/** `key: value` lines — record-shaped output (status, daemon state). */
export function renderKv(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${k}: ${v}`).join("\n");
}
