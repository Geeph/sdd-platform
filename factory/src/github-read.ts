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
      // Otherwise GET the ref, then follow tag→tag→...→commit chains by
      // calling /git/tags/{sha} for each tag object we encounter. We must
      // NOT feed a tag SHA back into /git/ref/{ref} — that endpoint only
      // accepts symbolic ref names and would 404 on a raw SHA.
      let _peeled = false;

      // Step 1: resolve the symbolic ref to an object (commit or tag).
      const candidates = ref.startsWith('refs/')
        ? [ref.slice('refs/'.length)]
        : ref.startsWith('tags/') || ref.startsWith('heads/')
          ? [ref]
          : [`tags/${ref}`, `heads/${ref}`];
      let initial: { object: { type: string; sha: string } } | undefined;
      for (const candidate of candidates) {
        try {
          initial = (await safeRequest('GET /repos/{owner}/{repo}/git/ref/{ref}', {
            owner: repo.owner,
            repo: repo.repo,
            ref: candidate,
          })) as { object: { type: string; sha: string } };
          break;
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err;
        }
      }
      if (!initial) throw new Error(`ref '${ref}' was not found`);

      // Fast path: the ref points directly at a commit.
      if (initial.object.type === 'commit') {
        return {
          commit: initial.object.sha.toLowerCase(),
          requestedRef: ref,
          peeled: false,
        };
      }
      if (initial.object.type !== 'tag') {
        throw new Error(
          `ref '${ref}' resolved to unsupported object type '${initial.object.type}'`,
        );
      }

      // Step 2: peel the tag chain. We know we have at least one tag; loop
      // calling /git/tags/{sha} until we hit a commit (or give up).
      let tagSha = initial.object.sha;
      for (let hops = 0; hops < 8; hops++) {
        _peeled = true;
        const tag = (await safeRequest('GET /repos/{owner}/{repo}/git/tags/{tag_sha}', {
          owner: repo.owner,
          repo: repo.repo,
          tag_sha: tagSha,
        })) as { object: { type: string; sha: string } };
        if (tag.object.type === 'commit') {
          return {
            commit: tag.object.sha.toLowerCase(),
            requestedRef: ref,
            peeled: true,
          };
        }
        if (tag.object.type === 'tag') {
          // Another annotated tag; keep peeling using /git/tags/{sha}.
          tagSha = tag.object.sha;
          continue;
        }
        throw new Error(`ref '${ref}' peeled to unsupported object type '${tag.object.type}'`);
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
        description?: string | null;
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
      let mainSha: string | undefined;
      let mainTreeSha: string | undefined;
      let mainParentShas: string[] | undefined;
      let seedCommitSha: string | undefined;
      let seedOperationId: string | undefined;
      let templateLock: string | undefined;
      try {
        const mainRef = (await safeRequest('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner,
          repo,
          ref: `heads/${repoResp.default_branch}`,
        })) as { object: { sha: string } };
        mainSha = mainRef.object.sha;
        const commit = (await safeRequest('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
          owner,
          repo,
          commit_sha: mainSha,
        })) as { message?: string; tree: { sha: string }; parents?: Array<{ sha: string }> };
        mainTreeSha = commit.tree.sha;
        mainParentShas = (commit.parents ?? []).map((parent) => parent.sha);
        // M2b owns exactly seed + snapshot. Recover the seed only when main
        // is the root seed or its direct child; deeper/branched history is not
        // silently adopted and does not require walking the full repo history.
        if (mainParentShas.length === 0) {
          seedCommitSha = mainSha;
          seedOperationId = extractSeedOperationId(commit.message);
        } else if (mainParentShas.length === 1) {
          const parentSha = mainParentShas[0];
          if (parentSha) {
            const parentCommit = (await safeRequest(
              'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
              { owner, repo, commit_sha: parentSha },
            )) as { message?: string; parents?: Array<{ sha: string }> };
            if ((parentCommit.parents ?? []).length === 0) {
              seedCommitSha = parentSha;
              seedOperationId = extractSeedOperationId(parentCommit.message);
            }
          }
        }
        try {
          const lockResponse = (await safeRequest('GET /repos/{owner}/{repo}/contents/{path}', {
            owner,
            repo,
            path: 'template.lock',
            ref: mainSha,
            mediaType: { format: 'raw' },
          })) as { content?: string; encoding?: string };
          templateLock = new TextDecoder().decode(decodeContent(lockResponse));
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err;
        }
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
      if (typeof repoResp.description === 'string') repoState.description = repoResp.description;
      if (initMarker !== undefined) {
        repoState.initMarker = initMarker;
      }
      if (mainSha !== undefined) repoState.mainSha = mainSha;
      if (mainTreeSha !== undefined) repoState.mainTreeSha = mainTreeSha;
      if (mainParentShas !== undefined) repoState.mainParentShas = mainParentShas;
      if (seedCommitSha !== undefined) repoState.seedCommitSha = seedCommitSha;
      if (seedOperationId !== undefined) repoState.seedOperationId = seedOperationId;
      if (templateLock !== undefined) repoState.templateLock = templateLock;

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

function extractSeedOperationId(message: string | undefined): string | undefined {
  return message?.match(/\[(sha256:[0-9a-f]{64})\]/)?.[1];
}

function normalizeVisibility(
  apiVisibility: string | undefined,
  isPrivate: boolean,
): 'private' | 'internal' | 'public' {
  if (apiVisibility === 'public') return 'public';
  if (apiVisibility === 'internal') return 'internal';
  return isPrivate ? 'private' : 'public';
}

// Re-export the TemplateManifest type so consumers can use `parseManifest`.
export type { TemplateManifest };
