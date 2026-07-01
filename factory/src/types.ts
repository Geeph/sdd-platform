/**
 * @sdd/factory — public types.
 *
 * This module defines the stable public API surface for product init.
 * Implementation files (resolve / render / plan) consume these types;
 * external callers (CLI) only see these.
 */

import type { SDDProjects } from '@sdd/schemas';

// ---- Inputs --------------------------------------------------------------

export interface ProductInitInput {
  product: string;
  target: {
    owner: string;
    repo: string;
    visibility: 'private' | 'internal' | 'public';
  };
  mode: 'monorepo';
  platform: {
    /** e.g. "acme/sdd-platform" */
    repository: string;
    /** Release tag or full commit SHA. Optional only for dry-run previews. */
    ref?: string;
  };
  config: ProductInitConfig;
}

/**
 * Parsed product-init.yaml. The schema is enforced by @sdd/schemas'
 * `validateProductInitDocument`; this interface is the typed view of that
 * shape for downstream code.
 */
export interface ProductInitConfig {
  schema_version: 1;
  repository?: {
    description?: string;
    visibility?: 'private' | 'internal' | 'public';
  };
  bootstrap: {
    approvers: string[];
  };
  owners: {
    product: string;
    api: string;
    design: string;
    admins: string;
    backend?: string;
    web?: string;
    ios?: string;
    android?: string;
  };
  team_permissions?: Record<string, 'pull' | 'triage' | 'push' | 'maintain' | 'admin'>;
  environments?: Record<
    string,
    {
      reviewers: string[];
      prevent_self_review?: boolean;
    }
  >;
  required_secrets?: string[];
}

// ---- GitHub read port (only this is visible in dry-run) ------------------

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface ResolvedCommit {
  /** Full 40-char lowercase SHA after peeling annotated tags. */
  commit: string;
  /** The ref the caller originally supplied (tag / branch / sha). */
  requestedRef: string;
  /** True if the ref was an annotated tag that got peeled. */
  peeled: boolean;
}

/**
 * A file inside a read-only template tree. Mirrors a manifest entry plus the
 * raw bytes (which the caller fetched at a pinned commit).
 */
export interface TemplateTreeEntry {
  /** Relative POSIX path inside the template directory. */
  path: string;
  /** POSIX mode (only "100644" or "100755" accepted downstream). */
  mode: '100644' | '100755';
  /** Raw UTF-8 content at the pinned commit. */
  content: Uint8Array;
}

/**
 * Manifest as loaded from `templates/<name>.manifest.json`. Same shape as the
 * on-disk JSON but frozen once loaded.
 */
export interface TemplateManifest {
  readonly template: 'monorepo-root';
  readonly path: string;
  readonly tree_sha256: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly mode: '100644' | '100755';
    readonly render: boolean;
    readonly sha256: string;
  }>;
}

export interface ReadonlyTree {
  readonly manifest: TemplateManifest;
  readonly entries: ReadonlyArray<TemplateTreeEntry>;
  /** sha256 of the concatenation of sorted entry sha256s. */
  readonly sourceTreeSha256: string;
}

/**
 * Snapshot of the target org/repo state relevant to planning. In dry-run this
 * is supplied by a fake (deterministic) reader; in real execution it comes
 * from paginated GitHub API calls.
 */
export interface ObservedState {
  /** True iff the target repo already exists. */
  repositoryExists: boolean;
  /** Existing repository identity (if any). */
  repository?: {
    id: number;
    defaultBranch: string;
    visibility: 'private' | 'internal' | 'public';
    empty: boolean;
    /** Existing `[sdd-init:<operation_id>]` marker, if any. */
    initMarker?: string;
    description?: string;
    /** Current default-branch commit state, used for crash recovery. */
    mainSha?: string;
    mainTreeSha?: string;
    mainParentShas?: string[];
    /** Root seed commit discovered by following the single-parent chain. */
    seedCommitSha?: string;
    seedOperationId?: string;
    /** Raw template.lock at main, if present. */
    templateLock?: string;
  };
  /** Existing label names (lower-cased) on the target repo. */
  existingLabels: string[];
  /** Teams observed to exist with ≥1 active member. */
  knownTeams: string[];
  /** Environments observed on the target repo. */
  existingEnvironments: string[];
  /** True if a Bootstrap PR is already open for this init. */
  bootstrapPullRequest?: {
    number: number;
    headSha: string;
    state: 'open' | 'merged' | 'closed';
    /** Merge commit SHA (populated when state === 'merged'). */
    mergeCommitSha?: string;
    /** PR author login. */
    author?: string;
    /** Approved reviews with reviewer login and the head SHA they approved. */
    approvals?: ReadonlyArray<{ user: string; headSha: string }>;
  };
  /** True if an `sdd-main` repository ruleset already exists. */
  repositoryRulesetExists: boolean;
  /** True if a dedicated org workflow ruleset exists for this repo id. */
  orgWorkflowRulesetExists: boolean;
  orgWorkflowRulesetEnforcement?: 'evaluate' | 'active';
  /**
   * Source identity of the org workflow ruleset (recovered during observe).
   * Used by finalize to verify the pinned workflow source has not drifted.
   * Contains ALL workflows from the ruleset, not just the first, so we can
   * verify both CI Gate and PR hygiene are pinned correctly.
   */
  orgWorkflowRulesetSource?: {
    /** All workflows pinned in the ruleset. */
    workflows: ReadonlyArray<{
      repositoryId: number;
      path: string;
      sha: string;
    }>;
    /** Targeted repo id; must equal `repository.id` for the ruleset to be ours. */
    targetRepoId?: number;
    /** Targeted branch pattern; expected `refs/heads/main`. */
    targetRefPattern?: string;
  };
  /**
   * Check runs emitted on the Bootstrap PR's final head SHA. Used by
   * finalizeProtection to verify that `CI Gate` and `PR hygiene` both
   * succeeded on the exact head that was approved/merged.
   */
  bootstrapCheckRuns?: ReadonlyArray<{
    context: string;
    conclusion: string;
    headSha: string;
    /** App id that produced the check run (GitHub Actions = 15368). */
    appId: number;
    /** Check suite used to correlate this job with an Actions workflow run. */
    checkSuiteId: number;
    /** Trusted workflow identity recovered from the correlated run. */
    workflowRepository: string;
    workflowPath: string;
    workflowSha: string;
  }>;
}

/**
 * Read-only port. dry-run sees only this type — there is no write path
 * exposed at the type level.
 */
export interface GitHubReadPort {
  resolveCommit(repo: RepoRef, ref: string): Promise<ResolvedCommit>;
  readTemplateTree(repo: RepoRef, commit: string, path: string): Promise<ReadonlyTree>;
  observe(input: ProductInitInput): Promise<ObservedState>;
  /**
   * Resolve a team slug to its member user logins. Used by finalizeProtection
   * to verify that reviewers are members of bootstrap approver teams.
   * Returns an empty array if the team doesn't exist or has no members.
   */
  resolveTeamMembers?(org: string, teamSlug: string): Promise<string[]>;
  /** True when ancestor is equal to or reachable from descendant. */
  isCommitReachable?(repo: RepoRef, ancestor: string, descendant: string): Promise<boolean>;
}

// ---- GitHub write port (real execution only) -----------------------------

export interface CreateRepoInput {
  owner: string;
  name: string;
  visibility: 'private' | 'internal' | 'public';
  description: string;
  initMarker: string;
}

export interface RepositoryIdentity {
  owner: string;
  name: string;
  id: number;
  defaultBranch: string;
  visibility: 'private' | 'internal' | 'public';
}

export interface SeedInput {
  repository: RepositoryIdentity;
  lockContent: string;
  operationId: string;
}

export interface RepositorySettingsInput {
  repository: RepositoryIdentity;
  description: string;
  defaultBranch: 'main';
}

export interface SnapshotInput {
  repository: RepositoryIdentity;
  seedCommit: string;
  /** Tree SHA of the seed commit. If empty, publishSnapshot reads it from the commit. */
  seedTree?: string;
  /** Canonical seed lock, used to verify an already-published snapshot. */
  lockContent: string;
  files: ReadonlyArray<{
    path: string;
    mode: '100644' | '100755';
    content: Uint8Array;
  }>;
}

export interface CommitIdentity {
  sha: string;
  treeSha: string;
  /** Disposition of the operation: 'create' | 'noop' | 'conflict'. */
  disposition?: 'create' | 'noop' | 'conflict';
}

export interface LabelsInput {
  repository: RepositoryIdentity;
  desired: ReadonlyArray<{
    name: string;
    color: string;
    description: string;
  }>;
}

export interface TeamsInput {
  repository: RepositoryIdentity;
  assignments: ReadonlyArray<{ team: string; permission: string }>;
  /** Referenced teams that must exist with active members even without an assignment. */
  requiredTeams?: ReadonlyArray<string>;
}

export interface EnvironmentsInput {
  repository: RepositoryIdentity;
  desired: ReadonlyArray<{
    name: string;
    reviewers: string[];
    preventSelfReview: boolean;
  }>;
}

export interface RulesetInput {
  repository: RepositoryIdentity;
  /**
   * `false` = initial ruleset (no required checks yet — contexts don't exist
   * before the Bootstrap PR runs). `true` = finalized ruleset with required
   * status checks bound to GitHub Actions integration_id (D10).
   */
  hardened:
    | false
    | {
        /** Required status check contexts (D8: frozen names). */
        requiredCheckContexts: ReadonlyArray<'CI Gate' | 'PR hygiene'>;
        /**
         * GitHub Actions integration_id used to bind the required checks to
         * runs produced by the trusted platform workflow source (D10). The
         * well-known GitHub Actions app id is 15368; callers MAY override.
         */
        integrationId?: number;
      };
}

export interface OrgWorkflowRulesetInput {
  repository: RepositoryIdentity;
  /** GitHub repository id of the platform repo. */
  platformRepoId: number;
  /** Pinned SHA of platform workflows. */
  pinnedSha: string;
  /** "evaluate" on init; "active" on finalize. */
  enforcement: 'evaluate' | 'active';
}

export interface BootstrapPullInput {
  repository: RepositoryIdentity;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  /** Bootstrap approver team slugs (≥1, used for the admins wildcard). */
  reviewers: string[];
  /** CODEOWNERS partition mapping (§3.3). */
  owners: ProductInitConfig['owners'];
}

export interface BootstrapPull {
  number: number;
  headSha: string;
  htmlUrl: string;
}

export interface ReconcileResult {
  created: string[];
  updated: string[];
  noop: string[];
}

export interface GitHubWritePort {
  createRepository(i: CreateRepoInput): Promise<RepositoryIdentity>;
  updateRepositorySettings(i: RepositorySettingsInput): Promise<RepositoryIdentity>;
  seedMainViaContents(i: SeedInput): Promise<CommitIdentity>;
  publishSnapshot(i: SnapshotInput): Promise<CommitIdentity>;
  reconcileLabels(i: LabelsInput): Promise<ReconcileResult>;
  grantTeamPermissions(i: TeamsInput): Promise<ReconcileResult>;
  reconcileEnvironments(i: EnvironmentsInput): Promise<ReconcileResult>;
  reconcileRepositoryRuleset(i: RulesetInput): Promise<ReconcileResult>;
  reconcileOrgWorkflowRuleset(i: OrgWorkflowRulesetInput): Promise<ReconcileResult>;
  upsertBootstrapPull(i: BootstrapPullInput): Promise<BootstrapPull>;
}

// ---- Init plan -----------------------------------------------------------

export type Disposition = 'create' | 'update' | 'noop' | 'blocked' | 'conflict';

export interface PlannedOperation {
  order: number;
  phase:
    | 'repository'
    | 'seed'
    | 'snapshot'
    | 'labels'
    | 'teams'
    | 'environments'
    | 'ruleset'
    | 'org-workflows'
    | 'bootstrap-pull';
  kind: string;
  disposition: Disposition;
  target: string;
  detail?: string;
}

export interface PlanTemplateFile {
  target: string;
  mode: '100644' | '100755';
  render: boolean;
  output_sha256: string;
}

export interface TemplatePlan {
  path: string;
  manifest_sha256: string;
  source_tree_sha256: string;
  output_tree_sha256: string;
  files: PlanTemplateFile[];
}

export interface TargetPlan {
  owner: string;
  repository: string;
  visibility: 'private' | 'internal' | 'public';
  default_branch: string;
}

export interface SourcePlan {
  repository: string;
  requested_ref: string;
  resolved_commit: string;
  ref_pinned: boolean;
}

export interface ProjectsPlan {
  schema_version: 1;
  product: string;
  repository_mode: 'monorepo';
  components: [];
}

export interface Requirement {
  kind: 'team' | 'environment' | 'secret' | 'capability';
  name: string;
  status: 'satisfied' | 'missing' | 'blocked';
}

export interface InitPlan {
  plan_version: 1;
  operation_id: string;
  target: TargetPlan;
  source: SourcePlan;
  template: TemplatePlan;
  projects: ProjectsPlan;
  operations: PlannedOperation[];
  requirements: Requirement[];
  warnings: string[];
}

// ---- Init result ---------------------------------------------------------

export type InitPhase =
  | 'PLANNED'
  | 'REPO_CREATED'
  | 'SEED_MAIN'
  | 'SNAPSHOT_MAIN'
  | 'REPO_CONFIGURED'
  | 'ORG_WORKFLOWS_EVALUATING'
  | 'BOOTSTRAP_PR_OPEN'
  | 'AWAITING_HUMAN'
  | 'BOOTSTRAP_MERGED'
  | 'CHECKS_VERIFIED'
  | 'ORG_WORKFLOWS_ACTIVE'
  | 'REPO_RULESET_HARDENED'
  | 'COMPLETE';

export interface AppliedOperation extends PlannedOperation {
  result?: string;
}

export type NextAction =
  | 'configure-repository'
  | 'await-human-merge'
  | 'run-finalize-protection'
  | 'retry'
  | 'complete'
  | 'blocked';

export interface InitResult {
  phase: InitPhase;
  operations: AppliedOperation[];
  repository?: RepositoryIdentity;
  mainSha?: string;
  bootstrapPr?: { number: number; headSha: string };
  repositoryRulesetId?: number;
  orgWorkflowRulesetId?: number;
  nextAction: NextAction;
}

// ---- Render output -------------------------------------------------------

export interface RenderedTree {
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly mode: '100644' | '100755';
    readonly content: Uint8Array;
  }>;
  readonly outputTreeSha256: string;
  /** Lock file YAML (canonical), not included in outputTreeSha256. */
  readonly lockYaml: string;
  /** Resolved source → output file digest pairs for lock. */
  readonly fileDigests: ReadonlyArray<{
    readonly path: string;
    readonly mode: '100644' | '100755';
    readonly source_sha256: string;
    readonly output_sha256: string;
  }>;
}

export interface RenderContext {
  product: string;
  repo: string; // GitHub org slug
  owners: ProductInitConfig['owners'];
}

export interface RenderInput {
  tree: ReadonlyTree;
  context: RenderContext;
  source: { repository: string; requestedRef: string; resolvedCommit: string };
  generator: { package: string; version: string };
}

// ---- Parsed product-init.yaml (semantic view) -----------------------------

export interface ParsedProductInitConfig extends ProductInitConfig {
  readonly __parsed: true;
}

export type { SDDProjects };
