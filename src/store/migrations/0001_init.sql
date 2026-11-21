-- Enforce Foreign Keys and Write-Ahead Logging
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- -----------------------------------------------------------------------------
-- 0. SCHEMA MIGRATIONS
-- -----------------------------------------------------------------------------
-- Migrations are plain SQL files applied in filename order, one row per file.
-- The store refuses to boot when an unapplied migration exists (the same
-- block-on-contract-mismatch rule the daemon applies to the Pi RPC contract).
CREATE TABLE IF NOT EXISTS schema_migrations (
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    filename TEXT PRIMARY KEY NOT NULL,
    sha256 TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 1. WORKSPACES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    description TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'disabled'))
DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);

-- -----------------------------------------------------------------------------
-- 2. PROJECTS & PROJECT TARGETS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    objective TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'planning',
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'paused',
'archived')) DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    UNIQUE(workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS project_targets (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('git_repo', 'directory')),
    root_path TEXT NOT NULL,
    base_branch TEXT DEFAULT 'main',
    branch_prefix TEXT DEFAULT 'novaflow/',
    default_access TEXT NOT NULL CHECK (default_access IN ('read_only',
'read_write')) DEFAULT 'read_write',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(project_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_project_targets_project ON
project_targets(project_id);

-- -----------------------------------------------------------------------------
-- 3. AGENT PROFILES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT, -- NULL denotes global default profiles
    name TEXT NOT NULL,
    role TEXT,  -- optional free-form label; a convention, not an enforced taxonomy
    provider TEXT NOT NULL,  -- validated at load against the live Pi model catalog
    model TEXT NOT NULL,
    thinking_level TEXT NOT NULL DEFAULT 'medium',  -- validated at load against
    -- the live Pi model catalog; Pi is the source of truth for the harness, so no CHECK enum,
    tools_allowlist_json TEXT NOT NULL DEFAULT '[]',
    system_prompt_path TEXT NOT NULL,
    max_timeout_sec INTEGER NOT NULL DEFAULT 3600 CHECK (max_timeout_sec > 0),
    max_cost_usd REAL NOT NULL DEFAULT 5.00 CHECK (max_cost_usd >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_workspace ON
agent_profiles(workspace_id);

-- -----------------------------------------------------------------------------
-- 4. TASKS & TARGET SCOPES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    key TEXT NOT NULL, -- Human-readable identifier e.g., "TASK-101"
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'draft', 'queued', 'running', 'awaiting_gate',
        'validating', 'completed', 'changes_requested', 'failed', 'cancelled'
    )) DEFAULT 'draft',  -- canonical FSM per FR-TSK-01 (novaflow-v1/srs); failure
                        -- detail (retry/terminated/crashed) lives on task_runs, not here,
    priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    requires_human_gate INTEGER NOT NULL DEFAULT 0 CHECK (requires_human_gate IN
(0, 1)),
    side_effect_class TEXT NOT NULL CHECK (side_effect_class IN ('pure_code',
'external_side_effect')) DEFAULT 'pure_code',
    compaction_count INTEGER NOT NULL DEFAULT 0 CHECK (compaction_count >= 0),
    output_schema_version TEXT NOT NULL DEFAULT '1.0.0',
    overrides_json TEXT DEFAULT '{}',  -- task-level overrides: timeout_sec, max_cost_usd,
                                       -- thinking_level (FR-AGT-03); profile baseline is default
    context_files_json TEXT NOT NULL DEFAULT '[]',
    chain_run_id TEXT,  -- membership: set at chain import (architecture 8.1 chain run
                        -- ownership); NULL for single tasks,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (profile_id) REFERENCES agent_profiles(id) ON DELETE RESTRICT,
    FOREIGN KEY (chain_run_id) REFERENCES chain_runs(id) ON DELETE SET NULL,
    UNIQUE(project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_profile ON tasks(profile_id);
CREATE INDEX IF NOT EXISTS idx_tasks_chain_run ON tasks(chain_run_id);

CREATE TABLE IF NOT EXISTS task_target_scopes (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only', 'read_write'))
DEFAULT 'read_write',
    write_scope_globs_json TEXT NOT NULL DEFAULT '["**/*"]',
    protected_test_globs_json TEXT NOT NULL DEFAULT '[]',
    verification_commands_json TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES project_targets(id) ON DELETE CASCADE,
    UNIQUE(task_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_task_target_scopes_task ON
task_target_scopes(task_id);

CREATE INDEX IF NOT EXISTS idx_task_target_scopes_target ON
task_target_scopes(target_id);

-- -----------------------------------------------------------------------------
-- 5. TASK EDGES (DEPENDENCIES & Dynamic DAG Routing)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_edges (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    target_task_id TEXT NOT NULL,
    edge_type TEXT NOT NULL CHECK (edge_type IN ('depends_on',
'on_changes_requested', 'on_failure')),
    condition_expr TEXT, -- Evaluated expression for dynamic branching
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (target_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(source_task_id, target_task_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON task_edges(source_task_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON task_edges(target_task_id);
CREATE INDEX IF NOT EXISTS idx_edges_project ON task_edges(project_id);

-- -----------------------------------------------------------------------------
-- 6. TASK RUNS (Execution Attempts)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    profile_id TEXT,  -- snapshot of the assigned profile for THIS run (FR-TSK-09);
                      -- tasks.profile_id may change between attempts,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    thinking_level TEXT,  -- the level actually used for this run (profile default or the
                          -- task override from overrides_json)
    attempt_kind TEXT NOT NULL DEFAULT 'execution' CHECK (attempt_kind IN ('execution',
'repair')),
    pi_session_id TEXT NOT NULL,
    pi_session_dir TEXT NOT NULL,
    pid INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed',
'timed_out', 'cancelled')) DEFAULT 'running',
    preflight_status TEXT NOT NULL CHECK (preflight_status IN ('pending',
'passed', 'failed')) DEFAULT 'pending',
    engine_verification_passed INTEGER NOT NULL DEFAULT 0 CHECK
(engine_verification_passed IN (0, 1)),
    model_used TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost_usd REAL NOT NULL DEFAULT 0.0 CHECK (cost_usd >= 0),
    exit_code INTEGER,
    artifact_path TEXT,
    events_log_path TEXT NOT NULL,
    git_commits_json TEXT NOT NULL DEFAULT '{}',
    error_summary TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    duration_ms INTEGER CHECK (duration_ms >= 0),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(task_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);

-- -----------------------------------------------------------------------------
-- 7. STATE TRANSITION LOGS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS state_transition_logs (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('engine', 'human', 'mcp',
'schedule', 'timeout')),
    actor TEXT NOT NULL, -- Engine worker ID or User identifier
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_transitions_task ON state_transition_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_transitions_run ON state_transition_logs(run_id);

-- -----------------------------------------------------------------------------
-- 8. SCHEDULES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('task')),
    target_id TEXT NOT NULL,
    cron_expr TEXT,
    run_at TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    missed_policy TEXT NOT NULL CHECK (missed_policy IN ('skip',
'run_immediately')) DEFAULT 'skip',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    last_run_at TEXT,
    next_run_at TEXT,  -- nullable: one-shot schedules that already expired
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CHECK (cron_expr IS NOT NULL OR run_at IS NOT NULL)
);

-- v1: schedules attach to TASKS only (project-level scheduling is deferred)
CREATE INDEX IF NOT EXISTS idx_schedules_workspace ON schedules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at) WHERE
enabled = 1;

-- -----------------------------------------------------------------------------
-- 9. CHAIN RUNS
-- -----------------------------------------------------------------------------
-- One chain run per chain import: created at import time, every member task's
-- chain_run_id stamped then (architecture 8.1 chain run ownership); started_at = import time.
-- Terminal: completed when all member tasks are `completed`; `failed` when any member
-- task is confirmed failed (the awaiting_gate -> failed terminal outcome); `aborted` by
-- operator via chain abort. A member cancelled by single-task abort does not change the
-- chain run state by itself; the operator decides via chain abort or lets remaining
-- members finish.
CREATE TABLE IF NOT EXISTS chain_runs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed',
'aborted')) DEFAULT 'active',
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chain_runs_project ON chain_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_chain_runs_state ON chain_runs(state);
