import type { Db } from "../store/db.ts";
import { DEFAULT_CONCURRENCY_WORKSPACE, loadWorkspaceConfig } from "../config.ts";
import {
  KILL_GRACE_MS,
  startRun,
  type RunControl,
  type RunOptions,
  type RunOutcome,
} from "../runs/loop.ts";

/**
 * The scheduler loop (srs FR-SCH-02; architecture 8.1's queued→running
 * row — the slot check is THIS module's duty, the transition itself is
 * startRun's, so the verbatim scheduler-slot trigger has exactly ONE
 * source: src/runs/triggers.ts START_TRIGGER, applied by startRun).
 *
 * FR-WS-03 AC2: candidate selection only admits tasks in ACTIVE
 * workspaces — archived (or disabled) workspaces' queued tasks are
 * skipped and stay QUEUED; archiving is how the operator disables
 * task execution for a workspace while its logs stay read-only.
 *
 * Concurrency semaphores: a slot is granted only when the global
 * running count is below `concurrency.global` (daemon config, default 4)
 * AND the task's workspace running count is below `concurrency.workspace`
 * (workspace config via src/config.ts, default 2). Surplus tasks stay
 * QUEUED in FIFO order — order by created_at with the ULID id as the
 * tiebreak (data.md: state_transition_logs.created_at is authoritative
 * for transition time; tasks.created_at + monotonic ULID id is the FIFO
 * order for admission).
 *
 * FIFO requeue-preemption (spec-silent, documented reading): admission
 * order is the TASK's created_at, not its (re)queue time — a task that
 * failed and re-entered queued via the retry rows (auto-retry or
 * operator retry) re-enters AHEAD of newer work created after it. This
 * is deliberate: ordering by transition time would starve retried tasks
 * behind a steady stream of new ones, and created_at is data.md's
 * authoritative admission key. Operators who need fresh work first
 * pause or abort the retried task.
 *
 * Single-flight discipline: a dispatch pass is fully synchronous (the
 * granted startRun's queued→running transition + spawn run inside it),
 * so passes can never overlap; requestDispatch() coalesces bursts into
 * one scheduled pass. A pass that fails to start a candidate logs the
 * failure and CONTINUES to the next candidate — the loop never wedges
 * on a poison task (it stays queued for the operator abort / retry
 * paths; a preflight failure inside startRun lands on the failed row
 * and the retry evaluator owns it from there).
 *
 * Start-failure cooldown (spec-silent, documented): a task whose
 * granted startRun THREW is skipped for a cooldown window (default
 * 5 s, injectable) before it is re-eligible. Without it, the freed-slot
 * requestDispatch + the periodic tick re-granted a poison task
 * ~10,500 attempts/s (live-measured) — unbounded CPU and a log flood.
 * The cooldown is per-task: other candidates are unaffected.
 *
 * Pause semantics (documented, FR-TSK-08's scheduler-level ruling): a
 * paused scheduler grants NO new slots; runs already running continue.
 *
 * Spec-silent choices (documented): the periodic tick is 1 s (cheap
 * re-evaluation; every admission-changing op also requests a pass); a
 * workspace whose config.yaml is broken uses the workspace default 2
 * (never-crash rule — the config loader's error is surfaced by
 * preflight separately).
 */

export type DispatchOptions = {
  /** FR-SCH-02 AC1: concurrency.global from the daemon config. */
  globalConcurrency: number;
  /** startRun options for every granted slot (tests inject the stub). */
  runOptions?: Omit<RunOptions, "control"> | undefined;
  /** Audit-log actor for the queued→running moves (default "daemon-dispatch"). */
  actor?: string | undefined;
  /** Periodic re-evaluation tick in ms; default 1000 (spec-silent). */
  tickMs?: number | undefined;
  /**
   * Called whenever a granted run concludes (resolve or reject) — the
   * retry evaluator's hook for "whenever a task enters failed".
   */
  onRunConcluded?: ((taskId: string, outcome: RunOutcome | { error: string }) => void) | undefined;
  /**
   * Per-task start-failure cooldown in ms (spec-silent; default 5000).
   * A task whose granted startRun threw is skipped for this window
   * before re-eligibility — the poison-task hot-loop breaker.
   */
  startFailureCooldownMs?: number | undefined;
  /**
   * Periodic schedule evaluation (FR-SCH-01/03): invoked on THIS
   * module's tick, only while unpaused — the schedule evaluator's
   * single-flight pass (src/daemon/schedules.ts). One timer, one
   * pause: a paused daemon freezes schedule evaluation exactly like
   * it freezes new spawns.
   */
  scheduleTick?: (() => void) | undefined;
};

export type RunStartFailure = { taskId: string; error: string };

export type LiveRun = {
  taskId: string;
  workspaceId: string;
  /** The daemon's abort/steer handle on the live attempt. */
  control: RunControl;
  /** Resolves when the attempt fully concludes (child reaped, state moved). */
  done: Promise<RunOutcome | RunStartFailure>;
};

export type DispatchStatus = {
  paused: boolean;
  running: number;
  liveTasks: string[];
  queued: number;
};

type CandidateRow = {
  id: string;
  created_at: string;
  workspace_id: string;
  ws_root: string;
};

function warn(message: string): void {
  console.warn(`[novaflow-dispatch] ${message}`);
}

export function createDispatcher(db: Db, opts: DispatchOptions) {
  const actor = opts.actor ?? "daemon-dispatch";
  const runOptions: Omit<RunOptions, "control"> = opts.runOptions ?? {};
  const killGraceMs = runOptions.killGraceMs ?? KILL_GRACE_MS;
  let paused = false;
  let stopped = false;
  let passScheduled = false;
  /** taskId → live attempt. In-memory is authoritative: the daemon is the
   *  single owner of every spawn, so no other writer can hold a slot. */
  const live = new Map<string, LiveRun>();
  const tickMs = opts.tickMs ?? 1000;
  const startFailureCooldownMs = opts.startFailureCooldownMs ?? 5000;
  /** taskId → epoch ms until which it is skipped (start-failure cooldown). */
  const cooldownUntil = new Map<string, number>();
  const tick = setInterval(() => {
    requestDispatch();
    if (!paused && !stopped) opts.scheduleTick?.();
  }, tickMs);
  tick.unref?.();

  function workspaceLimit(rootPath: string): number {
    const load = loadWorkspaceConfig(rootPath);
    if (!load.ok) return DEFAULT_CONCURRENCY_WORKSPACE; // never-crash rule
    return load.config.concurrency.workspace;
  }

  /** Schedule exactly one pass (coalesced; passes never overlap — see header). */
  function requestDispatch(): void {
    if (passScheduled) return;
    passScheduled = true;
    setImmediate(() => {
      passScheduled = false;
      pass();
    });
  }

  function pass(): void {
    if (paused || stopped) return;
    const candidates = db
      .prepare(
        `SELECT t.id, t.created_at, p.workspace_id, w.root_path AS ws_root
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN workspaces w ON w.id = p.workspace_id
          WHERE t.state = 'queued' AND w.status = 'active'
          ORDER BY t.created_at, t.id`,
      )
      .all() as CandidateRow[];
    const wsCounts = new Map<string, number>();
    for (const entry of live.values()) {
      wsCounts.set(entry.workspaceId, (wsCounts.get(entry.workspaceId) ?? 0) + 1);
    }
    for (const c of candidates) {
      // FR-SCH-02 AC1: global semaphore first
      if (live.size >= opts.globalConcurrency) break;
      // then the workspace semaphore — a full workspace holds its surplus
      // in QUEUED (AC2) without blocking other workspaces' FIFO order
      if ((wsCounts.get(c.workspace_id) ?? 0) >= workspaceLimit(c.ws_root)) continue;
      // start-failure cooldown: a task that just failed to start is
      // skipped for its window (re-eligible after; the tick re-probes)
      const cd = cooldownUntil.get(c.id);
      if (cd !== undefined) {
        if (Date.now() < cd) continue;
        cooldownUntil.delete(c.id); // expired: re-eligible
      }

      // ---- slot granted: startRun applies the verbatim queued→running
      // row (START_TRIGGER, one source) and owns the attempt ----
      const control: RunControl = { abortRequested: false, steer: null };
      const done: Promise<RunOutcome | RunStartFailure> = startRun(
        db,
        c.id,
        actor,
        { ...runOptions, control },
      ).then(
        (outcome) => outcome,
        (err: unknown) => {
          // a grant that failed before the transition: logged, never
          // wedged — and cooled down so the next tick/freed-slot pass
          // cannot turn it into a retry hot loop
          warn(`startRun failed for task ${c.id}: ${(err as Error).message}`);
          cooldownUntil.set(c.id, Date.now() + startFailureCooldownMs);
          return { taskId: c.id, error: (err as Error).message };
        },
      );
      const entry: LiveRun = { taskId: c.id, workspaceId: c.workspace_id, control, done };
      live.set(c.id, entry);
      wsCounts.set(c.workspace_id, (wsCounts.get(c.workspace_id) ?? 0) + 1);

      void entry.done.then((outcome) => {
        live.delete(c.id);
        opts.onRunConcluded?.(c.id, outcome);
        requestDispatch(); // a slot freed
      });
    }
  }

  /**
   * The group kill the abort paths share (abort op, kill-all, stop):
   * SIGTERM → grace → SIGKILL on the run's process group (architecture
   * 8.4 killpg; the loop's own budget/timeout kills use the same
   * escalation in src/runs/loop.ts). ESRCH (group already gone) is fine.
   */
  function killRunGroup(pid: number, graceMs: number): void {
    const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
      try {
        process.kill(-pid, sig);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          warn(`group kill ${sig} failed for pgid ${pid}: ${code}`);
        }
      }
    };
    signal("SIGTERM");
    const backstop = setTimeout(() => signal("SIGKILL"), graceMs);
    backstop.unref?.();
  }

  /** The live run's pid (the loop records it on the run row at spawn). */
  function livePid(taskId: string): number | null {
    const row = db
      .prepare(
        "SELECT pid FROM task_runs WHERE task_id = ? AND status = 'running' ORDER BY attempt_number DESC LIMIT 1",
      )
      .get(taskId) as { pid: number | null } | undefined;
    return row?.pid ?? null;
  }

  /**
   * Abort the task's LIVE attempt: mark the control (the loop then owns
   * the 'cancelled' run record and the running→cancelled row), perform
   * the group kill, and await the conclusion. No state write happens
   * here — the loop is the writer.
   */
  async function abortTask(
    taskId: string,
    meta: { triggerType: "human" | "mcp"; actor: string } = { triggerType: "human", actor: "operator" },
  ): Promise<{ aborted: boolean; outcome?: RunOutcome | RunStartFailure }> {
    const entry = live.get(taskId);
    if (entry === undefined) return { aborted: false };
    entry.control.abortRequested = true;
    entry.control.abortTriggerType = meta.triggerType;
    entry.control.abortActor = meta.actor;
    const pid = livePid(taskId);
    if (pid !== null) killRunGroup(pid, killGraceMs);
    const outcome = await entry.done;
    return { aborted: true, outcome };
  }

  /** Forward one LF-framed api.md §3 frame to the live child's stdin. */
  function steerFrame(taskId: string, frame: string): { ok: boolean; reason?: string } {
    const entry = live.get(taskId);
    if (entry === undefined) return { ok: false, reason: "task has no live run" };
    if (entry.control.steer === null) {
      return { ok: false, reason: "the live run's child process is not accepting input" };
    }
    entry.control.steer(frame);
    return { ok: true };
  }

  function pause(): void {
    paused = true; // running runs continue — no NEW spawns
  }

  function resume(): void {
    paused = false;
    requestDispatch();
  }

  /** Reap every live run (operator-abort semantics) and await conclusions. */
  async function stop(): Promise<void> {
    stopped = true; // a scheduled pass must never touch the store after this
    clearInterval(tick);
    const awaiting: Array<Promise<unknown>> = [];
    for (const [taskId, entry] of live) {
      entry.control.abortRequested = true;
      entry.control.abortTriggerType = "human";
      entry.control.abortActor = "daemon-stop";
      const pid = livePid(taskId);
      if (pid !== null) killRunGroup(pid, killGraceMs);
      awaiting.push(entry.done);
    }
    await Promise.allSettled(awaiting);
    live.clear();
  }

  function status(): DispatchStatus {
    return {
      paused,
      running: live.size,
      liveTasks: [...live.keys()],
      queued: (
        db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state = 'queued'").get() as { n: number }
      ).n,
    };
  }

  // boot pass (lifecycle runs recovery FIRST, then constructs the dispatcher)
  requestDispatch();

  return {
    requestDispatch,
    abortTask,
    steerFrame,
    pause,
    resume,
    stop,
    status,
    /** Live-registry view (tests, kill-all). */
    liveTasks: (): string[] => [...live.keys()],
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
