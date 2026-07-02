/**
 * @sdd/factory — public API.
 *
 * This module is the ONLY surface callers should import from. Internal
 * implementation details (octokit adapter internals, YAML parsing quirks,
 * etc.) are not exported.
 *
 * M2a: compileInitPlan + dry-run support.
 * M2b: + write-port implementation (createRepository, seedMainViaContents,
 *      publishSnapshot) + applyInitPlan state machine.
 */

// Detect platforms (M4)
export type { DetectInput, DetectResult } from './detect.js';
export { detectPlatforms } from './detect.js';
// Gate hygiene (M2c)
export { checkPrHygiene } from './gate-hygiene.js';
// GitHub minimal client (M4, D16)
export type {
  ChangedFileEntry,
  MinimalOctokit,
  PullRequestInfo,
} from './github-minimal-client.js';
export {
  fetchBlobAtRef,
  fetchChangedFiles,
  fetchPullRequest,
  fetchRecursiveTree,
  OPERATION_ID_RE,
  REQ_ID_RE,
  SCR_ID_RE,
} from './github-minimal-client.js';
// Read port
export type { OctokitReadOnly } from './github-read.js';
export { createReadonlyGitHubPort } from './github-read.js';
// Write port (M2b + M2c)
export type { OctokitMutate, SnapshotResult } from './github-write.js';
export {
  createRepository,
  createWriteGitHubPort,
  grantTeamPermissions,
  publishSnapshot,
  reconcileEnvironments,
  reconcileLabels,
  reconcileOrgWorkflowRuleset,
  reconcileRepositoryRuleset,
  seedMainViaContents,
  updateRepositorySettings,
  upsertBootstrapPull,
} from './github-write.js';
// Impact analysis (M4)
export type { ChangedPath, ComputeImpactInput, ImpactReader } from './impact.js';
export {
  computeImpact,
  createApiImpactReader,
  createLocalGitImpactReader,
  diffDesignScreens,
  diffOpenApiOperationsAsync,
  diffRequirementSections,
} from './impact.js';
// Init orchestrator (M2b + M2c)
export type { ApplyInitPlanDeps, FinalizeConfig } from './init.js';
export { applyInitPlan, finalizeProtection } from './init.js';
// Core functions
export { compileInitPlan, serializeInitPlan } from './plan.js';
export {
  computeOutputTreeDigest,
  parseLockYaml,
  rawSha256Hex,
  renderContent,
  renderTree,
} from './render.js';
// Resolve/render utilities (exposed for callers that need to load a manifest
// from disk or render a tree with custom context, e.g. for tests or the CLI
// dry-run preview path).
export {
  assembleTree,
  isFullCommit,
  isSha256,
  parseManifest,
  parseRepoRef,
  resolveRef,
  sha256Hex,
  validateManifest,
} from './resolve.js';
export type { CompiledScaffoldPlan, CompileScaffoldPlanInput } from './scaffold/plan.js';
// Scaffold (M3)
export { compileScaffoldPlan } from './scaffold/plan.js';
export type { OctokitMutate as ScaffoldOctokitMutate } from './scaffold/publish.js';
export { publishComponentBranch, upsertScaffoldPull } from './scaffold/publish.js';
export type { RenderComponentInput, RenderedComponent } from './scaffold/render.js';
export { expectedFilesForComponent, renderComponent } from './scaffold/render.js';
export type {
  ExpectedFile,
  SubtreeVerificationInput,
  SubtreeVerificationResult,
} from './scaffold/subtree.js';
export { verifyComponentSubtree } from './scaffold/subtree.js';
export type {
  ComponentLock,
  PublishComponentBranchInput,
  PublishResult,
  ResolvedTemplate,
  ScaffoldApproval,
  ScaffoldAuthorization,
  ScaffoldComponent,
  ScaffoldComponentPlan,
  ScaffoldDisposition,
  ScaffoldInput,
  ScaffoldNextAction,
  ScaffoldPlan,
  ScaffoldPlannedOperation,
  ScaffoldProductObservation,
  ScaffoldProjects,
  ScaffoldPull,
  ScaffoldReadPort,
  ScaffoldResult,
  ScaffoldWritePort,
  TreeEntry,
  UpsertScaffoldPullInput,
} from './scaffold/types.js';
// Types
export type {
  AppliedOperation,
  BootstrapPull,
  BootstrapPullInput,
  CommitIdentity,
  ComponentRenderContext,
  CreateRepoInput,
  Disposition,
  EnvironmentsInput,
  GitHubReadPort,
  GitHubWritePort,
  InitPhase,
  InitPlan,
  InitResult,
  LabelsInput,
  NextAction,
  ObservedState,
  OrgWorkflowRulesetInput,
  PlannedOperation,
  PlanTemplateFile,
  ProductInitConfig,
  ProductInitInput,
  ProjectsPlan,
  ReadonlyTree,
  ReconcileResult,
  RenderContext,
  RenderedTree,
  RenderInput,
  RepoRef,
  RepositoryIdentity,
  RepositorySettingsInput,
  Requirement,
  ResolvedCommit,
  RulesetInput,
  SeedInput,
  SnapshotInput,
  SourcePlan,
  TargetPlan,
  TeamsInput,
  TemplateManifest,
  TemplateName,
  TemplatePlan,
  TemplateTreeEntry,
} from './types.js';
export { TEMPLATE_NAMES } from './types.js';
export type {
  VerifiedWorkflowPin,
  VerifyRequiredWorkflowPinInput,
  WorkflowPinOctokit,
} from './workflow-pin.js';
export { verifyRequiredWorkflowPin } from './workflow-pin.js';
