# Releasing RepoYeti

Cutting a release is three things: bump, tag, sign. The middle one is automated; the other two are
not, and the first one has bitten every release that skipped a step.

## 1. Bump the version in all THREE places

The version lives in three files and `tests/version-consistency.test.ts` fails the build if they
disagree, on all three OS legs. That guard exists because `web/package.json` once drifted three
releases behind.

- `package.json` (what the updater reads)
- `src/config.ts` `VERSION` (what `GET /api/health` reports)
- `web/package.json`

Then add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` **and** its link reference at the
bottom of the file. `bun run check:changelog` fails if a release heading has no link.

Run the gates AFTER the bump, not before:

```sh
bun run check          # includes check:imports and check:changelog
bun run check:coverage # the full suite plus the coverage floor
```

## 2. Tag, and let CI build

```sh
git tag -a v1.0.1 -m "..."
git push origin v1.0.1
```

`.github/workflows/release.yml` builds one self-contained executable per OS, packages five assets
plus `SHA256SUMS.txt`, and publishes the release. Wait for it to go green before step 3; there is
nothing to sign until the assets exist.

The release job runs only on a tag. A `workflow_dispatch` on a branch builds and smoke-tests
without publishing, which is the way to prove a packaging change before tagging.

## 3. Sign the Windows assets

The binaries CI produces are unsigned. Windows gives a browser-downloaded unsigned executable
Mark-of-the-Web and shows "Windows protected your PC, Unknown publisher", and Explorer propagates
MOTW into anything extracted from the zips, so the tray bundle's `.ps1` files hit execution policy
on top of that. `SHA256SUMS.txt` does not help: Windows never reads it, and a checksum only proves
a file is what the same pipeline uploaded, never who published it.

Signing runs **on the workstation**, through the Connections vault, not in CI. The Azure Artifact
Signing account is `lunawerxsigning`, certificate profile `lunawerx-public-trust`, endpoint
`https://eus.codesigning.azure.net/`, subject `CN=LUNARWERX LLC`. The `sign_artifact` tool reads
the account and endpoint from Azure rather than trusting typed values, leases the credential into
SignTool value-blind, timestamps against Microsoft's RFC-3161 authority, and verifies the result
with `Get-AuthenticodeSignature` before reporting success.

It is not in CI because that would need `AZURE_CLIENT_SECRET` as a GitHub Actions secret, and the
standing rule is that a secret value never passes through an agent's context on the way there.
`.github/workflows/release.yml` carries a correct, ready, switched-off signing step for the day a
human puts the secret in, or a self-hosted Windows runner with the vault exists.

### The procedure

1. Download every asset from the published release into a scratch directory.
2. Unzip `repoyeti-windows-x64.zip` and `repoyeti-windows-x64-with-tray.zip`. All three copies of
   the executable are byte-identical, so sign one and reuse it.
3. Sign, via the Connections MCP `sign_artifact`, with `expect_subject: "LUNARWERX LLC"`:
   - `repoyeti.exe`
   - `misc/lunarwerx-tray.exe`
   - `misc/Create-Shortcut.ps1`, `New-TrayShortcut.ps1`, `RepoYeti-Tray.ps1`, `Tray-Host.ps1`
4. Copy the signed executable over all three of its homes, and smoke it: `./repoyeti.exe --version`
   must print the release version. That is the same check the updater makes before it swaps a
   binary in, so a signed file that will not run is caught here rather than by a user.
5. Repack, **with PowerShell 7, not Windows PowerShell 5.1**. `Compress-Archive` under 5.1 writes
   backslash path separators into the zip, which is not what the ZIP spec says and not what CI's
   `pwsh` produced; verify with `[System.IO.Compression.ZipFile]::OpenRead(...).Entries` that every
   entry uses forward slashes. Structure must match exactly:
   - `repoyeti-windows-x64.zip` -> one entry, `repoyeti.exe`. The updater asserts this.
   - `repoyeti-windows-x64-with-tray.zip` -> `repoyeti-windows-x64-with-tray/repoyeti.exe` plus
     `repoyeti-windows-x64-with-tray/misc/` (8 files).
6. Regenerate `SHA256SUMS.txt` over all five assets. The Linux and macOS lines must come out
   IDENTICAL to the originals; if they moved, something was repacked that should not have been.
7. Upload the three Windows assets first, then `SHA256SUMS.txt`, with `gh release upload --clobber`.
   Order matters a little and fails safe either way: the updater fetches the manifest first, so a
   client that straddles the swap sees a hash mismatch and refuses, which is a failed update rather
   than a bad install.
8. Prove it from the outside: re-download the whole release from GitHub, run `sha256sum -c
   SHA256SUMS.txt`, and check `Get-AuthenticodeSignature` reports `Valid` with the LUNARWERX
   subject. Do not trust the local copies you just made.

## 4. Afterwards

- Check the release page renders and the asset list is all six files.
- If the release fixes a reported issue, comment on it with the version and close it. A commit
  message with `Closes #N` closes the issue but posts no link to the release.
