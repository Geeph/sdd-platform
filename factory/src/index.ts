/**
 * @sdd/factory — public API.
 *
 * This module is the ONLY surface callers should import from. Internal
 * implementation details (octokit adapter internals, YAML parsing quirks,
 * etc.) are not exported.
 *
 * M2a scope: compileInitPlan + dry-run support. Write-port types are
 * declared but no writer implementation exists yet (M2b/c scope).
 */

export type { OctokitReadOnly } from './github-read.js';
// Read-only octokit adapter factory (M2b/c will wire this for real runs).
export { createReadonlyGitHubPort } from './github-read.js';
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
  resolveRef,
  sha256Hex,
  validateManifest,
} from './resolve.js';
// Types
export type {
  AppliedOperation,
  BootstrapPull,
  BootstrapPullInput,
  CommitIdentity,
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
  Requirement,
  ResolvedCommit,
  RulesetInput,
  SeedInput,
  SnapshotInput,
  SourcePlan,
  TargetPlan,
  TeamsInput,
  TemplateManifest,
  TemplatePlan,
  TemplateTreeEntry,
} from './types.js';

// Write port types remain declared only — no implementation in M2a.
