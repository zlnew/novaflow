/**
 * Human-mode rendering helpers (`novaflow-v100/cli` §2.1).
 *
 * Tables and detail blocks only; no banners, spinners, or colour, so the same
 * bytes are usable in logs and pipes.
 */

/** Renders an aligned table, always ending with a newline. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return `${[render(headers), ...rows.map(render)].join('\n')}\n`;
}

/** Renders `key: value` lines aligned on the colon. */
export function detail(pairs: readonly (readonly [string, string | null | undefined])[]): string {
  const width = Math.max(0, ...pairs.map(([key]) => key.length));
  const lines = pairs.map(([key, value]) => `${`${key}:`.padEnd(width + 2)}${value ?? ''}`.trimEnd());
  return `${lines.join('\n')}\n`;
}

/** Shortens a free-text field for a table cell. */
export function snippet(value: string, max = 48): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

/** Human label for a boolean capability column. */
export function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** Human label for a nullable scalar. */
export function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

/** Counts line used by status boards and workspace detail. */
export function countsLine(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');
}

/**
 * The documented status buckets, without the internal `total` counter
 * (`novaflow-v100/cli` §3.5 pins the exact key set).
 */
export function bucket<T extends object>(counts: T): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (key !== 'total' && typeof value === 'number') result[key] = value;
  }
  return result;
}
