import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDiskAvailability,
  DISK_FREE_FLOOR_BYTES,
  type StatfsLike,
} from "../../src/runs/preflight.ts";

/**
 * DEBT-003 — FR-TSK-10 AC1's third clause, quoted verbatim from the srs:
 *
 *   "1. Verifies target repository paths exist and are writable, and disk
 *       availability."
 *
 * The DEBT-002 closure implemented the first two clauses and left disk
 * availability open (the srs ~:459 review note records the omission as a
 * documented tension): `src/runs/preflight.ts` checked exists/access and
 * git cleanliness, never free space.
 *
 * THE SEAM: the probe takes an injectable `statfs` reader. That is the
 * honest way to prove the refusal path without vaulting a tmpfs (the box
 * has no privileged mounts): the DEFAULT is `fs.statfsSync` and a test can
 * hand in a filesystem that reports near-zero free bytes. The real syscall
 * is exercised too (a temp dir on this box's tmpfs), so deleting the probe
 * cannot pass: `checkDiskAvailability` with the default reader must report
 * THIS machine's real free space, and the injected case proves the policy
 * branch.
 *
 * THRESHOLD (the card's explicit decision, recorded as a code comment):
 * 1 GiB free. It is a working value chosen for v1 — a Pi run writes a
 * session log, an events stream, a result.json, and (through the agent's
 * tools) worktree edits; 1 GiB is comfortably more than a single task
 * needs while still catching a genuinely full disk before a token is
 * spent. Invented number, flagged for the parent's DEC.
 */

const GIB = 1024 * 1024 * 1024;

function stats(bfree: number, bavail = bfree): StatfsLike {
  return { bsize: 4096, blocks: 1, bfree, bavail, files: 1, ffree: 1 };
}

test("DISK_FREE_FLOOR_BYTES is the documented 1 GiB working value", () => {
  assert.equal(DISK_FREE_FLOOR_BYTES, GIB);
});

test("a filesystem with plenty of space passes (null = no preflight failure)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-disk-"));
  try {
    // 10 GiB free, reported by the seam
    const res = checkDiskAvailability(dir, {
      statfs: () => stats((10 * GIB) / 4096),
    });
    assert.equal(res, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a FULL filesystem refuses, naming the requirement, the free bytes and the path (zero tokens spent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-disk-"));
  try {
    const res = checkDiskAvailability(dir, { statfs: () => stats(0) });
    assert.notEqual(res, null);
    assert.match(res!, /disk availability/);
    assert.match(res!, /FR-TSK-10/);
    assert.match(res!, /0/); // 0 bytes free
    assert.match(res!, /1\.0 GiB required|1073741824/);
    assert.ok(res!.includes(dir), `the refusal names the checked path: ${res}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the boundary: exactly the floor passes, one byte under it refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-disk-"));
  try {
    const blocksAtFloor = GIB / 4096;
    assert.equal(checkDiskAvailability(dir, { statfs: () => stats(blocksAtFloor) }), null);
    const res = checkDiskAvailability(dir, { statfs: () => stats(blocksAtFloor - 1) });
    assert.notEqual(res, null);
    assert.match(res!, /disk availability/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TINY filesystem (a 64 KiB tmpfs shape) refuses: the probe compares available bytes, not a percentage", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-disk-"));
  try {
    // 64 KiB total, entirely free — plenty by percentage, nothing by rule
    const res = checkDiskAvailability(dir, {
      statfs: () => ({ bsize: 4096, blocks: 16, bfree: 16, bavail: 16, files: 1, ffree: 1 }),
    });
    assert.notEqual(res, null);
    assert.match(res!, /64\.0 KiB|65536/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bavail (what an unprivileged writer may use) governs, not bfree — reserved blocks never count as free", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-disk-"));
  try {
    // bfree says 10 GiB, but only 512 MiB is available to us: refuse
    const res = checkDiskAvailability(dir, {
      statfs: () => stats((10 * GIB) / 4096, (512 * 1024 * 1024) / 4096),
    });
    assert.notEqual(res, null);
    assert.match(res!, /disk availability/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable path is a preflight refusal, never a throw (the check is fail-closed)", () => {
  const res = checkDiskAvailability("/definitely/not/a/real/path/for/novaflow", {
    statfs: () => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  });
  assert.notEqual(res, null);
  assert.match(res!, /disk availability cannot be verified/);
  assert.match(res!, /ENOENT/);
});

test("the DEFAULT reader is the real syscall: the probe reports this box's actual free space", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-disk-"));
  try {
    // deleting the probe would leave this null unconditionally — this test
    // pins that the default path really calls statfs and really decides
    const res = checkDiskAvailability(dir);
    const free = realFreeBytes(dir);
    if (free >= DISK_FREE_FLOOR_BYTES) {
      assert.equal(res, null);
    } else {
      assert.notEqual(res, null, "a full box refuses");
      assert.match(res!, /disk availability/);
    }
    // and a 1-byte floor always passes through the default reader (the
    // syscall result is really the input to the decision)
    assert.equal(checkDiskAvailability(dir, { floorBytes: 1 }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the threshold is injectable for tests, but the shipped default is the 1 GiB floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-disk-"));
  try {
    const huge = checkDiskAvailability(dir, { statfs: () => stats(2 * GIB / 4096), floorBytes: 4 * GIB });
    assert.notEqual(huge, null, "an injected higher floor refuses 2 GiB of free space");
    const tiny = checkDiskAvailability(dir, { statfs: () => stats(512 / 4096), floorBytes: 1 });
    assert.equal(tiny, null, "an injected lower floor accepts 512 bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The test's own independent read of the same syscall (never the module's). */
function realFreeBytes(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}
