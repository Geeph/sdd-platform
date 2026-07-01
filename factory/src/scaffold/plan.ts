/**
 * scaffold/plan.ts — compile a scaffold plan from validated input.
 *
 * Pure function: no I/O, no writes. Takes validated projects.yaml,
 * resolved templates, and observation of the target product repo, and
 * produces a deterministic `ScaffoldPlan`.
 *
 * Determinism: same inputs → byte-identical output (per M2 D12).
 */

import { sha256Hex } from '../resolve.js';
import type { RenderComponentInput, RenderedComponent } from './render.js';
import { expectedFilesForComponent, renderComponent } from './render.js';
import type {
  ScaffoldAuthorization,
  ScaffoldComponent,
  ScaffoldComponentPlan,
  ScaffoldDisposition,
  ScaffoldPlan,
  ScaffoldPlannedOperation,
  ScaffoldProductObservation,
  ScaffoldProjects,
} from './types.js';

export interface CompileScaffoldPlanInput {
  /** Target product repo (owner/name). */
  target: { owner: string; name: string; defaultBranch: string };
  /** Platform repo string. */
  source: string;
  /** Validated projects.yaml. */
  projects: ScaffoldProjects;
  /** Observed state of the target product repo. */
  observation: ScaffoldProductObservation;
  /** Local worktree projects.yaml blob SHA (for D18 freshness check). */
  localProjectsBlobSha: string;
  /** Authorization state (D18 + Gate verification). */
  authorization: ScaffoldAuthorization;
  /** Generator identity for lock files. */
  generator: { package: string; version: string; resolved_commit?: string };
  /** Approval info (for lock files). */
  approval?: { pr?: number; mergeCommitSha?: string };
  /** Version label (for lock files). */
  version?: string;
  /** Provenance (from verifyGateApproval). */
  provenance?: {
    pr: number;
    approved_head_sha: string;
    merge_commit_sha: string;
    approved_at: string;
    authorization_policy: string;
  };
}

export interface CompiledScaffoldPlan {
  plan: ScaffoldPlan;
  /** Per-component rendered content (only for disposition='create'). */
  rendered: Map<string, RenderedComponent>;
  /** Expected file sets for D25 verification (only for disposition='create'). */
  expectedFiles: Map<string, ReturnType<typeof expectedFilesForComponent>>;
  /** Lock file content (only for disposition='create'). */
  lockContents: Map<string, string>;
}

/**
 * Compile a deterministic scaffold plan. Pure — no I/O.
 */
export function compileScaffoldPlan(input: CompileScaffoldPlanInput): CompiledScaffoldPlan {
  const {
    target,
    source,
    projects,
    observation,
    localProjectsBlobSha,
    authorization,
    generator,
    approval,
    version,
    provenance,
  } = input;

  // Step 1: determine disposition for each component.
  const componentPlans: ScaffoldComponentPlan[] = [];
  const rendered = new Map<string, RenderedComponent>();
  const expectedFiles = new Map<string, ReturnType<typeof expectedFilesForComponent>>();
  const lockContents = new Map<string, string>();

  // Sort components by id for determinism.
  const sortedComponents = [...projects.components].sort((a, b) => a.id.localeCompare(b.id));

  const pendingComponents: ScaffoldComponent[] = [];

  for (const component of sortedComponents) {
    const existsOnMain =
      observation.existingPaths.has(component.path) ||
      [...observation.existingPaths].some((p) => p.startsWith(`${component.path}/`));

    if (existsOnMain) {
      componentPlans.push({
        id: component.id,
        path: component.path,
        owner: component.owner,
        template: component.template,
        disposition: 'noop',
        detail: `${component.path} already has content on main`,
      });
      continue;
    }

    // Resolve template for this component.
    const resolved = observation.sourceTemplates.get(component.id);
    if (!resolved) {
      componentPlans.push({
        id: component.id,
        path: component.path,
        owner: component.owner,
        template: component.template,
        disposition: 'blocked',
        detail: `template not resolved for component '${component.id}'`,
      });
      continue;
    }

    // Render.
    const renderInput: RenderComponentInput = {
      product: projects.product,
      repo: target.name,
      platformRepo: source,
      component,
      resolvedTemplate: resolved,
      generator,
      ...(approval !== undefined ? { approval } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    };
    const renderedComp = renderComponent(renderInput);
    const lockContent = renderedComp.lockYaml;
    const expected = expectedFilesForComponent(component.path, renderedComp, lockContent);

    componentPlans.push({
      id: component.id,
      path: component.path,
      owner: component.owner,
      template: component.template,
      disposition: 'create',
      template_source: {
        path: resolved.manifest.path,
        resolved_commit: resolved.commit,
        manifest_sha256: sha256Hex(
          new TextEncoder().encode(
            `${JSON.stringify(
              {
                template: resolved.manifest.template,
                path: resolved.manifest.path,
                tree_sha256: resolved.manifest.tree_sha256,
                files: resolved.manifest.files.map((f) => ({
                  path: f.path,
                  mode: f.mode,
                  render: f.render,
                  sha256: f.sha256,
                })),
              },
              null,
              2,
            )}\n`,
          ),
        ),
        source_tree_sha256: resolved.sourceTreeSha256,
        output_tree_sha256: renderedComp.outputTreeSha256,
      },
      files: [
        ...renderedComp.files.map((f) => ({
          target: f.path,
          mode: f.mode,
          render: true,
          output_sha256: f.output_sha256,
        })),
        {
          target: 'template.lock',
          mode: '100644' as const,
          render: false,
          output_sha256: sha256Hex(new TextEncoder().encode(lockContent)),
        },
      ].sort((a, b) => a.target.localeCompare(b.target)),
    });

    rendered.set(component.id, renderedComp);
    expectedFiles.set(component.id, expected);
    lockContents.set(component.id, lockContent);
    pendingComponents.push(component);
  }

  // Step 2: build operations.
  const operations: ScaffoldPlannedOperation[] = [];
  const hasPending = pendingComponents.length > 0;

  if (hasPending) {
    const opId = computeOperationId({
      target,
      source,
      authorization,
      components: componentPlans.filter((c) => c.disposition === 'create'),
    });
    const branchName = `sdd/scaffold-${opId.slice(7, 19)}`; // first 12 hex chars

    operations.push({
      order: 10,
      phase: 'branch',
      kind: 'branch.create',
      disposition: 'create',
      target: branchName,
    });
    operations.push({
      order: 20,
      phase: 'pull-request',
      kind: 'pull.upsert',
      disposition: 'create',
      target: `${branchName} -> main`,
    });
  }

  // Step 3: assemble the plan.
  const plan: ScaffoldPlan = {
    plan_version: 1,
    operation_id: hasPending
      ? computeOperationId({
          target,
          source,
          authorization,
          components: componentPlans.filter((c) => c.disposition === 'create'),
        })
      : sha256Hex('no-pending-components'),
    target: {
      owner: target.owner,
      repository: target.name,
      default_branch: target.defaultBranch,
    },
    source: { repository: source },
    authorization,
    components: componentPlans,
    operations,
    warnings: [],
  };

  return { plan, rendered, expectedFiles, lockContents };
}

/**
 * Compute operation_id: sha256 of canonical JSON over (target, source,
 * authorization, sorted pending components). Only pending components
 * participate — noop components don't affect it (so re-running after
 * partial merge produces a new operation_id only if pending set changed).
 */
function computeOperationId(input: {
  target: { owner: string; name: string; defaultBranch: string };
  source: string;
  authorization: ScaffoldAuthorization;
  components: ScaffoldComponentPlan[];
}): string {
  const payload = {
    target: input.target,
    source: { repository: input.source },
    authorization: {
      gate: input.authorization.gate,
      version: input.authorization.version,
      ...(input.authorization.provenance ? { pr: input.authorization.provenance.pr } : {}),
    },
    components: [...input.components]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        path: c.path,
        template: c.template,
        template_source: c.template_source
          ? {
              resolved_commit: c.template_source.resolved_commit,
              output_tree_sha256: c.template_source.output_tree_sha256,
            }
          : null,
      })),
  };
  return sha256Hex(JSON.stringify(payload));
}
