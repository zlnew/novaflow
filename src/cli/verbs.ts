import {
  EXIT_DAEMON_UNREACHABLE,
  EXIT_ENGINE_STATE,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  type ExitCode,
} from "./exitcode.ts";

/**
 * THE verb table (srs 4.1.1; novaflow-v030 W4 R4.1/R4.2/R4.3).
 *
 * One table, four readers — so none of them can drift on its own:
 *   1. `nova <verb> --help` / `-h` (src/cli/help.ts) prints THIS row's
 *      synopsis, flags and ONE example, exit 0 — never the whole manual.
 *   2. the dispatcher (src/cli/main.ts) refuses a verb this table does not
 *      carry, so a new sub that forgets its row is unreachable, and the
 *      generated test (test/cli/help.test.ts) fails on the missing row.
 *   3. docs/cli.md's audit table is checked row-for-row against it
 *      (test/cli/cli-docs.test.ts): a new verb without a doc row fails.
 *   4. the exit-code test walks every `exits` list and every code in
 *      src/cli/exitcode.ts's map (test/cli/exitcode.test.ts).
 *
 * A row is the operator's contract, not prose: `exits` lists every row of
 * the srs 4.1.1 exit map the verb can actually emit (usage = 2 and — for
 * socket verbs — daemon unreachable = 5 are on nearly every row; the
 * interesting ones are 1/3/4).
 */

export type BlockingBehaviour = "returns" | "returns at enqueue" | "blocks to completion";

/**
 * What the verb does to the system, and therefore what it owes the operator:
 *   - `read`   only reads (every read verb MUST support `--json` — the
 *              audit test walks them);
 *   - `write`  mutates the store or a process (daemon/pi-web lifecycle);
 *   - `server` runs until its client disconnects (`mcp`; stdout is the
 *              protocol channel, so no `--json`).
 */
export type VerbKind = "read" | "write" | "server";

/** The closed set docs/cli.md's "blocking" column may carry. */
export const BLOCKING_BEHAVIOURS: readonly BlockingBehaviour[] = [
  "returns",
  "returns at enqueue",
  "blocks to completion",
];

export type Verb = {
  /** The srs 4.1.1 noun (`task`, `chain`, …); `status`/`version`/`mcp` are nouns that ARE verbs. */
  readonly noun: string;
  /** The sub-verb; null when the noun itself is the verb (a one-verb noun). */
  readonly sub: string | null;
  /** One line: what the verb does, for the noun list and the audit table. */
  readonly purpose: string;
  /** The full usage line, INCLUDING the leading `nova`. */
  readonly synopsis: string;
  /** Every flag the verb accepts, verb-specific ones only (--help is printed by the renderer). */
  readonly flags: readonly string[];
  /** Exactly ONE worked example — the help output prints this and nothing more. */
  readonly example: string;
  /** Does the verb return at enqueue, or wait? (R4.2's blocking column.) */
  readonly blocking: BlockingBehaviour;
  /** Read, write, or server — the classification the --json audit walks. */
  readonly kind: VerbKind;
  /** `--json` prints one JSON document (true for every read verb). */
  readonly json: boolean;
  /** Every srs 4.1.1 exit row this verb can emit. */
  readonly exits: readonly ExitCode[];
};

/* The recurring exit sets, named once so a row reads as its contract. */
const OK = EXIT_OK;
const FAIL = EXIT_OPERATION_FAILED;
const USAGE = EXIT_USAGE;
const STATE = EXIT_ENGINE_STATE;
const NF = EXIT_NOT_FOUND;
const DOWN = EXIT_DAEMON_UNREACHABLE;

/** A socket read: the op answers, or it does not exist, or the daemon is down. */
const SOCKET_READ = [OK, USAGE, NF, DOWN] as const;
/** A socket write: also engine-state rejections and operation failures. */
const SOCKET_WRITE = [OK, FAIL, USAGE, STATE, NF, DOWN] as const;
/** A local read/print (no daemon round-trip). */
const LOCAL = [OK, USAGE] as const;

export const VERBS: readonly Verb[] = [
  /* ------------------------------ workspace ------------------------------ */
  {
    noun: "workspace",
    sub: "create",
    purpose: "register a workspace root directory",
    synopsis: "nova workspace create <name> --path <dir> [--default-branch <branch>]",
    flags: ["--path <dir>", "--default-branch <branch>"],
    example: "nova workspace create app --path ~/code/app",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: SOCKET_WRITE,
  },
  {
    noun: "workspace",
    sub: "list",
    purpose: "list registered workspaces",
    synopsis: "nova workspace list",
    flags: [],
    example: "nova workspace list --json",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, DOWN],
  },
  {
    noun: "workspace",
    sub: "switch",
    purpose: "set the CLI-local active workspace marker",
    synopsis: "nova workspace switch <slug>",
    flags: [],
    example: "nova workspace switch app",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, NF, DOWN],
  },
  {
    noun: "workspace",
    sub: "archive",
    purpose: "archive a workspace: execution disabled, logs stay read-only",
    synopsis: "nova workspace archive <slug>",
    flags: [],
    example: "nova workspace archive app",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "workspace",
    sub: "unregister",
    purpose: "remove a workspace from the registry (files on disk untouched)",
    synopsis: "nova workspace unregister <slug>",
    flags: [],
    example: "nova workspace unregister app",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },

  /* ------------------------------- project ------------------------------- */
  {
    noun: "project",
    sub: "create",
    purpose: "create a project with optional targets",
    synopsis:
      "nova project create <name> --objective <text> [--target <alias=path[:git_repo|directory]>]...",
    flags: ["--objective <text>", "--target <alias=path[:type]>   repeatable"],
    example: 'nova project create app --objective "Ship PKCE" --target code=~/code/app:git_repo',
    blocking: "returns",
    kind: "write",
    json: true,
    exits: SOCKET_WRITE,
  },
  {
    noun: "project",
    sub: "list",
    purpose: "list projects (active workspace when one is set)",
    synopsis: "nova project list [--workspace <slug|id>]",
    flags: ["--workspace <slug|id>"],
    example: "nova project list --json",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, DOWN],
  },
  {
    noun: "project",
    sub: "status",
    purpose: "one project: phase, task counts, targets",
    synopsis: "nova project status <id|slug> [--workspace <slug|id>]",
    flags: ["--workspace <slug|id>"],
    example: "nova project status app",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: SOCKET_READ,
  },
  {
    noun: "project",
    sub: "phase",
    purpose: "set the project's free-text phase label (audited)",
    synopsis: "nova project phase <id|slug> <label...> [--workspace <slug|id>]",
    flags: ["--workspace <slug|id>"],
    example: "nova project phase app phase-2",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "project",
    sub: "import-dag",
    purpose: "import a chain graph (JSON or YAML) as draft members",
    synopsis: "nova project import-dag <file> [--project <slug>] [--workspace <slug|id>]",
    flags: ["--project <slug>", "--workspace <slug|id>"],
    example: "nova project import-dag chain.json --project app",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: SOCKET_WRITE,
  },

  /* ------------------------------- profile ------------------------------- */
  {
    noun: "profile",
    sub: "create",
    purpose: "validate and store an agent profile from a file",
    synopsis: "nova profile create --file <path> [--workspace <slug|id>]",
    flags: ["--file <path>", "--workspace <slug|id>"],
    example: "nova profile create --file profiles/dev.json",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, FAIL, USAGE, STATE, DOWN],
  },
  {
    noun: "profile",
    sub: "update",
    purpose: "replace a profile's document and canonical file",
    synopsis: "nova profile update <name> --file <path> [--workspace <slug|id>]",
    flags: ["--file <path>", "--workspace <slug|id>"],
    example: "nova profile update dev --file profiles/dev.json",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: SOCKET_WRITE,
  },
  {
    noun: "profile",
    sub: "delete",
    purpose: "delete an unpinned profile (a pinned one is refused)",
    synopsis: "nova profile delete <name> [--workspace <slug|id>]",
    flags: ["--workspace <slug|id>"],
    example: "nova profile delete dev",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, FAIL, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "profile",
    sub: "list",
    purpose: "list profiles visible in the current scope",
    synopsis: "nova profile list [--workspace <slug|id>]",
    flags: ["--workspace <slug|id>"],
    example: "nova profile list --json",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, DOWN],
  },
  {
    noun: "profile",
    sub: "validate",
    purpose: "structural check of a stored profile (catalog probe happens at enqueue)",
    synopsis: "nova profile validate <name> [--workspace <slug|id>]",
    flags: ["--workspace <slug|id>"],
    example: "nova profile validate dev",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },

  /* -------------------------------- task --------------------------------- */
  {
    noun: "task",
    sub: "create",
    purpose: "create a task in draft",
    synopsis:
      "nova task create <key> --title <t> --objective <o> --profile <name> --project <slug|id> [--gate] [--context <path>]... [--scope <repo_alias>[:read_only|read_write]]...",
    flags: [
      "--title <t>",
      "--objective <o>",
      "--profile <name>",
      "--project <slug|id>",
      "--gate                        require a human gate before completion",
      "--context <path>              repeatable: a file or a docs/ reference",
      "--scope <alias>[:access_mode]  repeatable: target scope (DEBT-010)",
    ],
    example: 'nova task create K1 --title "Add PKCE" --objective "Implement it" --profile dev --project app --scope code',
    blocking: "returns",
    kind: "write",
    json: true,
    exits: SOCKET_WRITE,
  },
  {
    noun: "task",
    sub: "list",
    purpose: "list tasks, optionally scoped to a project or state",
    synopsis: "nova task list [--project <slug|id>] [--state <state>]",
    flags: ["--project <slug|id>", "--state <state>"],
    example: "nova task list --state queued",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: SOCKET_READ,
  },
  {
    noun: "task",
    sub: "run",
    purpose: "enqueue a draft task (draft → queued); --watch waits for the outcome",
    synopsis: "nova task run <id|key> [--watch]",
    flags: ["--watch <flag>               block until the task reaches a terminal state"],
    example: "nova task run K1 --watch",
    blocking: "returns at enqueue",
    kind: "write",
    json: true,
    exits: [OK, FAIL, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "task",
    sub: "status",
    purpose: "one task: state, current run, elapsed time; --watch prints transitions",
    synopsis: "nova task status <id|key> [--watch]",
    flags: ["--watch <flag>               one line per transition until terminal"],
    example: "nova task status K1",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: SOCKET_READ,
  },
  {
    noun: "task",
    sub: "result",
    purpose: "print the task's latest result.json artifact",
    synopsis: "nova task result <id|key>",
    flags: [],
    example: "nova task result K1",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: SOCKET_READ,
  },
  {
    noun: "task",
    sub: "logs",
    purpose: "tail the run's redacted events log; --follow streams it live",
    synopsis: "nova task logs <id|key> [--lines <n>] [--follow]",
    flags: ["--lines <n>                   tail length, 1..1000", "--follow                      stream new lines until the run closes"],
    example: "nova task logs K1 --lines 50",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: SOCKET_READ,
  },
  {
    noun: "task",
    sub: "abort",
    purpose: "abort a live run (the run is marked cancelled, its group killed)",
    synopsis: "nova task abort <id|key>",
    flags: [],
    example: "nova task abort K1",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "task",
    sub: "retry",
    purpose: "operator retry of a failed task",
    synopsis: "nova task retry <id|key>",
    flags: [],
    example: "nova task retry K1",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "task",
    sub: "steer",
    purpose: "record an operator steering message for the task",
    synopsis: "nova task steer <id|key> <message...>",
    flags: [],
    example: 'nova task steer K1 "use the v2 endpoint"',
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, NF, DOWN],
  },
  {
    noun: "task",
    sub: "gate-approve",
    purpose: "approve the human gate on a gated run",
    synopsis: "nova task gate-approve <id|key> [--run <id>] [--by <name>] [--note <text>]",
    flags: ["--run <id>                    the run to approve (default: the live one)", "--by <name>", "--note <text>"],
    example: 'nova task gate-approve K1 --by nova --note "reviewed"',
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "task",
    sub: "gate-reject",
    purpose: "reject the human gate, feeding the feedback back to the run",
    synopsis: "nova task gate-reject <id|key> <feedback...>",
    flags: [],
    example: 'nova task gate-reject K1 "tests do not cover the cache path"',
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },

  /* ------------------------------- schedule ------------------------------ */
  {
    noun: "schedule",
    sub: "attach",
    purpose: "attach a cron or one-shot schedule to a task",
    synopsis:
      "nova schedule attach <id|key> [--cron '<expr>' | --at <iso>] [--missed skip|run_immediately]",
    flags: ["--cron '<expr>'", "--at <iso>", "--missed skip|run_immediately"],
    example: "nova schedule attach K1 --cron '0 9 * * 1-5'",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "schedule",
    sub: "list",
    purpose: "list schedules, optionally for one task or workspace",
    synopsis: "nova schedule list [--task <id|key>] [--workspace <slug|id>]",
    flags: ["--task <id|key>", "--workspace <slug|id>"],
    example: "nova schedule list --task K1",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: SOCKET_READ,
  },
  {
    noun: "schedule",
    sub: "pause",
    purpose: "pause one schedule: no runs fire, resume recomputes the next one",
    synopsis: "nova schedule pause <schedule-id>",
    flags: [],
    example: "nova schedule pause 01M84J1ZE6M1P380WK7SBNF1M8",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "schedule",
    sub: "resume",
    purpose: "resume a paused schedule",
    synopsis: "nova schedule resume <schedule-id>",
    flags: [],
    example: "nova schedule resume 01M84J1ZE6M1P380WK7SBNF1M8",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },

  /* -------------------------------- daemon ------------------------------- */
  {
    noun: "daemon",
    sub: "start",
    purpose: "start the daemon (detached) or run it in the foreground",
    synopsis: "nova daemon start [--foreground] [--migrate]",
    flags: [
      "--foreground                  run the daemon in this process (tests/dev)",
      "--migrate                     migrate the store on boot",
    ],
    example: "nova daemon start",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, FAIL, USAGE],
  },
  {
    noun: "daemon",
    sub: "stop",
    purpose: "stop the daemon and wait for its socket to go",
    synopsis: "nova daemon stop",
    flags: [],
    example: "nova daemon stop",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, FAIL, USAGE, DOWN],
  },
  {
    noun: "daemon",
    sub: "status",
    purpose: "daemon uptime, scheduler counters, spend totals",
    synopsis: "nova daemon status",
    flags: [],
    example: "nova daemon status --json",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, DOWN],
  },
  {
    noun: "daemon",
    sub: "pause",
    purpose: "pause dispatch (running runs finish, nothing new starts)",
    synopsis: "nova daemon pause",
    flags: [],
    example: "nova daemon pause",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, DOWN],
  },
  {
    noun: "daemon",
    sub: "resume",
    purpose: "resume dispatch",
    synopsis: "nova daemon resume",
    flags: [],
    example: "nova daemon resume",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, DOWN],
  },
  {
    noun: "daemon",
    sub: "kill-all",
    purpose: "pause dispatch and abort every live run",
    synopsis: "nova daemon kill-all",
    flags: [],
    example: "nova daemon kill-all",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, DOWN],
  },
  {
    noun: "daemon",
    sub: "backup",
    purpose: "online SQLite backup of the store (never overwrites)",
    synopsis: "nova daemon backup [--out <path>]",
    flags: ["--out <path>                  destination (default: <store dir>/state.db.bak-<stamp>)"],
    example: "nova daemon backup --out ~/state.db.bak",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, FAIL, USAGE, STATE, DOWN],
  },
  {
    noun: "daemon",
    sub: "prune",
    purpose: "purge run-dir events.raw.jsonl past retention (events.jsonl is never touched)",
    synopsis: "nova daemon prune [--retention-days <n>]",
    flags: ["--retention-days <n>          days to keep (default 30)"],
    example: "nova daemon prune --retention-days 30",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, DOWN],
  },
  {
    noun: "daemon",
    sub: "logs",
    purpose: "tail the daemon log file",
    synopsis: "nova daemon logs [--lines <n>]",
    flags: ["--lines <n>                   tail length, 1..1000 (default 50)"],
    example: "nova daemon logs --lines 100",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, NF],
  },

  /* -------------------------------- status ------------------------------- */
  {
    noun: "status",
    sub: null,
    purpose: "one operator screen: daemon, scheduler, spend, last three transitions",
    synopsis: "nova status [--watch] [--json]",
    flags: ["--watch                       reprint only when the screen changes"],
    example: "nova status --json",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, DOWN],
  },

  /* ---------------------------------- web -------------------------------- */
  {
    noun: "web",
    sub: "sync",
    purpose: "mirror settled runs' transcripts into the private Pi Web agent dir",
    synopsis: "nova web sync [--run <id|key> | --all]",
    flags: ["--run <id|key>                one run or every run of one task", "--all                         sweep the workspace (live runs reported, not an error)"],
    example: "nova web sync --all",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: SOCKET_WRITE,
  },
  {
    noun: "web",
    sub: "start",
    purpose: "start the dedicated Pi Web instance on port 30142",
    synopsis: "nova web start",
    flags: [],
    example: "nova web start",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, FAIL, USAGE],
  },
  {
    noun: "web",
    sub: "stop",
    purpose: "stop the dedicated Pi Web instance",
    synopsis: "nova web stop",
    flags: [],
    example: "nova web stop",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, FAIL, USAGE],
  },
  {
    noun: "web",
    sub: "status",
    purpose: "Pi Web instance: pid, port, answering, mirrored runs",
    synopsis: "nova web status",
    flags: [],
    example: "nova web status --json",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: LOCAL,
  },

  /* -------------------------------- version ------------------------------ */
  {
    noun: "version",
    sub: null,
    purpose: "print the CLI version (offline; no daemon round-trip)",
    synopsis: "nova version",
    flags: [],
    example: "nova version --json",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: LOCAL,
  },

  /* --------------------------------- chain ------------------------------- */
  {
    noun: "chain",
    sub: "list",
    purpose: "list chain runs with member counts",
    synopsis: "nova chain list [--workspace <slug|id>]",
    flags: ["--workspace <slug|id>"],
    example: "nova chain list --json",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, DOWN],
  },
  {
    noun: "chain",
    sub: "status",
    purpose: "one chain: state and per-member readiness; --watch prints member transitions",
    synopsis: "nova chain status <chain-run-id> [--watch]",
    flags: ["--watch <flag>               one line per member transition until the chain settles"],
    example: "nova chain status 01M84J1ZE6M1P380WK7SBNF1M8 --watch",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: SOCKET_READ,
  },
  {
    noun: "chain",
    sub: "abort",
    purpose: "abort a chain run and its members",
    synopsis: "nova chain abort <chain-run-id>",
    flags: [],
    example: "nova chain abort 01M84J1ZE6M1P380WK7SBNF1M8",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "chain",
    sub: "pause",
    purpose: "pause readiness propagation and dispatch for the chain's members",
    synopsis: "nova chain pause <chain-run-id>",
    flags: [],
    example: "nova chain pause 01M84J1ZE6M1P380WK7SBNF1M8",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "chain",
    sub: "resume",
    purpose: "resume a paused chain (readiness is evaluated immediately)",
    synopsis: "nova chain resume <chain-run-id>",
    flags: [],
    example: "nova chain resume 01M84J1ZE6M1P380WK7SBNF1M8",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },
  {
    noun: "chain",
    sub: "clean",
    purpose: "remove a settled chain's run worktrees (run rows and artifacts are kept)",
    synopsis: "nova chain clean <chain-run-id> [--force]",
    flags: ["--force                       remove even a dirty worktree"],
    example: "nova chain clean 01M84J1ZE6M1P380WK7SBNF1M8",
    blocking: "returns",
    kind: "write",
    json: true,
    exits: SOCKET_WRITE,
  },
  {
    noun: "chain",
    sub: "verify",
    purpose:
      "configured versus executed verification commands; exit 3 when one was never executed",
    synopsis: "nova chain verify <chain-run-id>",
    flags: [],
    example: "nova chain verify 01M84J1ZE6M1P380WK7SBNF1M8",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: [OK, USAGE, STATE, NF, DOWN],
  },

  /* ---------------------------------- mcp -------------------------------- */
  {
    noun: "mcp",
    sub: null,
    purpose: "serve the MCP control surface on stdio (a server, not a one-shot command)",
    synopsis: "nova mcp",
    flags: [],
    example: "nova mcp   # then speak JSON-RPC on stdin/stdout",
    blocking: "blocks to completion",
    kind: "server",
    json: false,
    exits: [OK, FAIL, USAGE],
  },

  /* --------------------------------- docs -------------------------------- */
  {
    noun: "docs",
    sub: "list",
    purpose: "list the workspace docs index (the selectable --context options)",
    synopsis: "nova docs list [<workspace>]",
    flags: ["--workspace <slug|id>"],
    example: "nova docs list",
    blocking: "returns",
    kind: "read",
    json: true,
    exits: SOCKET_READ,
  },
];

/** The verb's printable key: `nova chain create`, `nova status`. */
export function verbKey(verb: Verb): string {
  return verb.sub === null ? `nova ${verb.noun}` : `nova ${verb.noun} ${verb.sub}`;
}

/** Every noun, in table order, first appearance wins. */
export function nounNames(): string[] {
  const seen: string[] = [];
  for (const verb of VERBS) if (!seen.includes(verb.noun)) seen.push(verb.noun);
  return seen;
}

export function findVerb(noun: string, sub: string | undefined): Verb | undefined {
  return VERBS.find((v) => v.noun === noun && (v.sub ?? undefined) === sub);
}

export function verbsOf(noun: string): Verb[] {
  return VERBS.filter((v) => v.noun === noun);
}
