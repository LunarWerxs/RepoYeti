/**
 * NUL-delimited Git record decoders: the ONE place `--name-status` and `--numstat` output is
 * turned into file records.
 *
 * Why `-z` and why one decoder (1.0 audit, item 18). The commit-detail and incoming-preview
 * readers used to split human-oriented output by lines and tabs. That representation is lossy:
 * a path containing a tab or a newline (legal on Unix) breaks the split, and any path git decides
 * to quote (non-ASCII under the default `core.quotePath`, or a path with a control character) came
 * back as its C-quoted spelling — `"h\303\251llo.txt"` for `héllo.txt` — which names no file the
 * dashboard could then open. The two readers also parsed name-status and numstat rows separately
 * and zipped them by index, which holds only while both commands emit identical row sets.
 *
 * With `-z`, git terminates every field with NUL and never quotes, so the raw bytes are the path.
 * The shapes below were verified byte-for-byte against git 2.5x:
 *
 *   name-status:  <status>\0<path>\0                   e.g.  M\0src/a.ts\0
 *                 <R|C><score>\0<old>\0<new>\0         e.g.  R100\0old.txt\0new.txt\0
 *   numstat:      <added>\t<removed>\t<path>\0         e.g.  2\t0\tsrc/a.ts\0   ("-" counts = binary)
 *                 <added>\t<removed>\t\0<old>\0<new>\0 (rename/copy: the row ends after the second
 *                                                       tab; the two paths follow as two tokens)
 *   `git show -z --format=<fmt> …`: the format output comes first, NUL-terminated, then ONE
 *   newline, then the records. `git log -z --numstat --format=<fmt>`: commit records are
 *   NUL-separated (an empty token marks the boundary); inside one, the format line is followed by
 *   a newline and then the NUL-terminated numstat rows.
 *
 * Stats are joined to files by IDENTITY (`recordKey`: both paths for a rename/copy), never by
 * position, so a merge or a format quirk that makes one command emit a different row set cannot
 * staple a count onto the wrong file.
 */

export interface NameStatusRecord {
  /** The status letter only (A / M / D / R / C / T / U …); a rename/copy score is dropped. */
  status: string;
  path: string;
  /** Rename/copy source path (only for R / C). */
  from?: string;
}

export interface NumstatRecord {
  added: number;
  removed: number;
  /** True when git printed "-" for the counts. */
  binary: boolean;
  path: string;
  /** Rename/copy source path (only when git emitted the two-path form). */
  from?: string;
}

/** Split `-z` output into its NUL-terminated tokens; the empty tail after the final NUL is dropped. */
export function splitZ(out: string): string[] {
  const tokens = out.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  return tokens;
}

/**
 * Separate the `--format` line from the records in `git show -z --format=<fmt> --name-status`
 * (or `--numstat`) output. The header is the text before the first NUL; git prints one newline
 * after that NUL before the first record, which is skipped here so the record tokens are clean.
 */
export function splitShowZ(out: string): { header: string; records: string[] } {
  const nul = out.indexOf("\0");
  if (nul < 0) return { header: out.replace(/\n$/, ""), records: [] };
  const header = out.slice(0, nul);
  let rest = out.slice(nul + 1);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  return { header, records: splitZ(rest) };
}

const isPair = (status: string): boolean => status.startsWith("R") || status.startsWith("C");

/** Decode name-status record tokens (see the module note for the shapes). */
export function parseNameStatusZ(tokens: readonly string[]): NameStatusRecord[] {
  const out: NameStatusRecord[] = [];
  for (let i = 0; i < tokens.length; ) {
    const raw = tokens[i] ?? "";
    const status = raw[0] ?? "M";
    if (isPair(raw)) {
      out.push({ status, from: tokens[i + 1] ?? "", path: tokens[i + 2] ?? "" });
      i += 3;
    } else {
      out.push({ status, path: tokens[i + 1] ?? "" });
      i += 2;
    }
  }
  return out;
}

/** Decode numstat record tokens (see the module note for the shapes). Only the first two tabs of
 *  a row are separators: a path containing a tab is reassembled intact. */
export function parseNumstatZ(tokens: readonly string[]): NumstatRecord[] {
  const out: NumstatRecord[] = [];
  for (let i = 0; i < tokens.length; ) {
    const [addedRaw = "", removedRaw = "", ...rest] = (tokens[i] ?? "").split("\t");
    const inlinePath = rest.join("\t");
    const binary = addedRaw === "-" || removedRaw === "-";
    const added = binary ? 0 : Number(addedRaw) || 0;
    const removed = binary ? 0 : Number(removedRaw) || 0;
    if (rest.length > 0 && inlinePath === "") {
      // The two-path form: the row ended at its second tab; old and new follow as two tokens.
      out.push({ added, removed, binary, from: tokens[i + 1] ?? "", path: tokens[i + 2] ?? "" });
      i += 3;
    } else {
      out.push({ added, removed, binary, path: inlinePath });
      i += 1;
    }
  }
  return out;
}

/** A record's identity within one diff: the destination path, plus the source for a pair record,
 *  so a rename's stats join its rename and cannot land on an unrelated file of the same new name. */
export function recordKey(record: { path: string; from?: string }): string {
  return `${record.from ?? ""}\0${record.path}`;
}

/**
 * Decode `git log -z --numstat --format=<fmt>` into per-commit (header, numstat records) pairs.
 * The header is the format line verbatim; the caller parses its own fields. A commit with no
 * numstat rows (an empty commit) yields an empty record list.
 */
export function parseLogNumstatZ(out: string): Array<{ header: string; records: NumstatRecord[] }> {
  const commits: Array<{ header: string; rows: string[] }> = [];
  for (const token of splitZ(out)) {
    if (token === "") continue; // commit boundary: the next non-empty token is a header
    const current = commits.at(-1);
    // A header carries the caller's format; every caller here uses the unit separator in it, and
    // a numstat row never does (its separators are tabs). The header token also carries the
    // FIRST numstat row after its newline.
    if (token.includes("\x1f") || !current) {
      const newline = token.indexOf("\n");
      const header = newline < 0 ? token : token.slice(0, newline);
      const firstRow = newline < 0 ? "" : token.slice(newline + 1);
      commits.push({ header, rows: firstRow ? [firstRow] : [] });
      continue;
    }
    current.rows.push(token);
  }
  return commits.map(({ header, rows }) => ({ header, records: parseNumstatZ(rows) }));
}
