import { EXIT_OK } from "../exitcode.ts";
import { socketPath as defaultSocketPath, defaultDbPath } from "../client.ts";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova mcp` (mcp.md §2: "a subcommand of the same Node.js binary as the
 * CLI; no separate service of its own").
 *
 * This command STARTS A SERVER and serves MCP over stdio until its client
 * disconnects. Consequences, spelled out because they are easy to get
 * wrong (mcp.md §2 + §4):
 *
 *   - stdout is the PROTOCOL CHANNEL. Nothing decorative may be printed
 *     there; every diagnostic goes to stderr via the server's own logging.
 *   - the srs 4.1.1 CLI exit map does NOT apply to this command. That map
 *     maps taxonomy codes for one-shot commands; `daemon_unreachable` is
 *     here a TOOL-level error code (mcp.md §4) and does not end the
 *     server — the client may still call read-only tools, which serve from
 *     SQLite while the daemon is down. Exit 5 therefore has no meaning
 *     here, and returning it would misreport a healthy session.
 *   - the honest exit is 0 when the client disconnects: a session that
 *     ended because the client hung up is a normal end of service, per the
 *     stdio lifecycle in §2 ("stateless per connection").
 *   - a start-up failure BEFORE the transport is listening (unreadable
 *     stdio, a connect error) is an operation failure and returns 1.
 *
 * Only the common flags are parsed here: `--json`/`--watch` are accepted by
 * the dispatcher's pre-scan but have no meaning for a stdio server, so
 * they are ignored rather than refused (the CLI's own convention: options
 * are per-noun, and this noun has none).
 *
 * The MCP server module is imported DYNAMICALLY, exactly like
 * `daemon start --foreground` reaches the lifecycle: the read-only
 * fallback (src/mcp/read.ts → src/store/readonly.ts) needs the SQLite
 * driver, and dragging a database driver into the startup path of every
 * other `nova` command would break the thin-client rule that keeps the CLI
 * a pure socket client (pinned by test/cli/discipline.test.ts).
 */
export async function mcpCommand(argv: string[], opts: CommandOpts): Promise<number> {
  // A stray positional would silently be ignored — refuse instead of
  // pretending `nova mcp something` means `nova mcp`.
  const positionals = argv.filter((t) => !t.startsWith("--"));
  if (positionals.length > 0) {
    console.error(`nova: mcp takes no arguments (got "${positionals.join(" ")}")`);
    return 2;
  }
  void opts;
  try {
    const { runStdioServer } = await import("../../mcp/server.ts");
    await runStdioServer({ socketPath: defaultSocketPath(), dbPath: defaultDbPath() });
    return EXIT_OK;
  } catch (err) {
    // Only reachable when the transport never came up — after a successful
    // connect the promise resolves on client disconnect instead.
    console.error(`nova: mcp failed to start: ${(err as Error).message}`);
    return 1;
  }
}
