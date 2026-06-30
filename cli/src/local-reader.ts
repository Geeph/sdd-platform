/**
 * local-reader.ts — a `GitHubReadPort` backed by the local filesystem.
 *
 * Used by dry-run previews: reads the templates tree directly from the
 * platform repo checkout instead of making any network calls. This makes
 * dry-run:
 *   - zero-GitHub-write (no network at all),
 *   - deterministic (no tag peeling; commit is synthetic),
 *   - fast (no API pagination).
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
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
 * Build a `GitHubReadPort` that reads templates from the platform repo on
 * the local filesystem. No network, no mutations.
 *
 * The caller can optionally pass `platformRoot` (absolute path to the
 * sdd-platform checkout); defaults to CWD's ancestor templates/.
 */
export function createLocalFsReadPort(platformRoot?: string): GitHubReadPort {
  const root = platformRoot ? resolve(platformRoot) : resolve(process.cwd());

  return {
    async resolveCommit(_repo: RepoRef, ref: string): Promise<ResolvedCommit> {
      if (ref === UNPINNED_COMMIT || ref === '<unpinned>') {
        return {
          commit: UNPINNED_COMMIT,
          requestedRef: '<unpinned>',
          peeled: false,
        };
      }
      if (/^[0-9a-f]{40}$/i.test(ref)) {
        return { commit: ref.toLowerCase(), requestedRef: ref, peeled: false };
      }
      // Local FS cannot peel tags; accept any ref as-is. dry-run uses the
      // unpinned sentinel for preview, so callers should pin for real runs.
      // For local reader, we synthesize a deterministic commit from the ref.
      const hex = createHash('sha256').update(ref, 'utf8').digest('hex').slice(0, 40);
      return { commit: hex, requestedRef: ref, peeled: false };
    },

    async readTemplateTree(_repo: RepoRef, _commit: string, path: string): Promise<ReadonlyTree> {
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

    async observe(input: ProductInitInput): Promise<ObservedState> {
      // Local FS reader returns a clean "nothing exists yet" observed state.
      // This is what a dry-run preview shows before any GitHub state.
      return {
        repositoryExists: false,
        existingLabels: [],
        knownTeams: collectAllTeams(input),
        existingEnvironments: [],
        repositoryRulesetExists: false,
        orgWorkflowRulesetExists: false,
      };
    },
  };
}

function collectAllTeams(input: ProductInitInput): string[] {
  const set = new Set<string>();
  for (const v of Object.values(input.config.owners)) {
    if (typeof v === 'string') set.add(v);
  }
  for (const t of input.config.bootstrap.approvers) set.add(t);
  if (input.config.team_permissions) {
    for (const t of Object.keys(input.config.team_permissions)) set.add(t);
  }
  if (input.config.environments) {
    for (const env of Object.values(input.config.environments)) {
      for (const t of env.reviewers) set.add(t);
    }
  }
  return [...set].sort();
}

// Re-export readdir so tests can stub the module if needed.
export { readdir };
