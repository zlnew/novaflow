-- NovaFlow v1.0.0 initial schema.
-- Canonical source: novaflow-v100/data §2. Do not edit without a new migration.

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  objective   TEXT NOT NULL DEFAULT '',
  repo_path   TEXT,
  verify_cmd  TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'paused', 'archived')),
  next_seq    INTEGER NOT NULL DEFAULT 1,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  key              TEXT NOT NULL UNIQUE,
  slug             TEXT NOT NULL,
  title            TEXT NOT NULL,
  objective        TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'todo'
                   CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority         TEXT NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee         TEXT,
  claimed_by       TEXT,
  session_ref      TEXT,
  lease_expires_at TEXT,
  block_reason     TEXT,
  blocked_by_ref   TEXT,
  summary          TEXT,
  idempotency_key  TEXT,
  tags_json        TEXT NOT NULL DEFAULT '[]',
  meta_json        TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,
  UNIQUE (project_id, seq),
  UNIQUE (project_id, slug)
);

CREATE UNIQUE INDEX idx_tasks_idempotency
  ON tasks(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee) WHERE assignee IS NOT NULL;

CREATE TABLE task_deps (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id != depends_on)
);

CREATE INDEX idx_task_deps_depends_on ON task_deps(depends_on);

CREATE TABLE task_notes (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author      TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_task_notes_task ON task_notes(task_id, created_at);

CREATE TABLE task_artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uri         TEXT NOT NULL,
  label       TEXT,
  kind        TEXT NOT NULL DEFAULT 'file'
              CHECK (kind IN ('file', 'pr', 'log', 'url')),
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_task_artifacts_task ON task_artifacts(task_id, created_at);

CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('workspace', 'project', 'task')),
  entity_id    TEXT NOT NULL,
  entity_key   TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  actor        TEXT,
  from_state   TEXT,
  to_state     TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_events_entity ON events(entity_type, entity_id, seq);
CREATE INDEX idx_events_created ON events(created_at);
