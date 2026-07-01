/**
 * scaffold/types.ts — types for `sdd product scaffold` (M3).
 *
 * Mirror of the product-init types in factory/src/types.ts, but scoped to
 * the scaffold workflow: target repo already exists, input is projects.yaml
 * (not product-init.yaml), and output is per-component subtrees on a new
 * branch rather than a fresh repo.
 */

import type { ComponentRenderContext, RepoRef, TemplateManifest } from '../types.js';

// ---- Inputs --------------------------------------------------------------

export interface ScaffoldInput {
  /** Target product repo (already exists). */
  target: RepoRef;
  /** Platform repo (where templates live). */
  source: RepoRef;
  /** projects.yaml contents, pre-validated by @sdd/schemas. */
  projects: ScaffoldProjects;
  /** Approval ref: {pr: N} or {mergeCommitSha: '...'}. Required for real exec. */
  approval?: ScaffoldApproval;
  /** Version label value (e.g. 'v1'). Required for real exec. */
  version?: string;
  /** dry-run flag. */
  dryRun: boolean;
}

export interface ScaffoldApproval {
  pr?: number;
  mergeCommitSha?: string;
}

/**
 * Typed view of projects.yaml for scaffold purposes. The schema enforces
 * the structure; this interface is the typed view downstream code consumes.
 */
export interface ScaffoldProjects {
  schema_version: 1;
  product: string;
  repository_mode: 'monorepo';
  components: ScaffoldComponent[];
}

export interface ScaffoldComponent {
  id: string;
  path: string;
  template: 'spring-boot' | 'web' | 'ios-tuist' | 'android';
  template_ref: string;
  owner: string;
  ci: 'java' | 'web' | 'ios' | 'android';
}

// ---- Read port ------------------------------------------------------------

/**
 * Observed state of the target product repo for scaffold planning.
 */
export interface ScaffoldProductObservation {
  /** Current main HEAD commit SHA. */
  mainSha: string;
  /** Current main tree SHA. */
  mainTreeSha: string;
  /** Blob SHA of projects.yaml on main (for D18 freshness check). */
  mainProjectsYamlBlobSha: string | null;
  /** Set of paths that exist on main (for disposition: existing → noop). */
  existingPaths: Set<string>;
  /** The source (platform repo) observation: template trees at pinned commits. */
  sourceTemplates: Map<string, ResolvedTemplate>;
}

export interface ResolvedTemplate {
  /** The component this template was resolved for. */
  componentId: string;
  /** Resolved commit (== template_ref for 40-hex input). */
  commit: string;
  /** Manifest as parsed at the pinned commit. */
  manifest: TemplateManifest;
  /** The full template tree (all entries). */
  tree: ReadonlyArray<{ path: string; mode: '100644' | '100755'; content: Uint8Array }>;
  /** sha256 of the source tree (== manifest.tree_sha256 after assembly). */
  sourceTreeSha256: string;
}

export interface ScaffoldReadPort {
  /** Resolve the platform repo template tree at a given commit. */
  readTemplateTree(
    repo: RepoRef,
    commit: string,
    templateName: string,
  ): Promise<{
    manifest: TemplateManifest;
    entries: ReadonlyArray<{ path: string; mode: '100644' | '100755'; content: Uint8Array }>;
    sourceTreeSha256: string;
  }>;
  /** Observe the target product repo's current main state. */
  observeProduct(repo: RepoRef): Promise<ScaffoldProductObservation>;
  /** Read a blob's content by its SHA (for D25 subtree verification). */
  readBlobContent(repo: RepoRef, blobSha: string): Promise<Uint8Array>;
  /** List a tree's entries recursively. */
  readTreeRecursive(repo: RepoRef, treeSha: string): Promise<ReadonlyArray<TreeEntry>>;
  /** Resolve a commit (already 40-hex: identity; tag/branch: peel). */
  resolveCommit(
    repo: RepoRef,
    ref: string,
  ): Promise<{ commit: string; requestedRef: string; peeled: boolean }>;
  /** Look up an existing PR by head branch name. */
  findPullByHead(repo: RepoRef, headBranch: string): Promise<PullCandidate | null>;
  /** Resolve team members (D23: verify team exists + ≥1 active member). */
  resolveTeamMembers?(org: string, teamSlug: string): Promise<string[]>;
}

export interface TreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000';
  type: 'blob' | 'tree';
  sha: string;
}

export interface PullCandidate {
  number: number;
  state: 'open' | 'merged' | 'closed';
  headSha: string;
  baseRef: string;
  baseRepoOwner: string;
  baseRepoName: string;
  headRef: string;
  headRepoOwner: string;
  headRepoName: string;
}

// ---- Write port -----------------------------------------------------------

export interface ScaffoldWritePort {
  /** Create a new scaffold branch with the pending components' content. */
  publishComponentBranch(input: PublishComponentBranchInput): Promise<PublishResult>;
  /** Create or reuse a Scaffold PR. */
  upsertScaffoldPull(input: UpsertScaffoldPullInput): Promise<ScaffoldPull>;
}

export interface PublishComponentBranchInput {
  target: RepoRef;
  baseTreeSha: string;
  baseCommitSha: string;
  branchName: string;
  /** Files to write (all under pending component paths). */
  files: ReadonlyArray<{
    path: string;
    mode: '100644' | '100755';
    content: Uint8Array;
  }>;
  commitMessage: string;
}

export interface PublishResult {
  commitSha: string;
  treeSha: string;
  created: boolean;
}

export interface UpsertScaffoldPullInput {
  target: RepoRef;
  headBranch: string;
  baseBranch: 'main';
  title: string;
  body: string;
  /** Team slugs to request review from (D23). */
  teamReviewers: string[];
}

export interface ScaffoldPull {
  number: number;
  headSha: string;
  htmlUrl: string;
  created: boolean;
}

// ---- Plan -----------------------------------------------------------------

export interface ScaffoldPlan {
  plan_version: 1;
  operation_id: string;
  target: {
    owner: string;
    repository: string;
    default_branch: string;
  };
  source: {
    repository: string;
  };
  authorization: ScaffoldAuthorization;
  components: ScaffoldComponentPlan[];
  operations: ScaffoldPlannedOperation[];
  warnings: string[];
}

export interface ScaffoldAuthorization {
  gate: 'architecture';
  version: string | null;
  artifact_path: string;
  main_fresh: boolean;
  verified: boolean;
  reason: string | null;
  provenance?: {
    pr: number;
    approved_head_sha: string;
    merge_commit_sha: string;
    approved_at: string;
    authorization_policy: string;
  };
}

export type ScaffoldDisposition = 'create' | 'noop' | 'blocked' | 'conflict';

export interface ScaffoldComponentPlan {
  id: string;
  path: string;
  owner: string;
  template: string;
  disposition: ScaffoldDisposition;
  detail?: string;
  template_source?: {
    path: string;
    resolved_commit: string;
    manifest_sha256: string;
    source_tree_sha256: string;
    output_tree_sha256: string;
  };
  files?: ReadonlyArray<{
    target: string;
    mode: '100644' | '100755';
    render: boolean;
    output_sha256: string;
  }>;
}

export interface ScaffoldPlannedOperation {
  order: number;
  phase: 'branch' | 'pull-request';
  kind: 'branch.create' | 'pull.upsert';
  disposition: ScaffoldDisposition;
  target: string;
  detail?: string;
}

// ---- Result ---------------------------------------------------------------

export type ScaffoldNextAction = 'await-human-merge' | 'complete' | 'blocked';

export interface ScaffoldResult {
  plan: ScaffoldPlan;
  nextAction: ScaffoldNextAction;
  pullRequest?: { number: number; htmlUrl: string };
  exitCode: number;
}

// ---- Lock file ------------------------------------------------------------

export interface ComponentLock {
  schema_version: 1;
  generator: {
    package: string;
    version: string;
    resolved_commit?: string;
  };
  source: {
    repository: string;
    resolved_commit: string;
  };
  template: {
    name: string;
    path: string;
    manifest_sha256: string;
    source_tree_sha256: string;
    output_tree_sha256: string;
  };
  component: {
    id: string;
    path: string;
    owner: string;
  };
  approved_by: {
    gate: string;
    version: string;
    pr: number;
    approved_head_sha: string;
    merge_commit_sha: string;
    approved_at: string;
    authorization_policy: string;
    required_checks: string[];
  };
  files: ReadonlyArray<{
    path: string;
    mode: '100644' | '100755';
    source_sha256: string;
    output_sha256: string;
  }>;
}

// Re-export component render context for callers.
export type { ComponentRenderContext };
