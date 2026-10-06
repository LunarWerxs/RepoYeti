"""Bytes of the minified Bun bundle of the daemon (src/index.ts), same flags as scripts/build.ts
minus --compile. Output goes to tmp/rsi-daemon (gitignored). Prints daemon_bundle_bytes=<n>."""
import os
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "tmp", "rsi-daemon")
shutil.rmtree(OUT, ignore_errors=True)
subprocess.run(
    ["bun", "build", "src/index.ts", "--target", "bun", "--minify",
     "--external", "@lore-vcs/sdk", "--external", "koffi", "--outdir", "tmp/rsi-daemon"],
    cwd=ROOT, shell=(os.name == "nt"), check=True,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
total = 0
for dirpath, dirnames, filenames in os.walk(OUT):
    dirnames.sort()
    for name in sorted(filenames):
        if name.endswith(".map"):
            continue
        total += os.path.getsize(os.path.join(dirpath, name))
shutil.rmtree(OUT, ignore_errors=True)
print(f"daemon_bundle_bytes={total}")
