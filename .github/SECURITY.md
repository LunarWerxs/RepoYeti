# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report them privately to **2claude@lunarwerx.com** (or use GitHub's
[private vulnerability reporting](https://github.com/LunarWerxs/repoyeti/security/advisories/new)
on this repository). Include:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- the affected version / commit.

We aim to acknowledge reports within **72 hours** and to provide a remediation timeline after
triage. We follow coordinated disclosure — please give us a reasonable window to ship a fix before
any public disclosure.

## Scope & deployment model (important context)

RepoYeti is a self-hosted daemon that can expose a git dashboard over a Cloudflare tunnel. A few
properties are intentional and worth understanding before reporting:

- **The built-in Groq AI key is intentionally public/throwaway** — abusing it only burns its own
  rate limit. It is not a credential leak. Owners can (and for anything sensitive, should) supply
  their own provider key, which never leaves the host.
- **The OAuth client is a public PKCE client** — there is no confidential secret in the codebase.
- **Local vs. remote is decided from reverse-proxy headers** (`cf-connecting-ip` /
  `x-forwarded-*`). RepoYeti assumes a Cloudflare tunnel; if you deploy behind a different proxy that
  does **not** set these headers, remote requests may be treated as local. Configure your proxy to
  forward them. Reports about *this documented assumption* are not considered vulnerabilities; novel
  bypasses of the auth gate are.

Things we consider in-scope and want to hear about: path-traversal in the file viewer/editor,
command/argument injection into git, auth-gate bypasses over the tunnel, and any way to read a
provider key or the OAuth session out of the daemon.
