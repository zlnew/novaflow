/**
 * The ONE legal transition matrix, generated verbatim from
 * novaflow-v1/architecture 8.1 (24 rows) plus the fallback-label mapping.
 * Golden tests re-parse the spec and fail the build on any drift —
 * never edit the strings here; edit the spec (and re-pin) instead.
 */
export type CanonicalState =
  | "draft" | "queued" | "running" | "awaiting_gate"
  | "validating" | "completed" | "changes_requested" | "failed" | "cancelled";

export const CANONICAL_STATES: readonly CanonicalState[] = ["draft","queued","running","awaiting_gate","validating","completed","changes_requested","failed","cancelled"];

export type MatrixRow = {
  state: CanonicalState;
  trigger: string;
  target: CanonicalState;
  gate: string;
};

export const ROWS: readonly MatrixRow[] = [
  { state: "draft", trigger: `operator/agent enqueues (CLI \`task run\`, MCP \`nova_task_run\`)`, target: "queued", gate: `profile assigned and resolvable` },
  { state: "queued", trigger: `scheduler slot allocated`, target: "running", gate: `concurrency semaphore passed (FR-SCH-02)` },
  { state: "queued", trigger: `operator abort before start`, target: "cancelled", gate: `requested by operator surface` },
  { state: "running", trigger: `\`requires_human_gate: true\`, OR agent emitted \`status: blocked\`, AND agent settled with artifact present`, target: "awaiting_gate", gate: `artifact passes the task's output schema` },
  { state: "running", trigger: `agent_settled with artifact present (no gate required)`, target: "validating", gate: `artifact present` },
  { state: "running", trigger: `agent settled with artifact missing or schema-invalid, repair budget remains`, target: "running", gate: `new run spawned with \`attempt_kind='repair'\`; maximum 1 repair per run (FR-TSK-06)` },
  { state: "running", trigger: `subprocess error, invalid JSON, budget or timeout kill`, target: "failed", gate: `run outcome recorded (failed/timed_out/crashed)` },
  { state: "running", trigger: `operator abort (abort_bash -> SIGTERM -> SIGKILL)`, target: "cancelled", gate: `requested by operator surface` },
  { state: "awaiting_gate", trigger: `operator approves gate`, target: "validating", gate: `approval record verified (gate approval contract below)` },
  { state: "awaiting_gate", trigger: `operator rejects with feedback`, target: "changes_requested", gate: `retry budget checked` },
  { state: "awaiting_gate", trigger: `operator confirms failure (terminal gate outcome)`, target: "failed", gate: `requested by operator surface; retry budget treated as exhausted` },
  { state: "awaiting_gate", trigger: `operator abort`, target: "cancelled", gate: `requested by operator surface` },
  { state: "validating", trigger: `output schema valid AND engine verification passed`, target: "completed", gate: `schema + verification rules passed` },
  { state: "validating", trigger: `engine verification failed, retry budget remains`, target: "changes_requested", gate: `retry_count < max_retries` },
  { state: "validating", trigger: `retries exhausted or hard schema failure`, target: "failed", gate: `retry budget exhausted` },
  { state: "validating", trigger: `operator abort`, target: "cancelled", gate: `requested by operator surface` },
  { state: "completed", trigger: `named as the target of an emitter's \`on_changes_requested\` edge (review path, feedback routing rule below)`, target: "changes_requested", gate: `retry_count < max_retries; \`retry_count\` increments on this transition` },
  { state: "changes_requested", trigger: `feedback artifact delivered to next attempt`, target: "queued", gate: `retry_count < max_retries` },
  { state: "changes_requested", trigger: `retry_count >= max_retries`, target: "awaiting_gate", gate: `escalated for human intervention (FR-TSK-02)` },
  { state: "changes_requested", trigger: `operator abort`, target: "cancelled", gate: `requested by operator surface` },
  { state: "failed", trigger: `auto-retry timer expires (daemon config \`retry.delay_sec\`, default 300 s)`, target: "queued", gate: `retry_count < max_retries` },
  { state: "failed", trigger: `operator retry (CLI \`task retry\`)`, target: "queued", gate: `retry_count < max_retries` },
  { state: "failed", trigger: `operator abort inside the retry window (task abort or chain abort)`, target: "cancelled", gate: `requested by operator surface` },
  { state: "failed", trigger: `retry_count >= max_retries`, target: "awaiting_gate", gate: `escalated for human intervention (FR-TSK-02)` },
];

/** Initial state has no in-edges; terminal states have no out-edges. */
export const INITIAL_STATE: CanonicalState = "draft";
export const TERMINAL_STATES: readonly CanonicalState[] = ["completed", "cancelled"];

/** Prose fallback labels map to canonical storage rules; they are never stored. */
export const FALLBACK_MAP: Readonly<Record<string, string>> = {
  "FAILED_NEEDS_HUMAN_REVIEW": `the retry-budget escalation path above: task reaches \`awaiting_gate\` via \`changes_requested\`/\`failed\` with \`retry_count >= max_retries\``,
  "SCHEMA_FAULT": `task \`failed\`, run \`failed\``,
  "INTERRUPTED": `task state unchanged, run \`crashed\``,
  "FAILED_CRASHED": `run \`crashed\``,
  "FAILED_BUDGET_EXCEEDED": `task \`failed\`, run \`failed\` with error \`budget_exceeded\``,
  "worker_retry / review_pending / qa_pending": `scenario-only labels, never stored`,
};
