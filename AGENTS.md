# Rules live in the CrAInium

This file is only a pointer. This repo's rules are its docs in the CrAInium, not files on disk.

1. Run Hydra Core first: MicroHydra `hydra_core` with the task.
2. Read this repo's rules: Connections MCP `connections_execute { local: true, tool_name: "docs", params: { action: "get", path: "AGENTS.md", checkout: "<this repo root>" } }`, and `path: "CLAUDE.md"` too if it exists. If neither exists, `action: "search"` with `repo` set to this repo.
3. Change a rule only with docs `edit`, then `put`. Never write rules into this file, and never add a CLAUDE.md or a nested AGENTS.md.
