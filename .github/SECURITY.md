# Security Policy

RepoYeti runs on your own machine, but it reaches a lot from there: every git repository under
the folders you point it at, the git remotes and credentials those repositories use, a local
server on `127.0.0.1:7171` with a dashboard you can open from a phone, an optional Cloudflare
tunnel (`--tunnel`), an optional Cloudflare API token for Cloudflare Artifacts remotes, an
optional "Sign in with Connections" session, and an MCP server that AI agents can call. A bug in
any of those could expose more than one repo's worth of data, so we want to hear about it.

## Reporting a vulnerability

If you find a security issue (another program or web page reaching RepoYeti's local server or
MCP tools, a sign-in or token leaking, a repository or file exposed beyond your machine, a
tunnel reaching more than it should, or anything else that looks exploitable) **please report it
privately** rather than opening a public issue, so it can be fixed before it's disclosed:

- open a normal issue **asking us to contact you** (don't include the exploit details there), or
- message the maintainers on [Discord](https://discord.gg/PsWpeNUzhk) and ask for a private
  channel.

Please include:

- what triggers it (the steps, request or file, or a link to it),
- the **RepoYeti version** and your **operating system**, and
- what you observed (what was reachable, leaked or changed).

We'll acknowledge within a few days and keep you updated through to a fix and release.

## Supported versions

The **latest release** is the supported version, so please update and confirm the issue still
reproduces before reporting.

Thank you for helping keep RepoYeti users safe.
