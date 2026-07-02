/**
 * build-template-manifest.ts
 *
 * Generate `templates/<name>.manifest.json` by walking the
 * `templates/<name>/` directory tree and producing a canonical
 * manifest: sorted `relative path → mode + render + source sha256` plus a
 * `tree_sha256` derived from the sorted file list.
 *
 * Run: `pnpm run build:template-manifest --template <name>` (root workspace
 * script). Defaults to `monorepo-root` for backwards compatibility.
 *
 * Supported template names: monorepo-root, spring-boot, web, ios-tuist,
 * android (closed set, matches factory TEMPLATE_NAMES).
 *
 * Deterministic: output is stable given the same tree content; no timestamps,
 * mtimes, or platform-dependent ordering.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';

const TEMPLATE_NAMES = new Set([
  'monorepo-root',
  'spring-boot',
  'web',
  'ios-tuist',
  'android',
]);

// Dotfiles allowed in templates. Other hidden files (e.g. .DS_Store, .env)
// remain skipped — they are developer-local artifacts, not project config.
const ALLOWED_DOTFILES = new Set([
  '.gitignore',
  '.nvmrc',
  '.swiftlint.yml',
  '.tuist-version',
  '.xcode-version',
]);

// Binary files allowed in templates. The Gradle wrapper JAR is a fixed,
// untemplated binary required by Gradle; the official Gradle documentation
// says it should always be committed.
const BINARY_ALLOWLIST = new Set([
  'gradle/wrapper/gradle-wrapper.jar',
]);

// Parse --template <name> from argv.
function parseArgs(argv: string[]): string {
  const idx = argv.indexOf('--template');
  if (idx === -1 || idx + 1 >= argv.length) {
    return 'monorepo-root';
  }
  return argv[idx + 1] as string;
}

// Match {{token}} syntax. Used to flag files that need rendering.
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

interface ManifestFile {
  path: string;
  mode: '100644' | '100755';
  render: boolean;
  sha256: string; // "sha256:<hex>"
}

interface Manifest {
  template: string;
  path: string;
  tree_sha256: string; // "sha256:<hex>"
  files: ManifestFile[];
}

async function walk(root: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = `${root}/${entry.name}`;
    const rel = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isSymbolicLink()) {
      throw new Error(`Manifest refuses symlink: ${rel}`);
    }
    // Skip hidden files except the managed .github dir and a whitelist of
    // legitimate project config files used by the four platform templates
    // (.gitignore, .nvmrc, .swiftlint.yml, .tuist-version, .xcode-version).
    if (
      entry.name.startsWith('.') &&
      entry.name !== '.github' &&
      !ALLOWED_DOTFILES.has(entry.name)
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...(await walk(abs, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function assertSafePath(rel: string): void {
  if (rel.startsWith('/') || rel.includes('..')) {
    throw new Error(`Manifest refuses absolute or traversal path: ${rel}`);
  }
  if (rel !== posix.normalize(rel)) {
    throw new Error(`Manifest path not POSIX-normalized: ${rel}`);
  }
}

async function sha256Hex(data: Buffer): Promise<string> {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

async function fileMode(abs: string): Promise<'100644' | '100755'> {
  const s = await stat(abs);
  const mode = s.mode & 0o777;
  if (mode === 0o755) return '100755';
  if (mode === 0o644 || mode === 0o664) return '100644';
  // Default to 100644 if mode is non-standard (typical for checked-in text).
  return '100644';
}

function needsRender(data: Buffer, rel: string): boolean {
  // Binary files never need rendering.
  if (BINARY_ALLOWLIST.has(rel)) return false;
  // Reset the regex state.
  TOKEN_RE.lastIndex = 0;
  // Treat binary / CRLF as rejection later; here only detect render tokens.
  return TOKEN_RE.test(data.toString('utf8'));
}

function rejectBinary(data: Buffer, rel: string): void {
  // Allow binary files explicitly listed as safe (e.g. Gradle wrapper JAR —
  // the official Gradle documentation requires the wrapper JAR to be committed).
  if (BINARY_ALLOWLIST.has(rel)) return;
  // Reject files that contain NUL bytes (binary).
  if (data.includes(0)) {
    throw new Error(`Manifest refuses binary file content: ${rel}`);
  }
}

function rejectCRLF(data: Buffer, rel: string): void {
  // Skip binary files (already in BINARY_ALLOWLIST).
  if (BINARY_ALLOWLIST.has(rel)) return;
  if (data.includes(0x0d)) {
    throw new Error(`Manifest refuses CRLF line endings in ${rel}`);
  }
}

async function buildManifest(rootAbs: string, templateName: string, templatePath: string): Promise<Manifest> {
  const rels = await walk(rootAbs, '');
  rels.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  // Detect size/case collisions.
  const seen = new Set<string>();
  for (const rel of rels) {
    assertSafePath(rel);
    const lc = rel.toLowerCase();
    if (seen.has(lc)) {
      throw new Error(`Manifest detects case-insensitive collision: ${rel}`);
    }
    seen.add(lc);
  }

  const files: ManifestFile[] = [];
  for (const rel of rels) {
    const abs = `${rootAbs}/${rel}`;
    const data = await readFile(abs);
    rejectBinary(data, rel);
    rejectCRLF(data, rel);
    const mode = await fileMode(abs);
    if (mode !== '100644' && mode !== '100755') {
      throw new Error(`Manifest refuses mode ${mode} on ${rel}`);
    }
    const sha = await sha256Hex(data);
    const render = needsRender(data, rel);
    files.push({ path: rel, mode, render, sha256: sha });
  }

  // tree_sha256: digest of the canonical file list.
  const treeLines = files.map((f) => `${f.mode}  ${f.sha256}  ${f.path}`).join('\n');
  const treeHash = await sha256Hex(Buffer.from(`${treeLines}\n`, 'utf8'));

  return {
    template: templateName,
    path: templatePath,
    tree_sha256: treeHash,
    files,
  };
}

function canonicalJson(manifest: Manifest): string {
  // Field order matters for byte-identical output; JSON.stringify preserves
  // insertion order of keys.
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main(): Promise<void> {
  const templateName = parseArgs(process.argv);
  if (!TEMPLATE_NAMES.has(templateName)) {
    throw new Error(
      `Unknown template '${templateName}'. Supported: ${[...TEMPLATE_NAMES].join(', ')}`,
    );
  }
  const cwd = process.cwd();
  const templatePath = `templates/${templateName}`;
  const rootAbs = resolve(cwd, templatePath);
  const manifestPath = `templates/${templateName}.manifest.json`;
  const manifest = await buildManifest(rootAbs, templateName, templatePath);
  const outPath = resolve(cwd, manifestPath);
  await writeFile(outPath, canonicalJson(manifest), 'utf8');
  process.stdout.write(
    `Wrote ${manifestPath} (${manifest.files.length} files, tree=${manifest.tree_sha256})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(2);
});
