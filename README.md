<div align="center">

<img alt="RepoYeti: run git from your phone" src=".github/banner.png" width="880" />

<p>
  <a href="https://repoyeti.com"><b>repoyeti.com</b></a>
  &nbsp;·&nbsp; <a href="#quick-start">Quick start</a>
  &nbsp;·&nbsp; <a href="#what-you-get">Features</a>
  &nbsp;·&nbsp; <a href="https://github.com/LunarWerxs/RepoYeti/releases">Download</a>
  &nbsp;·&nbsp; <a href="CHANGELOG.md">Changelog</a>
</p>

<p>
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-3ddc84" />
  <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-3ddc84" />
  <img alt="Dashboard: Vue 3 PWA" src="https://img.shields.io/badge/dashboard-Vue%203%20PWA-3ddc84" />
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-3ddc84" />
</p>

</div>

---

RepoYeti runs a small daemon on your machine, finds every git repo you have, and serves a dashboard to your phone over a private tunnel. Fetch, commit, push, and read history and diffs from wherever you are. It runs on your machine, so your code stays there.

<!-- A table, not three loose <img> tags: GitHub collapses whitespace between images, so the
     phones ended up shoulder to shoulder. GitHub also sizes table columns to their content and
     drops most width/style attributes, so percentage widths do nothing. The gutters have to be
     real empty cells with a transparent spacer image holding them open. -->
<table align="center">
  <tr>
    <td align="center"><img src=".github/screenshots/dashboard-mobile.png" width="230" alt="Live repo grid on a phone: every repo's branch, dirty, ahead/behind at a glance" /></td>
    <td><img src=".github/spacer.png" width="34" height="1" alt="" /></td>
    <td align="center"><img src=".github/screenshots/graph-mobile.png" width="230" alt="Git-graph history on a phone, with commit-activity chart, lanes and merges" /></td>
    <td><img src=".github/spacer.png" width="34" height="1" alt="" /></td>
    <td align="center"><img src=".github/screenshots/diff-mobile.png" width="230" alt="Monaco diff viewer on a phone" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Every repo at a glance</sub></td>
    <td></td>
    <td align="center"><sub>Commit graph, lanes and merges</sub></td>
    <td></td>
    <td align="center"><sub>Real Monaco diffs</sub></td>
  </tr>
</table>

## What you get

- 📡 &nbsp;**Live repo grid.** Branch / dirty / ahead / behind for every repo, updated the moment it changes. Fetch all in one tap.
- 🌿 &nbsp;**Git-graph history.** The commit graph with lanes and merges, lazily paged, with each commit's files-and-lines delta.
- ☑️ &nbsp;**Bulk actions.** Select any number of repos and pin, star, hide or remove them in one go. Every action undoes.
- 👀 &nbsp;**Preview a pull.** See the incoming commits, the files they touch, and any conflicts they'd cause, before you pull. Nothing is fetched or merged by looking.
- 🔍 &nbsp;**Monaco diffs.** The real VS Code editor: syntax highlighting, HEAD-↔-tree diffs, edit and save.
- 🤖 &nbsp;**Smart Commit (AI).** Split a messy working tree into clean, scoped commits. Bring your own key.
- 🪪 &nbsp;**Per-repo identities.** The right git identity for each repo, no `--amend --author` afterthoughts.
- 🏠 &nbsp;**Self-hosted.** Nothing runs in someone else's cloud. Uninstall it and your repos are untouched.

<div align="center">
  <img src=".github/screenshots/graph-desktop.png" width="88%" alt="Git-graph history in a desktop browser: commit-activity chart above lanes, branches and a merge commit" />
  <br /><sub>The same history, opened in a desktop browser</sub>
</div>

## Quick start

```sh
git clone https://github.com/LunarWerxs/RepoYeti.git
cd repoyeti && bun install
bun run src/index.ts add-root ~/code   # point it at where your repos live
bun run src/index.ts start             # daemon on 127.0.0.1:7171
```

To reach it from your phone (opens a Cloudflare tunnel and prints a QR code):

```sh
bun run src/index.ts start --tunnel
```

Prefer a prebuilt copy? Grab your platform from
[Releases](https://github.com/LunarWerxs/RepoYeti/releases). On Windows, download
`repoyeti-windows-x64.exe` and run it directly. The dashboard is embedded in the executable; there
is no `web` or `node_modules` folder to keep beside it. The one-file ZIP remains available for the
automatic updater.

## AI setup: a free Groq key in 3 clicks

Smart Commit and AI commit messages are bring-your-own-key (there's no bundled key, because Groq revokes any key committed to a public repo). Groq is the suggested provider: free, fast, ~30 seconds:

1. Open **[console.groq.com/keys](https://console.groq.com/keys)** and sign in.
2. Click **Create API Key**, then **Copy**.
3. In the app, open **Settings → AI**, expand **Groq**, and paste it in.

"Generate" lights up right away. Prefer OpenAI / Claude / Gemini / OpenRouter / DeepSeek? Add that key in the same place instead; your key never leaves the daemon (it's kept in your OS keychain).

<div align="center">
  <img src=".github/screenshots/diff-desktop.png" width="88%" alt="Monaco diff viewer in a desktop browser, side by side with the repo list" />
  <br /><sub>Real Monaco, side by side with the repo list</sub>
</div>

## The rules

No force-push, no `reset --hard`, no rebase. A phone is a lousy place to rewrite history, so those live at your desk. Pulls are fast-forward-only, and everything runs as the git identity you set for that repo. Local state stays in `~/.repoyeti/`; nothing is written into your repos.

## Built with

Bun · `bun:sqlite` · Hono · `simple-git` on the daemon, and a Vue 3 + Tailwind PWA on the front end. Sign-in is "Sign in with Connections" (OIDC / PKCE, zero setup). A pluggable VCS backend also supports [Lore](src/vcs/lore.ts) behind `REPOYETI_LORE=1`.

Cloud sign-in and settings sync are entirely optional and off by default; core git management works fully self-hosted and offline, no LunarWerx account required.

## More

- **AI agents (MCP):** `repoyeti mcp` exposes local repos plus accepted collaboration status/diffs and guarded remote commit+sync; the full HTTP surface is at `GET /api/openapi.json`.
- **Buzz (experimental, Advanced):** opt-in Git Smart HTTP compatibility, saved communities, and
  daemon-safe preflight diagnostics. [Setup and security boundaries](docs/BUZZ.md).
- **Architecture, remote access, config:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Contributing & tests:** [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)

## License

[MIT](LICENSE) © LunarWerx Studios. Bundled file-type icons are [`vscode-icons`](https://github.com/vscode-icons/vscode-icons) (icon artwork under CC BY-SA).
