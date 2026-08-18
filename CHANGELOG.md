# Changelog

All notable changes to RepoYeti are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.21.4] - 2026-08-18

### Fixed

- **The overflow menus open where you can see them.** Four controls did nothing at all when clicked
  ([#15](https://github.com/LunarWerxs/RepoYeti/issues/15)): the file viewer's **View options** `⋮`,
  which is the only home word wrap has ever had, the **Changed-files** and **History** view-options
  sliders, the **branch switcher**, and the **recent commit messages** history button. Every one of
  them really did open. `aria-expanded` went `true`, every item was in the DOM, nothing was logged,
  and the menu was drawn at `translate(0, -200%)`, two menu-heights above the top of the window. On
  a 1600x900 desktop the file viewer's menu measured its top edge at **-594px**. Neither the markup
  nor the console said anything was wrong, which is how it survived four releases and one previous
  fix attempt.
  The cause is one line of nesting. reka's `MenuRoot`, `PopoverRoot` and `TooltipRoot` each render a
  `PopperRoot`, which `provide`s the anchor its popper positions against, and every trigger
  registers itself through `PopperAnchor`, which `inject`s the **nearest** one. With the menu
  wrapped **around** its tooltip, the menu's own trigger sat inside the tooltip and handed its
  anchor to the *tooltip's* root, while the menu's content, which sits outside the tooltip, injected
  a root that no longer had one. Floating UI never received a reference element, so it never
  positioned anything. The earlier attempt added an inert `<span>` between the two `as-child`
  triggers. That is a real and separate bug, but it could not touch this one: this half is
  `provide`/`inject` nesting, not DOM attribute merging. Each menu now lives **inside** its
  tooltip's trigger, so its own root is the nearest for both halves. Two guards now cover it: a
  `check:popper` build rule on the nesting itself, which costs nothing per component and so scales
  to the next one written, and a regression test that opens the shared popover and asserts it is
  positioned rather than merely present. Both were verified red against the last commit before the
  fix, which is the step the previous attempt skipped.

### Internal

- **The test suite cleans up after itself.** Nothing shipped to users changes, since the daemon's
  own scratch directories were always removed in `finally` blocks, but running the suite leaked
  directories on developer machines, in two separate ways, and had done since the scratch helper
  was introduced. Locally that came to **1,673,606 files across 46,854 directories** in `.testtmp/`
  between 2026-07-27 and 2026-08-15, plus **1,408 directories and 31,774 files** in the real
  `%TEMP%` from two days of runs. Only a few gigabytes; the damage is the file count, which slows
  every tool that walks the working tree and takes an age to delete once grown. CI never noticed
  because GitHub runners are destroyed after each job, so the entire cost landed on contributors.
  First cause: `tests/helpers/scratch.ts` moved scratch out of the OS temp directory (it had to,
  because `isUnderTempDir` refuses to import a repo from there) and, in doing so, silently gave up
  the reaping the OS had been doing for free, without replacing it. `.testtmp/` is gitignored, so no
  git-based check could see it either. Scratch now lives under a per-run subdirectory that is torn
  down when the run ends, and a run killed before its teardown is swept by the next run rather than
  left forever. Second cause: the migration to that helper was never finished. Sixteen test files
  still built fixtures directly under `%TEMP%` with no cleanup, and `%TEMP%\gm-*` repositories are
  the exact shape of the ~115 junk rows `isUnderTempDir` and `pruneTempRepos` exist to clean up. All
  sixteen now use `mkScratchDir`. `tests/db-temp-guard.test.ts` still uses a real temp path, because
  proving the guard fires there requires one, but it now records every directory it creates and
  removes them. A new `check:testscratch` guardrail fails the build if a test reaches for the OS
  temp directory again.

## [0.21.3] - 2026-08-15

### Fixed

- **An applied update no longer takes RepoYeti down.** On a downloaded release build, installing an
  update stopped the daemon and started nothing in its place: the dashboard went dead and the only
  way back was launching the app again by hand. The relaunch built its successor's command from
  `process.argv[0..1]`, which is the runtime and the script in a source checkout but, inside a
  compiled single-file executable, is a placeholder pair pointing at a virtual path that exists only
  inside the running binary. Respawning it fails immediately, and on the machines a compiled release
  exists for (no runtime installed, which is the entire pitch) the command cannot resolve at all.
  Nothing caught it, because the failure is in the child: the spawn call itself succeeds, so the
  guard that exists precisely to never shut down without a successor saw one and stepped aside.
  Second cause, same outcome, on any launch that did not spell out `start`, which is the documented
  "just run the .exe" path: the relaunch signal is appended as a flag, and with no other arguments
  it landed in the command slot, so the successor exited with `Unknown command: --relaunch`. The
  update itself was always written to disk correctly, so an install on an older build recovers the
  moment you start it again, and this is the last time it will need to.
- **An update no longer moves the daemon to a different port and kills the tab you had open.** The
  successor was handed the port this daemon *preferred*, not the port it was actually serving on.
  Those are the same number only until something else holds the preferred port once; after that
  every update aimed the successor at the wrong one, and it uses that value for both of its jobs. So
  it waited out its full 8-second handoff timeout on a socket its predecessor never held and nobody
  was going to release, then bound that port rather than the one your browser was talking to,
  and the open dashboard's live connection died against a daemon that was otherwise perfectly
  healthy. It is now given the bound port, so the wait applies to the socket actually being freed
  and the daemon keeps one address across updates. Measured on an isolated home: a daemon that had
  hopped once used to relocate its successor away from the open tab, and took 8.4s to do it; it now
  hands over in 1.2s on the same port.

## [0.21.2] - 2026-08-15

### Fixed

- **Refresh now reconciles the branch list, not just the status** ([#22]). Check out a different
  branch outside RepoYeti, from a terminal or another Git client, press Refresh, and the card kept
  showing the old branch while still offering branches that had been deleted. Only a full page
  reload cleared it. The status read was never wrong: Refresh really did return the new branch. What
  was missing is that nothing invalidated the cached branch list, and the selector renders the
  cache. Reconciled at the one funnel every status update passes through, so the Refresh button,
  an action's own response and the live event stream all behave identically. The trigger includes
  the ref-set hash, which is what catches the half of the report that leaves the current branch
  untouched: a branch deleted or updated elsewhere. Lists for cards nobody has opened are left
  alone rather than re-read for a view no one is looking at.
- **An installed PWA recovers by itself after the tunnel address rotates** ([#21]). Running mostly
  from a phone, an unattended update brings the daemon back on a fresh Quick Tunnel hostname, and
  opening the installed app showed a dead URL; the only way back was opening the permanent link in
  a browser and reinstalling. The self-heal for this already existed, but only for a page still
  running, and it assumed the service worker was serving a cached shell on the dead origin. It was
  not: no shell is precached, deliberately, because a precached one used to leave a rebuilt tab
  reloading into a stale build. Two correct decisions that combined into a bug, since a cold start
  then failed at the network before any code ran. A failed navigation now falls back to a tiny
  standalone page that asks the permanent address where the daemon went and goes there. It
  references no build assets, so it cannot go stale the way the app shell could, and it only ever
  appears when a navigation genuinely failed.

## [0.21.1] - 2026-08-15

### Added

- **Gitignored files and folders are dimmed in the All-files tree.** Browsing a working tree
  without knowing which parts git is ignoring means reading `node_modules`, `cdk.out` and
  `coverage` as if they were yours. Editors dim those rows; so does this now, files as well as
  folders. The mark comes from `git check-ignore` rather than from pattern-matching here, because
  gitignore is negations, nested ignore files, `core.excludesFile` and `info/exclude` evaluated in
  a defined order, and a hand-rolled matcher gets the interesting cases wrong.
- **A switch to keep "All files" on this machine only.** Settings, Remote access, beside the
  existing editing one: it stops the working-tree browser working over the tunnel while leaving
  loopback untouched. Its own switch rather than riding on the editing one, because it is a
  different risk. Editing writes; this enumerates, ignored paths included, which is where `.env`
  files and local credentials live. Being happy to read your diffs from a phone and being happy
  for the tunnel to list every file on the machine are separate decisions. Defaults to enabled.
  Share-link guests were never able to browse and still cannot: both routes are owner-only.

### Changed

- **The file search no longer returns every vendored copy of a filename.** Browsing and searching
  want opposite defaults, and shipping one for both was wrong: the tree can afford to list
  `node_modules` because a folder costs nothing until you open it, but a search has no such
  protection, and "tsconfig" came back as forty vendored hits burying the four that were the
  answer. Ignored paths are now excluded by default, with a toggle in the search box to opt back
  in. The default asks git rather than walking, which is both exact and far cheaper: 18,583 paths
  in 0.55s where walking the same checkout yields 200,000+ in 4.5s.

### Fixed

- **Every changelog release links to its diff again.** The reference at the foot of the file is
  what turns a `## [0.21.0]` heading into a link, and nothing enforced it, so it lapsed silently
  for seventeen consecutive releases. Backfilled, along with a reference pointing at a version
  this file has no entry for and an `[Unreleased]` link still comparing from v0.15.2. A check now
  fails the build rather than letting it rot again.

## [0.21.0] - 2026-08-15

### Added

- **Browse the whole repository, not just its changed files.** The file panel could only ever show
  files git had noticed. The viewer was always capable of opening any path, but the panel simply had
  no way to list one, so everything you had not edited was unreachable from inside the app. A
  toggle in each card's header now swaps the changed-file list for the entire working tree, using
  the same viewer, the same icons and the same panel. A file that IS changed keeps its status
  letter, so switching modes loses no signal, and the toggle sits outside the changed-files
  section on purpose: a clean repo is precisely when you want to read the code.
- **Ignored paths are included, and the tree loads one folder at a time.** Showing `dist/` and
  vendored bundles is the point: that is exactly what `git ls-files` hides and what you
  occasionally need to open. It is also what makes a whole-tree listing impossible rather than
  merely slow: a working checkout here runs past 200,000 files once `node_modules` is counted,
  seconds of disk to enumerate and a payload the browser would then have to turn into 200,000
  nodes. So a folder's contents are fetched the moment it is opened (about a millisecond, a few
  dozen entries) and folders nobody opens are never walked. Folders therefore start collapsed,
  the opposite of the changed-files tree.
- **Find a file anywhere in the repo.** Searching only the folders already expanded would look
  like it searched the repository and quietly not have, so the search walks the real tree,
  breadth-first, so shallow matches, nearly always the wanted ones, are found before the walk
  reaches a dependency tree. Bounded by both a result cap and a wall-clock budget, and it says
  when the answer is a head rather than the whole set. Clicking a folder result clears the query
  and opens the tree down to it.

Both new endpoints are owner-only. Reading a path you were handed is a different capability from
enumerating a repository, and the listing covers ignored files, which is exactly where `.env`
files and local credentials live. A view share stays "look at what I changed", not "walk my disk".

### Changed

- **A click no longer waits behind the background work.** Local git reads share one daemon-wide
  pool, and it was two slots deep with a plain first-come queue that had no idea who was waiting.
  Boot hydration fans out over every known repo with sixteen workers and the filesystem watcher
  runs sixteen concurrent refreshes, so expanding one card could put its `git status` behind two
  dozen reads draining two at a time. Seconds of "Loading changes…" caused entirely by queue
  position rather than by anything about the repo. It is also why some repos felt instant and
  others did not: which ones was luck.

  The queue now has a foreground lane, marked once at the HTTP boundary, because an inbound request is
  the definition of "someone is waiting for this", and nothing else reaches it, so background work
  cannot pick the marker up by accident. The pool also widens from two to half the machine's cores
  (clamped to 4–8): a single card expand issues four reads, so at two it could not fill even its
  own request in one pass. Background work is already coalesced and retried, so deferring it
  briefly costs nothing you can see.

### Fixed

- **A greyed-out view option now says why, in the menu.** The reason lived only in a `title`
  attribute, which is close to invisible, given the switch dims to 45% and a native tooltip wants a second
  of hover on a control nobody suspects is disabled. Every row in the changed-files view options
  needs "Diff statistics" turned on, and that ships off, so on a fresh install the whole popover
  was inert while looking like an ordinary menu that simply ignored you. Nothing was broken; it
  just never said so.

## [0.20.9] - 2026-08-14

### Fixed

- **A whitespace-only change is shown as a change.** Monaco's diff editor ignores leading and
  trailing whitespace by default, which is a reasonable default for a code editor and the wrong one
  for a git client: two lines differing only in trailing space were declared identical. The pane
  then drew no highlights and collapsed nothing, so a file the changed-file row beside it called
  `+1 -1` sat there side by side looking untouched. The list and the viewer disagreed about whether
  the file had changed at all, and the viewer was the one lying. Trailing whitespace is a real edit
  in this tool's world: it is exactly what a codemod leaves behind and what a formatter then
  strips, so it gets shown.
- **The diff pane waits for the diff instead of revealing the file un-diffed.** The viewer hides
  itself until Monaco's diff worker returns its first result, because until then Monaco paints
  precisely that: the whole file, nothing folded, nothing highlighted. But the safety net that
  guarantees an eventual reveal was a flat 600ms, and on a large file or a loaded machine the worker
  takes longer, so the net won the race and revealed the very state it existed to hide. The reveal
  deadline and the diff deadline were sharing one number; they are not the same thing. The diff
  event is the real signal and now gets 5s, with the timer back to being the failure path it was
  meant to be. Where no listener could be attached no event is ever coming, so that case reveals
  immediately rather than holding a blank pane.
- **"Showing 2000 of 13350 changed files" is no longer a dead end.** The cap is right as a default:
  it keeps the ordinary card render cheap and stops a mis-cloned repo producing a multi-megabyte
  payload. It is wrong as a ceiling, because a repo-wide codemod genuinely does dirty that many
  files. A "View all" now sits beside the notice and re-reads against a second, much higher bound
  that still refuses a pathological tree. The choice is sticky per repo, so the automatic refresh
  after a commit or a stage does not silently snap an expanded list back to the first 2000.

### Internal

- **The shared UI kit's MCP engine is re-synced.** A mechanical sync of the optional `initialize`
  `instructions` field from lunarwerx-ui, which owns that code. Behaviour here is unchanged: this
  server supplies no instructions, and the engine omits the field entirely rather than emitting it
  empty, so the initialize result is byte-for-byte what it was.

## [0.20.8] - 2026-08-13

### Added

- **The "Update available" badge installs the update.** Settings already told you a newer build
  existed and then left you with nothing to press
  ([#20](https://github.com/LunarWerxs/RepoYeti/issues/20)). The scheduled apply is hours away by
  design, and on an installed PWA that Settings screen is often the only interface there is, with
  no terminal beside it. The badge is a button now: it opens the same offer the bell entry opens, and
  that dialog still owns the install, so tapping the badge changes nothing on disk. Both entry
  points go through one action that re-derives "can this be installed right now?" from the live
  status rather than from whatever the last announcement said, so a tree committed since that
  announcement no longer opens a dialog refusing to install. The announcement also re-reads the
  update status now: it was read once at startup and never again, so an update announced while the
  dashboard was open reached the bell while the Version row went on saying there was nothing to
  install, and the badge that opens the offer never appeared at all.
- **A changelog link sits beside the version.** "What changed?" is the question a version number
  provokes, and the answer was on a machine with a terminal. It points at `CHANGELOG.md` on the
  branch rather than the Releases page: a source checkout updates off the branch and routinely
  sits ahead of any published release, so the file is what matches the build you are running.

### Fixed

- **The Settings tabs stay put when the panel is scrolled.** On a phone the tab row slid up behind
  the panel's title and then past it into the panel's clipped top edge, leaving "Settings" and
  "General" superimposed and the tabs sheared in half. That is the artifact visible in
  [#20](https://github.com/LunarWerxs/RepoYeti/issues/20)'s screenshot. The panel's body is
  deliberately tucked underneath its translucent title bar so rows shimmer through as they scroll,
  which reads as intended for rows of settings and as a bug for a control. The tab row is pinned
  under the title now, and stays usable while a long tab scrolls beneath it. It reproduces on any
  window short enough to make the panel overflow, not only on a phone. At a phone's full height
  the General tab can just fit, which is why it was hard to catch by hand.

## [0.20.7] - 2026-08-12

### Fixed

- **A pushed repo stops looking unpushed.** After a successful push the button stayed green, as
  though the commits were still waiting, until someone hit Refresh
  ([#17](https://github.com/LunarWerxs/RepoYeti/issues/17)). The daemon was right all along. It
  re-reads status after every action and broadcasts it, but the client that pressed the button
  had to wait for its own event to travel back over SSE, and Refresh was the one action that read
  its status straight from its own HTTP response. Every mutating action now answers with the state
  it produced, and the initiating client reconciles from that. The broadcast is still what tells
  the OTHER clients. This matters most where the stream is least reliable: a phone that
  backgrounds mid-action misses the frame outright, and a stream whose client falls behind is
  deliberately closed rather than left silently lossy. Fetch, pull, commit, smart commit, checkout,
  branch, stash, tag, remote edits, and the per-file stage/discard/delete/ignore actions all
  reconcile the same way now. A share-link guest's copy is redacted exactly as the broadcast
  already was, so the second delivery path cannot leak a credentialed remote URL.
- **"Visual bars" works on a phone.** The History panel switches to a compact two-line row below
  640px, and that row rendered numeric totals unconditionally, so choosing Visual bars did nothing
  in the only layout a phone ever shows ([#18](https://github.com/LunarWerxs/RepoYeti/issues/18)).
  It honours the setting now, on a narrower track since it shares a line with the author, age and
  hash rather than owning a column.
- **The History view-options button explains itself to a finger.** It labelled itself with a native
  `title`, which no touch device has ever displayed, leaving an unexplained slider icon on mobile
  ([#16](https://github.com/LunarWerxs/RepoYeti/issues/16)). It is a real tooltip now, reachable by
  press-and-hold. The tooltip sits on an inert wrapper rather than on the popover's own button:
  merging two reka `as-child` triggers onto one element is what broke the menu's click the last
  time this was attempted, and a quick tap must keep opening the menu in one tap.
- **Three more controls explain themselves on a phone.** The same native-`title` problem, found by
  sweeping for it rather than waiting for it to be reported: the branch switcher, the delete-branch
  button, the file viewer's overflow menu, and the commit box's recent-messages menu all labelled
  themselves with a `title` a touch device never renders. All four are press-and-hold tooltips now.
  The changed-files tree's row actions were left alone deliberately: that list runs to 2000 rows
  with every row in the DOM, and a tooltip instance per row is the exact thing measured as making
  it janky, so those need a different approach rather than this one.
- **Updating from source rebuilds the dashboard.** A source install's auto-update ran `bun install`
  at the repo root, which does not reach `web/`. That is a separate package with its own lockfile,
  not a workspace. The dashboard was then built against the previous commit's dependencies, or not
  at all, so a successful update could leave the PWA on the old build
  ([#16](https://github.com/LunarWerxs/RepoYeti/issues/16)). Both installs now run as one step, so
  the engine's rollback path gets the fix too. Packaged installs are untouched; they never build.
- **A reconnect re-hydrates collaboration presence.** Peer presence is pure SSE with no polling
  fallback, and was fetched only at the first connect, so a frame missed while a phone was
  backgrounded stranded a departed collaborator on screen indefinitely. The reconnect resync now
  covers it like everything else.
- **An unattended update is visible while it happens.** The daemon announces both phases of a
  background auto-update; the dashboard subscribed to those events and had no handler for either,
  so it showed nothing at all while the daemon went away for minutes. Settings now reads "Updating"
  and then "Restarting", which also explains the disconnect that follows instead of letting it read
  as a fault.
- **The mobile bulk-action bar is labelled and reachable.** Below 640px the Pin/Star/Hide/Remove
  buttons drop their text labels, which left them with no accessible name at all, and their 24–28px
  hit areas were under a finger's target, on a touch-only flow. They carry `aria-label`s now, and
  a pseudo-element grows each target to 40px vertically without moving anything (sideways would
  overlap the neighbour, and one of these neighbours is Remove).

## [0.20.6] - 2026-08-11

### Added

- **Tooltips answer to a finger now.** reka-ui ignores touch pointers on hover, so on a phone every
  tooltip in the dashboard was unreachable. Worst of all `InfoHint`, whose text is the only place a
  setting's description exists, which made that copy effectively invisible on mobile
  ([#16](https://github.com/LunarWerxs/RepoYeti/issues/16)). Info icons now open on a single tap and
  close on a tap outside, Escape, or a scroll; every other tooltip opens on a press-and-hold. A
  plain tap on an action button still just runs the action: the hold is what reveals, and the click
  it ends with is swallowed so nothing fires behind the tooltip. Sliding a finger abandons the hold,
  so scrolling past a tooltipped control is unaffected, as is mouse hover, keyboard focus, and the
  app-wide "show tooltips" switch. Info icons also gained a finger-sized tap target around their
  14px glyph, at no cost to layout.
- **Settings shows the version actually running.** With auto-update enabled, the terminal and
  `/api/health` were the only ways to tell which build was live, neither of them reachable from an
  installed PWA ([#15](https://github.com/LunarWerxs/RepoYeti/issues/15)). General, then Updates,
  now leads with it and flags an update the daemon has already found. It reports the DAEMON's
  version rather than the page's, so it stays honest after a self-update and reconnect.

## [0.20.5] - 2026-08-11

### Added

- **The installed PWA finds its own daemon after a tunnel rotation.** An installed app is pinned
  to the origin it was installed from, and a quick tunnel re-hosts the daemon on a fresh hostname
  every restart, so after an update the app opened onto a dead origin and the only fix was
  reinstalling it ([#15](https://github.com/LunarWerxs/RepoYeti/issues/15)). The shell now
  remembers its permanent `app.repoyeti.com/r/<id>` address while connected, and when its
  connection stays dead on a `*.trycloudflare.com` origin it asks the relay where the daemon
  moved and navigates itself there, path and hash intact. Inert on localhost and on stable or
  custom domains.
- **An opted-in auto-update now waits for the daemon to be idle.** The unattended apply defers
  while an MCP approval is pending or a git operation is in flight, retrying in five minutes
  rather than a full check interval, and background read churn can only postpone it six times in
  a row before it proceeds anyway. Being told an update exists is never delayed, only the
  unattended restart.

## [0.20.4] - 2026-08-11

### Fixed

- **`start --tunnel` now QR-codes the address worth bookmarking.** The permanent
  `app.repoyeti.com/r/<id>` address has been the default stable front door for a while, but the
  terminal only ever printed the raw `*.trycloudflare.com` URL, which rotates on every restart, so
  a phone that scanned the QR lost access the moment the daemon was updated
  ([#15](https://github.com/LunarWerxs/RepoYeti/issues/15)). The terminal now prints the raw URL
  immediately (marked as rotating) and draws the QR once the stable address is live; if the relay
  is off, fails, or takes too long, it falls back to the raw URL so something scannable always
  appears. Named tunnels and relay opt-outs behave exactly as before.

## [0.20.3] - 2026-08-10

### Added

- **An anonymous install ping, so we know RepoYeti is actually being used.** A compiled release
  already checked `studio.connections.icu/v1/app/repoyeti/latest` for updates; that same request now
  carries an `X-Install-Id` header (a random id persisted locally) and doubles as the install ping,
  so it costs zero extra network calls. A source checkout has no update check of its own, so daemon
  boot now fires the same ping directly, throttled to at most once every 24h. The ping carries only
  a random install id, the running version, and a coarse OS tag; see the [Privacy](README.md#privacy)
  section for exactly what the server derives from the request itself. Set `REPOYETI_NO_PING=1` to
  opt out entirely; it is already off under `NODE_ENV=test`, `CI`, and `REPOYETI_DEV=1`.

### Removed

- **The old `REPOYETI_PULSE_URL` / `CONNECTIONS_PULSE_URL` "product pulse" is gone.** That collector
  (`POST /api/pulse`, and the web app's `app_opened` beacon) was never actually stood up anywhere, so
  in production it never sent a single event. The install ping above replaces it with something that
  is actually live.

## [0.20.2] - 2026-08-10

### Added

- **A Windows download that can show a system-tray icon.** The new
  `repoyeti-windows-x64-with-tray.zip` bundles the same executable with the `misc\` tray toolkit.
  RepoYeti draws no tray icon itself, a small separate launcher does, so a release download could not
  have one however its settings were set, and the script that sets it up was reachable only from a
  clone. Grab that zip, run `misc\Create-Shortcut.ps1` once, and launch from the shortcut. The
  plain zip is unchanged: it is the automatic updater's transport and stays a single file.

### Fixed

- **The tray icon survives an Explorer restart.** When the Windows shell restarts it destroys every
  tray icon and expects each app to add its own back. The launcher never listened for that, so the
  icon vanished for the rest of the session while the app kept running normally, and relaunching
  the shortcut only reopened the UI.
- **A tray icon that fails to appear at startup now retries instead of giving up.** The launcher
  assumed its first attempt had worked; if it had not (most often because the taskbar did not exist
  yet, on a launcher started at logon), nothing ever tried again.
- **Two timer-round tests no longer fail at random.** They drive a real remote round-trip over a
  dozen-odd git processes, which measured 3.0-6.3s on Windows against a 5s default allowance, so
  they failed intermittently on process spawn time alone. They now carry an allowance matching what
  they actually cost.

## [0.20.1] - 2026-08-10

Remote sign-in works again, and the app works offline again. Thanks to Renan Franca
([@renanfranca](https://github.com/renanfranca)) for reporting all three issues and contributing
the sign-in fix.

### Fixed

- **Signing in from your phone over a Quick Tunnel works.** Sign-in used to be rejected with
  "redirect_uri is not registered" because every tunnel gets a fresh temporary address and the
  login service only accepts a registered one. Login now returns through RepoYeti's stable
  callback, which forwards it to wherever your daemon currently lives. The callback only ever
  passes the login response along; your dashboard and Git traffic never touch it, and it cannot
  read your session. Contributed by Renan Franca.
- **The dashboard loads offline again.** A dependency pin had silently emptied the offline cache
  at build time, so the installed app only cached a handful of static files instead of the app
  itself. The pin is gone, its security intent is preserved, and the full app shell is cached
  again.
- **A tunnel that cannot start now says why.** If `cloudflared` is missing, RepoYeti prints what
  is wrong and how to install it instead of sitting at "Starting cloudflared tunnel…" forever,
  and keeps serving locally. Docs no longer claim the tunnel client is bundled: it never was, on
  any install.
- **Running from a source clone is reproducible.** The quick start now leads with the prebuilt
  release, and the clone path includes the dashboard's separate install and build steps that a
  fresh checkout needs before the daemon has a UI to serve.
- **Turning the share-link relay off is honest about the one announcement sign-in still needs.**
  A Quick Tunnel must tell the stable callback where it lives or sign-in cannot return; that
  announcement now logs itself instead of happening silently, and a named tunnel avoids it
  entirely.

## [0.20.0] - 2026-08-09

A security and hardening release from a full-codebase audit, followed by adversarial review rounds
until a round found nothing left. Nothing in the way you use RepoYeti changes; several ways it could
have surprised you no longer can.

### Added

- **Dropping a stash and deleting a branch now confirm first.** They join discard and delete-file
  behind an explicit confirmation that names the exact thing it is about to remove, so a mistap on a
  phone can no longer throw away work that has no undo.
- **Files that look like secrets are held back from AI providers.** When Smart Commit or an AI commit
  message sends a diff to your provider, a file that looks like it holds credentials (a `.env`, a
  private key, a credential store) keeps its contents out of what is sent, while still appearing in
  the commit so the message stays accurate. Every provider now states at connect time that diffs
  leave your machine, not only the custom-endpoint option.

### Fixed

- **Share links no longer expose the owner's details.** A view-only link could receive a repo's
  unredacted remote URL (which can carry an access token), the owner's identity and account bindings,
  and raw error text containing local file paths. Guests now get a projected view with all of that
  removed, on every route rather than most of them.
- **"Sign out everywhere" revokes the API token, and "Sign out" clears the local-access cookie.**
  Neither leaves a working credential behind after you have asked to be signed out.
- **The dashboard recovers from a dropped live connection.** Updates missed while a phone was asleep
  are reconciled the moment it reconnects instead of leaving a repo card stale, and a session that
  expires mid-use returns you to sign-in instead of failing silently.
- **The auto-updater verifies every download against a published checksum before installing.** It
  refuses an update it cannot verify.
- **Assorted correctness fixes across git operations and startup.** File writes and moves are
  serialized against concurrent git operations, an interrupted network operation cleans up the lock
  it leaves behind, a stale database migration failure is reported instead of silently swallowed, and
  a repository living under a folder with accented or non-Latin characters no longer slips past the
  secret-file protection above.

### Security

- **Process launches on Windows are injection-proof.** A repository or file path containing shell
  metacharacters can no longer change what the daemon runs when it opens an editor, relaunches after
  an update, or shows the app window.
- **Config-file secrets are protected at the filesystem level when there is no OS keychain.** They
  are also never removed from disk until the keychain has actually been confirmed to hold them.
- **The dashboard's static files and every API route are path- and size-guarded.** Static files are
  served through a strict path check that cannot be walked out of, and every API route has a
  request-size ceiling.

### Internal

- **Settings routes validate their input through the shared schema layer**, like every other route.
- **The architecture and configuration docs were corrected to match the code** (the secrets design,
  the self-update engine, the real database schema).

## [0.19.1] - 2026-08-06

### Changed

- **Inter ships with the app instead of being fetched from Google's CDN.** The shared kit's base
  stylesheet opened with a remote `@import`, and a remote import at the head of a render-blocking
  stylesheet is itself render-blocking: nothing painted until the browser had been to Google and
  back. That is free on a warm HTTP cache, which is why it went unnoticed, but it is dead time on
  a first load or after a cache eviction, and an outright stall with no network, on a dashboard
  that is normally reached over your own LAN. Both Latin subsets of Inter's variable woff2 now
  ship with the web bundle, so the UI renders offline, with no flash of fallback text.

### Internal

- CI and Release can be started manually, so a commit or a tag can be built without waiting on a
  webhook. GitHub's standard mitigation for an Actions incident is to throttle webhook triggers,
  which lands the push and creates no run at all.
- Follow the sibling app's rename to AgentHydra in vendored comments.

## [0.19.0] - 2026-08-01

### Added

- **Merge conflicts can be resolved with AI, one region at a time.** A conflicted repo card now
  lists its unmerged files and offers "Resolve with AI" on each one. The model proposes a
  resolution per conflict region; you review them side by side with what git actually found, edit
  anything you want to change, and only the regions you tick are written. Off-limits by design:
  nothing is ever staged, so git keeps refusing the commit until you stage it yourself, and any
  region you skip keeps its conflict markers untouched.

  Because a wrong merge is code that compiles, unlike a wrong commit message, which you read
  before it lands, every proposal is checked mechanically as well as by the model. RepoYeti
  compares each resolution against both sides and the common ancestor and flags the telling
  cases: a line both sides kept that the resolution dropped, an output that is mostly new code,
  a region that merely picked a side. Those findings are shown above the code and are shown
  whatever confidence the model claimed for itself.

  The panel also names the model that will run and warns harder when it looks like a small, fast
  tier, including some of RepoYeti's own recommended defaults, which were chosen for cheap
  commit messages rather than for this. It is advice, not a gate. Turn the whole feature off in
  Settings → AI if you would rather not have the button. Owner-only: share-link guests cannot
  reach it, even with control permission.

- **A scan now tells you which projects it found, and lets you undo any of them.** "Found 51
  projects, 7 new" named none of the seven, so the only way to see what had just been added to
  your dashboard was to go hunting for it. The modal now lists every new project by name and
  path as it finds them, each with a Discard button. A scan cannot ask before it adds, because
  it has to index and watch a repository to read its status at all, so this is the undo rather
  than a prompt: discarding also tombstones the path, and a later scan will not put it back.

- **"Reset to A–Z" in the actions menu clears a saved drag order.** The first drag stamps a
  position onto every repository at once, and from then on anything newly discovered can only
  sort below all of them, permanently, whatever it is called. That is why scanned projects
  collected at the bottom of the list and stayed there across restarts. Resetting drops the
  saved positions and hands the list back to plain alphabetical ordering, with drag-to-reorder
  still available.

### Fixed

- **A repository found by a scan now shows its status without a reload.** Newly discovered
  repositories sat with no clean/dirty badge and a dead Push button until the whole dashboard
  was reloaded, which also made a repository that was genuinely behind look unpushable. The
  dashboard was caching the raw object from the discovery event rather than the reactive one the
  list actually renders, so every status update that followed wrote to a copy nothing was
  watching. Reloading appeared to fix it only because that rebuilt the cache from scratch.

- **A newly discovered repository is inserted where it belongs, not appended.** Scans added
  their finds to the end of the list in raw filesystem-walk order. They now land in the same
  position a fresh start would give them.

- **The mode buttons in "Add a repository" respond to the pointer.** Point to folder, Create
  new, Clone and From Lore had no hover feedback and no visible selection, so the group read as
  one flat block rather than four choices. Hover and the selected state were both painted in the
  same colour as the strip behind them. Fixed in the shared UI kit, so every toggle built on it
  gets the same treatment.

- **Closing "Add a repository" without adding anything resets it.** Reopening used to resume the
  half-filled form in whichever mode was last used. Stepping out to the scan modal is treated as
  a detour rather than a dismissal, and keeps what you had typed.

- **The scan modal can hand back to "Add a repository".** Opening it from there was a one-way
  door: the only exits dropped you on the dashboard with no route back to the flow you were in.

## [0.18.0] - 2026-07-30

### Added

- **The commit history can be dragged taller, so a big screen shows more than a screenful of
  commits.** A grip under the list sets the height you want; the panel keeps it until you
  double-click the grip to go back to the default. The height is remembered across restarts and
  applies to every repo card, because how much screen the history deserves is a preference rather
  than something that differs per repository. Keyboard works too: ↑/↓ nudge it, Delete resets it.

### Changed

- **Double-clicking a resize grip now eases back to the default size instead of jumping.** Both the
  history grip and the changed-files grip animate the reset. This needed more than a CSS rule:
  releasing a dragged height hands the element back to `height: auto`, which browsers cannot
  animate to, so the reset had always landed as an instant snap. The grip now holds the exact
  height the panel is about to settle at for the length of the transition. Respects
  `prefers-reduced-motion`, where the reset simply lands.

## [0.17.0] - 2026-07-29

### Added

- **Buzz Git compatibility is available as an Advanced experimental integration.** Owners can opt
  in, save public Buzz community URLs, run non-interactive Git/helper/relay/authentication
  diagnostics, and clone from Buzz through the existing Git backend without storing a Nostr key.
  Buzz and Lore now share one clean Experimental servers card with independent support toggles.

### Fixed

- **Large dirty repositories no longer make the daemon consume gigabytes of RAM or flood Windows
  with Git processes.** Diff parsing and untracked-file reads now have stable native-memory bounds,
  child output, collaboration/SSE queues, browser caches, and native watchers are byte/count capped;
  broad scans honor the configured repository budget; ignored temp trees do not retrigger refreshes;
  and the opt-in periodic all-repo fetch runs as a low-impact serial sweep. Porcelain-v2 status
  hydration also reuses one ref snapshot, cutting an ordinary refresh from four Git commands to
  two. Background network polling is now off by default; local watcher updates remain event-driven.

## [0.16.0] - 2026-07-28

### Added

- **The changed-files view is more informative and controllable.** Owners can switch totals between
  numbers and proportional addition/deletion bars, choose whether character totals appear, and use
  a compact view-options popover. File rows now distinguish live and resolved merge conflicts, and
  safely offer deleting files or whole folders while refusing repository roots and nested checkouts.
- **Commit assistance now sees new files.** Untracked text is included in scoped and whole-tree
  commit diffs, within firm file and byte caps, so generated plans can describe newly created work
  instead of treating it as an opaque filename.

### Changed

- **History gives the commit list more room while reading.** The activity overview collapses after
  a deliberate downward scroll and returns on an upward scroll, while preserving keyboard focus and
  reduced-motion behavior.
- **Working-tree refreshes cover ordinary filesystem edits more reliably.** The watcher observes
  relevant worktree changes as well as Git metadata, filters its own build churn, and coalesces
  bursts into one refresh.

## [0.15.3] - 2026-07-27

### Added

- **Tick a whole folder's files from one checkbox.** Folder rows in the changed-files tree had no
  checkbox, so selecting a build output directory for "Commit selected" cost one click per file
  inside it. A folder's box now covers every file beneath it, recursively, and is tri-state:
  checked when all of them are selected, a dash when only some are, so a collapsed folder still
  shows that a selection exists inside it. Clicking a partly-ticked folder fills it up rather than
  clearing it, so a half-ticked folder can never quietly discard files you picked by hand.

## [0.15.2] - 2026-07-26

### Added

- **The file viewer now previews the files people actually inspect.** Markdown renders as
  sanitized GitHub-style documentation, while browser-native images, PDF documents, audio, and
  video open in bounded inline previews from either the working tree or commit history. Binary
  responses verify their signatures, reject oversized content, sandbox SVG, and support byte
  ranges for media playback.

### Changed

- **Windows releases are single-file again.** Ship an icon-bearing GUI executable alongside the
  compact ZIP consumed by automatic updates. The dashboard is embedded, so releases no longer
  contain loose `web` or `node_modules` directories.
- **Connections sync is safer across devices and accounts.** Upgrade to the 1.2 engine, including
  one-step first-account seeding, nested conflict-safe patches, and a five-second final flush that
  cancels a stuck token or network request rather than delaying shutdown indefinitely.

### Fixed

- **Double-click startup opens the dashboard normally.** RepoYeti no longer opens a console that
  reports no configured scan routes and then appears to do nothing.
- **Release builds install the embedded dashboard dependencies.** Fresh tag runners now restore
  both lockfiles before compiling, so every supported platform can produce the one-file bundle.
- **The Windows updater ZIP is validated correctly.** Release automation now treats the
  one-line archive listing as a one-item list instead of indexing the first character.

## [0.14.0] - 2026-07-25

### Added

- **The primary commit button is configurable.** Settings → Appearance can now make either
  **Commit** or **Commit & Sync** the default action. The preference persists locally, updates
  every repository card immediately, and safely falls back to a plain commit when a repository
  has no sync target.
- **History now explains repository activity at a glance.** Compact colored cards and an
  interactive chart cover hourly, daily, and monthly activity with accurate additions, deletions,
  commits, contributors, and churn. Historical line statistics are cached once stable; tooltips
  are color-coded and offset from the pointer; range changes transition without blanking the
  panel; and contributor chips apply an exact, pagination-safe History filter. Appearance controls
  can independently hide the overview or colored branch map and can replace numeric change totals
  with proportional green/red bars. Commit rows also gain a right-click menu for details, copying
  commit/author information, and jumping to parents; the Changes, Date, Author, and Commit columns
  are centered consistently.
- **Any OpenAI-compatible endpoint can power commit assistance.** Owners can bring an HTTPS base
  URL, API key, and exact model ID, with optional model discovery, URL-only presets for Hugging
  Face Router and DashScope, and keyless loopback support for local models. Redirect blocking,
  bounded input, OS-backed secrets, and guest-safe error redaction keep the provider-neutral path
  inside RepoYeti's existing security boundary.

### Changed

- **Large installations now put firm bounds around background work.** Startup hydration, scans,
  GitHub account discovery, identity detection, bulk fetch/pull, and collaboration publishing use
  small worker pools, coalesce duplicate reads, and cap long-lived caches instead of creating one
  process or promise chain per repository. Ordinary status refreshes also inspect Git operation
  markers directly from `.git` metadata rather than launching another Git child.
- **The dashboard does substantially less work before and during interaction.** Settings,
  repository bodies, the file viewer, and Monaco load only when first needed; static assets stream
  compressed; Monaco stays out of the PWA precache; large diff algorithms, history, and detail
  caches are bounded; stale file/store requests are cancelled or ignored; and off-screen cards and
  large changed-file trees avoid repeated full-DOM work.
- **Release downloads are complete platform bundles.** Each archive keeps the compiled daemon,
  built dashboard, and optional native runtime sidecars together, so a downloaded release runs
  without requiring a source checkout or a separately built web app.

### Fixed

- **Manually resized working trees no longer stop at their current content height.** Dragging the
  grip can give a short changed-files list as much vertical workspace as desired, the exact
  per-repository height survives reloads, and double-clicking the grip restores the global
  content-fitting height preset. A small gap below the final file makes the end of the list
  visually unambiguous. In automatic mode, live file additions and removals now explicitly
  remeasure the viewport so it grows and shrinks with the visible rows up to that preset, using
  a short firm ease-out animation that yields to direct dragging and reduced-motion preferences.
- **Pull preview and Pull now make the same safety decision.** The preview models RepoYeti's actual
  fast-forward-only pull, fingerprints HEAD, upstream, staged blobs, and the working tree, and
  clearly marks divergence, conflicts, unsafe local changes, or an unknown/stale result. Pull
  turns destructive red and disables itself when the preview says the operation is unsafe instead
  of promising a clean merge and failing afterward.
- **History reacts to Git changes made outside RepoYeti.** Branch, tag, packed-ref, reftable, linked
  worktree, staged-blob, and equal-count path changes now participate in revision identity.
  Recursive ref watching remains descriptor-bounded and falls back once to jittered polling when
  a required native watch cannot be installed or later fails.

## [0.13.1] - 2026-07-24

### Changed

- **Collaboration presence is event-driven instead of browser-polled.** Known repository changes
  publish immediately, stopped peers expire through one daemon timer, and a slower fallback still
  catches edits made outside RepoYeti. Concurrent triggers coalesce so status and diff subprocesses
  cannot queue behind obsolete samples.
- **Large repository scans and operation queues stay bounded.** Discovery now enforces its repository
  cap across concurrent directory reads, honors cancellation and whole-walk deadlines even when a
  filesystem call stalls, and uses amortized constant-time queues for both scanning and Git gates.

### Fixed

- **Hosted remote access now recovers from a broken relay identity instead of spinning forever.**
  RepoYeti keeps the relay keypair together in the owner-only config, validates it before every
  announce, migrates and removes the former Credential Manager entry, and rotates the complete
  identity when the stored halves do not match. Relay-only status events no longer erase a healthy
  Cloudflare tunnel URL, and the UI shows the actual relay failure while using that direct URL.
- **Behind notifications now reconcile with current repository state.** Pull, fetch, refresh,
  removal, and later background checks update the existing notification in place or clear it once
  the repository is no longer behind, rather than leaving a stale commit count in the bell.
- **Organization repositories now choose the GitHub account that can actually push.** When a
  remote owner is an organization rather than a signed-in login, RepoYeti checks each authenticated
  account's repository permissions and automatically uses the unique writable account (or the
  active writable account when several qualify). The repo picker now calls this mode “Automatic”
  and names permission-derived choices instead of implying it blindly uses the active account.

## [0.13.0] - 2026-07-23

### Added

- **Live collaboration between RepoYeti installations.** A share can allow collaboration
  independently of View or Commit access. The recipient pastes the invitation into their own
  RepoYeti, maps a local checkout to one of the shared repositories, and appears live on the
  owner's card. The owner can switch between Mine, Theirs, and Combined changed-file views and
  expand a bounded unified diff for tracked peer edits. Working-tree snapshots contain
  repo-relative paths, Git state, line/character totals, and that encrypted diff, never credentials
  or absolute paths, and are authenticated with the share secret before going directly to the
  owner's tunnel. Revoking or rotating the share cuts off future updates. A Connections identity
  supplies the collaborator label; their own remote access can remain off.
- **Accepted collaborations are available to MCP agents.** New read-only tools list both
  directions of collaboration, inspect a sharer's dirty paths/status, and fetch an individual
  remote diff. A separate mutating tool can commit, fast-forward pull, and push the sharer's
  checkout only when the share is still collaborative and control-tier, the local MCP Safety
  Rail approves it, and an opaque owner-computed fingerprint proves the dirty state has remained
  unchanged under observation for at least ten minutes. It never amends. The general MCP surface
  also gains `repo_changes`, so agents can inspect dirty paths and their staged/stat state before
  requesting a diff or commit.

### Changed

- **Remote addresses are now three explicit choices.** `https://app.repoyeti.com` is the
  zero-input default. The Access panel can instead expose Cloudflare's generated quick-tunnel
  address directly, or use a named tunnel on a domain the owner controls. The older
  `go.repoyeti.com` address remains routed so previously issued links keep working.
- **Remote access now uses progressive disclosure.** The stable hosted choice and current address
  stay visible while the Cloudflare/custom-domain choices fold behind Change. The header dialog
  uses the stable hosted URL, shows an existing live share link when one is available, and links
  directly to the full create/edit/revoke screen.
- **Guest AI use is owner-controlled and bounded.** Share guests use only the owner's selected
  default provider, receive no provider/model metadata, and are limited per share link to ten
  requests per minute with at most two running concurrently. The owner can disable guest commit
  generation altogether.

### Fixed

- **Leaving a shared dashboard now visibly leaves it.** The button clears the guest cookie and
  replaces the dashboard with an explicit completion screen instead of reloading into a state
  that looked unchanged or like an unrelated owner sign-in.
- **Share-link guests can use the sharer's AI provider for commit messages.** Provider calls were
  already daemon-side, but the guest UI skipped the owner's redacted AI settings and incorrectly
  stopped at a local “no API key” check. Guests now receive only two capability booleans; the
  provider, model, and key remain on the sharer's daemon, which returns only the generated result.
- **The hosted address no longer loses a startup race to Cloudflare.** Settings now follows the
  daemon's hosted-by-default state while status hydrates, so it cannot latch onto a temporary
  `trycloudflare.com` URL. Pending hosted registration and intentionally temporary Cloudflare
  links also receive different, accurate warnings.
- **Collaboration views and remote commits revalidate the actual bytes.** Presence snapshots
  refresh their encrypted patch even when an edit keeps identical line totals, and an MCP-driven
  remote commit carries the exact owner-observed fingerprint so the sharer's daemon can reject a
  tree that changed between observation and mutation.

### Security

- **Stable-address relay private keys now live in the OS keychain.** Existing plaintext keys are
  migrated out of `config.json`; only the public relay identity remains there. Keychain-less
  systems retain the documented local fallback rather than silently losing their stable address.
- **Shared file and diff reads cannot escape through links or Git metadata.** RepoYeti resolves
  symlinks and Windows junctions before reading, confines the real target to the repository, and
  blocks `.git` path segments case-insensitively across read, write, move, diff, and commit-file
  routes.
- **Frontend security dependencies are pinned to patched releases.** DOMPurify, `fast-uri`, and
  `brace-expansion` receive explicit safe overrides, while Monaco is updated to the current
  compatible release.

## [0.12.0] - 2026-07-23

### Added

- **Copy an existing share link.** Every link in Settings → Accounts → Sharing now has a copy
  button, so re-sending one no longer means regenerating it and breaking the copy the other person
  already has. RepoYeti keeps each link it mints in its local database to make this possible, which
  is a deliberate trade: that file now holds working links rather than one-way hashes of them. It
  never leaves your machine (settings sync carries preferences only, never secrets), and anything
  able to read it could already mint links of its own. Revoking a link erases its copy. Links made
  before this update were never kept, so theirs is greyed out and says so; regenerating one is the
  way to get a copyable link, at the usual cost of retiring the old one.
- **Tray shortcuts can forward dropped files and folders.** Dropping paths onto a shortcut built
  from `misc/Tray-Launch.vbs` now passes them to an adapter through the opt-in
  `LUNARWERX_TRAY_DROP` process variable. Plain launches and adapters that do not support drops
  keep their existing behavior.

### Changed

- **Unread notifications are easier to spot.** The header count badge is now destructive red
  instead of the app's brand green, keeping it visually distinct from ordinary enabled and
  success states.

### Fixed

- **A share link now shows the same dashboard you see.** Pinned and Starred arrived at the other
  end flattened, so whoever you sent the link to got one long unlabelled list instead of your
  Pinned section on top and a collapsible "All repositories" below it. Both flags now survive the
  trip, and they update live: pin something and the guest's sections re-group without a reload.
  There was never a second UI to maintain; the daemon was blanking the two fields the one UI
  groups by. Everything that was private stays private: commit identities, linked GitHub accounts,
  auto-commit and any credential embedded in a remote URL are still stripped, and a guest still
  cannot pin or star anything.
- **"Share every repo" no longer includes the ones you hid.** Hiding a repo is how you retire it
  here, so a "share all" link was handing out repos you had already taken off your own dashboard.
  Hidden repos are now out of scope for those links entirely: gone from the list, and their
  per-repo URLs answer 404 rather than merely being unlisted. Hide one while someone has the link
  open and it disappears from their view live; unhide it and it comes back. Sharing a repo by
  picking it explicitly is unchanged and still wins, because naming it is a decision that outranks
  a dashboard-declutter flag.
- **The file viewer closes when its repo disappears.** Removing a repo (or, on a share link,
  losing access to it) dropped the card but left the file drawer open on it, looking live while
  every button in it quietly failed. It now closes with the card.

## [0.11.0] - 2026-07-20

### Added

- **A stable address out of the box.** The permanent forwarding address is now the default (on
  once remote access is on) instead of an opt-in toggle: a fresh daemon gets one link that
  survives restarts with zero configuration. Configuring your own domain switches you to it and
  quietly steps the relay aside; an explicit opt-out in the config is still honored.
- **"Custom address" is one honest toggle.** Off by default; turning it on opens the domain
  editor, and turning it off with a domain configured asks before removing anything. A new
  [setup guide](docs/STABLE_ADDRESS.md) walks through creating the Cloudflare named tunnel,
  the part nobody could have guessed from an input box.
- **Cloud sync says what "not connected" means.** Signed-in-but-disconnected now explains that
  the daemon keeps its own credential (your browser session is separate) and that Reconnect
  restores it.

### Fixed

- **Settings toggles stick again.** "Watch specific folders" no longer flips itself back on at
  every settings open, an over-helpful auto-disclose overrode the saved choice, and it's gone.
- **The Accounts tab fits on one line.** "Accounts & access" wrapped the tab bar; it's just
  "Accounts" now.
- **One Connections account, one place.** The "Signed in with Connections" card moved into
  Cloud sync (it used to float under Git identity, where it looked like a git thing), and Cloud
  sync no longer offers "Sign in with Connections" while you're already signed in, a sync that
  lost its connection says so and offers Reconnect instead.
- **The stable address no longer presents as an editable mystery.** The active address shows as a
  status line; the hostname/token editor is folded behind "Change or remove this address…".

### Changed

- **The built-in stable address got a real name.** New links use `https://go.repoyeti.com`
  instead of the `…workers.dev` hostname. It's the same Worker and store behind a custom domain,
  so every link already registered keeps resolving, nothing to migrate. (The free fallback
  hostname is `repoyeti.lunawerx.workers.dev`.)
- **Running your own relay is a linked click away.** "Use a different relay" now points at the
  setup guide, so pointing RepoYeti at a relay you host isn't a guess.
- **Advanced grew the tuning knobs.** External editor, Keyboard shortcuts, and the large-file
  diff threshold moved from General to Advanced; Updates is just "Updates" again.

## [0.10.0] - 2026-07-20

### Added

- **History shows changed files as a folder tree.** Expanding a commit lists its changed files as a
  collapsible folder tree (the same look as the Changes panel), toggleable in Settings → Appearance
  (a flat path list is still available). A commit touching more than a few hundred files opens with
  its folders collapsed, so a pathological commit is a scannable directory overview rather than a
  wall of rows. Rename provenance and per-file line counts show on every row.

- **A permanent share link, without needing a domain.** Remote access → **Permanent link** turns on
  a relay that gives this RepoYeti one address that never changes and forwards to wherever it
  currently lives. Without it, a zero-config tunnel is handed a fresh hostname on every restart, so
  every link you already sent quietly stops resolving and the recipient sees what looks like a
  broken link. Off until you turn it on, and only your current address is ever published, never a
  repository name, a path, or the link itself. Share tokens ride in the URL fragment, which browsers
  do not transmit, so the relay cannot see or redeem the link it forwards. Owners with a stable
  named tunnel are told they don't need it.

- **Cloning a private repo works for any account you're signed in to,** not just the active one,
  the same fix as below, applied to the clone URL.
- **Repos sync as the right GitHub account on their own.** If a repo's own git config names an
  account, or its remote is one you're signed in to, RepoYeti now authenticates as that account
  without being told to. Previously this was the cause of a baffling failure: `git` would refuse
  with *"could not read Password for 'https://someone@github.com'"* naming an account that
  `gh auth status` listed as signed in on the very next line, because the GitHub CLI's credential
  helper only ever serves whichever account is *active*, and declines for every other one.

### Changed

- **Switching a repo's GitHub account no longer changes your machine's active account.** The
  credential is handed to that one git command instead. Previously syncing a repo flipped the
  active account for every other tool on the machine (terminals, editors, agents) and left it
  flipped; with several repos syncing at once they could also interleave and authenticate as each
  other. Both are gone.
- **A failed sync says which account it needed.** The raw git error is replaced with a plain one
  naming the account and how to fix it.
- **"Address has changed" is now measured against the address links are actually handed out on.**
  With the relay on, a tunnel restart no longer flags every healthy link as stale, while links
  minted before the relay was switched on are still flagged, because those really are dead.
- **Settings is reorganized.** A new Advanced tab holds the rarely-touched tools (agent rail,
  identity firewall, Lore servers); Accounts and Access merged into one tab; the General tab
  consolidated its lone sections; and Ctrl/⌘+Enter to commit is now on by default instead of behind
  a power-user toggle. Sharing's row actions are icon buttons with tooltips, and a tooltip on a
  disabled button now actually shows.

## [0.9.0] - 2026-07-18

### Added

- **Share links can be edited, and re-keyed.** A link's name, tier, expiry and repo list are now
  editable in place: the URL you already sent keeps working and simply grants whatever you set.
  Separately, **Regenerate** mints a fresh URL for the same link, which is the way back when you
  lose the original: the daemon only ever stored a hash of the token, so the plaintext genuinely
  cannot be recovered. Regenerating kills the previous URL, and says so before it does.
- **Collapsible dashboard sections.** Pinned, Starred and the rest each fold away, and the state
  is remembered across reloads.
- **A long commit message collapses.** History clamps a big body to a few lines behind a Show more
  toggle, so a generated changelog can't push the changed-files list off the card.

### Changed

- **Share links warn that a quick-tunnel address is temporary.** A zero-config tunnel gets a fresh
  random `*.trycloudflare.com` hostname every time RepoYeti restarts, and links are built against
  whatever the address was when they were minted, so a restart silently kills every link already
  sent, and the recipient sees a DNS failure that reads as "your link is wrong". The panel now says
  this up front and points at the named tunnel, whose address survives restarts.
- **The remote-access dialog leads with the link, not the QR code.** The QR is behind a button next
  to the URL, Copy moved inside the URL box, and there's a route to share links, which were
  previously undiscoverable from the one screen about sharing access.
- **Sign in with Connections opens in a new tab** instead of navigating away from whatever you had
  open. The dashboard re-checks your session when the window regains focus.
- **Settings rows are consistent.** Working tree height, Default editor and the large-file diff
  threshold are laid out like every other setting (label left, control right). The editor picker
  lists only editors actually installed, and is named "Default editor". "Agent Safety Rail" is now
  "MCP Safety Rail"; "Tell me about updates" is "Auto-check for updates".
- **The create-a-share-link form is disclosed on demand.** It sat permanently open under the list
  of links; now it's one button until you want it, and the freshly-minted link auto-dismisses once
  you've had a chance to copy it.
- **A behind-remote notification is titled with the repo.** Which repo it is was the one part you
  couldn't guess, and it was buried in the description under a generic "Behind remote".
- **The repo name sits where it should.** The drag handle shrank to the width of its glyph and lost
  its hover plate, reclaiming a gutter of dead space to the left of every repo.

### Fixed

- **Switching commits in History no longer throws you up the page.** Opening one commit closes the
  previously open one, and when that one was tall and above, the collapse pulled the row you just
  clicked off the top of the screen. It's now held in place while the layout settles.
- **The pull-preview caret matches its button.** It took the accent colour when the repo is behind
  (it was hardcoded grey), matches the button's height, and opens a menu like every other caret in
  the app. In the shared view, where the caret isn't offered, Pull no longer renders with a flat
  right edge joined to nothing.
- **Right-click works on folders in the working tree.** Reveal, copy path, stage, ignore and
  discard now apply to a whole folder; ignoring a build directory previously meant one right-click
  per file inside it.
- **A read-only file tree stops offering actions it can't perform.** The pull preview no longer
  draws per-file checkboxes, a pull is fetch + merge of a branch, so there is no such thing as
  pulling a subset, and its context menu no longer shows dividers around items that aren't there.
- **Toasts stack instead of hiding each other.** Ours carry Undo, and an older toast's Undo used to
  end up unreachable behind a newer one.
- **History rows are reachable by keyboard.** They were plain divs with a click handler, so they
  couldn't be focused or activated with Enter.

## [0.8.0] - 2026-07-18

### Added

- **Preview a pull before you take it.** The caret beside Pull opens a read-only view of what's
  actually incoming: the commits, the files they touch, and, when git can tell in advance, the
  paths that will conflict. Conflict detection uses `git merge-tree` against an in-memory tree, so
  asking the question never touches your working copy. Nothing is fetched or merged by looking.
- **Updates announce themselves instead of installing themselves.** RepoYeti now checks on a
  schedule and *tells* you when a newer version is ready, with a prompt offering **Update now** or
  **Later**. "Later" leaves an entry in the notification bell, so a deferred update is not a lost
  one. If an update exists but cannot be installed yet, usually because the working tree is dirty,
  the prompt says so and disables the button rather than failing silently.

### Changed

- **"Install updates automatically" is now separate from "Tell me about updates", and stays off.**
  Being told you are out of date and having the daemon restart itself unattended are different
  consents. Notification is on by default; the silent install is opt-in. Anyone who had the old
  combined setting enabled keeps the installer on, since that was an explicit choice.
- **Falling behind a remote raises a notification, not a banner over the page.** The warning used
  to sit across the middle of the dashboard in a tint too close to the background to read. It is
  now a persistent bell entry with a Pull button that resolves it in place, plus a compact
  one-line toast bottom-right. One entry per batch, replaced rather than stacked.
- **Auto-approve and auto-deny can no longer both be on.** They are opposite answers to the same
  question. Turning one on now turns the other off, and deny wins if a stored config somehow
  carries both.
- **The changed-files list grows to fit its contents.** The height setting is now a ceiling rather
  than a fixed size, so a repo with two changed files no longer renders in a tall mostly-empty
  box. The setting is also named for what it controls, "Working tree height", and the per-repo
  drag grip still caps an individual repo lower.
- **Turning diff statistics off now turns them off everywhere,** including inside the changed-files
  tree, where they previously stayed on. Where both are shown, lines and characters get distinct
  icons instead of two identical-looking numbers.
- **"Behind" and "changed" counts no longer share a colour,** which made a repo that was behind
  read at a glance as a repo with local edits.
- **Toasts moved to the bottom-right and stack vertically.** Stacked rather than collapsed behind
  one another, because our toasts carry Undo, and an Undo you cannot click is worse than a taller
  stack. While the bulk-action bar is up the stack lifts clear of it, so a toast can never land on
  the very Undo button a mis-clicked bulk action depends on.

## [0.7.0] - 2026-07-18

### Added

- **Select multiple repositories, then act on all of them.** The dashboard's ⋮ menu has a new
  **Select multiple**: every card turns into a checkbox row and a bar rises from the bottom with
  Pin, Star, Hide and Remove across the whole selection. "Select all" honours whatever filter is
  active, so it ticks what you can actually see and never a repo the search bar was hiding. Every
  bulk action offers Undo, and undo restores each repo's *own* previous state rather than blanket
  clearing the flag, so a repo you had already pinned stays pinned. Bulk Remove is still
  index-only and confirm-gated: no folder on disk is ever touched.
- **Per-commit change totals in the history table.** A new **Changes** column shows what each
  commit did (lines added, lines removed, files touched), sourced from `git log --numstat`.
  Big commits abbreviate (`+1.2k`) so the column can't blow out; the exact figures are on hover.
  Merge commits report nothing, because git prints no diff for one.
- **Files *and* lines on the collapsed repo card.** The header used to say only "40 changed". It
  now reads as a pair: how many files, and the line delta beside it. Collapsed you get bare
  numbers; expanding the card fills them into pills that name themselves ("40 files changed",
  "+1,439 −368 lines").

### Changed

- **AI providers are no longer all listed at once.** Settings showed the entire catalogue whether
  or not you used any of it. Now you see only the providers you have connected, plus an **Add
  provider** picker for the rest; pick one and its key form opens right there. The commit-style
  and diff-detail pickers also narrowed, so their labels stop wrapping.
- **The repo card's ⋮ menu moved** from the end of the fetch/pull/push row up to the card's
  identity line, immediately right of Refresh and the remote-presence cloud. Its contents are
  unchanged.
- **The changed-files tree is tighter and no longer crowds its right edge.** Rows lost a couple of
  pixels of height, and the status letter (M / D / A) gained the padding it was missing.
- **Pinned and Starred cards drop their own badge inside their own section.** The section heading
  above the card already says it; the icon only restated it. The badges still appear anywhere else
  the card shows up.
- **Collapse all stays put.** It used to vanish in list view or while searching, which changed the
  toolbar's button count and slid the other controls around under the pointer. It now stays in
  place and greys out when there is nothing to collapse.

### Fixed

- **The history table's column titles now sit over their columns.** The header row and each commit
  row are separate CSS grids, and both used content-sized tracks, so the header sized itself to
  the word "AUTHOR" while every row sized to its own author name and the two drifted apart by up
  to 23px. They now share one fixed template.
- **The Settings tab indicator no longer sits off-centre on its tab.** The sliding highlight was
  anchored with the tab strip's padding *and* translated by an offset that already included that
  padding, so it double-counted and rendered ~4px right of the tab it marks: dead space on the
  right of a wide tab, none on the left. (Fixed in the shared UI kit, so the other LunarWerx apps
  get it too.)
- **The Remove-repo dialog no longer scrolls sideways.** A long repo path forced the whole modal
  wider than the screen. The path now lives in its own scrolling box with a copy button.
- **Smart Commit falls back predictably when the AI planner is unavailable.** You choose what
  happens instead of it silently doing nothing.
- **Windows: the daemon no longer keeps its port pinned after exit.** Child processes are detached
  via WMI, so a restart doesn't hop to the next port.
- **Drag-to-reorder works for mouse users again**, and tall dialogs scroll instead of overflowing
  off-screen.

## [0.6.1] - 2026-07-16

### Fixed

- Shipped the portable-window type declarations that 0.6.0's release build left behind.

## [0.6.0] - 2026-07-16

### Security

- **A loopback CSRF-to-RCE hole on the local `/api` path is closed.** Any page you visited in a
  browser on the same machine could reach the daemon's local API. It now consumes the shared kit's
  loopback-guard primitive, so the check is one implementation across every LunarWerx app rather
  than a per-app copy.

### Fixed

- **Sign-in was broken for everyone, permanently.** A dead GitMob `client_secret` meant every
  attempt failed; there was no combination of retries that would have worked.
- **Portable-window sizing.** Forwarded launches now honour the `?window-size` hint, and a window
  that has never been opened before starts at a measured 840×760 instead of an arbitrary default.

## [0.5.0] - 2026-07-15

### Added

- **Rename and Remove, on every repo card** (overflow menu). Two things the dashboard simply had no
  button for.
  - **Rename** sets a display label. Your folder keeps its own name, nothing on disk is moved or
    renamed, and the label survives a rescan. Clear it to fall back to the folder name.
  - **Remove from RepoYeti** takes a repo out of the list *only*: the folder, the files and the git
    history are never touched. It also stops future scans re-adding it (a removal that a rescan
    silently undid would be no removal at all), and both actions offer Undo. Restore anything you
    removed from Settings.

### Changed

- Commit identities now stay out of the way until you use them. If you commit as one person, which
  is nearly everyone, the identity picker, the identity manager and the Identity Firewall are
  hidden, and the Settings tab reads "Accounts". They come back on their own the moment you save a
  second identity, pin a Firewall rule, or assign one to a repo; "Using more than one git identity?
  → Set up" turns them on by hand. GitHub accounts are unaffected and always shown: an account is
  who you authenticate as, an identity is the name on the commit, and only the second one was
  asking a question most people never need to answer.
- Smart Commit asks the model for each commit's body as a *list* of points rather than as one
  block of prose, and asks for roughly one point per file the commit touches. Prose has no unit to
  be short of, so "- improved db logic" was a complete answer and the model stopped there; a list
  of one point per file is not something a single vague line can satisfy.
- Commit-message style now sizes the AI's token reservation: `concise` reserves far less (it emits
  no body), `detailed` reserves more. Reduces rejections on rate-limited free tiers, where a
  provider gates on the reservation rather than what the reply actually uses.
- The AI's decoding is now set explicitly instead of inheriting each provider's default. Smart
  Commit decodes greedily, because it must return valid JSON and an unparseable reply costs a retry
  and then a worse, non-AI split.
- The message prompt's worked example now rides as a real example exchange (an example diff and its
  finished message, as prior turns) instead of text inside the instructions. Rendered in the
  instructions, its content leaked: one live run attributed the example's null-timestamp fix to a
  function in the actual diff. As a completed exchange it teaches the shape and stays attributed to
  its own change, zero leaks in six runs after the move.
- The message prompt tells the model how many files the change touches and asks for roughly one
  bullet each; a count derived from the tree can't be argued down or padded past.
- Commit bodies wrap at 72 columns in code, with continuation indent under each bullet. The prompt
  used to ask the model to wrap, which is asking it to count characters; no tool that cares does it
  that way.

### Fixed

- A scripted rebuild (`misc\Restart-Daemon.ps1` + `misc\Wait-Daemon.ps1`) can no longer end with
  RepoYeti not running at all. The restart killed only the daemon, so the old tray host survived
  with its auto-restart watchdog armed, and the relaunch raced it with a second tray host, a fight
  that on 2026-07-15 left zero instances within ~90 seconds. The old tray host is now a first-class
  kill target (found by its `RepoYeti-Tray.ps1` command line, killed before the daemon so no
  watchdog interferes), the replacement is launched detached via WMI so closing the terminal that
  ran the rebuild no longer tears the app down with it, and `Wait-Daemon.ps1` only declares victory
  after the new daemon stays up (same process, still answering) through a 30-second stability
  hold instead of one second after boot. Also fixed on the way: under Windows PowerShell 5.1 both
  scripts died at startup ("empty string" from `Split-Path`), because a `[CmdletBinding()]` script
  evaluates parameter defaults before `$PSScriptRoot` exists; the root now resolves in the body.
  (Shared tray-host kit files, the same fix landed in lunarwerx-ui and all four apps.)
- Smart Commit no longer reports a deleted line as a deleted function. It read each change with no
  surrounding lines, so a file whose only edit was dropping an unused local arrived as a lone
  deletion under a header naming the enclosing function, and the message said the function had
  been removed, in 4 of 6 measured runs. It now reads one line of context on each side, which shows
  the function still standing: 0 of 6 in the same test.
- AI commit messages write a real body instead of restating the subject. A body like
  `- generate plane pwa` under the subject `chore: generate plane pwa` had several causes and none
  of them was the model being lazy. The largest: a big file's diff was folded down to a list of
  symbol names with no code under it, so the message was written by something that had never seen
  the change, "Modified `AI_ADAPTERS` record to accommodate changes" was the best answer that
  input allowed. A folded file now carries real diff lines alongside its symbol map, sampled from
  the hunks that changed the most rather than whatever sat at the top of the file, and within the
  same per-file budget as before. The prompt also asked for "WHAT changed and WHY", which is
  satisfied by re-tensing the subject, and the reply's token reservation was sized for one-line
  bodies. Messages now name the function, file or flag that changed and how, grounded strictly in
  the diff, since the model has no repo history and inventing one reads worse than being brief.
- A trivial change still gets a short message: length follows how much the change has to explain,
  not how many lines it touched.

## [0.4.0] - 2026-07-13

### Added

- AI key health check at boot: a revoked or expired key raises a dashboard alert instead of failing silently later.
- Right-click menus on changed files: open, open in editor, reveal, copy path, add to `.gitignore`, discard.
- Dirty-diff gutter in the file viewer (added/changed/removed line markers).
- Reveal now selects the file, not just its folder.
- Optional auto-approve timer for agent (MCP) prompts (off by default).
- Dismiss and restore auto-detected git identities.

### Changed

- AI is now fully bring-your-own-key; the built-in key mechanism is gone. Keys stay in your OS keychain.
- Model lists hide non-chat models; each provider suggests a default on connect.
- AI commit buttons follow an "enabled" toggle, prompting if a key is still needed.
- Settings reorganized: Sync & Hotkeys split into Background Sync (Automation) and Updates & Hotkeys (General); notifications deep-link to the right tab; scan-roots behind a toggle.

### Fixed

- Pull no longer blocks on a dirty tree: it fast-forwards and keeps your edits, stopping only on a real file collision (`WOULD_OVERWRITE`).
- Branch switch no longer blocks on a dirty tree (same guard).
- Background auto-pull now covers dirty repos (still skips mid-merge/rebase).

## [0.3.0] - 2026-07-13

### Changed

- **Brand tray/taskbar icon regenerated** from the current yeti-medallion vector (the shipped
  `misc/RepoYeti.ico` had drifted to a generic placeholder). `misc/Make-Icon.ps1` rebuilds it
  from the committed `misc/RepoYeti-icon.png` master (re-rendered from `web/public/icon.svg`).
- **Settings split into tabs.** The settings sidebar now groups its ten sections under four tabs
  (General / Identities / Automation / Access) instead of one long scroll, landing on General so
  the everyday knobs come first and the power-user sections (Identity Firewall, Agent Safety
  Rail, AI providers, tunnel) stay one click away. The old combined identity-and-access section
  was split into `IdentitiesSection` and `AccessSection`.
- **Remote access asks, not redirects.** Flipping the Remote access toggle (Settings → Access,
  or the header Connection dialog) on an unclaimed daemon no longer bounces the page to the
  Connections OAuth login mid-toggle; it discloses an inline "Sign in with Connections" prompt
  instead. The Stable address (tunnel) block, "Sign out everywhere", and the
  editing-over-remote policy toggle are now hidden while remote access is off; they only
  apply when it is on.
- **Quieter search bar.** The repo filter box on the main page sits on a faint fill with no
  border until focused, so it reads as a utility instead of competing with the repo list.

### Fixed

- **Settings sidebar no longer opens with a tooltip already showing.** Opening the panel
  autofocuses its first control, and reka-ui discloses tooltips on focus, so the identities
  info-hint popped instantly. The shared kit's `InfoHint` now ignores non-keyboard focus
  (hover and keyboard Tab still disclose).

### Added

- **Portable window.** A Settings → Appearance toggle ("Portable window") that opens RepoYeti in
  a chromeless Chromium app window (`msedge`/`chrome --app=URL`, its own taskbar entry, no tabs
  or address bar) instead of a normal browser tab. Turning it on persists the setting and opens
  one immediately (`POST /api/portable-window`); the desktop tray launcher follows the same
  preference on every subsequent open, including a cold start before the daemon is up, by
  reading it off `runtime.json`. Off by default (a plain tab). Falls back to a normal tab/browser
  window when no Edge/Chrome install can be found. The window uses a dedicated Chromium profile
  (`~/.repoyeti/portable-profile`, shared by both the server route and the tray launcher) so it
  remembers its own size/position across launches instead of inheriting the main browser profile.

## [0.2.0] - 2026-07-09

A self-hosted remote git manager: a background daemon plus a mobile dashboard, packaged
as a single `bun --compile` binary. First feature release on top of the v0.1.0 initial tag.

### Release hardening

A pre-tag pass over the whole tree, focused on nothing shipping that shouldn't:

- Removed an internal engineering spec doc from the public tree and fixed every dangling
  reference to it; trimmed `docs/ARCHITECTURE.md` §16 down to the app-agnostic shared-kit
  story so it no longer names sibling projects.
- Scrubbed leftover codenames for sibling apps out of shared-kit file comments.
- One shared VS Code-style git-status color map now backs every place in the dashboard that
  colors a file by status, replacing four copies that had already drifted out of sync with
  each other.
- One shared identity-firewall glob matcher now backs both the daemon and the dashboard's
  display-only mirror of it, with new tests pinning down edge cases so the two can't
  silently diverge again.
- The self-updater now rolls back cleanly if a build fails partway through an update:
  on a failed install/build after pulling the new version, it restores the previous commit
  and reinstalls/rebuilds it, and reports honestly which step failed instead of leaving the
  install in a half-updated state. Covered by new tests that exercise the rollback against a
  real git repo.
- The optional Connections settings-sync and Lore VCS integrations are now both optional,
  lazy-loaded dependencies, a daemon that doesn't use either feature never pulls their SDKs
  into memory.
- Added last-resort process-level handlers for uncaught exceptions and unhandled promise
  rejections, so an unexpected error is logged instead of crashing the daemon silently.

### Added

- **Auto-commit timer.** An opt-in, daemon-wide scheduler that, for each repo you flag from its
  ⋯ menu, automatically runs the AI **Smart Commit** splitter over its uncommitted changes and,
  configurably, `pull --ff-only`s then pushes. Two schedules: **repeat on a timer** (every
  N minutes/hours, clamped [60s, 24h]) or **once a day** at a set local time. Pull and push are
  each independently toggleable (off = commit locally only). **Safety:** a repo with a merge
  conflict or that is mid-merge/rebase/cherry-pick is always **skipped** (never auto-committed) and
  surfaced via a warning toast; pull-before-push (and skipping the push if the pull fails) mirrors
  "commit & sync" so an unattended run can't publish over a diverged remote. Uses your configured AI
  provider to split the commits, falling back to a deterministic grouping when none is set. New
  daemon module `src/auto-commit.ts` (self-rescheduling timer, mirrors `remote-sync.ts`), a per-repo
  `auto_commit` column, `POST /api/repos/:id/auto-commit`, and the `autoCommit*` owner settings.
- **Tree ⇄ list view for a repo's changes.** A per-repo toggle in the changed-files toolbar (between
  "Search content" and Collapse All) flips the file view between the nested folder **tree** (default)
  and a flat **list** of full paths. Persisted per repo in `localStorage`, like the tree height and
  fold state; reuses the same rows so selection, discard, diff-stats, and keyboard nav are identical.
- **MCP server for AI agents.** A hand-rolled Model Context Protocol server (zero new deps,
  JSON-RPC 2.0 + MCP implemented directly) exposes RepoYeti's git operations to AI agents over
  two transports: **`repoyeti mcp`** (stdio, what an MCP client like Claude Desktop/Code or
  Cursor spawns) and **`POST /api/mcp`** (HTTP, auto-gated by the same `/api/*` auth). One
  transport-agnostic core drives **14 tools**, 8 read-only (`list_repos`, `repo_status`,
  `git_log`, `list_branches`, `git_diff`, `git_search`, `list_stashes`, `drift`) and 6 mutating
  (`git_commit`, `create_branch`, `git_checkout`, `git_push`, `git_pull`, `git_fetch`, each
  tagged `MUTATES`). The stdio server proxies to the local daemon over HTTP; the HTTP endpoint
  uses an in-process adapter. Either way every call runs behind the same op-queue and safety
  guards as the dashboard, the daemon never half-merges, no matter who asks.
- **CLI git verbs.** `repoyeti repos / status <repo> / log / branches / branch / checkout /
  commit / diff / drift / stash / push / pull / fetch`, real shell shortcuts (no `curl`) that
  drive the already-running daemon over its loopback HTTP API and pretty-print the result. They
  locate the live daemon and never start one or touch git in-process (single-instance respected).
  Honour `REPOYETI_BASE_URL` (override the daemon origin) and `REPOYETI_TOKEN` (Bearer auth for a
  remote daemon). Bare `status` stays the daemon-config summary; `status <repo>` is the git verb.
- **Opt-in API token (Bearer) for remote/headless agents.** An owner-minted token
  (`repoyeti token new` → `POST /api/auth/token`, value shown once; revoke/show too) lets a
  remote or headless agent authenticate over the tunnel with `Authorization: Bearer <token>` (or
  `REPOYETI_TOKEN` for the CLI/MCP) when there's no browser for the OIDC login. **Off by
  default**, when no token is set, auth is byte-for-byte the prior OIDC-only behavior. The token
  is a separate, local credential (constant-time compared, stored in the OS keychain), never
  touches connections.icu, and never weakens the default OIDC posture.
- **Machine-readable API surface.** `GET /api/openapi.json` serves an OpenAPI 3.1 document built
  by introspecting the live router against a curated metadata registry (per-route summary, tags,
  Zod request bodies, query params). It's the one `/api/*` path fetchable without sign-in, so
  agents and tooling can auto-discover the surface; a drift-guard test asserts every `/api` route
  appears in the doc.
- **Merge-commit detection.** The log/commit reads now capture parent hashes, so `LogEntry` and
  `CommitDetail` carry `parents: string[]` + `isMerge`, and `GET /api/repos/:id/log` accepts
  `?merges=only|exclude`. Surfaces in the CLI `log`, the MCP `git_log` tool, and OpenAPI. (Lore
  history is linear, so its backend reports `parents: []` / `isMerge: false`.)

### Changed

- **Maintainability reorg (structure-only, no behavior change).** The three god-files were split
  into layered directories: the read-only inspection layer moved to **`src/read/`**;
  `service.ts` (1075 lines) became **`src/service/`** (core / watch / actions / repo-mgmt / reads
  / files / guards + an `index.ts` barrel); `daemon.ts` (1159 lines) became **`src/http/`** (an
  `app.ts` composition root wiring per-domain `routes/*` behind the single `/api/*` auth
  middleware, plus `respond.ts` / `web.ts` / `openapi.ts`); and the CLI entry moved to
  **`src/cli/`** (a thin `main.ts` dispatcher + `lifecycle.ts`). `check-boundaries.ts` enforces
  the new layering (`read ⊥ service`, `cli ⊥ service/read/git`, MCP core ⊥ service/read/db).

- **Smart Commit (AI multi-commit splitter).** Turn a pile of unrelated working-tree changes into
  an ordered set of small, scoped commits. The daemon proposes a plan (`POST /api/repos/:id/commit-plan`
  → AI, with a deterministic heuristic fallback, nothing is committed), you review and edit it in a
  dedicated editor (rename subjects, move files between commits, reorder/merge), then execute
  (`POST /api/repos/:id/smart-commit`, which re-validates the edited plan against the live tree and
  commits each group in isolation, file-level only). A **YOLO mode** (Settings → AI) skips the review
  and commits the plan in one tap. Never auto-pushes.
- **VCS-agnostic backend.** Repos now carry a `vcs` kind behind a pluggable `VcsBackend` interface
  (`src/vcs/`). **git** is the default; **[Epic's Lore](https://dev.epicgames.com/documentation/en-us/lore)**
  is supported experimentally behind `REPOYETI_LORE=1`.
- **Server registry (API).** Register version-control servers and clone repos from them via
  `GET/POST/DELETE /api/servers` + `POST /api/servers/clone` (→ `cloneLoreRepo`). _Backend + routes
  only for now, the Settings → Servers UI is still pending._
- **Background remote-sync.** An optional periodic check (`src/remote-sync.ts`) keeps each repo's
  "behind" count fresh, with an opt-in **keep-in-sync** mode that auto fast-forwards safe (clean,
  non-diverged) repos. Cadence + toggles live in Settings (`syncCheck` / `syncIntervalSecs` / `keepInSync`).
- **Remote & tags management.** A per-repo "Remote & tags" dialog (repo card ⋮ menu) sets or
  updates the `origin` URL (a local config change, no network), so a repo you created with
  `git init` from the phone can finally be given a remote and pushed. The same dialog lists the
  repo's tags (newest first) and **creates a tag** (annotated when you add a message), optionally
  **pushing it to origin**, "tag a release from your phone." Backed by `POST`/`DELETE
  /api/repos/:id/remote` (URL-scheme validated), `GET /api/repos/:id/tags`, and
  `POST /api/repos/:id/tag` (git-only, ref-name validated).
- **Clone from URL.** The Add-repository dialog has a **Clone** mode: paste a git URL, pick a
  destination folder (must be inside a scan folder) and an optional identity, and RepoYeti clones
  it onto the machine, the new repo appears live. The URL scheme, target name, and destination
  are validated server-side before any git runs, and the chosen identity's SSH key is injected
  per-operation (same seam as fetch/pull/push).
- **Recent commit messages.** The commit box shows your last few commit subjects as one-tap
  chips, handy when typing on a phone.
- **Scan folders from the dashboard.** Add or remove discovery roots in **Settings → Scan
  folders** (no more CLI-only `repoyeti add-root`). Adding one scans it immediately and the repos
  stream in live; removing one drops the auto-discovered repos found under it (repos you added
  explicitly by path are kept). The empty state now offers "Add a scan folder" too.
- **Fetch all.** A header button fetches every repo that has a remote in one tap (bounded by the
  network gate), then reports a one-line summary of what succeeded / failed.
- **Sign out everywhere.** Settings → Access can invalidate the session on every device at once.
  Sessions are stateless signed cookies, so this rotates the daemon's signing key, every existing
  cookie stops verifying instantly.
- **Branches.** Each repo card now lists its local branches (with ahead/behind), lets you
  **switch** to one (refused on a dirty tree, "stash or resolve at your desk"), **create** a
  new branch (＋), and **safe-delete** a merged local branch (`-d` only; the current branch and
  protected `main`/`master`/`develop`/`trunk` are refused, and an unmerged branch surfaces
  `UNMERGED_BRANCH` rather than being force-deleted).
- **Commit history.** A lazy, paginated read-only log per repo (short hash · subject · author ·
  relative time; tap a hash to copy it), backed by `GET /api/repos/:id/log`.
- **Stash.** Stash all changes (including untracked) to escape the "dirty tree blocks pull"
  dead-end, then **pop** or **drop** from the phone. A conflicting pop keeps the stash entry and
  reports `STASH_CONFLICT` ("resolve at your desk") instead of leaving a silent half-merge.
- **Discard a file.** Revert one changed file to its last-committed state directly from the
  changes tree (confirm-gated), the inverse of the in-app editor. Path-confined and behind the
  per-repo op-queue, like every other mutation.
- **In-app file viewer.** Click any changed file in a repo's tree to open its contents in an
  inline Monaco (VS Code) editor, a right-side push-drawer on desktop (the page slides left
  and stays centred; drag the left edge to resize) or a bottom sheet on mobile. Read-only,
  syntax-highlighted, theme-aware. A **Content / Diff** toggle (defaulting to Diff) switches
  between the whole file and a HEAD ↔ working-tree diff with GitHub-style collapsed unchanged
  regions, plus a **word-level highlight** toggle and a **split / unified** layout toggle (all
  persisted). Backed by read-only, path-confined `GET /api/repos/:id/file` and `/diff`
  endpoints (binary, deleted-file, and oversized cases handled). Monaco is lazy-loaded and
  excluded from the PWA precache so it never bloats the initial app.
- **Internationalisation scaffolding (i18n).** All UI copy runs through `vue-i18n` rather than
  hardcoded strings, so locales can be added later. **Only English (`en.json`) ships today**,
  the earlier machine-translated drafts and the language switcher were removed; `bun run i18n:check`
  keeps the codebase translation-ready (no untranslated literals, no missing keys).
- **`bun run i18n:check`**, a compliance script that fails CI on untranslated UI strings,
  missing translation keys, or locale key-parity drift (templates are parsed with the Vue
  compiler, not regex).
- **VS Code-style file-type icons** in the changed-files tree, using the `vscode-icons`
  set (real per-language glyphs and colours, bundled offline, tree-shaken).
- **Resizable changed-files view**, a per-repo drag grip (with keyboard ↑/↓ and
  double-click-to-reset) plus a global default size (Small / Medium / Tall) in Settings.
- **Bring-your-own-key AI commit messages**, generate a commit message from the repo's
  diff via a configurable provider (Groq / OpenRouter / Gemini / Claude / ChatGPT /
  DeepSeek). Keys live on the daemon only and never leave the machine.
- **Sponsor credit** footer.
- **Launcher guard tests** (`tests/launcher.test.ts`), fail the build unless the one-click
  launcher is intact: the shortcut machinery (`Create-Shortcut.ps1`, `RepoYeti.vbs`,
  `RepoYeti-Tray.ps1`, `RepoYeti.ico`) exists, is **committed**, and is wired
  shortcut → wscript → vbs → tray → daemon + icon. On Windows it also runs the tray's new
  headless `-SelfTest` (bun on PATH + daemon entry + the icon actually loading into a
  `NotifyIcon`) and regenerates + resolves the root shortcut. Committing `misc/` (which was
  untracked) means a fresh clone always has a working shortcut + tray icon.

### Changed

- **Single instance + the launcher follows the real port.** The daemon already hopped past
  a busy port; now it records the port it ACTUALLY bound in `~/.repoyeti/runtime.json`, so the
  tray opens the right URL (validated with an auth-exempt `/api/health` probe) instead of
  blindly assuming the preferred port. A second launch detects the running daemon and exits
  rather than starting a rival on another port, across the tray, `bun run start`, and
  `bun run dev` (whose `--watch` reloads stay exempt so hot-reload still rebinds). The Vite
  dev proxy follows the same pointer.
- Web UI rebuilt on **reka-ui (shadcn-vue) + Tailwind v4** (replacing the earlier Naive UI
  prototype).
- **Filesystem-watch fallback polling.** A repo whose `.git` watch can't be installed (OS
  watch limits, unsupported filesystem) now falls back to low-frequency jittered polling and
  logs a warning, instead of silently going stale.

### Performance

- **Bounded git subprocess concurrency.** A daemon-wide read pool (status / changed-files)
  and a separate network pool (fetch / pull / push) cap how many `git` children run at once,
  so boot or a multi-client burst can't spawn hundreds and bog down the machine. Tune with
  `REPOYETI_GIT_READ_CONCURRENCY` / `REPOYETI_GIT_NET_CONCURRENCY`.
- **Progressive startup.** The daemon serves the dashboard immediately and hydrates repo
  statuses in the background (streaming each over SSE as it lands), so a slow or hung repo no
  longer delays the daemon from coming up.
- **Coalesced refreshes.** Bursts of watcher/poll events for one repo collapse into at most
  one in-flight read plus one trailing pass, instead of stacking a deep queue of soon-obsolete
  `git status` reads behind a slow operation.
- **Cached remote URLs.** The origin URL is cached per repo until `.git/config` changes,
  skipping a `git remote -v` subprocess on every status read.
- **Capped changed-file responses.** The changed-files API returns at most 2000 entries with a
  `truncated` / `total` marker, so a repo with tens of thousands of dirty files can't produce a
  multi-MB payload or freeze the tree view.

## [0.1.0] - 2026-07-06

Initial public tag of the daemon + dashboard, before the release-hardening pass.

## [0.0.1], Initial

- Daemon core: repo discovery, `.git` watchers, SQLite state, per-repo status engine,
  serialized op-queue, REST + SSE.
- "Sign in with Connections" auth (config-gated OIDC) + redirect shim.
- Git identities (per-operation `core.sshCommand` / `user.*` injection) and guarded
  fetch / pull (fast-forward only) / push (no force) / commit.
- cloudflared tunnel (+ QR) and the Vue 3 PWA dashboard.

[#22]: https://github.com/LunarWerxs/RepoYeti/issues/22
[#21]: https://github.com/LunarWerxs/RepoYeti/issues/21
[0.21.4]: https://github.com/LunarWerxs/RepoYeti/compare/v0.21.3...v0.21.4
[0.21.3]: https://github.com/LunarWerxs/RepoYeti/compare/v0.21.2...v0.21.3
[0.21.2]: https://github.com/LunarWerxs/RepoYeti/compare/v0.21.1...v0.21.2
[0.21.1]: https://github.com/LunarWerxs/RepoYeti/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.9...v0.21.0
[0.20.9]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.8...v0.20.9
[0.20.8]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.7...v0.20.8
[0.20.7]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.6...v0.20.7
[0.20.6]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.5...v0.20.6
[0.20.5]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.4...v0.20.5
[0.20.4]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.3...v0.20.4
[0.20.3]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.2...v0.20.3
[0.20.2]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.1...v0.20.2
[0.20.1]: https://github.com/LunarWerxs/RepoYeti/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.19.1...v0.20.0
[0.19.1]: https://github.com/LunarWerxs/RepoYeti/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.15.3...v0.16.0
[0.15.3]: https://github.com/LunarWerxs/RepoYeti/compare/v0.15.2...v0.15.3
[0.15.2]: https://github.com/LunarWerxs/RepoYeti/compare/v0.14.0...v0.15.2
[0.14.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/LunarWerxs/RepoYeti/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/LunarWerxs/RepoYeti/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LunarWerxs/RepoYeti/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LunarWerxs/RepoYeti/releases/tag/v0.1.0
[0.0.1]: https://github.com/LunarWerxs/RepoYeti/releases/tag/v0.0.1
