"""Committed bytes at HEAD of the product: daemon source (src/) and dashboard UI (web/src + web/public).
Prints daemon_bytes=<n> and web_bytes=<n>."""
import subprocess

EXTS = (".ts", ".mts", ".mjs", ".js", ".vue", ".css", ".html", ".svg", ".png", ".jpg", ".webp", ".ico",
        ".woff", ".woff2", ".json", ".webmanifest", ".txt")

listing = subprocess.run(["git", "ls-tree", "-r", "-l", "-z", "HEAD"], capture_output=True, check=True).stdout
daemon = 0
web = 0
for entry in listing.split(b"\0"):
    if not entry:
        continue
    meta, path = entry.decode("utf-8", "replace").split("\t", 1)
    size = meta.split()[3]
    if size == "-":
        continue
    low = path.lower()
    parts = path.split("/")
    if any(p.startswith(".") for p in parts):
        continue
    if ".test." in low or ".spec." in low or "__tests__" in parts:
        continue
    if not low.endswith(EXTS):
        continue
    if path.startswith("src/"):
        daemon += int(size)
    elif path.startswith("web/src/") or path.startswith("web/public/"):
        web += int(size)
print(f"daemon_bytes={daemon}")
print(f"web_bytes={web}")
