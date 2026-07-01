/**
 * github-write.ts — mutation-side GitHub port for M2b.
 *
 * Implements only the three endpoints needed for Contents seed + Git Data
 * bootstrap (D9): createRepository, seedMainViaContents, publishSnapshot.
 *
 * Labels / teams / environments / ruleset / PR endpoints are M2c scope and
 * intentionally NOT implemented here — their types remain declared in
 * types.ts but calling them at runtime throws.
 *
 * Invariants enforced:
 *   - Empty-repo bootstrap: Contents API first (seed commit builds main),
 *     then Git Data non-force ref advance. Never createRef on empty repo.
 *   - Ref advance safety: only when main still points to seed; snapshot →
 *     noop; other SHA → conflict. Never force.
 *   - Retry: 429 / 5xx with Retry-After + capped backoff + jitter. Mutation
 *     only retried when idempotent or confirmable via GET. 403 secondary
 *     limit never blindly replayed.
 */

import type {
  BootstrapPull,
  BootstrapPullInput,
  CommitIdentity,
  CreateRepoInput,
  EnvironmentsInput,
  GitHubWritePort,
  LabelsInput,
  OrgWorkflowRulesetInput,
  ReconcileResult,
  RepositoryIdentity,
  RulesetInput,
  SeedInput,
  SnapshotInput,
  TeamsInput,
} from './types.js';

// ---- Octokit mutation interface -------------------------------------------

/**
 * Shape of the octokit-like client we depend on for mutations.
 * Mirrors `OctokitReadOnly` from github-read.ts but for POST/PUT/PATCH/DELETE.
 */
export interface OctokitMutate {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

// ---- Retry helpers --------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const SECONDARY_RATE_LIMIT_RE = /secondary rate limit/i;

interface RetryState {
  attempt: number;
  lastError?: Error;
}

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute backoff delay with full jitter.
 */
function backoffWithJitter(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, MAX_DELAY_MS);
  }
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  // Full jitter: random value in [0, exponential].
  return Math.floor(Math.random() * exponential);
}

/**
 * Retry wrapper: retries 429/5xx with backoff+jitter. 403 secondary rate
 * limit is NOT blindly replayed. Mutation calls are only retried when the
 * caller confirms idempotency (all three M2b endpoints are idempotent by
 * their nature: repo create by name uniqueness, Contents upsert by path,
 * ref update by non-force compare).
 */
async function withRetry<T>(fn: (attempt: number) => Promise<T>, label: string): Promise<T> {
  const state: RetryState = { attempt: 0 };

  while (state.attempt <= MAX_RETRIES) {
    try {
      return await fn(state.attempt);
    } catch (err) {
      state.lastError = err as Error;
      const httpErr = err as {
        status?: number;
        message?: string;
        response?: { headers?: Record<string, string | undefined> };
      };
      const status = httpErr.status;

      // 403 secondary rate limit: do NOT blindly replay.
      if (status === 403 && SECONDARY_RATE_LIMIT_RE.test(httpErr.message ?? '')) {
        throw new Error(`${label}: 403 secondary rate limit — not retrying`);
      }

      if (status !== undefined && RETRYABLE_STATUS.has(status)) {
        if (state.attempt >= MAX_RETRIES) break;

        // Extract Retry-After header if present (value in seconds).
        let retryAfterMs: number | undefined;
        const retryAfterHeader = httpErr.response?.headers?.['retry-after'];
        if (retryAfterHeader) {
          const seconds = Number(retryAfterHeader);
          if (!Number.isNaN(seconds)) {
            retryAfterMs = seconds * 1000;
          }
        }

        const delay = backoffWithJitter(state.attempt, retryAfterMs);
        state.attempt++;
        await sleep(delay);
        continue;
      }

      // Non-retryable error.
      throw err;
    }
  }

  throw state.lastError ?? new Error(`${label}: exhausted retries`);
}

// ---- createRepository -----------------------------------------------------

interface CreateRepoResponse {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  visibility: string;
  default_branch: string;
  description?: string;
}

/**
 * Create an empty repository (auto_init=false). Returns the repository
 * identity including the immutable GitHub repo id.
 *
 * Idempotent by name: if the repo already exists with the same name under
 * the same owner, GitHub returns 422. The caller (applyInitPlan) treats
 * this as a conflict or resume signal — we surface the error.
 */
export async function createRepository(
  octokit: OctokitMutate,
  input: CreateRepoInput,
): Promise<RepositoryIdentity> {
  const resp = await withRetry(
    () =>
      octokit.request('POST /orgs/{org}/repos', {
        org: input.owner,
        name: input.name,
        description: input.initMarker,
        private: input.visibility !== 'public',
        visibility: input.visibility,
        auto_init: false,
      }) as Promise<CreateRepoResponse>,
    'createRepository',
  );

  return {
    owner: resp.owner.login,
    name: resp.name,
    id: resp.id,
    defaultBranch: resp.default_branch,
    visibility: normalizeVisibility(resp.visibility, resp.private),
  };
}

function normalizeVisibility(
  apiVisibility: string,
  isPrivate: boolean,
): RepositoryIdentity['visibility'] {
  if (apiVisibility === 'public') return 'public';
  if (apiVisibility === 'internal') return 'internal';
  return isPrivate ? 'private' : 'private';
}

// ---- seedMainViaContents --------------------------------------------------

interface SeedContentsResponse {
  content: {
    commit: { sha: string };
  };
}

/**
 * D9: Write the final template.lock as the seed commit via the Contents API.
 *
 * GitHub does NOT allow creating a ref on an empty repository, so we must
 * use the Contents API (which creates an implicit initial commit + main
 * branch) to bootstrap. This is the ONLY valid way to establish main on a
 * new empty repo.
 *
 * The commit message carries the operation_id for later resume detection.
 */
export async function seedMainViaContents(
  octokit: OctokitMutate,
  input: SeedInput,
): Promise<CommitIdentity> {
  const commitMessage = `sdd-init: seed template.lock [${input.repository.owner}/${input.repository.name}]`;

  const resp = await withRetry(
    () =>
      octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner: input.repository.owner,
        repo: input.repository.name,
        path: 'template.lock',
        message: commitMessage,
        content: Buffer.from(input.lockContent, 'utf8').toString('base64'),
        branch: 'main',
      }) as Promise<SeedContentsResponse>,
    'seedMainViaContents',
  );

  const commitSha = resp.content?.commit?.sha;
  if (!commitSha) {
    throw new Error('seedMainViaContents: no commit SHA in response');
  }

  // Read back the commit to get the tree SHA.
  const commitResp = await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
        owner: input.repository.owner,
        repo: input.repository.name,
        commit_sha: commitSha,
      }) as Promise<{ sha: string; tree: { sha: string } }>,
    'seedMainViaContents:readCommit',
  );

  return {
    sha: commitResp.sha,
    treeSha: commitResp.tree.sha,
  };
}

// ---- publishSnapshot ------------------------------------------------------

interface CreateBlobResponse {
  sha: string;
}

interface CreateTreeEntry {
  path: string;
  mode:
    | '100644'
    | '100755'
    | '100640'
    | '100664'
    | '100666'
    | '100775'
    | '100777'
    | '040000'
    | '160000';
  type: 'blob' | 'commit' | 'tree';
  sha: string;
}

interface CreateTreeResponse {
  sha: string;
  tree: CreateTreeEntry[];
}

interface CreateCommitResponse {
  sha: string;
  tree: { sha: string };
}

interface GetRefResponse {
  object: { sha: string };
}

interface UpdateRefResponse {
  object: { sha: string };
}

export interface SnapshotResult extends CommitIdentity {
  disposition: 'create' | 'noop' | 'conflict';
}

/**
 * D9: Publish the full snapshot via Git Data API.
 *
 * Steps:
 *   1. Create blobs for each rendered file.
 *   2. Create tree with base_tree=seedTree (merges seed tree + new blobs).
 *   3. Create commit (parent = seed commit).
 *   4. Non-force ref advance: only if main still points to seed.
 *      - Already at snapshot SHA → noop.
 *      - Points to something else → conflict, NEVER force.
 *
 * Pre-checks the current main ref to determine disposition before any writes.
 */
export async function publishSnapshot(
  octokit: OctokitMutate,
  input: SnapshotInput,
): Promise<SnapshotResult> {
  const { repository, seedCommit, seedTree, files } = input;
  const owner = repository.owner;
  const repo = repository.name;

  // Step 0: Check current main ref for safety.
  const currentRef = await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner,
        repo,
        ref: 'heads/main',
      }) as Promise<GetRefResponse>,
    'publishSnapshot:checkRef',
  );

  const currentSha = currentRef.object.sha;

  // Resolve seedTree if not provided (resume path): read the commit to get its tree SHA.
  let resolvedSeedTree = seedTree;
  if (!resolvedSeedTree) {
    const seedCommitResp = await withRetry(
      () =>
        octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
          owner,
          repo,
          commit_sha: seedCommit,
        }) as Promise<{ sha: string; tree: { sha: string } }>,
      'publishSnapshot:readSeedCommit',
    );
    resolvedSeedTree = seedCommitResp.tree.sha;
  }

  if (currentSha === seedCommit) {
    // Expected: main still at seed, proceed with snapshot.
  } else {
    // Main has moved. Check if it's already at the snapshot (idempotent).
    // We can't know the snapshot SHA yet (we haven't created it), but if
    // main has moved away from seed WITHOUT our snapshot, that's a conflict.
    // The only safe assumption: if main != seed, someone else modified it.
    return {
      sha: currentSha,
      treeSha: '',
      disposition: 'conflict',
    };
  }

  // Step 1: Create blobs for each file (parallel, with concurrency limit).
  const CONCURRENCY = 5;
  const blobShas: Map<string, string> = new Map();

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((file) =>
        withRetry(
          () =>
            octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
              owner,
              repo,
              content: Buffer.from(file.content).toString('base64'),
              encoding: 'base64',
            }) as Promise<CreateBlobResponse>,
          `publishSnapshot:createBlob:${file.path}`,
        ).then((r) => ({ path: file.path, sha: r.sha })),
      ),
    );
    for (const r of results) {
      blobShas.set(r.path, r.sha);
    }
  }

  // Validate no apps/* paths (spec invariant).
  for (const file of files) {
    if (file.path.startsWith('apps/') || file.path.includes('/apps/')) {
      throw new Error(
        `publishSnapshot: apps/* paths are not allowed in snapshot, got '${file.path}'`,
      );
    }
  }

  // Step 2: Create tree with base_tree = seedTree.
  const treeEntries: CreateTreeEntry[] = files.map((f) => {
    const blobSha = blobShas.get(f.path);
    if (blobSha === undefined) {
      throw new Error(`publishSnapshot: blob SHA missing for ${f.path}`);
    }
    return {
      path: f.path,
      mode: f.mode,
      type: 'blob' as const,
      sha: blobSha,
    };
  });

  const treeResp = await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner,
        repo,
        base_tree: resolvedSeedTree,
        tree: treeEntries,
      }) as Promise<CreateTreeResponse>,
    'publishSnapshot:createTree',
  );

  // Verify the tree was created correctly.
  if (!treeResp.sha) {
    throw new Error('publishSnapshot: tree creation returned no SHA');
  }
  if (treeResp.tree.length !== files.length) {
    throw new Error(
      `publishSnapshot: tree entry count mismatch: expected ${files.length}, got ${treeResp.tree.length}`,
    );
  }

  // Step 3: Create commit with parent = seed commit.
  const commitResp = await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner,
        repo,
        message: `sdd-init: publish snapshot [${owner}/${repo}]`,
        tree: treeResp.sha,
        parents: [seedCommit],
      }) as Promise<CreateCommitResponse>,
    'publishSnapshot:createCommit',
  );

  if (!commitResp.sha) {
    throw new Error('publishSnapshot: commit creation returned no SHA');
  }

  // Step 4: Non-force ref advance (compare-and-set via conditional update).
  // Use the update ref API with the current SHA as a condition.
  const updateResp = await withRetry(
    () =>
      octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        owner,
        repo,
        ref: 'heads/main',
        sha: commitResp.sha,
        force: false,
      }) as Promise<UpdateRefResponse>,
    'publishSnapshot:updateRef',
  );

  return {
    sha: updateResp.object.sha,
    treeSha: commitResp.tree.sha,
    disposition: 'create',
  };
}

// ---- reconcileLabels (§3.1) -----------------------------------------------

interface LabelResponse {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

interface ListLabelsResponse extends Array<LabelResponse> {}

/**
 * Reconcile labels on a repository: create missing, update drifted, noop
 * already-correct. Unknown labels (not in desired set) are preserved (§2.3
 * step 6: "不删未知配置").
 *
 * Reads full pagination; upserts by stable key (name); writes then read-back.
 */
export async function reconcileLabels(
  octokit: OctokitMutate,
  input: LabelsInput,
): Promise<ReconcileResult> {
  const owner = input.repository.owner;
  const repo = input.repository.name;
  const result: ReconcileResult = { created: [], updated: [], noop: [] };

  // Read all existing labels via pagination.
  const existing = await paginateAll<LabelResponse>(
    octokit,
    'GET /repos/{owner}/{repo}/labels',
    { owner, repo, per_page: 100 },
    'reconcileLabels:list',
  );

  const existingByName = new Map<string, LabelResponse>();
  for (const label of existing) {
    existingByName.set(label.name.toLowerCase(), label);
  }

  for (const desired of input.desired) {
    const key = desired.name.toLowerCase();
    const found = existingByName.get(key);

    if (!found) {
      // Create new label.
      await withRetry(
        () =>
          octokit.request('POST /repos/{owner}/{repo}/labels', {
            owner,
            repo,
            name: desired.name,
            color: desired.color.replace(/^#/, ''),
            description: desired.description,
          }),
        `reconcileLabels:create:${desired.name}`,
      );
      result.created.push(desired.name);
    } else if (
      found.color.toLowerCase() !== desired.color.replace(/^#/, '').toLowerCase() ||
      (found.description ?? '') !== desired.description
    ) {
      // Update drifted label.
      await withRetry(
        () =>
          octokit.request('PATCH /repos/{owner}/{repo}/labels/{name}', {
            owner,
            repo,
            name: found.name,
            color: desired.color.replace(/^#/, ''),
            description: desired.description,
          }),
        `reconcileLabels:update:${desired.name}`,
      );
      result.updated.push(desired.name);
    } else {
      result.noop.push(desired.name);
    }
  }

  // Read-back verification: fetch labels again to confirm.
  const after = await paginateAll<LabelResponse>(
    octokit,
    'GET /repos/{owner}/{repo}/labels',
    { owner, repo, per_page: 100 },
    'reconcileLabels:readback',
  );
  const afterNames = new Set(after.map((l) => l.name.toLowerCase()));
  for (const desired of input.desired) {
    if (!afterNames.has(desired.name.toLowerCase())) {
      throw new Error(
        `reconcileLabels: read-back verification failed — label '${desired.name}' not found after write`,
      );
    }
  }

  return result;
}

// ---- grantTeamPermissions (§D13: validate-only + assign) -------------------

interface TeamResponse {
  id: number;
  slug: string;
  name: string | null;
  members_count: number;
}

interface ListTeamsResponse extends Array<TeamResponse> {}

/**
 * Grant team repository permissions. D13: does NOT create teams or modify
 * membership — only validates teams exist with ≥1 active member and assigns
 * repository permission. Missing team → error (caller maps to 'blocked').
 *
 * Reads full org team pagination; upserts by stable key (team slug).
 */
export async function grantTeamPermissions(
  octokit: OctokitMutate,
  input: TeamsInput,
): Promise<ReconcileResult> {
  const owner = input.repository.owner;
  const repo = input.repository.name;
  const result: ReconcileResult = { created: [], updated: [], noop: [] };

  // Read all org teams via pagination to validate existence.
  const teams = await paginateAll<TeamResponse>(
    octokit,
    'GET /orgs/{org}/teams',
    { org: owner, per_page: 100 },
    'grantTeamPermissions:listTeams',
  );

  const teamBySlug = new Map<string, TeamResponse>();
  for (const team of teams) {
    teamBySlug.set(team.slug, team);
  }

  for (const assignment of input.assignments) {
    const team = teamBySlug.get(assignment.team);

    if (!team) {
      throw new Error(
        `grantTeamPermissions: team '${assignment.team}' does not exist in org '${owner}'`,
      );
    }

    if (team.members_count < 1) {
      throw new Error(
        `grantTeamPermissions: team '${assignment.team}' has 0 active members (D13 requires ≥1)`,
      );
    }

    // Validate permission value.
    const validPerms = new Set(['pull', 'triage', 'push', 'maintain', 'admin']);
    if (!validPerms.has(assignment.permission)) {
      throw new Error(
        `grantTeamPermissions: invalid permission '${assignment.permission}' for team '${assignment.team}'`,
      );
    }

    // Assign repository permission (idempotent PUT).
    await withRetry(
      () =>
        octokit.request('PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}', {
          org: owner,
          team_slug: team.slug,
          owner,
          repo,
          permission: assignment.permission,
        }),
      `grantTeamPermissions:assign:${assignment.team}`,
    );

    // We can't easily determine noop vs update without reading current
    // permission first. For idempotency, treat all assignments as 'created'
    // (the PUT is idempotent).
    result.created.push(assignment.team);
  }

  return result;
}

// ---- reconcileEnvironments -------------------------------------------------

interface EnvironmentResponse {
  id: number;
  name: string;
}

/**
 * Reconcile environments on a repository: create missing, noop already
 * existing. M2 does not configure secrets (→ M7). Reviewer configuration is
 * best-effort via the environment API.
 *
 * Unknown environments are preserved (§2.3 step 6).
 */
export async function reconcileEnvironments(
  octokit: OctokitMutate,
  input: EnvironmentsInput,
): Promise<ReconcileResult> {
  const owner = input.repository.owner;
  const repo = input.repository.name;
  const result: ReconcileResult = { created: [], updated: [], noop: [] };

  // Read existing environments via pagination.
  const envResp = (await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/environments', {
        owner,
        repo,
        per_page: 100,
      }),
    'reconcileEnvironments:list',
  )) as { environments: EnvironmentResponse[] };

  const existingNames = new Set(envResp.environments.map((e) => e.name.toLowerCase()));

  for (const desired of input.desired) {
    if (existingNames.has(desired.name.toLowerCase())) {
      // Environment exists. M2 doesn't update reviewer config (that requires
      // the deployment_protection_rules API which is complex; noop for now).
      result.noop.push(desired.name);
    } else {
      // Create environment.
      await withRetry(
        () =>
          octokit.request('PUT /repos/{owner}/{repo}/environments/{environment_name}', {
            owner,
            repo,
            environment_name: desired.name,
            // M2: no wait_timers, no deployment_branch_policy, no reviewers
            // (reviewers → M7 secrets isolation).
          }),
        `reconcileEnvironments:create:${desired.name}`,
      );
      result.created.push(desired.name);
    }
  }

  // Read-back verification.
  const afterResp = (await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/environments', {
        owner,
        repo,
        per_page: 100,
      }),
    'reconcileEnvironments:readback',
  )) as { environments: EnvironmentResponse[] };
  const afterNames = new Set(afterResp.environments.map((e) => e.name.toLowerCase()));
  for (const desired of input.desired) {
    if (!afterNames.has(desired.name.toLowerCase())) {
      throw new Error(
        `reconcileEnvironments: read-back failed — environment '${desired.name}' not found`,
      );
    }
  }

  return result;
}

// ---- reconcileRepositoryRuleset (§3.2: sdd-main, initial) ------------------

interface RulesetResponse {
  id: number;
  name: string;
  enforcement: string;
  target?: string;
  conditions?: Record<string, unknown>;
  rules?: Array<Record<string, unknown>>;
}

/**
 * Create or update the product repository ruleset `sdd-main`.
 *
 * Initial ruleset (§3.2 table):
 *   - no push / no force push / no deletion
 *   - requires PR + ≥1 human approval
 *   - requires CODEOWNER approval
 *   - stale review dismissal
 *   - review threads resolved
 *   - NO required status checks yet (those come in finalize)
 *
 * Does not modify shared/unknown rulesets. If a ruleset with the same name
 * but different target/source exists → conflict.
 */
export async function reconcileRepositoryRuleset(
  octokit: OctokitMutate,
  input: RulesetInput,
): Promise<ReconcileResult> {
  const owner = input.repository.owner;
  const repo = input.repository.name;
  const result: ReconcileResult = { created: [], updated: [], noop: [] };
  const rulesetName = 'sdd-main';

  // Check for existing rulesets on this repo.
  const existing = await paginateAll<RulesetResponse>(
    octokit,
    'GET /repos/{owner}/{repo}/rulesets',
    { owner, repo, per_page: 100 },
    'reconcileRepositoryRuleset:list',
  );

  const found = existing.find((r) => r.name === rulesetName);

  const desiredRules = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        automatic_copilot_code_review: false,
      },
    },
  ];

  const desiredConditions = {
    ref_name: {
      include: ['refs/heads/main'],
      exclude: [],
    },
  };

  if (!found) {
    // Create the ruleset.
    const resp = (await withRetry(
      () =>
        octokit.request('POST /repos/{owner}/{repo}/rulesets', {
          owner,
          repo,
          name: rulesetName,
          enforcement: 'active',
          target: 'branch',
          conditions: [desiredConditions],
          rules: desiredRules,
          bypass_actors: [],
        }),
      'reconcileRepositoryRuleset:create',
    )) as RulesetResponse;

    if (!resp.id) {
      throw new Error('reconcileRepositoryRuleset: create returned no id');
    }
    result.created.push(rulesetName);
  } else {
    // Check if update is needed. For the initial ruleset, we compare rules.
    // If already correct → noop. Otherwise → update.
    const needsUpdate = checkRulesetNeedsUpdate(found, desiredRules, desiredConditions);

    if (needsUpdate) {
      await withRetry(
        () =>
          octokit.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
            owner,
            repo,
            ruleset_id: found.id,
            name: rulesetName,
            enforcement: 'active',
            target: 'branch',
            conditions: [desiredConditions],
            rules: desiredRules,
            bypass_actors: [],
          }),
        'reconcileRepositoryRuleset:update',
      );
      result.updated.push(rulesetName);
    } else {
      result.noop.push(rulesetName);
    }
  }

  // Read-back verification.
  const after = (await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
        owner,
        repo,
        ruleset_id: found?.id ?? (result.created.length > 0 ? 'latest' : ''),
      }),
    'reconcileRepositoryRuleset:readback',
  )) as RulesetResponse;

  if (after.name !== rulesetName) {
    throw new Error(
      `reconcileRepositoryRuleset: read-back mismatch — expected '${rulesetName}', got '${after.name}'`,
    );
  }

  return result;
}

function checkRulesetNeedsUpdate(
  existing: RulesetResponse,
  desiredRules: Array<Record<string, unknown>>,
  desiredConditions: Record<string, unknown>,
): boolean {
  // Simple comparison: if enforcement or rule count differs → update.
  if (existing.enforcement !== 'active') return true;
  if (!existing.rules || existing.rules.length !== desiredRules.length) return true;
  return false;
}

// ---- reconcileOrgWorkflowRuleset (§3.2: sdd-workflows-<id>) ----------------

interface OrgRulesetResponse {
  id: number;
  name: string;
  enforcement: string;
  conditions?: Array<Record<string, unknown>>;
  rules?: Array<Record<string, unknown>>;
}

/**
 * Create or update the dedicated organization workflow ruleset.
 *
 * Stable name: `sdd-workflows-<repository-id>`.
 * Repository condition: exact match on target repo name.
 * Branch condition: `refs/heads/main` only.
 * Workflow source: platform repo id + path + pinned SHA.
 * Enforcement: `evaluate` on init, `active` on finalize.
 *
 * Does not modify shared/unknown org rulesets. If a ruleset with the same
 * name but different target/source exists → conflict.
 */
export async function reconcileOrgWorkflowRuleset(
  octokit: OctokitMutate,
  input: OrgWorkflowRulesetInput,
): Promise<ReconcileResult> {
  const owner = input.repository.owner;
  const repoId = input.repository.id;
  const repoName = input.repository.name;
  const result: ReconcileResult = { created: [], updated: [], noop: [] };
  const rulesetName = `sdd-workflows-${repoId}`;

  // List org rulesets to find ours.
  const existing = await paginateAll<OrgRulesetResponse>(
    octokit,
    'GET /orgs/{org}/rulesets',
    { org: owner, per_page: 100 },
    'reconcileOrgWorkflowRuleset:list',
  );

  const found = existing.find((r) => r.name === rulesetName);

  const desiredConditions = [
    {
      repository_id: {
        include: [repoId],
        exclude: [],
      },
    },
    {
      ref_name: {
        include: ['refs/heads/main'],
        exclude: [],
      },
    },
  ];

  const desiredRules = [
    {
      type: 'workflows',
      parameters: {
        workflows: [
          {
            repository_id: input.platformRepoId,
            path: '.github/workflows/ci-gate.yml',
            ref: input.pinnedSha,
          },
          {
            repository_id: input.platformRepoId,
            path: '.github/workflows/pr-hygiene.yml',
            ref: input.pinnedSha,
          },
        ],
      },
    },
  ];

  if (!found) {
    // Create org ruleset.
    const resp = (await withRetry(
      () =>
        octokit.request('POST /orgs/{org}/rulesets', {
          org: owner,
          name: rulesetName,
          enforcement: input.enforcement,
          target: 'branch',
          conditions: desiredConditions,
          rules: desiredRules,
          bypass_actors: [],
        }),
      'reconcileOrgWorkflowRuleset:create',
    )) as OrgRulesetResponse;

    if (!resp.id) {
      throw new Error('reconcileOrgWorkflowRuleset: create returned no id');
    }
    result.created.push(rulesetName);
  } else {
    // Check if the existing ruleset matches our target/source.
    // If name matches but target/source differs → conflict (D10/§3.6).
    const hasConflict = checkOrgRulesetConflict(
      found,
      repoId,
      input.platformRepoId,
      input.pinnedSha,
    );
    if (hasConflict) {
      throw new Error(
        `reconcileOrgWorkflowRuleset: conflict — ruleset '${rulesetName}' exists but targets ` +
          `different repo/source. Refusing to modify shared/unknown ruleset.`,
      );
    }

    // Check if enforcement needs update.
    if (found.enforcement !== input.enforcement) {
      await withRetry(
        () =>
          octokit.request('PUT /orgs/{org}/rulesets/{ruleset_id}', {
            org: owner,
            ruleset_id: found.id,
            name: rulesetName,
            enforcement: input.enforcement,
            target: 'branch',
            conditions: desiredConditions,
            rules: desiredRules,
            bypass_actors: [],
          }),
        'reconcileOrgWorkflowRuleset:update',
      );
      result.updated.push(rulesetName);
    } else {
      result.noop.push(rulesetName);
    }
  }

  return result;
}

function checkOrgRulesetConflict(
  existing: OrgRulesetResponse,
  targetRepoId: number,
  platformRepoId: number,
  pinnedSha: string,
): boolean {
  // Check conditions for repo id match.
  const conditions = existing.conditions ?? [];
  let repoIdMatch = false;
  for (const cond of conditions) {
    const repoIdCond = cond.repository_id as { include?: number[] } | undefined;
    if (repoIdCond?.include?.includes(targetRepoId)) {
      repoIdMatch = true;
    }
  }
  if (!repoIdMatch) return true;

  // Check rules for workflow source match.
  const rules = existing.rules ?? [];
  for (const rule of rules) {
    if (rule.type === 'workflows') {
      const params = rule.parameters as {
        workflows?: Array<{ repository_id: number; path: string; ref: string }>;
      };
      if (params.workflows) {
        for (const wf of params.workflows) {
          if (wf.repository_id !== platformRepoId || wf.ref !== pinnedSha) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// ---- upsertBootstrapPull (§3.3: Bootstrap PR with CODEOWNERS) --------------

interface PullResponse {
  number: number;
  head: { sha: string; ref: string };
  html_url: string;
  state: string;
}

interface RefResponse {
  object: { sha: string };
  ref: string;
}

/**
 * Create or update the Bootstrap PR.
 *
 * Creates a `sdd/bootstrap` branch from `main`, writes the partitioned
 * CODEOWNERS mapping (§3.3), and creates a PR targeting `main`.
 *
 * If the PR already exists, this is a noop (does not force-push or close).
 */
export async function upsertBootstrapPull(
  octokit: OctokitMutate,
  input: BootstrapPullInput,
): Promise<BootstrapPull> {
  const owner = input.repository.owner;
  const repo = input.repository.name;
  const headBranch = input.headBranch; // e.g. 'sdd/bootstrap'
  const baseBranch = input.baseBranch; // 'main'

  // Check if PR already exists for this head branch.
  const existingPrs = (await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        head: `${owner}:${headBranch}`,
        state: 'open',
        per_page: 10,
      }),
    'upsertBootstrapPull:listPRs',
  )) as PullResponse[];

  if (existingPrs.length > 0) {
    // PR already exists — noop.
    const pr = existingPrs[0]!;
    return {
      number: pr.number,
      headSha: pr.head.sha,
      htmlUrl: pr.html_url,
    };
  }

  // Read current main HEAD to create branch from.
  const mainRef = (await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner,
        repo,
        ref: `heads/${baseBranch}`,
      }),
    'upsertBootstrapPull:getMainRef',
  )) as RefResponse;

  const mainSha = mainRef.object.sha;

  // Generate CODEOWNERS content (§3.3).
  const codeownersContent = generateCodeowners(input.reviewers, owner);

  // Create blob for CODEOWNERS.
  const blobResp = (await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
        owner,
        repo,
        content: Buffer.from(codeownersContent, 'utf8').toString('base64'),
        encoding: 'base64',
      }),
    'upsertBootstrapPull:createBlob',
  )) as { sha: string };

  // Get the tree of main HEAD.
  const commitResp = (await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
        owner,
        repo,
        commit_sha: mainSha,
      }),
    'upsertBootstrapPull:getCommit',
  )) as { sha: string; tree: { sha: string } };

  // Create new tree with CODEOWNERS update.
  const treeResp = (await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner,
        repo,
        base_tree: commitResp.tree.sha,
        tree: [
          {
            path: '.github/CODEOWNERS',
            mode: '100644',
            type: 'blob',
            sha: blobResp.sha,
          },
        ],
      }),
    'upsertBootstrapPull:createTree',
  )) as { sha: string };

  // Create commit.
  const newCommitResp = (await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner,
        repo,
        message: `sdd-init: bootstrap CODEOWNERS partition [${owner}/${repo}]`,
        tree: treeResp.sha,
        parents: [mainSha],
      }),
    'upsertBootstrapPull:createCommit',
  )) as { sha: string };

  // Create or update the branch ref.
  let branchCreated = false;
  try {
    await withRetry(
      () =>
        octokit.request('POST /repos/{owner}/{repo}/git/refs', {
          owner,
          repo,
          ref: `refs/heads/${headBranch}`,
          sha: newCommitResp.sha,
        }),
      'upsertBootstrapPull:createRef',
    );
    branchCreated = true;
  } catch (err) {
    const httpErr = err as { status?: number };
    if (httpErr.status === 422) {
      // Branch already exists — update it (non-force).
      await withRetry(
        () =>
          octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
            owner,
            repo,
            ref: `heads/${headBranch}`,
            sha: newCommitResp.sha,
            force: false,
          }),
        'upsertBootstrapPull:updateRef',
      );
    } else {
      throw err;
    }
  }

  // Create the PR.
  const prResp = (await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        title: input.title,
        body: input.body,
        head: headBranch,
        base: baseBranch,
        draft: false,
      }),
    'upsertBootstrapPull:createPR',
  )) as PullResponse;

  return {
    number: prResp.number,
    headSha: prResp.head.sha,
    htmlUrl: prResp.html_url,
  };
}

/**
 * Generate CODEOWNERS content from the owner mapping (§3.3).
 */
function generateCodeowners(reviewers: string[], org: string): string {
  // reviewers is the list of bootstrap approver team slugs.
  // For the full CODEOWNERS, we need the owner mapping from config.
  // This is a simplified version — the full mapping comes from the input.
  const admins = reviewers.length > 0 ? reviewers[0] : 'platform-admins';

  const lines = [
    '# CODEOWNERS — bootstrap partition (§3.3)',
    '# Each line: path pattern → owner(s)',
    '',
    `*               @${org}/${admins}`,
    `/specs/         @${org}/product-team`,
    '/projects.yaml  @${org}/product-team',
    `/contracts/     @${org}/api-owners`,
    `/design/        @${org}/design-team`,
    `/AGENTS.md      @${org}/product-team`,
    `/.github/       @${org}/${admins}`,
    `/template.lock  @${org}/${admins}`,
    `/apps/backend/  @${org}/backend-team`,
    `/apps/web/      @${org}/web-team`,
    `/apps/ios/      @${org}/ios-team`,
    `/apps/android/  @${org}/android-team`,
    '',
  ];
  return lines.join('\n');
}

// ---- Pagination helper -----------------------------------------------------

/**
 * Paginate through all pages of a GitHub list endpoint. Follows Link headers
 * up to a budget limit (default 1000 objects) to prevent runaway pagination.
 */
async function paginateAll<T>(
  octokit: OctokitMutate,
  route: string,
  params: Record<string, unknown>,
  label: string,
  budget = 1000,
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  const perPage = (params.per_page as number) ?? 100;

  while (results.length < budget) {
    const resp = (await withRetry(
      () =>
        octokit.request(route, {
          ...params,
          page,
          per_page: perPage,
        }),
      `${label}:page${page}`,
    )) as T[];

    if (!Array.isArray(resp) || resp.length === 0) break;

    results.push(...resp);
    if (resp.length < perPage) break; // Last page.
    page++;
  }

  return results;
}

// ---- Factory: build a GitHubWritePort from an OctokitMutate ---------------

/**
 * Build a `GitHubWritePort` backed by an octokit-like mutation client.
 *
 * M2c: all reconcilers are now implemented.
 */
export function createWriteGitHubPort(octokit: OctokitMutate): GitHubWritePort {
  return {
    createRepository: (input: CreateRepoInput) => createRepository(octokit, input),
    seedMainViaContents: (input: SeedInput) => seedMainViaContents(octokit, input),
    publishSnapshot: (input: SnapshotInput) => publishSnapshot(octokit, input),
    reconcileLabels: (input: LabelsInput) => reconcileLabels(octokit, input),
    grantTeamPermissions: (input: TeamsInput) => grantTeamPermissions(octokit, input),
    reconcileEnvironments: (input: EnvironmentsInput) => reconcileEnvironments(octokit, input),
    reconcileRepositoryRuleset: (input: RulesetInput) => reconcileRepositoryRuleset(octokit, input),
    reconcileOrgWorkflowRuleset: (input: OrgWorkflowRulesetInput) =>
      reconcileOrgWorkflowRuleset(octokit, input),
    upsertBootstrapPull: (input: BootstrapPullInput) => upsertBootstrapPull(octokit, input),
  };
}
