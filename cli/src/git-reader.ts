/**
 * git-reader.ts — `GitReader` implementation backed by the local product
 * repo worktree (D8). First concrete implementation of the
 * `@sdd/provenance` GitReader interface (previously only had test mocks).
 *
 * This reader shells out to `git` to read the product repo's local state:
 *   - blobAt: `git rev-parse <commit>:<path>` → blob SHA
 *   - blobWorktree: `git hash-object <file>` → blob SHA of worktree content
 *   - isClean: `git status --porcelain -- <path>` → empty iff clean
 *   - codeownersAt: `git show <commit>:.github/CODEOWNERS` → parse lines
 *
 * Direction: this reads the PRODUCT repo (scaffold's operation target).
 * Distinct from `local-reader.ts` which reads the PLATFORM repo templates
 * (implements `GitHubReadPort`, not `GitReader`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CodeownersEntry, GitReader } from '@sdd/provenance';

export interface LocalGitReaderOptions {
  /** Absolute path to the product repo root. */
  repoRoot: string;
}

/**
 * Build a `GitReader` backed by the local product repo.
 *
 * The caller must ensure `repoRoot` is the git repo root (not a
 * subdirectory); otherwise git commands may fail or return wrong results.
 */
export function createLocalGitReader(options: LocalGitReaderOptions): GitReader {
  const { repoRoot } = options;

  if (!existsSync(resolve(repoRoot, '.git'))) {
    throw new Error(`createLocalGitReader: '${repoRoot}' is not a git repository`);
  }

  function git(args: string[]): string {
    try {
      return execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const msg = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? e.message);
      throw new Error(`git ${args.join(' ')} failed: ${msg}`);
    }
  }

  return {
    async blobAt(commit: string, path: string): Promise<string> {
      // `git rev-parse <commit>:<path>` returns the blob SHA directly.
      // Provenance only compares blob SHAs (not content hashes), so this
      // is sufficient — no need to actually read the bytes.
      return git(['rev-parse', `${commit}:${path}`]);
    },

    async blobWorktree(path: string): Promise<string> {
      // `git hash-object <file>` returns the blob SHA as if the file
      // were added to the index. Works even for uncommitted changes.
      const abs = resolve(repoRoot, path);
      return git(['hash-object', abs]);
    },

    async isClean(path: string): Promise<boolean> {
      // `git status --porcelain -- <path>` outputs nothing iff clean.
      const out = git(['status', '--porcelain', '--', path]);
      return out.length === 0;
    },

    async codeownersAt(commit: string): Promise<CodeownersEntry[]> {
      // `git show <commit>:.github/CODEOWNERS` returns the file content.
      // Parse it into CodeownersEntry[] using the same simple line format
      // as provenance/src/verify.ts (pattern + owners per line).
      let content: string;
      try {
        content = git(['show', `${commit}:.github/CODEOWNERS`]);
      } catch {
        return [];
      }
      return parseCodeowners(content);
    },
  };
}

/**
 * Parse CODEOWNERS content into a list of pattern+owners entries.
 * Lines starting with `#` are comments; blank lines are skipped.
 * Each non-comment line: `<pattern> <owner1> <owner2> ...`.
 */
export function parseCodeowners(content: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [pattern, ...owners] = parts;
    entries.push({ pattern: pattern as string, owners: owners as string[] });
  }
  return entries;
}
