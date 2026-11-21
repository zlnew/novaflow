-- 0002_project_phase_log.sql
--
-- FR-PRJ-02 AC2 (novaflow-v1/srs): "Logs phase label changes and the
-- triggering identity to the audit log." The spec DDL (data.md §3) has
-- no project-phase audit surface: state_transition_logs is task-FK
-- scoped (its task_id column, DDL CHECK vocabulary) and cannot carry a
-- project-level event. This migration adds the minimal durable audit
-- surface. DIVERGENCE (documented, parent to decide on amending the
-- spec DDL): this table lives in code only — the data.md ```sql block
-- and test/helpers/spec.ts's golden extract do not contain it.
--
-- One row per applied phase CHANGE (from != to); a re-set of the same
-- label is not a change and writes no row. Phase is free text (FR-PRJ-02
-- AC1: no transition rules enforced); the actor is the triggering
-- identity (operator name / surface).

CREATE TABLE IF NOT EXISTS project_phase_logs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    from_phase TEXT NOT NULL,
    to_phase TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_phase_logs_project ON project_phase_logs(project_id);
