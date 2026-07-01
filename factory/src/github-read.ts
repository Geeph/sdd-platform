/**
 * github-read.ts — read-only GitHub port.
 *
 * M2a delivers only the *type* (`GitHubReadPort`, already exported from
 * `types.ts`) plus a small factory that constructs a *read-only* octokit
 * adapter suitable for dry-run. The writer type is declared in `types.ts`
 * but **not implemented** in M2a; that is M2b/c scope.
 *
 * M2b: `observe()` is now implemented for real execution. dry-run callers
 * should still inject a fake for deterministic observed state.
 *
 * This module intentionally refuses any mutating method at runtime
 * (defense-in-depth on top of the type-level separation). Tests use a fake
 * `GitHubReadPort` directly, not this adapter.
 */

import { assembleTree, parseManifest } from './resolve.js';
import type {
  GitHubReadPort,
  ObservedState,
  ProductInitInput,
  ReadonlyTree,
  RepoRef,
  ResolvedCommit,
  TemplateManifest,
  TemplateTreeEntry,
} from './types.js';

/**
 * Shape of the octokit-like client we depend on. We only declare the
 * methods we call and only GET/HEAD paths.
 */
export interface OctokitReadOnly {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

const WRITE_METHODS_RE = /^(POST|PUT|PATCH|DELETE)\s/i;

/**
 * Build a `GitHubReadPort` backed by an octokit-like client. The adapter
 * refuses any route that is not GET/HEAD (defense-in-depth).
 *
 * For M2a, no real caller constructs this; tests use `FakeReadPort` instead.
 * The factory exists so M2b/c can wire it in without changing the interface.
 */
export function createReadonlyGitHubPort(octokit: OctokitReadOnly): GitHubReadPort {
  async function safeRequest(
    route: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    const method = route.split(' ')[0];
    if (!method) throw new Error(`invalid route: '${route}'`);
    if (WRITE_METHODS_RE.test(route)) {
      throw new Error(`read-only port refuses mutating route: '${route}'`);
    }
    return octokit.request(route, parameters);
  }

  return {
    async resolveCommit(repo: RepoRef, ref: string): Promise<ResolvedCommit> {
      // First try as a commit SHA (fast path).
      if (/^[0-9a-f]{40}$/i.test(ref)) {
        return { commit: ref.toLowerCase(), requestedRef: ref, peeled: false };
      }
      // Otherwise GET the ref and peel annotated tags recursively.
      let currentRef = ref;
      let peeled = false;
      for (let hops = 0; hops < 8; hops++) {
        const res = (await safeRequest('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner: repo.owner,
          repo: repo.repo,
          ref: currentRef,
        })) as { object: { type: string; sha: string } };
        if (res.object.type === 'commit') {
          return {
            commit: res.object.sha.toLowerCase(),
            requestedRef: ref,
            peeled,
          };
        }
        if (res.object.type === 'tag') {
          peeled = true;
          const tag = (await safeRequest('GET /repos/{owner}/{repo}/git/tags/{tag_sha}', {
            owner: repo.owner,
            repo: repo.repo,
            tag_sha: res.object.sha,
          })) as { object: { type: string; sha: string } };
          if (tag.object.type === 'commit') {
            return {
              commit: tag.object.sha.toLowerCase(),
              requestedRef: ref,
              peeled: true,
            };
          }
          // Annotated tag pointing to another tag; keep peeling.
          currentRef = tag.object.sha;
          continue;
        }
        throw new Error(`ref '${ref}' resolved to unsupported object type '${res.object.type}'`);
      }
      throw new Error(`ref '${ref}' exceeded peel depth`);
    },

    async readTemplateTree(repo: RepoRef, commit: string, path: string): Promise<ReadonlyTree> {
      // Load the manifest first (so we know which files to fetch).
      const manifestPath = `templates/${path.split('/').pop() ?? 'monorepo-root'}.manifest.json`;
      const manifestResp = (await safeRequest('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: repo.owner,
        repo: repo.repo,
        path: manifestPath,
        ref: commit,
        mediaType: { format: 'raw' },
      })) as { content?: string; encoding?: string };
      const manifestBytes = decodeContent(manifestResp);
      const manifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));

      // Fetch each listed file at the pinned commit.
      const entries: TemplateTreeEntry[] = [];
      for (const mf of manifest.files) {
        const absPath = `${path}/${mf.path}`;
        const resp = (await safeRequest('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: repo.owner,
          repo: repo.repo,
          path: absPath,
          ref: commit,
          mediaType: { format: 'raw' },
        })) as { content?: string; encoding?: string };
        entries.push({
          path: mf.path,
          mode: mf.mode,
          content: decodeContent(resp),
        });
      }
      return assembleTree(manifest, entries);
    },

    async observe(input: ProductInitInput): Promise<ObservedState> {
      const { owner, repo } = input.target;

      // Check if the repo exists.
      let repoResp: {
        id: number;
        name: string;
        owner: { login: string };
        default_branch: string;
        private: boolean;
        visibility?: string;
        description?: string;
      };
      try {
        repoResp = (await safeRequest('GET /repos/{owner}/{repo}', {
          owner,
          repo,
        })) as typeof repoResp;
      } catch (err) {
        const httpErr = err as { status?: number };
        if (httpErr.status === 404) {
          return {
            repositoryExists: false,
            existingLabels: [],
            knownTeams: [],
            existingEnvironments: [],
            repositoryRulesetExists: false,
            orgWorkflowRulesetExists: false,
          };
        }
        throw err;
      }

      // Repo exists. Determine if it's empty by checking for HEAD commit.
      let empty = true;
      try {
        await safeRequest('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner,
          repo,
          ref: `heads/${repoResp.default_branch}`,
        });
        empty = false;
      } catch (err) {
        const httpErr = err as { status?: number };
        if (httpErr.status === 409) {
          empty = true;
        } else if (httpErr.status !== 404) {
          throw err;
        }
      }

      // Extract init marker from description: `[sdd-init:<operation_id>]`
      const markerMatch = repoResp.description?.match(/\[sdd-init:(sha256:[0-9a-f]{64})\]/);
      const initMarker = markerMatch ? markerMatch[1] : undefined;

      // M2c: observe labels, teams, environments, rulesets, bootstrap PR.

      // Labels — paginated.
      const labels: string[] = [];
      try {
        let page = 1;
        while (labels.length < 1000) {
          const labelResp = (await safeRequest('GET /repos/{owner}/{repo}/labels', {
            owner,
            repo,
            per_page: 100,
            page,
          })) as Array<{ name: string }>;
          if (!Array.isArray(labelResp) || labelResp.length === 0) break;
          for (const l of labelResp) labels.push(l.name);
          if (labelResp.length < 100) break;
          page++;
        }
      } catch {
        // Labels observation is best-effort.
      }

      // Teams — read org teams that have access to this repo.
      const teams: string[] = [];
      try {
        const teamResp = (await safeRequest('GET /repos/{owner}/{repo}/teams', {
          owner,
          repo,
          per_page: 100,
        })) as Array<{ slug: string; members_count: number }>;
        for (const t of teamResp) {
          if (t.members_count > 0) teams.push(t.slug);
        }
      } catch {
        // Teams observation is best-effort.
      }

      // Environments.
      const environments: string[] = [];
      try {
        const envResp = (await safeRequest('GET /repos/{owner}/{repo}/environments', {
          owner,
          repo,
          per_page: 100,
        })) as { environments: Array<{ name: string }> };
        for (const e of envResp.environments) environments.push(e.name);
      } catch {
        // Environments observation is best-effort.
      }

      // Repository rulesets — check for sdd-main.
      let repositoryRulesetExists = false;
      try {
        const rulesets = (await safeRequest('GET /repos/{owner}/{repo}/rulesets', {
          owner,
          repo,
          per_page: 100,
        })) as Array<{ name: string }>;
        repositoryRulesetExists = rulesets.some((r) => r.name === 'sdd-main');
      } catch {
        // Ruleset observation is best-effort.
      }

      // Organization workflow rulesets — check for sdd-workflows-<id>.
      let orgWorkflowRulesetExists = false;
      let orgWorkflowRulesetEnforcement: 'evaluate' | 'active' | undefined;
      try {
        const orgRulesets = (await safeRequest('GET /orgs/{org}/rulesets', {
          org: owner,
          per_page: 100,
        })) as Array<{ name: string; enforcement: string }>;
        const targetName = `sdd-workflows-${repoResp.id}`;
        const found = orgRulesets.find((r) => r.name === targetName);
        if (found) {
          orgWorkflowRulesetExists = true;
          orgWorkflowRulesetEnforcement = found.enforcement as 'evaluate' | 'active';
        }
      } catch {
        // Org ruleset observation is best-effort.
      }

      // Bootstrap PR — check for open PR from sdd/bootstrap branch.
      let bootstrapPullRequest: ObservedState['bootstrapPullRequest'] | undefined;
      try {
        const prs = (await safeRequest('GET /repos/{owner}/{repo}/pulls', {
          owner,
          repo,
          head: `${owner}:sdd/bootstrap`,
          state: 'all',
          per_page: 5,
        })) as Array<{ number: number; head: { sha: string }; state: string; merged: boolean }>;
        const bootstrap = prs[0];
        if (bootstrap) {
          bootstrapPullRequest = {
            number: bootstrap.number,
            headSha: bootstrap.head.sha,
            state: bootstrap.merged ? 'merged' : bootstrap.state === 'open' ? 'open' : 'closed',
          };
        }
      } catch {
        // Bootstrap PR observation is best-effort.
      }

      const repoState: ObservedState['repository'] = {
        id: repoResp.id,
        defaultBranch: repoResp.default_branch,
        visibility: normalizeVisibility(repoResp.visibility, repoResp.private),
        empty,
      };
      if (initMarker !== undefined) {
        repoState.initMarker = initMarker;
      }

      const result: ObservedState = {
        repositoryExists: true,
        repository: repoState,
        existingLabels: labels,
        knownTeams: teams,
        existingEnvironments: environments,
        repositoryRulesetExists,
        orgWorkflowRulesetExists,
      };
      if (bootstrapPullRequest !== undefined) {
        result.bootstrapPullRequest = bootstrapPullRequest;
      }
      if (orgWorkflowRulesetEnforcement !== undefined) {
        result.orgWorkflowRulesetEnforcement = orgWorkflowRulesetEnforcement;
      }
      return result;
    },
  };
}

function decodeContent(resp: { content?: string; encoding?: string }): Uint8Array {
  if (!resp.content) return new Uint8Array();
  if (resp.encoding === 'base64') {
    const bin = Buffer.from(resp.content.replace(/\n/g, ''), 'base64');
    return new Uint8Array(bin);
  }
  return new TextEncoder().encode(resp.content);
}

function normalizeVisibility(
  apiVisibility: string | undefined,
  isPrivate: boolean,
): 'private' | 'internal' | 'public' {
  if (apiVisibility === 'public') return 'public';
  if (apiVisibility === 'internal') return 'internal';
  return isPrivate ? 'private' : 'private';
}

// Re-export the TemplateManifest type so consumers can use `parseManifest`.
export type { TemplateManifest };
