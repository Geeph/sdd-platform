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
        // Follow first-parent history to the root seed. This remains stable
        // after the Bootstrap PR merge (merge/squash/rebase) while avoiding
        // adoption of a second-parent branch. Bound the walk to fail closed
        // on unexpectedly deep or cyclic history.
        let cursorSha = mainSha;
        let cursorCommit = commit;
        for (let hops = 0; hops < 64; hops++) {
          const parents = cursorCommit.parents ?? [];
          if (parents.length === 0) {
            seedCommitSha = cursorSha;
            seedOperationId = extractSeedOperationId(cursorCommit.message);
            break;
          }
          const firstParent = parents[0]?.sha;
          if (!firstParent || firstParent === cursorSha) break;
          cursorSha = firstParent;
          cursorCommit = (await safeRequest('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
            owner,
            repo,
            commit_sha: cursorSha,
          })) as { message?: string; tree: { sha: string }; parents?: Array<{ sha: string }> };
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
      // Capture the source identity (platform repo id + path + sha) and
      // target (repo id + branch pattern) so finalize can verify no drift.
      let orgWorkflowRulesetExists = false;
      let orgWorkflowRulesetEnforcement: 'evaluate' | 'active' | undefined;
      let orgWorkflowRulesetSource: ObservedState['orgWorkflowRulesetSource'] | undefined;
      try {
        const orgRulesets = (await safeRequest('GET /orgs/{org}/rulesets', {
          org: owner,
          per_page: 100,
        })) as Array<{
          id?: number;
          name: string;
          enforcement: string;
          conditions?: Record<string, unknown>;
          rules?: Array<Record<string, unknown>>;
        }>;
        const targetName = `sdd-workflows-${repoResp.id}`;
        const found = orgRulesets.find((r) => r.name === targetName);
        if (found) {
          orgWorkflowRulesetExists = true;
          orgWorkflowRulesetEnforcement = found.enforcement as 'evaluate' | 'active';

          // List responses are not a sufficient security contract. Read the
          // exact ruleset so conditions and workflow parameters are complete.
          const detail = found.id
            ? ((await safeRequest('GET /orgs/{org}/rulesets/{ruleset_id}', {
                org: owner,
                ruleset_id: found.id,
              })) as typeof found)
            : found;
          orgWorkflowRulesetEnforcement = detail.enforcement as 'evaluate' | 'active';

          // Recover source identity from the `workflows` rule parameters.
          const conditions = detail.conditions ?? {};
          const repoIdCond = conditions.repository_id as { repository_ids?: number[] } | undefined;
          const targetRepoIds = repoIdCond?.repository_ids ?? [];
          const refName = conditions.ref_name as { include?: string[] } | undefined;
          const targetRefPattern = refName?.include?.[0];

          const workflowsRule = (detail.rules ?? []).find((r) => r.type === 'workflows');
          if (workflowsRule) {
            const params = workflowsRule.parameters as {
              workflows?: Array<{ repository_id: number; path: string; sha: string }>;
            };
            const allWorkflows = params.workflows ?? [];
            if (allWorkflows.length > 0) {
              const source: NonNullable<ObservedState['orgWorkflowRulesetSource']> = {
                workflows: allWorkflows.map((wf) => ({
                  repositoryId: wf.repository_id,
                  path: wf.path,
                  sha: wf.sha,
                })),
              };
              if (targetRepoIds[0] !== undefined) source.targetRepoId = targetRepoIds[0];
              if (targetRefPattern !== undefined) source.targetRefPattern = targetRefPattern;
              orgWorkflowRulesetSource = source;
            }
          }
        }
      } catch {
        // Org ruleset observation is best-effort.
      }

      // Bootstrap PR — check for open PR from sdd/bootstrap branch.
      // Collect enough detail for finalizeProtection to verify evidence
      // (approvals bound to final head, author, merge commit).
      let bootstrapPullRequest: ObservedState['bootstrapPullRequest'] | undefined;
      try {
        const prs = (await safeRequest('GET /repos/{owner}/{repo}/pulls', {
          owner,
          repo,
          head: `${owner}:sdd/bootstrap`,
          state: 'all',
          per_page: 5,
        })) as Array<{
          number: number;
          head: { sha: string };
          state: string;
          merged: boolean;
          merge_commit_sha: string | null;
          user: { login: string };
        }>;
        const bootstrap = prs[0];
        if (bootstrap) {
          const state: 'open' | 'merged' | 'closed' = bootstrap.merged
            ? 'merged'
            : bootstrap.state === 'open'
              ? 'open'
              : 'closed';

          // Approved reviews — only APPROVED state counts; capture the
          // commit SHA at time of review to bind approval to final head.
          let approvals: Array<{ user: string; headSha: string }> | undefined;
          try {
            const reviews = (await safeRequest(
              'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
              {
                owner,
                repo,
                pull_number: bootstrap.number,
                per_page: 100,
              },
            )) as Array<{
              user: { login: string };
              state: string;
              commit_id: string;
            }>;
            approvals = reviews
              .filter((r) => r.state === 'APPROVED')
              .map((r) => ({ user: r.user.login, headSha: r.commit_id }));
          } catch {
            // Reviews are best-effort; finalize will fail closed if absent.
          }

          bootstrapPullRequest = {
            number: bootstrap.number,
            headSha: bootstrap.head.sha,
            state,
            author: bootstrap.user.login,
          };
          if (bootstrap.merge_commit_sha) {
            bootstrapPullRequest.mergeCommitSha = bootstrap.merge_commit_sha;
          }
          if (approvals !== undefined) {
            bootstrapPullRequest.approvals = approvals;
          }
        }
      } catch {
        // Bootstrap PR observation is best-effort.
      }

      // Check runs on the Bootstrap PR's final head SHA (used by finalize).
      // We query by the PR head SHA, which is the commit that ran the
      // platform workflows when the PR was open.
      let bootstrapCheckRuns: ObservedState['bootstrapCheckRuns'] | undefined;
      if (bootstrapPullRequest) {
        try {
          const workflowRunsResp = (await safeRequest('GET /repos/{owner}/{repo}/actions/runs', {
            owner,
            repo,
            head_sha: bootstrapPullRequest.headSha,
            event: 'pull_request',
            per_page: 100,
          })) as {
            workflow_runs?: Array<{
              check_suite_id: number;
              head_sha: string;
              path: string;
              workflow_url: string;
            }>;
          };
          const workflowBySuite = new Map(
            (workflowRunsResp.workflow_runs ?? []).map((run) => [run.check_suite_id, run]),
          );
          const checkRunsResp = (await safeRequest(
            'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
            {
              owner,
              repo,
              ref: bootstrapPullRequest.headSha,
              per_page: 100,
            },
          )) as {
            check_runs: Array<{
              name: string;
              status: string;
              conclusion: string | null;
              head_sha: string;
              app: { id: number };
              check_suite: { id: number };
            }>;
          };
          bootstrapCheckRuns = checkRunsResp.check_runs
            .filter((cr) => cr.status === 'completed')
            .map((cr) => {
              const workflow = workflowBySuite.get(cr.check_suite.id);
              const identity = parseWorkflowRunIdentity(workflow?.workflow_url, workflow?.path);
              return {
                context: cr.name,
                conclusion: cr.conclusion ?? 'unknown',
                headSha: cr.head_sha,
                appId: cr.app.id,
                checkSuiteId: cr.check_suite.id,
                workflowRepository: identity.repository,
                workflowPath: identity.path,
                workflowSha: identity.sha,
              };
            });
        } catch {
          // Check runs observation is best-effort; finalize will fail closed.
        }
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
      if (orgWorkflowRulesetSource !== undefined) {
        result.orgWorkflowRulesetSource = orgWorkflowRulesetSource;
      }
      if (bootstrapCheckRuns !== undefined) {
        result.bootstrapCheckRuns = bootstrapCheckRuns;
      }
      return result;
    },

    async resolveTeamMembers(org: string, teamSlug: string): Promise<string[]> {
      const members: string[] = [];
      try {
        let page = 1;
        while (members.length < 1000) {
          const resp = (await safeRequest('GET /orgs/{org}/teams/{team_slug}/members', {
            org,
            team_slug: teamSlug,
            per_page: 100,
            page,
          })) as Array<{ login: string }>;
          if (!Array.isArray(resp) || resp.length === 0) break;
          for (const m of resp) members.push(m.login);
          if (resp.length < 100) break;
          page++;
        }
      } catch {
        // Team doesn't exist or no access — return empty
      }
      return members;
    },

    async isCommitReachable(repoRef: RepoRef, ancestor: string, descendant: string) {
      const comparison = (await safeRequest('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
        owner: repoRef.owner,
        repo: repoRef.repo,
        base: ancestor,
        head: descendant,
      })) as { status?: string };
      return comparison.status === 'identical' || comparison.status === 'ahead';
    },
  };
}

function parseWorkflowRunIdentity(
  workflowUrl: string | undefined,
  runPath: string | undefined,
): { repository: string; path: string; sha: string } {
  const urlRepository =
    workflowUrl?.match(
      /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/actions\/workflows\//,
    )?.[1] ?? '';
  if (!runPath) return { repository: urlRepository, path: '', sha: '' };
  const separator = runPath.lastIndexOf('@');
  const rawPath = separator >= 0 ? runPath.slice(0, separator) : runPath;
  const ref = separator >= 0 ? runPath.slice(separator + 1) : '';
  const marker = '/.github/workflows/';
  const markerIndex = rawPath.indexOf(marker);
  const pathRepository = markerIndex >= 0 ? rawPath.slice(0, markerIndex) : '';
  const repository = /^[^/]+\/[^/]+$/.test(pathRepository) ? pathRepository : urlRepository;
  const path = markerIndex >= 0 ? rawPath.slice(markerIndex + 1) : rawPath.replace(/^\//, '');
  return {
    repository,
    path,
    sha: /^[0-9a-f]{40}$/i.test(ref) ? ref.toLowerCase() : '',
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
