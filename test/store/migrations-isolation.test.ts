import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { migrate, MIGRATIONS_DIR, BootRefusedError } from "../../src/store/migrate.ts";

/**
 * DEBT-004 ROOT CAUSE — the cross-test interference, pinned.
 *
 * `migrate()` reads `MIGRATIONS_DIR` — the module's OWN directory inside the
 * repository (`src/store/migrations/`). The previous version of this file
 * proved the block-on-contract-mismatch rule by writing
 * `src/store/migrations/0002_sneaky.sql` INTO that directory and deleting it
 * afterwards. Under `node --test` (or any parallel runner) every OTHER test
 * file runs concurrently, and ~40 of them boot a daemon that calls `migrate()`
 * on its own store. While the sneaky file existed, those boots legitimately
 * refused with `unapplied migration exists: 0002_sneaky.sql — refusing to
 * boot (version skew)` (observed: exactly one copy of a 3-way concurrent
 * suite run failing across the board, and the file itself disappearing
 * mid-write in another copy).
 *
 * THAT is the p6 "captured flake" family: the schedules quarantine test, the
 * catalog silent-probe test and the dispatch abort tests all failed only
 * under full-suite load and always passed in isolation, because the trigger
 * was another TEST FILE mutating shared repository state — not timing inside
 * the subject under test. (The secondary, genuinely timing-shaped member of
 * the family was fixed separately: fixed readiness sleeps become bounded
 * polls in test/daemon/debt4.test.ts.)
 *
 * THE FIX: `migrate(db, { migrationsDir })` — an injectable root, mirroring
 * the seam style used across this codebase. The default is the shipped
 * directory, so nothing about production behavior changes; a test that needs
 * to add a file copies the real migrations into a temp directory and points
 * the call there. No test may ever write inside `src/`.
 */

/** Copy the shipped migrations into a throwaway directory. */
function copiedMigrations(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-migrations-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("PRESERVE: the default migrationsDir is the shipped directory (production behavior unchanged)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-"));
  const db = openDb(join(dir, "state.db"));
  try {
    assert.equal(migrate(db), 2, "0001_init + 0002_project_phase_log apply from the shipped dir");
    assert.equal(migrate(db), 0, "idempotent");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an injected migrationsDir is honored: an unapplied file there refuses the boot", () => {
  const store = mkdtempSync(join(tmpdir(), "novaflow-"));
  const migrations = copiedMigrations();
  const db = openDb(join(store, "state.db"));
  try {
    migrate(db, { migrationsDir: migrations.dir });
    // a new unapplied file must block boot (block-on-contract-mismatch)
    writeFileSync(join(migrations.dir, "0003_sneaky.sql"), "CREATE TABLE nope (a);");
    assert.throws(
      () => migrate(db, { migrationsDir: migrations.dir }),
      (err: unknown) => {
        assert.ok(err instanceof BootRefusedError);
        assert.match(err.message, /unapplied migration exists: 0003_sneaky\.sql/);
        return true;
      },
    );
  } finally {
    db.close();
    migrations.cleanup();
    rmSync(store, { recursive: true, force: true });
  }
});

test("a CHANGED applied migration under an injected dir refuses (tamper detection is the same code)", () => {
  const store = mkdtempSync(join(tmpdir(), "novaflow-"));
  const migrations = copiedMigrations();
  const db = openDb(join(store, "state.db"));
  try {
    migrate(db, { migrationsDir: migrations.dir });
    writeFileSync(join(migrations.dir, "0001_init.sql"), "CREATE TABLE tampered (a);");
    assert.throws(
      () => migrate(db, { migrationsDir: migrations.dir }),
      (err: unknown) => {
        assert.ok(err instanceof BootRefusedError);
        assert.match(err.message, /changed on disk/);
        return true;
      },
    );
  } finally {
    db.close();
    migrations.cleanup();
    rmSync(store, { recursive: true, force: true });
  }
});

test("a CONCURRENT migrate on the shipped directory never sees a foreign file (the interference is structurally impossible now)", async () => {
  // the shape of the old bug: one actor adds/removes a file in the shared dir
  // while another migrates. With the test confined to a temp copy, the
  // shipped directory can be read from many boots at once with no refusal.
  const stores = Array.from({ length: 16 }, () => mkdtempSync(join(tmpdir(), "novaflow-conc-")));
  try {
    const results = await Promise.all(
      stores.map(
        (store) =>
          new Promise<number>((resolve, reject) => {
            setImmediate(() => {
              const db = openDb(join(store, "state.db"));
              try {
                resolve(migrate(db));
              } catch (err) {
                reject(err);
              } finally {
                db.close();
              }
            });
          }),
      ),
    );
    assert.deepEqual(results, stores.map(() => 2), "every concurrent boot applied both migrations");
    // and the shipped directory holds exactly the shipped files
    assert.deepEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort(), [
      "0001_init.sql",
      "0002_project_phase_log.sql",
    ]);
  } finally {
    for (const store of stores) rmSync(store, { recursive: true, force: true });
  }
});

test("no test file writes inside the repository's migrations directory (grep-level pin)", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.name.endsWith(".test.ts")) continue;
      // this guard's own source necessarily mentions the patterns
      if (name.name === "migrations-isolation.test.ts") continue;
      const src = readFileSync(path, "utf8");
      // a write whose DESTINATION derives from the shipped migrations dir:
      // `writeFileSync(join(MIGRATIONS_DIR, …)`, `rmSync(join(MIGRATIONS_DIR, …)`,
      // `mkdirSync(join(MIGRATIONS_DIR, …)`. Copying FROM it is a read and is
      // the sanctioned pattern (copy the real migrations into a temp dir).
      const writesInto =
        /(?:writeFileSync|rmSync|unlinkSync|mkdirSync|appendFileSync)\(\s*join\(\s*MIGRATIONS_DIR/g;
      if (writesInto.test(src)) offenders.push(path);
    }
  };
  walk(join(import.meta.dirname, ".."));
  assert.deepEqual(offenders, [], "tests must never mutate the repo's migrations directory");
});
