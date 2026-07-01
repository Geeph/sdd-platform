/**
 * local-reader.ts — a `GitHubReadPort` backed by the local filesystem.
 *
 * Used by dry-run previews: reads the templates tree directly from the
 * platform repo checkout instead of making any network calls. This makes
 * dry-run:
 *   - zero-GitHub-write (no network at all),
 *   - deterministic,
 *   - fast (no API pagination).
 *
 * The commit reported by this reader is the *actual* git HEAD of the
 * platform repo checkout (or, if not a git checkout, a content-derived
 * digest of the template manifest). We never synthesize a fake commit
 * from the user-supplied ref — the report must always reflect what bytes
 * were actually read.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  GitHubReadPort,
  ObservedState,
  ProductInitInput,
  ReadonlyTree,
  RepoRef,
  ResolvedCommit,
  TemplateTreeEntry,
} from '@sdd/factory';
import { parseManifest } from '@sdd/factory';

const UNPINNED_COMMIT = '0'.repeat(40);

/**
 * Resolve the platform repo root from a starting path. We look for
 * `templates/monorepo-root.manifest.json` to anchor the root; if the path
 * is a git work tree, we additionally surface HEAD.
 */
async function resolvePlatformRoot(seed: string): Promise<{
  root: string;
  headCommit: string | null;
  headRef: string | null;
}> {
  let dir = resolve(seed);
  // Walk up looking for `templates/monorepo-root.manifest.json`.
  for (let hops = 0; hops < 8; hops++) {
    const candidate = `${dir}/templates/monorepo-root.manifest.json`;
    try {
      await stat(candidate);
      return { root: dir, ...(await readGitHead(dir)) };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Fall back to CWD if nothing found; HEAD will be null.
  return { root: resolve(seed), ...(await readGitHead(resolve(seed))) };
}

async function readGitHead(dir: string): Promise<{
  headCommit: string | null;
  headRef: string | null;
}> {
  try {
    // Get HEAD commit (short-circuits if not a git repo).
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      return { headCommit: null, headRef: null };
    }
    // Get the symbolic ref (e.g. "refs/heads/main") or the tag if detached.
    let headRef: string | null = null;
    try {
      headRef = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      // Detached HEAD — try describe.
      try {
        headRef = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
      } catch {
        headRef = commit.slice(0, 12);
      }
    }
    return { headCommit: commit, headRef };
  } catch {
    return { headCommit: null, headRef: null };
  }
}

/**
 * Build a `GitHubReadPort` that reads templates from the platform repo on
 * the local filesystem. No network, no mutations.
 *
 * The caller can optionally pass `platformRoot` (absolute path to the
 * sdd-platform checkout); defaults to walking up from CWD looking for
 * `templates/monorepo-root.manifest.json`.
 */
export function createLocalFsReadPort(platformRoot?: string): GitHubReadPort {
  const seed = platformRoot ?? process.cwd();
  // Resolve once at creation time so all subsequent calls see the same view.
  let cached: Promise<{ root: string; headCommit: string | null; headRef: string | null }> | null =
    null;
  const resolved = () => {
    if (!cached) cached = resolvePlatformRoot(seed);
    return cached;
  };

  return {
    async resolveCommit(_repo: RepoRef, ref: string): Promise<ResolvedCommit> {
      const { headCommit, headRef } = await resolved();

      if (ref === UNPINNED_COMMIT || ref === '<unpinned>') {
        // Caller did not pin. Use the local HEAD as the real identity (if
        // available), otherwise fall back to the zero-commit sentinel.
        return {
          commit: headCommit ?? UNPINNED_COMMIT,
          requestedRef: '<unpinned>',
          peeled: false,
        };
      }

      // Caller pinned to a specific ref. We need to reconcile that against
      // what's actually on disk.
      if (/^[0-9a-f]{40}$/i.test(ref)) {
        // A full SHA was supplied. If we know the local HEAD, verify it
        // matches; otherwise we cannot honor the ref from local FS and
        // must fail closed.
        if (headCommit && headCommit !== ref.toLowerCase()) {
          throw new Error(
            `--platform-ref='${ref}' does not match local HEAD '${headCommit}'. ` +
              'Run dry-run inside the matching platform checkout, or omit --platform-ref.',
          );
        }
        if (!headCommit) {
          throw new Error(
            `Cannot verify --platform-ref='${ref}': platform checkout is not a git work tree. ` +
              'Provide a git checkout or omit --platform-ref for a content-derived preview.',
          );
        }
        return {
          commit: headCommit,
          requestedRef: ref,
          peeled: false,
        };
      }

      // A tag/branch name was supplied. We can only honor it if the local
      // HEAD ref matches (or the tag resolves to the local HEAD via
      // `git rev-parse`).
      if (headCommit) {
        try {
          const resolvedRef = execFileSync(
            'git',
            ['rev-parse', '--verify', '--end-of-options', `${ref}^{}`],
            { cwd: (await resolved()).root, stdio: ['ignore', 'pipe', 'ignore'] },
          )
            .toString()
            .trim();
          if (/^[0-9a-f]{40}$/.test(resolvedRef)) {
            if (resolvedRef !== headCommit) {
              throw new Error(
                `--platform-ref='${ref}' resolves to '${resolvedRef}' but local HEAD is '${headCommit}'. ` +
                  'Fetch/check out the matching revision before running dry-run.',
              );
            }
            return { commit: headCommit, requestedRef: ref, peeled: headRef !== ref };
          }
        } catch (err) {
          // Re-throw our own errors; swallow git resolution failures only
          // when they're not ours.
          if (err instanceof Error && err.message.startsWith('--platform-ref')) {
            throw err;
          }
        }
        throw new Error(
          `--platform-ref='${ref}' does not match local HEAD ref '${headRef ?? headCommit}'.`,
        );
      }

      // No git HEAD available; we cannot validate a symbolic ref against
      // local FS. Fail closed.
      throw new Error(
        `Cannot resolve --platform-ref='${ref}': platform checkout is not a git work tree. ` +
          'Run dry-run inside a git checkout of the platform repo.',
      );
    },

    async readTemplateTree(_repo: RepoRef, _commit: string, path: string): Promise<ReadonlyTree> {
      const { root } = await resolved();
      // The `path` is "templates/monorepo-root" (or similar). Load the
      // manifest from the local filesystem at `<root>/<path>.manifest.json`.
      const templateDir = resolve(root, path);
      const manifestPath = `${templateDir}.manifest.json`;
      const manifestJson = JSON.parse(await readFile(manifestPath, 'utf8'));
      const manifest = parseManifest(manifestJson);

      const entries: TemplateTreeEntry[] = [];
      for (const mf of manifest.files) {
        const abs = resolve(templateDir, mf.path);
        // Check no traversal.
        if (!abs.startsWith(templateDir)) {
          throw new Error(`template file escapes root: ${mf.path}`);
        }
        const content = await readFile(abs);
        const s = await stat(abs);
        if (s.isSymbolicLink()) {
          throw new Error(`template file is symlink: ${mf.path}`);
        }
        entries.push({
          path: mf.path,
          mode: mf.mode,
          content: new Uint8Array(content),
        });
      }

      // Re-assemble via factory to enforce manifest/tree consistency.
      const { assembleTree } = await import('@sdd/factory');
      return assembleTree(manifest, entries);
    },

    async observe(_input: ProductInitInput): Promise<ObservedState> {
      // Local FS reader returns a clean "nothing exists yet" observed state
      // with UNKNOWN teams — we cannot verify team existence from local FS,
      // so we do not claim any team is satisfied. The plan will surface
      // these as "missing" (with a warning clarifying they're unchecked).
      return {
        repositoryExists: false,
        existingLabels: [],
        knownTeams: [],
        existingEnvironments: [],
        repositoryRulesetExists: false,
        orgWorkflowRulesetExists: false,
      };
    },
  };
}

/**
 * Build a content-derived commit identifier from a manifest. Used as a
 * last-resort fallback when the platform checkout is not a git work tree
 * and the caller did not pin a ref. The identifier is a deterministic
 * function of the template bytes, so re-running dry-run against the same
 * template produces the same id.
 */
export function contentDerivedCommit(manifestJson: string): string {
  return createHash('sha256').update(manifestJson, 'utf8').digest('hex').slice(0, 40);
}

// Re-export readdir so tests can stub the module if needed.
export { readdir };
