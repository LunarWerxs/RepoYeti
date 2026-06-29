// Per-file-type icon for the changes tree — the real VS Code "vscode-icons" set.
//
// Each entry is a Vue component from the vscode-icons collection, inlined at build
// time by unplugin-icons (see vite.config.ts) and tree-shaken to only the icons
// imported here. Colours are baked into the SVGs, so callers render the component
// as-is (no tint). Resolution order for files:
//   exact filename → known prefix (Dockerfile/.env) → compound suffix (.d.ts) →
//   final extension → generic file.
import type { Component } from "vue";

// ── languages ─────────────────────────────────────────────────────────────────
import Ts from "~icons/vscode-icons/file-type-typescript";
import TsDef from "~icons/vscode-icons/file-type-typescriptdef";
import Tsx from "~icons/vscode-icons/file-type-reactts";
import Js from "~icons/vscode-icons/file-type-js";
import Jsx from "~icons/vscode-icons/file-type-reactjs";
import VueIcon from "~icons/vscode-icons/file-type-vue";
import Svelte from "~icons/vscode-icons/file-type-svelte";
import Astro from "~icons/vscode-icons/file-type-astro";
import Py from "~icons/vscode-icons/file-type-python";
import Rust from "~icons/vscode-icons/file-type-rust";
import Go from "~icons/vscode-icons/file-type-go";
import Java from "~icons/vscode-icons/file-type-java";
import Kotlin from "~icons/vscode-icons/file-type-kotlin";
import Cpp from "~icons/vscode-icons/file-type-cpp";
import CLang from "~icons/vscode-icons/file-type-c";
import CSharp from "~icons/vscode-icons/file-type-csharp";
import Php from "~icons/vscode-icons/file-type-php";
import Ruby from "~icons/vscode-icons/file-type-ruby";
import Swift from "~icons/vscode-icons/file-type-swift";
import Dart from "~icons/vscode-icons/file-type-dartlang";
import Scala from "~icons/vscode-icons/file-type-scala";
import Haskell from "~icons/vscode-icons/file-type-haskell";
import Lua from "~icons/vscode-icons/file-type-lua";
import RLang from "~icons/vscode-icons/file-type-r";
import Perl from "~icons/vscode-icons/file-type-perl";
import Elixir from "~icons/vscode-icons/file-type-elixir";
import GraphQL from "~icons/vscode-icons/file-type-graphql";

// ── markup / styles ─────────────────────────────────────────────────────────────
import Html from "~icons/vscode-icons/file-type-html";
import Xml from "~icons/vscode-icons/file-type-xml";
import Css from "~icons/vscode-icons/file-type-css";
import Scss from "~icons/vscode-icons/file-type-scss";
import Sass from "~icons/vscode-icons/file-type-sass";
import Less from "~icons/vscode-icons/file-type-less";
import Svg from "~icons/vscode-icons/file-type-svg";

// ── data / config ────────────────────────────────────────────────────────────────
import Json from "~icons/vscode-icons/file-type-json";
import Json5 from "~icons/vscode-icons/file-type-json5";
import Yaml from "~icons/vscode-icons/file-type-yaml";
import Toml from "~icons/vscode-icons/file-type-toml";
import Ini from "~icons/vscode-icons/file-type-ini";
import Dotenv from "~icons/vscode-icons/file-type-dotenv";

// ── docs ──────────────────────────────────────────────────────────────────────
import Markdown from "~icons/vscode-icons/file-type-markdown";
import TextIcon from "~icons/vscode-icons/file-type-text";
import Log from "~icons/vscode-icons/file-type-log";
import Pdf from "~icons/vscode-icons/file-type-pdf2";
import Word from "~icons/vscode-icons/file-type-word";
import Excel from "~icons/vscode-icons/file-type-excel";
import Powerpoint from "~icons/vscode-icons/file-type-powerpoint";
import Todo from "~icons/vscode-icons/file-type-todo";
import License from "~icons/vscode-icons/file-type-license";

// ── shells ──────────────────────────────────────────────────────────────────────
import Shell from "~icons/vscode-icons/file-type-shell";
import Powershell from "~icons/vscode-icons/file-type-powershell";
import Bat from "~icons/vscode-icons/file-type-bat";

// ── media ─────────────────────────────────────────────────────────────────────
import ImageIcon from "~icons/vscode-icons/file-type-image";
import Video from "~icons/vscode-icons/file-type-video";
import Audio from "~icons/vscode-icons/file-type-audio";
import Font from "~icons/vscode-icons/file-type-font";

// ── archives / binaries / data ─────────────────────────────────────────────────
import Zip from "~icons/vscode-icons/file-type-zip";
import Binary from "~icons/vscode-icons/file-type-binary";
import Sql from "~icons/vscode-icons/file-type-sql";
import Sqlite from "~icons/vscode-icons/file-type-sqlite";

// ── keys / git / docker / tooling ──────────────────────────────────────────────
import Key from "~icons/vscode-icons/file-type-key";
import GitIcon from "~icons/vscode-icons/file-type-git";
import Docker from "~icons/vscode-icons/file-type-docker";
import Npm from "~icons/vscode-icons/file-type-npm";
import Yarn from "~icons/vscode-icons/file-type-yarn";
import Pnpm from "~icons/vscode-icons/file-type-pnpm";
import Bun from "~icons/vscode-icons/file-type-bun";
import Cargo from "~icons/vscode-icons/file-type-cargo";
import Composer from "~icons/vscode-icons/file-type-composer";
import Prettier from "~icons/vscode-icons/file-type-prettier";
import Eslint from "~icons/vscode-icons/file-type-eslint";
import Diff from "~icons/vscode-icons/file-type-diff";
import Cmake from "~icons/vscode-icons/file-type-cmake";

// ── fallbacks + folders ─────────────────────────────────────────────────────────
import DefaultFile from "~icons/vscode-icons/default-file";
import DefaultFolder from "~icons/vscode-icons/default-folder";
import FolderGit from "~icons/vscode-icons/folder-type-git";
import FolderGithub from "~icons/vscode-icons/folder-type-github";
import FolderSrc from "~icons/vscode-icons/folder-type-src";
import FolderDist from "~icons/vscode-icons/folder-type-dist";
import FolderDocs from "~icons/vscode-icons/folder-type-docs";
import FolderPublic from "~icons/vscode-icons/folder-type-public";
import FolderVscode from "~icons/vscode-icons/folder-type-vscode";
import FolderNode from "~icons/vscode-icons/folder-type-node";
import FolderTest from "~icons/vscode-icons/folder-type-test";
import FolderComponent from "~icons/vscode-icons/folder-type-component";
import FolderConfig from "~icons/vscode-icons/folder-type-config";

// ── extension → icon ──────────────────────────────────────────────────────────────
const byExt: Record<string, Component> = {
  ts: Ts, mts: Ts, cts: Ts, tsx: Tsx,
  js: Js, mjs: Js, cjs: Js, jsx: Jsx,
  vue: VueIcon, svelte: Svelte, astro: Astro,
  json: Json, jsonc: Json, json5: Json5,
  yml: Yaml, yaml: Yaml, toml: Toml,
  ini: Ini, cfg: Ini, conf: Ini, properties: Ini, env: Dotenv,
  html: Html, htm: Html, xhtml: Html,
  xml: Xml, xsl: Xml, xsd: Xml, plist: Xml,
  css: Css, pcss: Css, scss: Scss, sass: Sass, less: Less, styl: Sass,
  md: Markdown, markdown: Markdown, mdx: Markdown, rst: Markdown,
  txt: TextIcon, text: TextIcon, log: Log, rtf: TextIcon,
  pdf: Pdf, doc: Word, docx: Word,
  py: Py, pyw: Py, pyi: Py,
  rs: Rust, go: Go,
  java: Java, kt: Kotlin, kts: Kotlin,
  cs: CSharp,
  c: CLang, h: CLang, cpp: Cpp, cc: Cpp, cxx: Cpp, hpp: Cpp, hxx: Cpp,
  php: Php, rb: Ruby,
  swift: Swift, dart: Dart, scala: Scala, hs: Haskell, lua: Lua, r: RLang,
  pl: Perl, pm: Perl, ex: Elixir, exs: Elixir,
  graphql: GraphQL, gql: GraphQL,
  sh: Shell, bash: Shell, zsh: Shell, fish: Shell,
  ps1: Powershell, psm1: Powershell, psd1: Powershell,
  bat: Bat, cmd: Bat,
  png: ImageIcon, jpg: ImageIcon, jpeg: ImageIcon, gif: ImageIcon, webp: ImageIcon,
  bmp: ImageIcon, ico: ImageIcon, avif: ImageIcon, tiff: ImageIcon, tif: ImageIcon, heic: ImageIcon,
  svg: Svg,
  mp4: Video, mov: Video, webm: Video, mkv: Video, avi: Video, m4v: Video,
  mp3: Audio, wav: Audio, flac: Audio, ogg: Audio, m4a: Audio, aac: Audio,
  woff: Font, woff2: Font, ttf: Font, otf: Font, eot: Font,
  zip: Zip, tar: Zip, gz: Zip, tgz: Zip, rar: Zip, "7z": Zip, bz2: Zip, xz: Zip, zst: Zip,
  exe: Binary, dll: Binary, so: Binary, o: Binary, bin: Binary, wasm: Binary,
  sql: Sql, db: Sql, sqlite: Sqlite, sqlite3: Sqlite,
  csv: Excel, tsv: Excel, xlsx: Excel, xls: Excel,
  ppt: Powerpoint, pptx: Powerpoint,
  key: Key, pem: Key, crt: Key, cert: Key, pub: Key, p12: Key, pfx: Key,
  diff: Diff, patch: Diff,
};

// ── exact filename → icon (highest priority) ──────────────────────────────────────
const byName: Record<string, Component> = {
  "package.json": Npm,
  "package-lock.json": Npm,
  "yarn.lock": Yarn,
  "pnpm-lock.yaml": Pnpm,
  "bun.lock": Bun,
  "bun.lockb": Bun,
  "cargo.lock": Cargo,
  "cargo.toml": Cargo,
  "composer.lock": Composer,
  "composer.json": Composer,
  license: License,
  "license.md": License,
  licence: License,
  copying: License,
  todo: Todo,
  "todo.md": Todo,
  makefile: Cmake,
  "cmakelists.txt": Cmake,
  gemfile: Ruby,
  "gemfile.lock": Ruby,
  ".gitignore": GitIcon,
  ".gitattributes": GitIcon,
  ".gitmodules": GitIcon,
  ".gitkeep": GitIcon,
  ".dockerignore": Docker,
  "docker-compose.yml": Docker,
  "docker-compose.yaml": Docker,
  ".prettierrc": Prettier,
  ".prettierignore": Prettier,
  ".eslintrc": Eslint,
  ".eslintignore": Eslint,
};

const byFolder: Record<string, Component> = {
  ".git": FolderGit,
  ".github": FolderGithub,
  ".vscode": FolderVscode,
  node_modules: FolderNode,
  src: FolderSrc,
  dist: FolderDist,
  build: FolderDist,
  out: FolderDist,
  docs: FolderDocs,
  test: FolderTest,
  tests: FolderTest,
  public: FolderPublic,
  assets: FolderPublic,
  components: FolderComponent,
  config: FolderConfig,
};

/** Resolve a tree row's vscode-icons component. `isDir` switches map + fallback. */
export function fileVisual(name: string, isDir: boolean): Component {
  if (isDir) {
    // Compressed chains arrive as "a/b/c" — match on the top segment.
    const top = name.toLowerCase().split("/")[0] ?? name;
    return byFolder[top] ?? DefaultFolder;
  }
  const lower = name.toLowerCase();
  if (byName[lower]) return byName[lower];
  if (lower.startsWith("dockerfile")) return Docker;
  if (lower.startsWith(".env")) return Dotenv;
  if (lower.endsWith(".d.ts")) return TsDef;
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return byExt[ext] ?? DefaultFile;
}
