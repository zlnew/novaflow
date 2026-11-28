import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
} from '../../src/store/migrations.js';
import {
  isInTransaction,
  migrate,
  openDatabase,
  readSchemaVersion,
  withTx,
} from '../../src/store/db.js';
import { isNovaError } from '../../src/store/errors.js';
import { sandbox, type Sandbox } from './helpers.js';

const EXPECTED_TABLES = [
  'events',
  'projects',
  'schema_migrations',
  'task_artifacts',
  'task_deps',
  'task_notes',
  'tasks',
];

const EXPECTED_INDEXES = [
  'idx_events_created',
  'idx_events_entity',
  'idx_task_artifacts_task',
  'idx_task_deps_depends_on',
  'idx_task_notes_task',
  'idx_tasks_assignee',
  'idx_tasks_idempotency',
  'idx_tasks_project_status',
];

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String((row as Record<string, unknown>).name));
}

function indexNames(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String((row as Record<string, unknown>).name));
}

function pragmaNumber(db: ReturnType<typeof openDatabase>, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  assert.ok(row, `PRAGMA ${name} returned no row`);
  const value = Object.values(row)[0];
  return Number(value);
}

function projectRow(id: string, slug: string, prefix: string): string[] {
  return [
    id,
    slug,
    prefix,
    `title-${slug}`,
    'active',
    '2026-11-28T00:00:00.000Z',
    '2026-11-28T00:00:00.000Z',
  ];
}

const INSERT_PROJECT = `INSERT INTO projects (id, slug, prefix, title, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

describe('store/migrations', () => {
  it('keeps 0001_init.sql as the canonical file and embeds identical SQL for dist', () => {
    const sqlPath = join(import.meta.dirname, '..', '..', 'src', 'store', 'migrations', '0001_init.sql');
    const fileSql = readFileSync(sqlPath, 'utf8');
    const embedded = MIGRATIONS.find((migration) => migration.version === 1);
    assert.ok(embedded, 'expected a version 1 migration');
    assert.equal(embedded.name, '0001_init');
    assert.equal(embedded.sql.trim(), fileSql.trim());
  });

  it('exposes the latest known schema version', () => {
    assert.equal(LATEST_SCHEMA_VERSION, 1);
    assert.equal(MIGRATIONS.at(-1)?.version, LATEST_SCHEMA_VERSION);
  });
});

describe('store/db', () => {
  let box: Sandbox;
  let dbPath = '';
  let db: ReturnType<typeof openDatabase>;

  before(() => {
    box = sandbox();
    dbPath = box.path('.novaflow', 'state.db');
    db = openDatabase(dbPath);
  });

  after(() => {
    try {
      db.close();
    } finally {
      box.dispose();
    }
  });

  it('opens the database in WAL mode with the documented pragmas', () => {
    const journal = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
    assert.equal(String(Object.values(journal)[0]).toLowerCase(), 'wal');
    assert.equal(pragmaNumber(db, 'synchronous'), 1, 'synchronous = NORMAL');
    assert.equal(pragmaNumber(db, 'foreign_keys'), 1);
    assert.equal(pragmaNumber(db, 'busy_timeout'), 5000);
  });

  it('applies 0001_init with every table from the schema spec', () => {
    assert.deepEqual(tableNames(db), EXPECTED_TABLES);
  });

  it('creates every index from the schema spec', () => {
    assert.deepEqual(indexNames(db), EXPECTED_INDEXES);
  });

  it('records the applied migration once with an ISO timestamp', () => {
    const rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all() as Array<
      Record<string, unknown>
    >;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.version, 1);
    assert.equal(rows[0]?.name, '0001_init');
    const appliedAt = String(rows[0]?.applied_at);
    assert.equal(new Date(appliedAt).toISOString(), appliedAt);
    assert.equal(readSchemaVersion(db), 1);
  });

  it('is idempotent when opened twice on the same file', () => {
    const second = openDatabase(dbPath);
    try {
      const rows = second.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as Record<string, unknown>;
      assert.equal(Number(rows.count), 1);
      assert.equal(readSchemaVersion(second), 1);
    } finally {
      second.close();
    }
  });

  it('migrate() is a no-op on an already current database', () => {
    assert.deepEqual(migrate(db), { applied: [], version: 1 });
  });

  it('commits a write transaction and reports the transaction state', () => {
    assert.equal(isInTransaction(db), false);
    const result = withTx(db, (tx) => {
      assert.equal(isInTransaction(tx), true);
      tx.prepare(INSERT_PROJECT).run(...projectRow('01JPROJCOMMIT0000000000001', 'commit-proj', 'CP1'));
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(isInTransaction(db), false);
    const row = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE slug = ?').get('commit-proj') as Record<string, unknown>;
    assert.equal(Number(row.count), 1);
  });

  it('rolls a failing write transaction back and rethrows the original error', () => {
    const boom = new Error('boom');
    assert.throws(
      () =>
        withTx(db, (tx) => {
          tx.prepare(INSERT_PROJECT).run(...projectRow('01JPROJROLLBACK00000000001', 'rollback-proj', 'RP1'));
          throw boom;
        }),
      (error: unknown) => error === boom,
    );
    assert.equal(isInTransaction(db), false);
    const row = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE slug = ?').get('rollback-proj') as Record<string, unknown>;
    assert.equal(Number(row.count), 0);
  });

  it('nests transactions with savepoints so an inner failure does not discard outer work', () => {
    withTx(db, (tx) => {
      tx.prepare(INSERT_PROJECT).run(...projectRow('01JPROJOUTER00000000000001', 'outer-proj', 'OP1'));
      assert.throws(() =>
        withTx(tx, (inner) => {
          inner.prepare(INSERT_PROJECT).run(...projectRow('01JPROJINNER00000000000001', 'inner-proj', 'IP1'));
          throw new Error('inner boom');
        }),
      );
      assert.equal(isInTransaction(tx), true, 'outer transaction still open after inner rollback');
    });
    const outer = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE slug = ?').get('outer-proj') as Record<string, unknown>;
    const inner = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE slug = ?').get('inner-proj') as Record<string, unknown>;
    assert.equal(Number(outer.count), 1);
    assert.equal(Number(inner.count), 0);
  });

  it('enforces foreign keys on tasks.project_id', () => {
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, seq, key, slug, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('01JTASKORPHAN0000000000001', '01JMISSINGPROJECT0000000000', 1, 'XX-1', 'orphan', 'orphan', 'now', 'now'),
    );
  });

  it('enforces CHECK constraints on task status', () => {
    withTx(db, (tx) => {
      tx.prepare(INSERT_PROJECT).run(...projectRow('01JPROJCHECK00000000000001', 'check-proj', 'CK1'));
    });
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, seq, key, slug, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('01JTASKBADSTATUS000000001', '01JPROJCHECK00000000000001', 1, 'CK1-1', 'bad', 'bad', 'nope', 'now', 'now'),
    );
  });

  it('keeps idempotency keys unique per project but allows many NULLs', () => {
    const projectId = '01JPROJIDEMPOTENT000000001';
    withTx(db, (tx) => {
      tx.prepare(INSERT_PROJECT).run(...projectRow(projectId, 'idem-proj', 'ID1'));
      for (const seq of [1, 2]) {
        tx.prepare(
          `INSERT INTO tasks (id, project_id, seq, key, slug, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(`01JTASKIDEMNULL0000000000${seq}`, projectId, seq, `ID1-${seq}`, `null-${seq}`, 'null', 'now', 'now');
      }
      tx.prepare(
        `INSERT INTO tasks (id, project_id, seq, key, slug, title, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('01JTASKIDEMKEY000000000001', projectId, 3, 'ID1-3', 'keyed', 'keyed', 'idem-key', 'now', 'now');
    });
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO tasks (id, project_id, seq, key, slug, title, idempotency_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('01JTASKIDEMKEY000000000002', projectId, 4, 'ID1-4', 'keyed-2', 'keyed', 'idem-key', 'now', 'now'),
      /UNIQUE/i,
    );
  });

  it('fails fast with SCHEMA_TOO_NEW (exit 1) when the database is newer than the binary', () => {
    const futurePath = box.path('future', 'state.db');
    const future = openDatabase(futurePath);
    future
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(99, '0099_future', new Date().toISOString());
    future.close();

    assert.throws(
      () => openDatabase(futurePath),
      (error: unknown) => {
        assert.ok(isNovaError(error), 'expected a NovaError');
        assert.equal(error.code, 'SCHEMA_TOO_NEW');
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /upgrade/i);
        return true;
      },
    );
  });
});
