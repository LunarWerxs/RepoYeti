/**
 * repoyeti CLI dispatcher. `repoyeti <command> [args]`.
 *
 * Daemon-lifecycle commands (start/add-root/status) live in ./lifecycle.ts. Git/agent verbs
 * that drive a running daemon over its local HTTP API (commit/log/branch/…, mcp, token) are
 * added in ./git.ts, ./token.ts, ./mcp.ts and wired into the switch below. `start` is the
 * implicit default so a bare `repoyeti` boots the daemon, preserving the original behavior.
 */
import { VERSION } from "../config.ts";
import { start, addRootCmd, statusCmd } from "./lifecycle.ts";
import { runGitVerb } from "./git.ts";
import { runTokenVerb } from "./token.ts";
import { runStdioMcp } from "../mcp/stdio.ts";

/** Verbs that drive a running daemon over HTTP (src/cli/git.ts). `status` is handled separately
 *  because of the name clash with the daemon-config summary (see the switch below). */
const GIT_VERBS = new Set([
  "repos",
  "log",
  "branches",
  "branch",
  "checkout",
  "commit",
  "diff",
  "drift",
  "stash",
  "push",
  "pull",
  "fetch",
]);

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "start";

  switch (cmd) {
    case "start":
      await start(argv.slice(1));
      break;
    case "add-root":
      addRootCmd(argv[1]);
      break;
    case "status":
      // Name clash: bare `status` is the daemon-config summary (lifecycle); `status <repo>` is the
      // git verb that asks the running daemon for that repo's state.
      if (argv[1]) await runGitVerb("status", argv.slice(1));
      else statusCmd();
      break;
    case "token":
      // Manage the optional API Bearer token (new / revoke / show) on the running daemon.
      await runTokenVerb(argv[1] ?? "show");
      break;
    case "mcp":
      // Run an MCP (stdio) server — what an AI agent (Claude Desktop/Code, Cursor) spawns. It
      // proxies tool calls to the local daemon over HTTP, so the daemon must already be running.
      await runStdioMcp();
      break;
    case "-h":
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      if (GIT_VERBS.has(cmd)) {
        await runGitVerb(cmd, argv.slice(1));
        break;
      }
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`repoyeti ${VERSION}

Usage:
  repoyeti start [--root <path>] [--port <n>] [--tunnel]   Boot the daemon
  repoyeti add-root <path>                                  Register a directory to scan
  repoyeti status                                           Show config + discovered repos

Drive a running daemon:
  repoyeti repos                                            List repos (branch / dirty / drift / vcs)
  repoyeti status <repo>                                    One repo's status block
  repoyeti log <repo> [--limit N] [--merges only|exclude]  Commit history
  repoyeti branches <repo>                                  List branches (ahead/behind/upstream)
  repoyeti branch <repo> <name> [--switch]                 Create a branch (optionally switch to it)
  repoyeti checkout <repo> <branch>                         Switch branch
  repoyeti commit <repo> -m <msg> [--amend]                Commit staged changes
  repoyeti diff <repo> <path>                               Show a file's diff
  repoyeti drift                                            List repos ahead/behind their remote
  repoyeti stash <repo> [list|pop|drop]                    Stash (no sub = save)
  repoyeti push|pull|fetch <repo>                          Sync with the remote
  repoyeti token [new|revoke|show]                         Manage the optional API Bearer token
  repoyeti mcp                                              Run an MCP server (stdio) for AI agents
`);
}
