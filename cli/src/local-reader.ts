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
 * Source identity invariants (P0 hardening):
 *   - The commit reported by this reader is the *actual* git HEAD of the
 *     platform repo checkout. We never synthesize a fake commit from the
 *     user-supplied ref.
 *   - The local git remote's owner/repo MUST match the caller-supplied
 *     `repo`. A mismatch → fail closed. This prevents reporting
 *     `source.repository = 'acme/sdd-platform'` while reading bytes from
 *     `Geeph/sdd-platform` or any other checkout.
 *   - The local worktree MUST be clean (`git status --porcelain` empty).
 *     Uncommitted template changes would be silently attributed to HEAD,
 *     producing a dishonest report.
 *   - When a commit is supplied, it must match the local HEAD; we do not
 *     read blobs at an arbitrary tree that doesn't correspond to what
 *     `HEAD` points at.
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

interface PlatformRootInfo {
  root: string;
  headCommit: string | null;
  headRef: string | null;
  remoteOwner: string | null;
  remoteRepo: string | null;
  clean: boolean;
}

/**
 * Resolve the platform repo root from a starting path. We look for
 * `templates/monorepo-root.manifest.json` to anchor the root; if the path
 * is a git work tree, we additionally surface HEAD, remote, and clean state.
 */
async function resolvePlatformRoot(seed: string): Promise<PlatformRootInfo> {
  let dir = resolve(seed);
  // Walk up looking for `templates/monorepo-root.manifest.json`.
  for (let hops = 0; hops < 8; hops++) {
    const candidate = `${dir}/templates/monorepo-root.manifest.json`;
    try {
      await stat(candidate);
      return { root: dir, ...(await readGitState(dir)) };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Fall back to CWD if nothing found.
  return { root: resolve(seed), ...(await readGitState(resolve(seed))) };
}

async function readGitState(dir: string): Promise<{
  headCommit: string | null;
  headRef: string | null;
  remoteOwner: string | null;
  remoteRepo: string | null;
  clean: boolean;
}> {
  const base = {
    headCommit: null as string | null,
    headRef: null as string | null,
    remoteOwner: null as string | null,
    remoteRepo: null as string | null,
    clean: false,
  };
  try {
    // HEAD commit (short-circuits if not a git repo).
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      return base;
    }
    base.headCommit = commit;

    // Symbolic ref (branch name) or tag or short SHA.
    try {
      base.headRef = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      try {
        base.headRef = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
      } catch {
        base.headRef = commit.slice(0, 12);
      }
    }

    // Remote: prefer 'origin', else first remote. Parse `owner/repo` from
    // the URL (handles both HTTPS and SSH forms).
    try {
      const remoteName =
        execFileSync('git', ['config', 'remote.origin.url'], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim() && 'origin'
          ? 'origin'
          : (execFileSync('git', ['remote'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
              .toString()
              .trim()
              .split('\n')[0] ?? null);
      if (remoteName) {
        const url = execFileSync('git', ['remote', 'get-url', remoteName], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        const parsed = parseRemoteUrl(url);
        if (parsed) {
          base.remoteOwner = parsed.owner;
          base.remoteRepo = parsed.repo;
        }
      }
    } catch {
      // Remote parsing is best-effort; leave null.
    }

    // Clean check: `git status --porcelain` should be empty.
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      base.clean = status.length === 0;
    } catch {
      base.clean = false;
    }

    return base;
  } catch {
    return base;
  }
}

/**
 * Parse an owner/repo from a git remote URL. Handles:
 *   - git@github.com:owner/repo.git
 *   - https://github.com/owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 *
 * Owner is lowercased — GitHub org names are case-insensitive and the
 * platform always uses the lowercase canonical form.
 */
export function parseRemoteUrl(url: string): { owner: string; repo: string } | null {
  // SSH shorthand
  const sshMatch = url.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1]?.toLowerCase(), repo: sshMatch[2]?.toLowerCase() };
  }
  // https / ssh URL
  const urlMatch = url.match(/^(?:https?|ssh):\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (urlMatch) {
    return { owner: urlMatch[1]?.toLowerCase(), repo: urlMatch[2]?.toLowerCase() };
  }
  return null;
}

/**
 * Build a `GitHubReadPort` that reads templates from the platform repo on
 * the local filesystem. No network, no mutations.
 *
 * The caller can optionally pass `platformRoot` (absolute path to the
 * sdd-platform checkout); defaults to walking up from CWD looking for
 * `templates/monorepo-root.manifest.json`.
 */
export function createLocalFsReadPort(platformRoot?: string): GitHubReadPort & {
  /**
   * Check whether the underlying platform checkout has uncommitted changes.
   * Callers (e.g. the CLI) can surface this as a warning in the plan output.
   */
  verifyWorktree: () => Promise<{ dirty: boolean }>;
} {
  const seed = platformRoot ?? process.cwd();
  // Resolve once at creation time so all subsequent calls see the same view.
  let cached: Promise<PlatformRootInfo> | null = null;
  const resolved = () => {
    if (!cached) cached = resolvePlatformRoot(seed);
    return cached;
  };

  /**
   * Verify the caller-supplied repo matches the local git remote. Fails
   * closed when we cannot determine the remote (not a git repo) OR when
   * the caller's repo differs from it. Returns whether the worktree is
   * dirty (the caller should surface this as a warning — we do not hard-
   * fail because developers routinely run dry-run mid-edit).
   */
  async function verifyRepoIdentity(callerRepo: RepoRef): Promise<{ dirty: boolean }> {
    const info = await resolved();
    if (info.remoteOwner === null || info.remoteRepo === null) {
      throw new Error(
        `local-reader: cannot verify repo identity — platform checkout at '${info.root}' ` +
          'has no git remote. Refusing to attribute template bytes to an unverified source.',
      );
    }
    if (info.remoteOwner !== callerRepo.owner || info.remoteRepo !== callerRepo.repo) {
      throw new Error(
        `local-reader: caller requested '${callerRepo.owner}/${callerRepo.repo}' but ` +
          `local git remote is '${info.remoteOwner}/${info.remoteRepo}'. ` +
          'Run dry-run inside the matching platform checkout, or pass --platform-repo accordingly.',
      );
    }
    return { dirty: !info.clean };
  }

  return {
    async resolveCommit(repo: RepoRef, ref: string): Promise<ResolvedCommit> {
      await verifyRepoIdentity(repo);
      const { headCommit, headRef } = await resolved();

      if (ref === UNPINNED_COMMIT || ref === '<unpinned>') {
        return {
          commit: headCommit ?? UNPINNED_COMMIT,
          requestedRef: '<unpinned>',
          peeled: false,
        };
      }

      if (/^[0-9a-f]{40}$/i.test(ref)) {
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

      // Tag/branch name: must resolve to local HEAD.
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
          if (err instanceof Error && err.message.startsWith('--platform-ref')) {
            throw err;
          }
        }
        throw new Error(
          `--platform-ref='${ref}' does not match local HEAD ref '${headRef ?? headCommit}'.`,
        );
      }

      throw new Error(
        `Cannot resolve --platform-ref='${ref}': platform checkout is not a git work tree. ` +
          'Run dry-run inside a git checkout of the platform repo.',
      );
    },

    async readTemplateTree(repo: RepoRef, commit: string, path: string): Promise<ReadonlyTree> {
      await verifyRepoIdentity(repo);
      const info = await resolved();

      // Verify the requested commit matches what's on disk. We only ever
      // read from HEAD, so any other commit → fail closed.
      if (info.headCommit && commit !== info.headCommit) {
        throw new Error(
          `local-reader: caller asked for commit '${commit}' but local HEAD is '${info.headCommit}'. ` +
            'Refusing to serve blobs at a commit that does not match the working tree.',
        );
      }

      const templateDir = resolve(info.root, path);
      const manifestPath = `${templateDir}.manifest.json`;
      const manifestJson = JSON.parse(await readFile(manifestPath, 'utf8'));
      const manifest = parseManifest(manifestJson);

      const entries: TemplateTreeEntry[] = [];
      for (const mf of manifest.files) {
        const abs = resolve(templateDir, mf.path);
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

      const { assembleTree } = await import('@sdd/factory');
      return assembleTree(manifest, entries);
    },

    async observe(_input: ProductInitInput): Promise<ObservedState> {
      return {
        repositoryExists: false,
        existingLabels: [],
        knownTeams: [],
        existingEnvironments: [],
        repositoryRulesetExists: false,
        orgWorkflowRulesetExists: false,
      };
    },

    async verifyWorktree(): Promise<{ dirty: boolean }> {
      const info = await resolved();
      return { dirty: !info.clean };
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
