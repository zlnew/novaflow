/**
 * The read-only tools' daemon-down answer path (mcp.md §4: "read-only
 * tools serve from the SQLite store directly").
 *
 * THE POINT OF THIS MODULE IS REUSE, NOT REIMPLEMENTATION. Every body it
 * dispatches to is the daemon's own read op (src/daemon/readops.ts), so
 * the MCP answer and the socket answer are literally the same function
 * over the same store: same rows, same envelope keys, same taxonomy
 * errors, same log file. In particular `nova_run_logs` reads the run's
 * `events_log_path` — `events.jsonl`, the redacted surface scrubbed by
 * src/runs/pump.ts through src/runs/redact.ts — and NEVER
 * `events.raw.jsonl` (NFR-SE-04). Re-deriving "tail the file" here would
 * be exactly the reimplementation the card forbids.
 *
 * The store is opened READ-ONLY by the caller (src/store/readonly.ts);
 * nothing here writes.
 */

import type Database from "better-sqlite3";
import {
  projectList,
  resultGet,
  runLogs,
  taskList,
  taskStatus,
  workspaceList,
} from "../daemon/readops.ts";
import { OpError, reqString } from "../opcodes.ts";

/**
 * Serve one read-only tool from the store. Only the six store-backed
 * read tools are reachable here — `nova_daemon_status` is live daemon
 * state and is refused before this point (src/mcp/server.ts).
 */
export function serveReadOnly(
  toolName: string,
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  switch (toolName) {
    case "nova_workspace_list":
      return workspaceList(db);
    case "nova_project_list":
      return projectList(db, {
        ...(args["workspace_id"] === undefined
          ? {}
          : { workspace_id: reqString(args, "workspace_id") }),
      });
    case "nova_task_list":
      return taskList(db, {
        ...(args["project_id"] === undefined ? {} : { project_id: reqString(args, "project_id") }),
        ...(args["state"] === undefined ? {} : { state: reqString(args, "state") }),
      });
    case "nova_task_status":
      return taskStatus(db, { task_id: reqString(args, "task_id") });
    case "nova_run_logs":
      return runLogs(db, {
        task_id: reqString(args, "task_id"),
        ...(args["run_id"] === undefined ? {} : { run_id: reqString(args, "run_id") }),
        ...(args["tail_lines"] === undefined ? {} : { tail_lines: args["tail_lines"] }),
      });
    case "nova_result_get":
      return resultGet(db, {
        task_id: reqString(args, "task_id"),
        ...(args["run_id"] === undefined ? {} : { run_id: reqString(args, "run_id") }),
      });
    default:
      // unreachable through the catalog; honest if a future read tool is
      // added to §3 without a store-backed body
      throw new OpError(
        "not_found",
        `${toolName} has no SQLite-direct answer — the daemon is required for it`,
      );
  }
}
