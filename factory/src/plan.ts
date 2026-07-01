/**
 * plan.ts — pure plan compiler.
 *
 * Takes a `ProductInitInput` (the desired state) plus a `GitHubReadPort`
 * (the observed state of the world) and produces a canonical `InitPlan`.
 *
 * The compiler never mutates; it makes no network writes. dry-run simply
 * invokes this function and renders the result. Real execution re-uses the
 * same compiler, then feeds the plan to an apply step that holds the writer.
 *
 * Determinism (D12):
 *  - All arrays in the output are sorted by explicit keys.
 *  - All objects use fixed key order (insertion order via object literal).
 *  - No timestamps / request ids / rate-limit remainders / tokens / paths
 *    appear in the output.
 *  - `operation_id = sha256(JCS(canonical_input + resolved_commit +
 *    template.output_tree_sha256))`.
 */

import { createHash } from 'node:crypto';
import { validateProjectsDocument } from '@sdd/schemas';
import { renderTree } from './render.js';
import { assembleTree, parseRepoRef, resolveRef, sha256Hex } from './resolve.js';
import type {
  Disposition,
  GitHubReadPort,
  InitPlan,
  ObservedState,
  PlannedOperation,
  PlanTemplateFile,
  ProductInitInput,
  Requirement,
  TemplateManifest,
  TemplatePlan,
} from './types.js';

// ---- Helpers -------------------------------------------------------------

/**
 * RFC 8785 JSON Canonicalization Scheme (simplified): serialize keys in
 * lexicographic order, arrays preserved, no whitespace. We use this for the
 * operation_id input so byte-identical inputs produce byte-identical digests
 * regardless of the order the caller constructed the object.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jcs(v)).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${jcs(v)}`);
  }
  return `{${parts.join(',')}}`;
}

export function computeOperationId(parts: {
  input: ProductInitInput;
  resolvedCommit: string;
  outputTreeSha256: string;
}): string {
  // Canonical input: strip any undefined, sort keys deterministically.
  const canonicalInput = {
    mode: parts.input.mode,
    platform: {
      ref: parts.input.platform.ref ?? '',
      repository: parts.input.platform.repository,
    },
    product: parts.input.product,
    target: {
      owner: parts.input.target.owner,
      repo: parts.input.target.repo,
      visibility: parts.input.target.visibility,
    },
    // Config contributes stable identity: owners + team permissions keys +
    // bootstrap approvers + environments keys + required_secrets. Values like
    // descriptions don't affect plan identity but do appear in operations.
    config_identity: {
      approvers: [...(parts.input.config.bootstrap?.approvers ?? [])].sort(),
      environments: Object.keys(parts.input.config.environments ?? {}).sort(),
      owners: sortObject(parts.input.config.owners),
      required_secrets: [...(parts.input.config.required_secrets ?? [])].sort(),
      team_permissions: sortObject(parts.input.config.team_permissions ?? {}),
    },
  };
  const blob = jcs({
    input: canonicalInput,
    output_tree_sha256: parts.outputTreeSha256,
    resolved_commit: parts.resolvedCommit,
  });
  const hex = createHash('sha256').update(blob, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

function sortObject(o: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!o) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    out[k] = v;
  }
  return out;
}

function validateSlug(s: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(s)) {
    throw new Error(`${label} must match ^[a-z][a-z0-9-]*$: '${s}'`);
  }
}

function validateRepoRef(s: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(s)) {
    throw new Error(`${label} must be '<owner>/<repo>': '${s}'`);
  }
}

// ---- Plan compiler -------------------------------------------------------

/**
 * Compile an init plan from input + observed state. Pure function modulo the
 * reader (which only does read operations).
 */
export async function compileInitPlan(
  input: ProductInitInput,
  reader: GitHubReadPort,
): Promise<InitPlan> {
  // 1. Validate input slugs / identifiers before any network call.
  validateSlug(input.product, 'product');
  validateSlug(input.target.owner, 'target.owner');
  validateSlug(input.target.repo, 'target.repo');
  validateRepoRef(input.platform.repository, 'platform.repository');
  if (input.mode !== 'monorepo') {
    throw new Error(`only mode='monorepo' supported, got '${input.mode}'`);
  }

  // 2. Resolve platform ref → full 40-char commit (dry-run may omit ref).
  const refPinned = Boolean(input.platform.ref);
  let resolvedCommit: string;
  let requestedRef: string;
  let _peeled = false;
  if (refPinned) {
    const r = await resolveRef(
      reader,
      parseRepoRef(input.platform.repository),
      input.platform.ref as string,
    );
    resolvedCommit = r.commit;
    requestedRef = r.requestedRef;
    _peeled = r.peeled;
  } else {
    // Unpinned: marker value only valid for preview.
    resolvedCommit = '0'.repeat(40);
    requestedRef = '<unpinned>';
  }

  // 3. Observe the target state.
  const observed: ObservedState = await reader.observe(input);

  // 4. Read the template tree at the pinned commit.
  //    (For unpinned previews, this is allowed to fail — callers must pin
  //    before actual apply. dry-run without pin uses a synthetic observed
  //    tree supplied via the reader.)
  let tree: Awaited<ReturnType<GitHubReadPort['readTemplateTree']>>;
  if (refPinned) {
    tree = await reader.readTemplateTree(
      parseRepoRef(input.platform.repository),
      resolvedCommit,
      'templates/monorepo-root',
    );
    tree = assembleTree(tree.manifest, [...tree.entries]);
  } else {
    // For unpinned dry-run, the reader is expected to supply a tree at the
    // synthetic "0" commit.
    tree = await reader.readTemplateTree(
      parseRepoRef(input.platform.repository),
      resolvedCommit,
      'templates/monorepo-root',
    );
    tree = assembleTree(tree.manifest, [...tree.entries]);
  }

  // 5. Render the tree with input.context tokens.
  const rendered = renderTree({
    tree,
    context: {
      product: input.product,
      repo: input.target.owner,
      owners: input.config.owners,
    },
    source: {
      repository: input.platform.repository,
      requestedRef,
      resolvedCommit,
    },
    generator: { package: '@sdd/factory', version: '0.1.0' },
  });

  // 6. Validate rendered projects.yaml passes sdd validate.
  const projectsEntry = rendered.entries.find((e) => e.path === 'projects.yaml');
  if (!projectsEntry) {
    throw new Error('rendered tree missing projects.yaml');
  }
  const projectsText = new TextDecoder().decode(projectsEntry.content);
  const { parse: parseYaml } = await import('yaml');
  const projectsDoc = parseYaml(projectsText);
  const projectsResult = await validateProjectsDocument(projectsDoc);
  if (!projectsResult.ok) {
    const msgs = projectsResult.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`rendered projects.yaml fails schema: ${msgs}`);
  }
  if (projectsDoc.product !== input.product) {
    throw new Error(
      `rendered projects.yaml product mismatch: expected '${input.product}', got '${projectsDoc.product}'`,
    );
  }
  if (!Array.isArray(projectsDoc.components) || projectsDoc.components.length !== 0) {
    throw new Error('rendered projects.yaml must have components: []');
  }

  // 7. Build template plan section.
  const templatePlan = buildTemplatePlan(tree.manifest, rendered);

  // 8. Compute operation_id (stable hash).
  const operationId = computeOperationId({
    input,
    resolvedCommit,
    outputTreeSha256: rendered.outputTreeSha256,
  });

  // 9. Plan operations (desired state vs observed state).
  const operations = planOperations(input, observed, operationId);

  // 10. Compute requirements.
  const requirements = computeRequirements(input, observed);

  // 11. Compute warnings.
  const warnings: string[] = [];
  if (!refPinned) {
    warnings.push('未固定 platform ref，仅供预览；实际执行必须指定 --platform-ref。');
  }
  if (observed.repositoryExists && observed.repository?.initMarker !== operationId) {
    warnings.push(
      `目标仓已存在但 init marker 不匹配（期望 ${operationId}，实际 ${observed.repository?.initMarker ?? '<none>'}）；视为 conflict。`,
    );
  }

  // 12. Assemble the canonical plan.
  return {
    plan_version: 1,
    operation_id: operationId,
    target: {
      owner: input.target.owner,
      repository: input.target.repo,
      visibility: input.target.visibility,
      default_branch: 'main',
    },
    source: {
      repository: input.platform.repository,
      requested_ref: requestedRef,
      resolved_commit: resolvedCommit,
      ref_pinned: refPinned,
    },
    template: templatePlan,
    projects: {
      schema_version: 1,
      product: input.product,
      repository_mode: 'monorepo',
      components: [],
    },
    operations,
    requirements,
    warnings,
  };
}

function buildTemplatePlan(
  manifest: TemplateManifest,
  rendered: {
    outputTreeSha256: string;
    fileDigests: ReadonlyArray<{ path: string; mode: '100644' | '100755'; output_sha256: string }>;
  },
): TemplatePlan {
  // Files sorted by target (UTF-8 byte order ≈ localeCompare numeric off).
  const files: PlanTemplateFile[] = rendered.fileDigests
    .map((d) => {
      const mf = manifest.files.find((f) => f.path === d.path);
      return {
        target: d.path,
        mode: d.mode,
        render: mf?.render ?? false,
        output_sha256: d.output_sha256,
      };
    })
    .sort((a, b) => a.target.localeCompare(b.target));

  // manifest_sha256: sha256 of canonical manifest JSON (same as lock's).
  const manifestJson = JSON.stringify(
    {
      template: 'monorepo-root',
      path: manifest.path,
      tree_sha256: manifest.tree_sha256,
      files: manifest.files.map((f) => ({
        path: f.path,
        mode: f.mode,
        render: f.render,
        sha256: f.sha256,
      })),
    },
    null,
    2,
  );
  const manifestSha256 = sha256Hex(`${manifestJson}\n`);

  return {
    path: manifest.path,
    manifest_sha256: manifestSha256,
    source_tree_sha256: manifest.tree_sha256,
    output_tree_sha256: rendered.outputTreeSha256,
    files,
  };
}

/**
 * Helper to build a PlannedOperation with optional detail. Only sets detail
 * when a non-undefined value is provided (required by exactOptionalPropertyTypes).
 */
function pushOp(
  base: Omit<PlannedOperation, 'detail'>,
  detail: string | undefined,
): PlannedOperation {
  if (detail === undefined) return { ...base };
  return { ...base, detail };
}

/**
 * Decide disposition for each operation based on observed state.
 */
function planOperations(
  input: ProductInitInput,
  observed: ObservedState,
  operationId: string,
): PlannedOperation[] {
  const ops: PlannedOperation[] = [];

  // Repository.
  const repoDisposition: Disposition = observed.repositoryExists
    ? observed.repository?.initMarker === operationId
      ? 'noop'
      : 'conflict'
    : 'create';
  ops.push({
    order: 10,
    phase: 'repository',
    kind: 'repository.create',
    disposition: repoDisposition,
    target: `${input.target.owner}/${input.target.repo}`,
  });

  // Seed (template.lock via Contents API).
  ops.push({
    order: 20,
    phase: 'seed',
    kind: 'main.seed',
    disposition: repoDisposition === 'noop' ? 'noop' : 'create',
    target: `${input.target.owner}/${input.target.repo}:template.lock`,
  });

  // Snapshot (blobs → tree → commit → non-force ref advance).
  ops.push({
    order: 30,
    phase: 'snapshot',
    kind: 'main.snapshot',
    disposition: repoDisposition === 'noop' ? 'noop' : 'create',
    target: `${input.target.owner}/${input.target.repo}:main`,
  });

  // Labels — two families (5 gate + 8 backlog).
  const desiredGateLabels = [
    'gate:spec',
    'gate:architecture',
    'gate:design',
    'gate:plan',
    'gate:contract',
  ];
  const desiredBacklogLabels = [
    'platform:backend',
    'platform:web',
    'platform:ios',
    'platform:android',
    'track:spec',
    'track:design',
    'track:contract',
    'track:code',
    'type:epic',
    'type:task',
    'type:change',
    'status:blocked',
  ];
  const allDesiredLabels = [...desiredGateLabels, ...desiredBacklogLabels];
  const existingSet = new Set(observed.existingLabels.map((l) => l.toLowerCase()));
  const labelsMissing = allDesiredLabels.filter((l) => !existingSet.has(l.toLowerCase()));
  ops.push(
    pushOp(
      {
        order: 40,
        phase: 'labels',
        kind: 'labels.upsert',
        disposition:
          labelsMissing.length === 0 ? 'noop' : observed.repositoryExists ? 'update' : 'create',
        target: `${input.target.owner}/${input.target.repo}:labels`,
      },
      labelsMissing.length > 0 ? `create ${labelsMissing.length} missing` : undefined,
    ),
  );

  // Teams — only validate and grant permissions, never create.
  const allTeams = collectTeams(input);
  const missingTeams = allTeams.filter((t) => !observed.knownTeams.includes(t));
  ops.push(
    pushOp(
      {
        order: 50,
        phase: 'teams',
        kind: 'teams.grant',
        disposition:
          missingTeams.length > 0 ? 'blocked' : observed.repositoryExists ? 'update' : 'create',
        target: `${input.target.owner}/${input.target.repo}:teams`,
      },
      missingTeams.length > 0 ? `missing: ${missingTeams.join(', ')}` : undefined,
    ),
  );

  // Environments.
  const desiredEnvs = Object.keys(input.config.environments ?? {}).sort();
  const existingEnvSet = new Set(observed.existingEnvironments);
  const envsMissing = desiredEnvs.filter((e) => !existingEnvSet.has(e));
  ops.push(
    pushOp(
      {
        order: 60,
        phase: 'environments',
        kind: 'environments.upsert',
        disposition:
          envsMissing.length === 0 ? 'noop' : observed.repositoryExists ? 'update' : 'create',
        target: `${input.target.owner}/${input.target.repo}:environments`,
      },
      envsMissing.length > 0 ? `create ${envsMissing.length} missing` : undefined,
    ),
  );

  // Repository ruleset (initial, no required checks).
  ops.push({
    order: 70,
    phase: 'ruleset',
    kind: 'ruleset.repository',
    disposition: observed.repositoryRulesetExists ? 'noop' : 'create',
    target: `${input.target.owner}/${input.target.repo}:sdd-main`,
  });

  // Organization workflow ruleset (evaluate first; finalize later).
  ops.push({
    order: 80,
    phase: 'org-workflows',
    kind: 'ruleset.org-workflow',
    disposition:
      observed.orgWorkflowRulesetExists && observed.orgWorkflowRulesetEnforcement === 'evaluate'
        ? 'noop'
        : 'create',
    target: `${input.target.owner}/${input.target.repo}:sdd-workflows-${observed.repository?.id ?? '<new>'}`,
    detail: 'enforcement=evaluate',
  });

  // Bootstrap PR.
  const bootstrapPrState = observed.bootstrapPullRequest?.state;
  ops.push({
    order: 90,
    phase: 'bootstrap-pull',
    kind: 'pull.bootstrap',
    disposition: bootstrapPrState === 'open' || bootstrapPrState === 'merged' ? 'noop' : 'create',
    target: `${input.target.owner}/${input.target.repo}:bootstrap`,
  });

  // Sort by (phase, order) per spec.
  return ops.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.phase.localeCompare(b.phase);
  });
}

function collectTeams(input: ProductInitInput): string[] {
  const set = new Set<string>();
  for (const v of Object.values(input.config.owners)) {
    if (typeof v === 'string') set.add(v);
  }
  for (const t of input.config.bootstrap.approvers) set.add(t);
  if (input.config.team_permissions) {
    for (const t of Object.keys(input.config.team_permissions)) set.add(t);
  }
  if (input.config.environments) {
    for (const env of Object.values(input.config.environments)) {
      for (const t of env.reviewers) set.add(t);
    }
  }
  return [...set].sort();
}

function computeRequirements(input: ProductInitInput, observed: ObservedState): Requirement[] {
  const reqs: Requirement[] = [];
  const allTeams = collectTeams(input);
  for (const t of allTeams) {
    reqs.push({
      kind: 'team',
      name: t,
      status: observed.knownTeams.includes(t) ? 'satisfied' : 'missing',
    });
  }
  for (const env of Object.keys(input.config.environments ?? {}).sort()) {
    reqs.push({
      kind: 'environment',
      name: env,
      status: observed.existingEnvironments.includes(env) ? 'satisfied' : 'missing',
    });
  }
  for (const secret of (input.config.required_secrets ?? []).sort()) {
    reqs.push({
      kind: 'secret',
      name: secret,
      status: 'missing', // M2 reports only; actual rotation in M7.
    });
  }
  return reqs.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.name.localeCompare(b.name);
  });
}

// ---- Canonical output serialization -------------------------------------

/**
 * Serialize an InitPlan as canonical JSON for dry-run output: UTF-8, LF,
 * 2-space indent, trailing newline. Field order is whatever insertion order
 * the compiler produced; arrays are pre-sorted.
 */
export function serializeInitPlan(plan: InitPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/**
 * Re-digest a serialized plan's operation_id to verify byte-identical output.
 */
export function verifyPlanIdentity(plan: InitPlan): boolean {
  const recomputed = computeOperationId({
    input: reconstructInputSkeleton(plan),
    resolvedCommit: plan.source.resolved_commit,
    outputTreeSha256: plan.template.output_tree_sha256,
  });
  return recomputed === plan.operation_id;
}

function reconstructInputSkeleton(plan: InitPlan): ProductInitInput {
  // We don't need a fully valid ProductInitInput for the hash; only the
  // fields that contribute to the identity. The compiler already stored them
  // via `plan.source.*`, `plan.target.*`, `plan.projects.product`. Callers
  // should prefer to re-run compileInitPlan for verification.
  const platform: { repository: string; ref?: string } = {
    repository: plan.source.repository,
  };
  if (plan.source.ref_pinned) {
    platform.ref = plan.source.requested_ref;
  }
  return {
    product: plan.projects.product,
    target: {
      owner: plan.target.owner,
      repo: plan.target.repository,
      visibility: plan.target.visibility,
    },
    mode: 'monorepo',
    platform,
    config: {
      schema_version: 1,
      bootstrap: { approvers: [] },
      owners: { product: '', api: '', design: '', admins: '' },
    },
  };
}

/** Expose for tests. */
export const __internal__ = { jcs, sha256Hex };
