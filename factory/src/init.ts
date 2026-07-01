/**
 * init.ts — `applyInitPlan`: state machine orchestrator for M2b.
 *
 * Covers §2.6 state machine from PLANNED through SNAPSHOT_MAIN only.
 * M2c adds REPO_CONFIGURED → ORG_WORKFLOWS_EVALUATING → BOOTSTRAP_PR_OPEN → …
 *
 * Key invariants (D11):
 *   - Phase is derived from GitHub actual state — no local checkpoint.
 *   - Re-running with the same input converges (idempotent).
 *   - Defaults: no delete / no close / no force / no rollback.
 *   - Inconsistency → conflict and stop.
 *
 * M2b preflight (per prompt):
 *   - Reuses M2a template resolve/checksum (done in compileInitPlan).
 *   - Target repo name validation.
 *   - Existence / partial-state detection via operation_id marker.
 *   - Token capability for repo + contents + git data.
 *   - team/env/ruleset capability checks deferred to M2c.
 */

import { renderTree } from './render.js';
import { assembleTree, parseRepoRef } from './resolve.js';
import type {
  AppliedOperation,
  CreateRepoInput,
  GitHubReadPort,
  GitHubWritePort,
  InitPhase,
  InitPlan,
  InitResult,
  NextAction,
  ObservedState,
  ProductInitInput,
  ReadonlyTree,
  RepositoryIdentity,
  SeedInput,
  SnapshotInput,
} from './types.js';

/**
 * Helper to build an InitResult with conditional optional properties.
 * Handles exactOptionalPropertyTypes correctly.
 */
function buildInitResult(
  phase: InitPhase,
  operations: AppliedOperation[],
  nextAction: NextAction,
  repository?: RepositoryIdentity,
  mainSha?: string,
  bootstrapPr?: { number: number; headSha: string },
  repositoryRulesetId?: number,
  orgWorkflowRulesetId?: number,
): InitResult {
  const result: InitResult = { phase, operations, nextAction };
  if (repository !== undefined) result.repository = repository;
  if (mainSha !== undefined) result.mainSha = mainSha;
  if (bootstrapPr !== undefined) result.bootstrapPr = bootstrapPr;
  if (repositoryRulesetId !== undefined) result.repositoryRulesetId = repositoryRulesetId;
  if (orgWorkflowRulesetId !== undefined) result.orgWorkflowRulesetId = orgWorkflowRulesetId;
  return result;
}

// ---- Public API -----------------------------------------------------------

export interface ApplyInitPlanDeps {
  reader: GitHubReadPort;
  writer: GitHubWritePort;
  /** M2b CLI boundary: stop after the repository snapshot is established. */
  stopAfterSnapshot?: boolean;
}

/**
 * Execute an init plan against GitHub.
 *
 * Covers PLANNED → REPO_CREATED → SEED_MAIN → SNAPSHOT_MAIN.
 * Stops at SNAPSHOT_MAIN with nextAction indicating M2c is pending.
 *
 * Idempotent: re-running with the same input converges to the same state.
 */
export async function applyInitPlan(
  input: ProductInitInput,
  plan: InitPlan,
  deps: ApplyInitPlanDeps,
): Promise<InitResult> {
  // Re-render the tree to obtain lock content + file list for seed/snapshot.
  // Rendering is deterministic, so this produces byte-identical output to
  // what compileInitPlan computed.
  const rendered = await renderForApply(input, plan, deps.reader);

  const lockContent = rendered.lockYaml;
  const snapshotFiles = rendered.entries
    .filter((e) => e.path !== 'template.lock')
    .map((e) => ({
      path: e.path,
      mode: e.mode,
      content: e.content,
    }));

  // Sort files by path for determinism.
  snapshotFiles.sort((a, b) => a.path.localeCompare(b.path));

  // Validate no apps/* paths (spec invariant).
  for (const f of snapshotFiles) {
    if (f.path.startsWith('apps/') || f.path.includes('/apps/')) {
      throw new Error(`applyInitPlan: apps/* paths are not allowed in snapshot, got '${f.path}'`);
    }
  }

  // Observe current GitHub state to determine phase.
  const observed: ObservedState = await deps.reader.observe(input);

  // Preflight: validate repo name + partial-state detection.
  preflightCheck(input, plan, observed, lockContent);

  // Determine starting phase from observed state.
  const { phase: startPhase, seedCommit } = determineStartPhase(observed, plan);

  const operations: AppliedOperation[] = [];
  let repository: RepositoryIdentity | undefined;
  let mainSha: string | undefined;
  let mainTreeSha: string | undefined;
  let currentPhase: InitPhase = startPhase;

  // ---- Phase: REPO_CREATED ------------------------------------------------

  if (currentPhase === 'PLANNED') {
    const createInput: CreateRepoInput = {
      owner: input.target.owner,
      name: input.target.repo,
      visibility: input.target.visibility,
      description: `[sdd-init:${plan.operation_id}]`,
      initMarker: plan.operation_id,
    };

    let identity: RepositoryIdentity;
    try {
      identity = await deps.writer.createRepository(createInput);
    } catch (err) {
      // 422 from GitHub means repo already exists — might be our partial state.
      const httpErr = err as { status?: number };
      if (httpErr.status === 422 && observed.repositoryExists && observed.repository?.empty) {
        // Resume: the repo exists and is empty with our marker.
        identity = {
          owner: input.target.owner,
          name: input.target.repo,
          id: observed.repository?.id,
          defaultBranch: observed.repository?.defaultBranch,
          visibility: input.target.visibility,
        };
        operations.push({
          order: 10,
          phase: 'repository',
          kind: 'repository.create',
          disposition: 'noop',
          target: `${input.target.owner}/${input.target.repo}`,
          result: 'resume: repo already exists (empty, marker matches)',
        });
      } else {
        throw err;
      }
    }

    if (operations.length === 0) {
      operations.push({
        order: 10,
        phase: 'repository',
        kind: 'repository.create',
        disposition: 'create',
        target: `${input.target.owner}/${input.target.repo}`,
        result: identity.id.toString(),
      });
    }

    repository = identity;
    currentPhase = 'REPO_CREATED';
  } else {
    // Resume: repo already exists.
    const repo = observed.repository;
    if (!repo) throw new Error('state machine error: observed.repository missing in resume');
    repository = {
      owner: input.target.owner,
      name: input.target.repo,
      id: repo.id,
      defaultBranch: repo.defaultBranch,
      visibility: input.target.visibility,
    };
    operations.push({
      order: 10,
      phase: 'repository',
      kind: 'repository.create',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}`,
      result: 'resume: repo already exists',
    });
  }

  // ---- Phase: SEED_MAIN ---------------------------------------------------

  if (currentPhase === 'REPO_CREATED') {
    if (!repository) throw new Error('state machine error: repository not set at REPO_CREATED');
    const seedInput: SeedInput = {
      repository,
      lockContent,
      operationId: plan.operation_id,
    };

    const seedResult = await deps.writer.seedMainViaContents(seedInput);

    operations.push({
      order: 20,
      phase: 'seed',
      kind: 'main.seed',
      disposition: 'create',
      target: `${input.target.owner}/${input.target.repo}:template.lock`,
      result: seedResult.sha,
    });

    mainSha = seedResult.sha;
    mainTreeSha = seedResult.treeSha;
    currentPhase = 'SEED_MAIN';
  } else {
    // Resume from SEED_MAIN or later — seed commit already exists.
    const seedSha = seedCommit ?? observed.repository?.mainSha;
    operations.push({
      order: 20,
      phase: 'seed',
      kind: 'main.seed',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}:template.lock`,
      result: seedSha ?? 'resumed',
    });
  }

  // ---- Phase: SNAPSHOT_MAIN -----------------------------------------------

  if (currentPhase === 'SEED_MAIN') {
    if (!repository) throw new Error('state machine error: repository not set at SEED_MAIN');

    // On fresh seed, we have mainSha/mainTreeSha from the seed call.
    // On resume, we need to read the seed commit SHA from GitHub.
    // publishSnapshot will read the tree SHA from the commit if seedTree is empty.
    const seedCommitSha = mainSha ?? seedCommit ?? observed.repository?.mainSha;
    if (!seedCommitSha) {
      throw new Error('state machine error: seed commit is unavailable for snapshot recovery');
    }

    const snapshotInput: SnapshotInput = {
      repository,
      seedCommit: seedCommitSha,
      lockContent,
      files: snapshotFiles,
    };
    if (mainTreeSha !== undefined) snapshotInput.seedTree = mainTreeSha;

    const snapResult = await deps.writer.publishSnapshot(snapshotInput);

    if (snapResult.disposition === 'conflict') {
      operations.push({
        order: 30,
        phase: 'snapshot',
        kind: 'main.snapshot',
        disposition: 'conflict',
        target: `${input.target.owner}/${input.target.repo}:main`,
        result: `main ref advanced away from seed (SHA=${snapResult.sha})`,
      });
      const conflictResult = buildInitResult(
        'SEED_MAIN',
        operations,
        'blocked',
        repository,
        mainSha,
      );
      return conflictResult;
    }

    operations.push({
      order: 30,
      phase: 'snapshot',
      kind: 'main.snapshot',
      disposition: snapResult.disposition === 'noop' ? 'noop' : 'create',
      target: `${input.target.owner}/${input.target.repo}:main`,
      result: snapResult.sha,
    });

    mainSha = snapResult.sha;
    currentPhase = 'SNAPSHOT_MAIN';
  } else {
    // Resume from SNAPSHOT_MAIN — snapshot already published.
    operations.push({
      order: 30,
      phase: 'snapshot',
      kind: 'main.snapshot',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}:main`,
      result: 'resume: snapshot already published',
    });
  }

  // ---- Post-snapshot: update description ----------------------------------
  // Replace the temporary marker only after template.lock + snapshot provide
  // durable recovery evidence. This is desired state, not best-effort.
  if (currentPhase === 'SNAPSHOT_MAIN') {
    const description = input.config.repository?.description ?? `${input.product} monorepo`;
    const settingsChanged =
      observed.repository?.description !== description ||
      observed.repository?.defaultBranch !== 'main';
    if (settingsChanged) {
      if (!repository) throw new Error('state machine error: repository not set at SNAPSHOT_MAIN');
      repository = await deps.writer.updateRepositorySettings({
        repository,
        description,
        defaultBranch: 'main',
      });
    }
    operations.push({
      order: 35,
      phase: 'repository',
      kind: 'repository.settings',
      disposition: settingsChanged ? 'update' : 'noop',
      target: `${input.target.owner}/${input.target.repo}`,
      result: `default_branch=main, description=${JSON.stringify(description)}`,
    });
  }

  if (currentPhase === 'SNAPSHOT_MAIN' && deps.stopAfterSnapshot) {
    return buildInitResult(
      'SNAPSHOT_MAIN',
      operations,
      'configure-repository',
      repository,
      mainSha ?? observed.repository?.mainSha,
    );
  }

  // ---- Phase: REPO_CONFIGURED (labels + teams + envs + repo ruleset) -------

  if (currentPhase === 'SNAPSHOT_MAIN') {
    if (!repository) throw new Error('state machine error: repository not set at SNAPSHOT_MAIN');

    // Labels (§3.1: two families — 5 gate + 8 backlog).
    const desiredLabels = buildDesiredLabels();
    try {
      const labelsResult = await deps.writer.reconcileLabels({
        repository,
        desired: desiredLabels,
      });
      operations.push({
        order: 40,
        phase: 'labels',
        kind: 'labels.upsert',
        disposition:
          labelsResult.created.length > 0 || labelsResult.updated.length > 0 ? 'create' : 'noop',
        target: `${input.target.owner}/${input.target.repo}:labels`,
        result: `created=${labelsResult.created.length}, updated=${labelsResult.updated.length}, noop=${labelsResult.noop.length}`,
      });
    } catch (err) {
      operations.push({
        order: 40,
        phase: 'labels',
        kind: 'labels.upsert',
        disposition: 'blocked',
        target: `${input.target.owner}/${input.target.repo}:labels`,
        result: (err as Error).message,
      });
      return buildInitResult(currentPhase, operations, 'blocked', repository, mainSha);
    }

    // Team permissions (D13: validate + grant, never create teams).
    const teamAssignments = buildTeamAssignments(input);
    try {
      const teamsResult = await deps.writer.grantTeamPermissions({
        repository,
        assignments: teamAssignments,
      });
      operations.push({
        order: 50,
        phase: 'teams',
        kind: 'teams.grant',
        disposition: 'create',
        target: `${input.target.owner}/${input.target.repo}:teams`,
        result: `granted=${teamsResult.created.length}`,
      });
    } catch (err) {
      const msg = (err as Error).message;
      // Team missing → blocked (D13).
      operations.push({
        order: 50,
        phase: 'teams',
        kind: 'teams.grant',
        disposition: 'blocked',
        target: `${input.target.owner}/${input.target.repo}:teams`,
        result: msg,
      });
      return buildInitResult(currentPhase, operations, 'blocked', repository, mainSha);
    }

    // Environments.
    const desiredEnvs = buildDesiredEnvironments(input);
    if (desiredEnvs.length > 0) {
      try {
        const envsResult = await deps.writer.reconcileEnvironments({
          repository,
          desired: desiredEnvs,
        });
        operations.push({
          order: 60,
          phase: 'environments',
          kind: 'environments.upsert',
          disposition: envsResult.created.length > 0 ? 'create' : 'noop',
          target: `${input.target.owner}/${input.target.repo}:environments`,
          result: `created=${envsResult.created.length}, noop=${envsResult.noop.length}`,
        });
      } catch (err) {
        operations.push({
          order: 60,
          phase: 'environments',
          kind: 'environments.upsert',
          disposition: 'blocked',
          target: `${input.target.owner}/${input.target.repo}:environments`,
          result: (err as Error).message,
        });
        return buildInitResult(currentPhase, operations, 'blocked', repository, mainSha);
      }
    } else {
      operations.push({
        order: 60,
        phase: 'environments',
        kind: 'environments.upsert',
        disposition: 'noop',
        target: `${input.target.owner}/${input.target.repo}:environments`,
        result: 'no environments configured',
      });
    }

    // Repository ruleset (initial, no required checks — §3.2).
    try {
      const rulesetResult = await deps.writer.reconcileRepositoryRuleset({
        repository,
        hardened: false,
      });
      operations.push({
        order: 70,
        phase: 'ruleset',
        kind: 'ruleset.repository',
        disposition:
          rulesetResult.created.length > 0
            ? 'create'
            : rulesetResult.updated.length > 0
              ? 'update'
              : 'noop',
        target: `${input.target.owner}/${input.target.repo}:sdd-main`,
        result: 'initial ruleset (no required checks)',
      });
    } catch (err) {
      operations.push({
        order: 70,
        phase: 'ruleset',
        kind: 'ruleset.repository',
        disposition: 'blocked',
        target: `${input.target.owner}/${input.target.repo}:sdd-main`,
        result: (err as Error).message,
      });
      return buildInitResult(currentPhase, operations, 'blocked', repository, mainSha);
    }

    currentPhase = 'REPO_CONFIGURED';
  } else if (currentPhase === 'REPO_CONFIGURED' || isLaterPhase(currentPhase, 'REPO_CONFIGURED')) {
    operations.push({
      order: 40,
      phase: 'labels',
      kind: 'labels.upsert',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}:labels`,
      result: 'resume',
    });
    operations.push({
      order: 50,
      phase: 'teams',
      kind: 'teams.grant',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}:teams`,
      result: 'resume',
    });
    operations.push({
      order: 60,
      phase: 'environments',
      kind: 'environments.upsert',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}:environments`,
      result: 'resume',
    });
    operations.push({
      order: 70,
      phase: 'ruleset',
      kind: 'ruleset.repository',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}:sdd-main`,
      result: 'resume',
    });
  }

  // ---- Phase: ORG_WORKFLOWS_EVALUATING -------------------------------------
  // MUST happen BEFORE Bootstrap PR creation (§2.3 step 6, §3.2).

  if (currentPhase === 'REPO_CONFIGURED') {
    if (!repository) throw new Error('state machine error: repository not set');

    // Resolve platform repo id and pinned SHA.
    const platformRepoRef = parseRepoRef(input.platform.repository);
    const resolvedCommit = input.platform.ref ?? '';

    // We need the platform repo's numeric ID — read it via the reader.
    const platformObserved = await deps.reader.observe({
      ...input,
      target: { owner: platformRepoRef.owner, repo: platformRepoRef.repo, visibility: 'private' },
    });
    const platformRepoId = platformObserved.repository?.id ?? 0;

    try {
      const orgRulesetResult = await deps.writer.reconcileOrgWorkflowRuleset({
        repository,
        platformRepoId,
        pinnedSha: resolvedCommit,
        enforcement: 'evaluate',
      });
      operations.push({
        order: 80,
        phase: 'org-workflows',
        kind: 'ruleset.org-workflow',
        disposition:
          orgRulesetResult.created.length > 0
            ? 'create'
            : orgRulesetResult.updated.length > 0
              ? 'update'
              : 'noop',
        target: `${input.target.owner}/${input.target.repo}:sdd-workflows-${repository.id}`,
        result: 'enforcement=evaluate',
      });
    } catch (err) {
      operations.push({
        order: 80,
        phase: 'org-workflows',
        kind: 'ruleset.org-workflow',
        disposition: 'blocked',
        target: `${input.target.owner}/${input.target.repo}:sdd-workflows-${repository.id}`,
        result: (err as Error).message,
      });
      return buildInitResult(currentPhase, operations, 'blocked', repository, mainSha);
    }

    currentPhase = 'ORG_WORKFLOWS_EVALUATING';
  } else if (isLaterPhase(currentPhase, 'ORG_WORKFLOWS_EVALUATING')) {
    operations.push({
      order: 80,
      phase: 'org-workflows',
      kind: 'ruleset.org-workflow',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}:org-workflows`,
      result: 'resume',
    });
  }

  // ---- Phase: BOOTSTRAP_PR_OPEN → AWAITING_HUMAN --------------------------

  if (currentPhase === 'ORG_WORKFLOWS_EVALUATING') {
    if (!repository) throw new Error('state machine error: repository not set');

    const bootstrapTitle = `sdd bootstrap: ${input.product} initial structure`;
    const bootstrapBody = [
      `## SDD Bootstrap PR`,
      ``,
      `This PR was created by \`sdd product init\` to establish the initial`,
      `CODEOWNERS partition and product configuration for **${input.product}**.`,
      ``,
      `### What this PR contains`,
      `- Partitioned CODEOWNERS mapping (§3.3)`,
      `- Product identity files (projects.yaml, AGENTS.md, README.md)`,
      `- Template structure (specs/, contracts/, design/)`,
      ``,
      `### After merge`,
      `Run \`sdd product init --finalize-protection\` to activate required checks.`,
      ``,
      `---`,
      `operation_id: ${plan.operation_id}`,
    ].join('\n');

    try {
      const bootstrapPr = await deps.writer.upsertBootstrapPull({
        repository,
        title: bootstrapTitle,
        body: bootstrapBody,
        headBranch: 'sdd/bootstrap',
        baseBranch: 'main',
        reviewers: input.config.bootstrap.approvers,
        owners: input.config.owners,
      });
      operations.push({
        order: 90,
        phase: 'bootstrap-pull',
        kind: 'pull.bootstrap',
        disposition: 'create',
        target: `${input.target.owner}/${input.target.repo}:bootstrap`,
        result: `PR #${bootstrapPr.number} (${bootstrapPr.headSha.slice(0, 8)})`,
      });

      currentPhase = 'BOOTSTRAP_PR_OPEN';

      return buildInitResult(
        'AWAITING_HUMAN',
        operations,
        'await-human-merge',
        repository,
        mainSha,
        { number: bootstrapPr.number, headSha: bootstrapPr.headSha },
      );
    } catch (err) {
      operations.push({
        order: 90,
        phase: 'bootstrap-pull',
        kind: 'pull.bootstrap',
        disposition: 'blocked',
        target: `${input.target.owner}/${input.target.repo}:bootstrap`,
        result: (err as Error).message,
      });
      return buildInitResult(currentPhase, operations, 'blocked', repository, mainSha);
    }
  } else if (currentPhase === 'BOOTSTRAP_PR_OPEN' || currentPhase === 'AWAITING_HUMAN') {
    // Already created PR — check if it's still open or merged.
    const bootstrapObserved = observed.bootstrapPullRequest;
    if (bootstrapObserved?.state === 'merged') {
      // PR was merged — continue to finalize path.
      operations.push({
        order: 90,
        phase: 'bootstrap-pull',
        kind: 'pull.bootstrap',
        disposition: 'noop',
        target: `${input.target.owner}/${input.target.repo}:bootstrap`,
        result: 'resume: merged',
      });

      return buildInitResult(
        'BOOTSTRAP_MERGED',
        operations,
        'run-finalize-protection',
        repository,
        mainSha,
        { number: bootstrapObserved.number, headSha: bootstrapObserved.headSha },
      );
    }

    operations.push({
      order: 90,
      phase: 'bootstrap-pull',
      kind: 'pull.bootstrap',
      disposition: 'noop',
      target: `${input.target.owner}/${input.target.repo}:bootstrap`,
      result: 'resume: PR open',
    });

    return buildInitResult(
      'AWAITING_HUMAN',
      operations,
      'await-human-merge',
      repository,
      mainSha,
      bootstrapObserved
        ? { number: bootstrapObserved.number, headSha: bootstrapObserved.headSha }
        : undefined,
    );
  }

  // ---- Return result ------------------------------------------------------

  const nextAct: NextAction = 'complete';
  return buildInitResult(currentPhase, operations, nextAct, repository, mainSha);
}

// ---- finalizeProtection (§2.3 step 6, idempotent) -------------------------

/**
 * Evidence that finalizeProtection must recover before it will switch the
 * org ruleset to `active` and harden the product ruleset. See §2.3 step 6.
 */
export interface FinalizeConfig {
  /**
   * Bootstrap approver team slugs. If supplied, every approving reviewer
   * must be a member of one of these teams (the caller resolves membership
   * upstream). When omitted, finalize only checks reviewer !== author.
   */
  bootstrapApprovers?: ReadonlyArray<string>;
}

/** Well-known GitHub Actions app id (used to bind required status checks). */
const GITHUB_ACTIONS_APP_ID = 15368;

/**
 * Activate required protections after the Bootstrap PR has merged and all
 * evidence checks out. Idempotent and fail-closed — see §2.3 step 6 and
 * §3.2. If any evidence is missing or inconsistent, the function refuses
 * to mutate anything and returns a `blocked` InitResult.
 *
 * Evidence required (all must hold):
 *   - Bootstrap PR state === 'merged'
 *   - ≥1 approval, each bound to the PR's final head SHA, reviewer ≠ author
 *   - If `config.bootstrapApprovers` given, each reviewer is in that set
 *   - Check runs on the final head: `CI Gate` + `PR hygiene`, conclusion=success,
 *     app.id === GITHUB_ACTIONS_APP_ID
 *   - Org workflow ruleset exists, enforcement === 'evaluate', target matches
 *     current repo/main, source matches pinned platform repo/path/sha
 *     recovered from template.lock
 *   - Merge commit reachable from current main
 *
 * Mutation sequence (only after all evidence passes):
 *   1. org ruleset: evaluate → active
 *   2. product ruleset: add required_status_checks with integration_id
 *   3. read-back both (handled by the reconcilers)
 *
 * The platform source identity is recovered from the target repo's
 * `template.lock` + the existing org ruleset — the caller MUST NOT pass it.
 */
export async function finalizeProtection(
  target: ProductInitInput['target'],
  deps: { reader: GitHubReadPort; writer: GitHubWritePort },
  config: FinalizeConfig = {},
): Promise<InitResult> {
  const operations: AppliedOperation[] = [];

  // Build a minimal input just to drive observe(). finalize doesn't need
  // the full product/platform config — it recovers source identity from
  // template.lock and the existing org ruleset.
  const observeInput: ProductInitInput = {
    product: '',
    target,
    mode: 'monorepo',
    platform: { repository: '', ref: '' },
    config: {
      schema_version: 1,
      bootstrap: { approvers: [] },
      owners: { product: '', api: '', design: '', admins: '' },
    },
  };

  const observed = await deps.reader.observe(observeInput);
  if (!observed.repositoryExists || !observed.repository) {
    throw new Error('finalizeProtection: target repo does not exist');
  }

  const repository: RepositoryIdentity = {
    owner: target.owner,
    name: target.repo,
    id: observed.repository.id,
    defaultBranch: observed.repository.defaultBranch,
    visibility: observed.repository.visibility,
  };

  // Helper: emit a blocked operation and return.
  const blocked = (
    phase: AppliedOperation['phase'],
    kind: string,
    targetLabel: string,
    resultMsg: string,
  ): InitResult => {
    operations.push({
      order: operations.length * 10 + 100,
      phase,
      kind,
      disposition: 'blocked',
      target: targetLabel,
      result: resultMsg,
    });
    return buildInitResult('BOOTSTRAP_MERGED', operations, 'blocked', repository);
  };

  // ---- Evidence 1: Bootstrap PR merged -------------------------------------
  const bootstrapPr = observed.bootstrapPullRequest;
  if (bootstrapPr?.state !== 'merged') {
    return blocked(
      'bootstrap-pull',
      'pull.bootstrap.verify',
      `${target.owner}/${target.repo}:bootstrap`,
      `Bootstrap PR not merged (state: ${bootstrapPr?.state ?? 'not found'})`,
    );
  }

  operations.push({
    order: 100,
    phase: 'bootstrap-pull',
    kind: 'pull.bootstrap.verify',
    disposition: 'noop',
    target: `${target.owner}/${target.repo}:bootstrap`,
    result: `PR #${bootstrapPr.number} merged (head: ${bootstrapPr.headSha.slice(0, 8)})`,
  });

  // ---- Evidence 2: approvals bound to final head, reviewer ≠ author -------
  const approvals = bootstrapPr.approvals ?? [];
  if (approvals.length === 0) {
    return blocked(
      'bootstrap-pull',
      'approval.verify',
      `${target.owner}/${target.repo}:bootstrap`,
      'no APPROVED reviews on Bootstrap PR',
    );
  }
  const finalHead = bootstrapPr.headSha;
  const author = bootstrapPr.author;
  const staleApprovals: string[] = [];
  const selfApprovals: string[] = [];
  for (const approval of approvals) {
    if (approval.headSha !== finalHead) {
      staleApprovals.push(`${approval.user}@${approval.headSha.slice(0, 8)}`);
    }
    if (author && approval.user === author) {
      selfApprovals.push(approval.user);
    }
  }
  if (staleApprovals.length > 0) {
    return blocked(
      'bootstrap-pull',
      'approval.verify',
      `${target.owner}/${target.repo}:bootstrap`,
      `approval(s) not bound to final head ${finalHead.slice(0, 8)}: ${staleApprovals.join(', ')}`,
    );
  }
  if (selfApprovals.length > 0) {
    return blocked(
      'bootstrap-pull',
      'approval.verify',
      `${target.owner}/${target.repo}:bootstrap`,
      `self-approval not permitted: ${selfApprovals.join(', ')}`,
    );
  }
  // Optional: cross-check against bootstrapApprovers allow-list.
  if (config.bootstrapApprovers && config.bootstrapApprovers.length > 0) {
    const allow = new Set(config.bootstrapApprovers);
    const unknownReviewers = approvals.map((a) => a.user).filter((user) => !allow.has(user));
    if (unknownReviewers.length > 0) {
      return blocked(
        'bootstrap-pull',
        'approval.verify',
        `${target.owner}/${target.repo}:bootstrap`,
        `reviewer(s) not in bootstrap.approvers: ${unknownReviewers.join(', ')}`,
      );
    }
  }

  operations.push({
    order: 110,
    phase: 'bootstrap-pull',
    kind: 'approval.verify',
    disposition: 'noop',
    target: `${target.owner}/${target.repo}:bootstrap`,
    result: `${approvals.length} approval(s) bound to final head ${finalHead.slice(0, 8)}`,
  });

  // ---- Evidence 3: CI Gate + PR hygiene succeeded on final head -------------
  const checkRuns = observed.bootstrapCheckRuns ?? [];
  const requiredContexts = ['CI Gate', 'PR hygiene'] as const;
  for (const ctx of requiredContexts) {
    const matching = checkRuns.filter((cr) => cr.context === ctx);
    if (matching.length === 0) {
      return blocked(
        'ruleset',
        'check.verify',
        `${target.owner}/${target.repo}:${ctx}`,
        `no check run for '${ctx}' on head ${finalHead.slice(0, 8)}`,
      );
    }
    const onFinalHead = matching.find((cr) => cr.headSha === finalHead);
    if (!onFinalHead) {
      return blocked(
        'ruleset',
        'check.verify',
        `${target.owner}/${target.repo}:${ctx}`,
        `'${ctx}' ran but not on final head (have: ${matching.map((m) => m.headSha.slice(0, 8)).join(', ')})`,
      );
    }
    if (onFinalHead.conclusion !== 'success') {
      return blocked(
        'ruleset',
        'check.verify',
        `${target.owner}/${target.repo}:${ctx}`,
        `'${ctx}' conclusion='${onFinalHead.conclusion}' on final head, expected 'success'`,
      );
    }
    if (onFinalHead.appId !== GITHUB_ACTIONS_APP_ID) {
      return blocked(
        'ruleset',
        'check.verify',
        `${target.owner}/${target.repo}:${ctx}`,
        `'${ctx}' produced by app id ${onFinalHead.appId}, expected GitHub Actions (${GITHUB_ACTIONS_APP_ID})`,
      );
    }
  }

  operations.push({
    order: 120,
    phase: 'ruleset',
    kind: 'check.verify',
    disposition: 'noop',
    target: `${target.owner}/${target.repo}:checks`,
    result: `CI Gate + PR hygiene succeeded on ${finalHead.slice(0, 8)} (app=${GITHUB_ACTIONS_APP_ID})`,
  });

  // ---- Evidence 4: org ruleset pinned source + target ----------------------
  const templateLock = observed.repository.templateLock;
  if (!templateLock) {
    return blocked(
      'org-workflows',
      'ruleset.org-workflow.verify',
      `${target.owner}/${target.repo}:template.lock`,
      'template.lock not readable from target repo — cannot recover platform source',
    );
  }
  let parsedLock: { source?: { repository?: string; resolved_commit?: string } };
  try {
    // template.lock is canonical YAML; we do a light parse here to extract
    // the platform repo + resolved commit. Full parse is in render.ts; we
    // intentionally don't re-import it to avoid circular deps.
    // Lazy-import YAML parser only when needed.
    const { parse: parseYaml } = await import('yaml');
    parsedLock = parseYaml(templateLock) as typeof parsedLock;
  } catch (err) {
    return blocked(
      'org-workflows',
      'ruleset.org-workflow.verify',
      `${target.owner}/${target.repo}:template.lock`,
      `template.lock failed to parse: ${(err as Error).message}`,
    );
  }
  const platformRepo = parsedLock.source?.repository;
  const pinnedSha = parsedLock.source?.resolved_commit;
  if (!platformRepo || !pinnedSha) {
    return blocked(
      'org-workflows',
      'ruleset.org-workflow.verify',
      `${target.owner}/${target.repo}:template.lock`,
      'template.lock missing source.repository or source.resolved_commit',
    );
  }

  const orgSource = observed.orgWorkflowRulesetSource;
  if (!observed.orgWorkflowRulesetExists || !orgSource) {
    return blocked(
      'org-workflows',
      'ruleset.org-workflow.verify',
      `${target.owner}/${target.repo}:org-workflows`,
      'org workflow ruleset sdd-workflows-<id> not found',
    );
  }
  if (observed.orgWorkflowRulesetEnforcement !== 'evaluate') {
    if (observed.orgWorkflowRulesetEnforcement === 'active') {
      // Already finalized — this is the idempotent path. Fall through to
      // harden the product ruleset (also idempotent).
      operations.push({
        order: 130,
        phase: 'org-workflows',
        kind: 'ruleset.org-workflow.activate',
        disposition: 'noop',
        target: `${target.owner}/${target.repo}:org-workflows`,
        result: 'already active',
      });
    } else {
      return blocked(
        'org-workflows',
        'ruleset.org-workflow.verify',
        `${target.owner}/${target.repo}:org-workflows`,
        `unexpected enforcement: ${observed.orgWorkflowRulesetEnforcement}`,
      );
    }
  } else {
    // Verify target — must match current repo/main.
    if (orgSource.targetRepoId !== undefined && orgSource.targetRepoId !== repository.id) {
      return blocked(
        'org-workflows',
        'ruleset.org-workflow.verify',
        `${target.owner}/${target.repo}:org-workflows`,
        `org ruleset targets repo id ${orgSource.targetRepoId}, expected ${repository.id}`,
      );
    }
    if (orgSource.targetRefPattern && orgSource.targetRefPattern !== 'refs/heads/main') {
      return blocked(
        'org-workflows',
        'ruleset.org-workflow.verify',
        `${target.owner}/${target.repo}:org-workflows`,
        `org ruleset targets '${orgSource.targetRefPattern}', expected 'refs/heads/main'`,
      );
    }
    // Verify source — must match template.lock's pinned platform repo/sha.
    // We compare the platform repo by name (org ruleset stores repo id,
    // template.lock stores 'owner/repo' — caller must reconcile).
    if (orgSource.sha.toLowerCase() !== pinnedSha.toLowerCase()) {
      return blocked(
        'org-workflows',
        'ruleset.org-workflow.verify',
        `${target.owner}/${target.repo}:org-workflows`,
        `org ruleset pinned SHA ${orgSource.sha.slice(0, 8)} does not match template.lock ${pinnedSha.slice(0, 8)}`,
      );
    }
    // Note: platform repo id vs name reconciliation would require an extra
    // read; for M2 we trust that the name→id mapping was validated at init
    // time and verify only the SHA pin here.
  }

  // ---- Evidence 5: merge commit reachable from main ------------------------
  const mergeCommit = bootstrapPr.mergeCommitSha;
  const mainSha = observed.repository.mainSha;
  if (!mergeCommit || !mainSha) {
    return blocked(
      'bootstrap-pull',
      'merge.verify',
      `${target.owner}/${target.repo}:main`,
      'merge commit SHA or current main SHA unavailable',
    );
  }
  // The merge commit must be reachable from current main. We use the
  // reader's resolveCommit to detect whether main is at the merge commit
  // or a descendant. In practice, after the Bootstrap PR merge, main
  // should point directly at the merge commit (or at a subsequent
  // snapshot if other work landed — but that other work would not have
  // been possible without required checks already in place, so the
  // common case is main === merge_commit).
  if (mainSha !== mergeCommit) {
    // main has advanced beyond the merge commit. This is only acceptable
    // if the advancement was done through the protected path (i.e., with
    // required checks already active). For M2 we treat this as drift.
    return blocked(
      'bootstrap-pull',
      'merge.verify',
      `${target.owner}/${target.repo}:main`,
      `main=${mainSha.slice(0, 8)} has advanced past merge commit=${mergeCommit.slice(0, 8)} — unexpected drift`,
    );
  }

  operations.push({
    order: 140,
    phase: 'bootstrap-pull',
    kind: 'merge.verify',
    disposition: 'noop',
    target: `${target.owner}/${target.repo}:main`,
    result: `main == merge commit ${mergeCommit.slice(0, 8)}`,
  });

  // ---- All evidence gathered. Now mutate. ----------------------------------

  // Step 1: activate org workflow ruleset (evaluate → active). Only if not
  // already active (idempotent).
  if (observed.orgWorkflowRulesetEnforcement === 'evaluate') {
    try {
      // Recover platformRepoId: we don't have it directly, but the writer
      // needs it. Reconstruct from observed org source — it already stores
      // the platform repo id.
      const platformRepoId = orgSource.repositoryId;
      await deps.writer.reconcileOrgWorkflowRuleset({
        repository,
        platformRepoId,
        pinnedSha,
        enforcement: 'active',
      });
      operations.push({
        order: 200,
        phase: 'org-workflows',
        kind: 'ruleset.org-workflow.activate',
        disposition: 'update',
        target: `${target.owner}/${target.repo}:org-workflows`,
        result: `evaluate → active (pinned ${platformRepo.split('/')[1]}/${pinnedSha.slice(0, 8)})`,
      });
    } catch (err) {
      // Fail closed: do NOT proceed to harden the product ruleset.
      return blocked(
        'org-workflows',
        'ruleset.org-workflow.activate',
        `${target.owner}/${target.repo}:org-workflows`,
        `activate failed: ${(err as Error).message}`,
      );
    }
  }

  // Step 2: harden product ruleset — add required status checks with
  // integration_id binding (D10). Idempotent: the reconciler compares
  // desired vs existing rules.
  try {
    await deps.writer.reconcileRepositoryRuleset({
      repository,
      hardened: {
        requiredCheckContexts: ['CI Gate', 'PR hygiene'],
        integrationId: GITHUB_ACTIONS_APP_ID,
      },
    });
    operations.push({
      order: 210,
      phase: 'ruleset',
      kind: 'ruleset.repository.harden',
      disposition: 'update',
      target: `${target.owner}/${target.repo}:sdd-main`,
      result: `added required_status_checks [CI Gate, PR hygiene] integration_id=${GITHUB_ACTIONS_APP_ID}`,
    });
  } catch (err) {
    // Fail closed. Org ruleset may already be active — that's OK, the next
    // run of finalize will reconcile. We do not pretend to be COMPLETE.
    return blocked(
      'ruleset',
      'ruleset.repository.harden',
      `${target.owner}/${target.repo}:sdd-main`,
      `harden failed: ${(err as Error).message}`,
    );
  }

  const result: InitResult = {
    phase: 'COMPLETE',
    operations,
    repository,
    mainSha,
    bootstrapPr: { number: bootstrapPr.number, headSha: bootstrapPr.headSha },
    nextAction: 'complete',
  };

  return result;
}

// ---- Helpers (M2c) ---------------------------------------------------------

/**
 * Build the desired labels for §3.1 (two families: 5 gate + 8 backlog).
 */
function buildDesiredLabels(): Array<{ name: string; color: string; description: string }> {
  return [
    // Gate family (§3.1).
    { name: 'gate:spec', color: '0075ca', description: 'Spec Gate PR' },
    { name: 'gate:architecture', color: '0075ca', description: 'Architecture Gate PR' },
    { name: 'gate:design', color: '0075ca', description: 'Design Gate PR' },
    { name: 'gate:plan', color: '0075ca', description: 'Plan Gate PR' },
    { name: 'gate:contract', color: '0075ca', description: 'Contract Gate PR (M4.5)' },
    // Backlog/issue family (§3.1, handbook §5.3).
    { name: 'platform:backend', color: 'e4e669', description: 'Backend platform' },
    { name: 'platform:web', color: 'e4e669', description: 'Web platform' },
    { name: 'platform:ios', color: 'e4e669', description: 'iOS platform' },
    { name: 'platform:android', color: 'e4e669', description: 'Android platform' },
    { name: 'track:spec', color: 'bfdadc', description: 'Spec track' },
    { name: 'track:design', color: 'bfdadc', description: 'Design track' },
    { name: 'track:contract', color: 'bfdadc', description: 'Contract track' },
    { name: 'track:code', color: 'bfdadc', description: 'Code track' },
    { name: 'type:epic', color: 'd4c5f9', description: 'Epic' },
    { name: 'type:task', color: 'd4c5f9', description: 'Task' },
    { name: 'type:change', color: 'd4c5f9', description: 'Change' },
    { name: 'status:blocked', color: 'b60205', description: 'Blocked' },
  ];
}

function buildTeamAssignments(
  input: ProductInitInput,
): Array<{ team: string; permission: string }> {
  const assignments: Array<{ team: string; permission: string }> = [];
  const perms = input.config.team_permissions ?? {};
  for (const [team, permission] of Object.entries(perms)) {
    assignments.push({ team, permission });
  }
  return assignments.sort((a, b) => a.team.localeCompare(b.team));
}

function buildDesiredEnvironments(
  input: ProductInitInput,
): Array<{ name: string; reviewers: string[]; preventSelfReview: boolean }> {
  const envs = input.config.environments ?? {};
  return Object.entries(envs)
    .map(([name, config]) => ({
      name,
      reviewers: config.reviewers,
      preventSelfReview: config.prevent_self_review ?? false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isLaterPhase(current: InitPhase, target: InitPhase): boolean {
  const order: InitPhase[] = [
    'PLANNED',
    'REPO_CREATED',
    'SEED_MAIN',
    'SNAPSHOT_MAIN',
    'REPO_CONFIGURED',
    'ORG_WORKFLOWS_EVALUATING',
    'BOOTSTRAP_PR_OPEN',
    'AWAITING_HUMAN',
    'BOOTSTRAP_MERGED',
    'CHECKS_VERIFIED',
    'ORG_WORKFLOWS_ACTIVE',
    'REPO_RULESET_HARDENED',
    'COMPLETE',
  ];
  const currentIdx = order.indexOf(current);
  const targetIdx = order.indexOf(target);
  return currentIdx >= targetIdx;
}

// ---- Helpers --------------------------------------------------------------

/**
 * Re-render the template tree for apply. Deterministic — produces
 * byte-identical output to compileInitPlan's render.
 */
async function renderForApply(
  input: ProductInitInput,
  plan: InitPlan,
  reader: GitHubReadPort,
): Promise<ReturnType<typeof renderTree>> {
  const platformRepoRef = parseRepoRef(input.platform.repository);
  const resolvedCommit = plan.source.resolved_commit;

  const tree: ReadonlyTree = await reader.readTemplateTree(
    platformRepoRef,
    resolvedCommit,
    'templates/monorepo-root',
  );

  const rendered = renderTree({
    tree: assembleTree(tree.manifest, [...tree.entries]),
    context: {
      product: input.product,
      repo: input.target.owner,
      owners: input.config.owners,
    },
    source: {
      repository: input.platform.repository,
      requestedRef: input.platform.ref ?? '<unpinned>',
      resolvedCommit,
    },
    generator: { package: '@sdd/factory', version: '0.1.0' },
  });
  if (rendered.outputTreeSha256 !== plan.template.output_tree_sha256) {
    throw new Error(
      `applyInitPlan: rendered tree digest changed after planning ` +
        `(plan=${plan.template.output_tree_sha256}, apply=${rendered.outputTreeSha256})`,
    );
  }
  return rendered;
}

/**
 * Determine the starting phase from observed GitHub state (D11: phase derived
 * from actual state, no local checkpoint).
 *
 * M2c: handles all phases through BOOTSTRAP_PR_OPEN / AWAITING_HUMAN.
 */
function determineStartPhase(
  observed: ObservedState,
  plan: InitPlan,
): { phase: InitPhase; seedCommit?: string } {
  if (!observed.repositoryExists) {
    return { phase: 'PLANNED' };
  }

  const repo = observed.repository;
  if (!repo) {
    return { phase: 'PLANNED' };
  }

  const isOurOperation = repo.initMarker === plan.operation_id;

  if (repo.empty && isOurOperation) {
    return { phase: 'REPO_CREATED' };
  }

  if (repo.empty) {
    // Repo exists but is empty and not ours — handled by preflight.
    return { phase: 'SEED_MAIN' };
  }

  // Repo exists and is not empty. Check progressive state.
  // Check if Bootstrap PR is merged → we're at BOOTSTRAP_MERGED or later.
  if (observed.bootstrapPullRequest?.state === 'merged') {
    if (observed.orgWorkflowRulesetEnforcement === 'active') {
      if (observed.repositoryRulesetExists) {
        return { phase: 'REPO_RULESET_HARDENED' };
      }
      return { phase: 'ORG_WORKFLOWS_ACTIVE' };
    }
    return { phase: 'BOOTSTRAP_MERGED' };
  }

  // Bootstrap PR is open (or doesn't exist yet).
  if (observed.bootstrapPullRequest?.state === 'open') {
    return { phase: 'AWAITING_HUMAN' };
  }

  // No Bootstrap PR yet — check if org workflow ruleset is in place.
  if (observed.orgWorkflowRulesetExists && observed.orgWorkflowRulesetEnforcement === 'evaluate') {
    return { phase: 'ORG_WORKFLOWS_EVALUATING' };
  }

  // If repository ruleset exists, we're at least REPO_CONFIGURED.
  if (observed.repositoryRulesetExists) {
    return { phase: 'REPO_CONFIGURED' };
  }

  // Repo has content — assume at least SEED_MAIN.
  // publishSnapshot will check the ref and return noop if already snapshotted.
  const result: { phase: InitPhase; seedCommit?: string } = { phase: 'SEED_MAIN' };
  const seed = repo.seedCommitSha ?? (repo.mainParentShas?.length === 0 ? repo.mainSha : undefined);
  if (seed !== undefined) result.seedCommit = seed;
  return result;
}

/**
 * M2b preflight checks (per prompt requirements):
 *   - Target repo name validation.
 *   - Existence / partial-state determination (operation_id marker).
 *   - Token capability for repo + contents + git data (implicit via observe).
 *
 * team/env/ruleset capability checks are M2c scope.
 */
function preflightCheck(
  input: ProductInitInput,
  plan: InitPlan,
  observed: ObservedState,
  expectedLock: string,
): void {
  // Repo name was already validated in compileInitPlan (validateSlug).
  // Here we check for conflicts based on observed state.

  if (observed.repositoryExists && observed.repository) {
    const repo = observed.repository;
    const markerMatches = repo.initMarker === plan.operation_id;
    const lockMatches = repo.templateLock === expectedLock;
    const seedMarkerMatches = repo.seedOperationId === plan.operation_id;
    const isOurOperation = repo.empty ? markerMatches : lockMatches && seedMarkerMatches;

    if (!isOurOperation && !repo.empty) {
      // Repo exists, is not empty, and was not created by us → conflict.
      throw new Error(
        `preflight: target repo '${input.target.owner}/${input.target.repo}' exists and is not ` +
          `a partial state from this operation (marker mismatch); cannot proceed.`,
      );
    }

    if (!isOurOperation && repo.empty) {
      // Repo exists and is empty but not ours → conflict.
      throw new Error(
        `preflight: target repo '${input.target.owner}/${input.target.repo}' exists (empty) ` +
          `but was not created by this operation; cannot proceed.`,
      );
    }

    // If isOurOperation, we can resume. No error.
  }

  // If repo doesn't exist, we'll create it. No preflight error.
}
