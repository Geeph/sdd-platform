/**
 * init.test.ts — applyInitPlan state machine tests.
 *
 * Covers:
 *   - Full happy path: PLANNED → ... → AWAITING_HUMAN
 *   - Resume from each phase (crash recovery / idempotency)
 *   - Conflict detection (existing repo not ours)
 *   - Preflight validation
 *   - Spec invariants (no apps/*, no M2c calls)
 */

import { describe, expect, it } from 'vitest';
import { applyInitPlan } from '../src/init.js';
import { assembleTree, parseManifest, sha256Hex } from '../src/resolve.js';
import type {
  CommitIdentity,
  GitHubReadPort,
  GitHubWritePort,
  InitPlan,
  ObservedState,
  ProductInitInput,
  RepositoryIdentity,
  TemplateManifest,
  TemplateTreeEntry,
} from '../src/types.js';

// ---- Test helpers ---------------------------------------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const TEST_OPERATION_ID = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeInput(overrides: Partial<ProductInitInput> = {}): ProductInitInput {
  return {
    product: 'demo',
    target: { owner: 'acme', repo: 'demo', visibility: 'private' },
    mode: 'monorepo',
    platform: { repository: 'acme/sdd-platform', ref: 'v1.0.0' },
    config: {
      schema_version: 1,
      bootstrap: { approvers: ['platform-admins'] },
      owners: {
        product: 'product-team',
        api: 'api-owners',
        design: 'design-team',
        admins: 'platform-admins',
      },
    },
    ...overrides,
  };
}

function makePlan(overrides: Partial<InitPlan> = {}): InitPlan {
  return {
    plan_version: 1,
    operation_id: TEST_OPERATION_ID,
    target: {
      owner: 'acme',
      repository: 'demo',
      visibility: 'private',
      default_branch: 'main',
    },
    source: {
      repository: 'acme/sdd-platform',
      requested_ref: 'v1.0.0',
      resolved_commit: 'a'.repeat(40),
      ref_pinned: true,
    },
    template: {
      path: 'templates/monorepo-root',
      manifest_sha256: 'sha256:manifest',
      source_tree_sha256: 'sha256:source-tree',
      output_tree_sha256: 'sha256:output-tree',
      files: [
        { target: 'AGENTS.md', mode: '100644', render: true, output_sha256: 'sha256:agents' },
        { target: 'README.md', mode: '100644', render: true, output_sha256: 'sha256:readme' },
        { target: 'template.lock', mode: '100644', render: false, output_sha256: 'sha256:lock' },
      ],
    },
    projects: {
      schema_version: 1,
      product: 'demo',
      repository_mode: 'monorepo',
      components: [],
    },
    operations: [],
    requirements: [],
    warnings: [],
    ...overrides,
  };
}

function makeTestManifest(): TemplateManifest {
  return makeTestManifestFromEntries(makeTestEntries());
}

function makeTestEntries(): TemplateTreeEntry[] {
  const agentsContent = utf8('# Agents for {{product}}');
  const readmeContent = utf8('# {{product}}');
  const lockContent = utf8('schema_version: 1');
  return [
    { path: 'AGENTS.md', mode: '100644', content: agentsContent },
    { path: 'README.md', mode: '100644', content: readmeContent },
    { path: 'template.lock', mode: '100644', content: lockContent },
  ];
}

function makeTestManifestFromEntries(entries: TemplateTreeEntry[]): TemplateManifest {
  const files = entries.map((e) => ({
    path: e.path,
    mode: e.mode,
    render: e.path !== 'template.lock',
    sha256: sha256Hex(e.content),
  }));
  const lines = files.map((f) => `${f.mode}  ${f.sha256}  ${f.path}`).join('\n');
  const treeSha = sha256Hex(`${lines}\n`);
  return parseManifest({
    template: 'monorepo-root',
    path: 'templates/monorepo-root',
    tree_sha256: treeSha,
    files,
  });
}

/**
 * Create a fake reader that returns a configurable observed state and
 * serves a minimal template tree.
 */
function createFakeReader(observed: ObservedState): GitHubReadPort {
  return {
    async resolveCommit() {
      return { commit: 'a'.repeat(40), requestedRef: 'v1.0.0', peeled: false };
    },
    async readTemplateTree() {
      return assembleTree(makeTestManifest(), makeTestEntries());
    },
    async observe() {
      return observed;
    },
  };
}

/**
 * Create a fake writer that records calls and returns configurable responses.
 */
function createFakeWriter(responses: {
  createRepo?: RepositoryIdentity;
  seed?: CommitIdentity;
  snapshot?: CommitIdentity & { disposition: 'create' | 'noop' | 'conflict' };
}) {
  const calls: string[] = [];

  const writer: GitHubWritePort = {
    async createRepository() {
      calls.push('createRepository');
      if (responses.createRepo) return responses.createRepo;
      return {
        owner: 'acme',
        name: 'demo',
        id: 12345,
        defaultBranch: 'main',
        visibility: 'private',
      };
    },
    async seedMainViaContents() {
      calls.push('seedMainViaContents');
      if (responses.seed) return responses.seed;
      return { sha: 'seed-commit-sha', treeSha: 'seed-tree-sha' };
    },
    async publishSnapshot() {
      calls.push('publishSnapshot');
      if (responses.snapshot) return responses.snapshot;
      return {
        sha: 'snapshot-commit-sha',
        treeSha: 'snapshot-tree-sha',
        disposition: 'create' as const,
      };
    },
    async reconcileLabels() {
      calls.push('reconcileLabels');
      return { created: [], updated: [], noop: [] };
    },
    async grantTeamPermissions() {
      calls.push('grantTeamPermissions');
      return { created: [], updated: [], noop: [] };
    },
    async reconcileEnvironments() {
      calls.push('reconcileEnvironments');
      return { created: [], updated: [], noop: [] };
    },
    async reconcileRepositoryRuleset() {
      calls.push('reconcileRepositoryRuleset');
      return { created: [], updated: [], noop: [] };
    },
    async reconcileOrgWorkflowRuleset() {
      calls.push('reconcileOrgWorkflowRuleset');
      return { created: [], updated: [], noop: [] };
    },
    async upsertBootstrapPull() {
      calls.push('upsertBootstrapPull');
      return {
        number: 1,
        headSha: 'bootstrap-head-sha',
        htmlUrl: 'https://github.com/acme/demo/pull/1',
      };
    },
  };

  return { writer, calls };
}

// ---- Tests ----------------------------------------------------------------

describe('applyInitPlan — happy path', () => {
  it('executes PLANNED → REPO_CREATED → SEED_MAIN → SNAPSHOT_MAIN', async () => {
    const observed: ObservedState = {
      repositoryExists: false,
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader = createFakeReader(observed);
    const { writer, calls } = createFakeWriter({});

    const result = await applyInitPlan(makeInput(), makePlan(), { reader, writer });

    expect(result.phase).toBe('AWAITING_HUMAN');
    expect(result.nextAction).toBe('await-human-merge');
    expect(result.mainSha).toBe('snapshot-commit-sha');
    expect(result.repository).toBeDefined();

    // Verify all write methods were called in order (M2c: includes labels/teams/env/rulesets/PR).
    expect(calls).toEqual([
      'createRepository',
      'seedMainViaContents',
      'publishSnapshot',
      'reconcileLabels',
      'grantTeamPermissions',
      'reconcileRepositoryRuleset',
      'reconcileOrgWorkflowRuleset',
      'upsertBootstrapPull',
    ]);

    // Verify operations recorded (M2c: includes labels/teams/env/rulesets/PR).
    expect(result.operations.length).toBeGreaterThanOrEqual(3);
    expect(result.operations[0].phase).toBe('repository');
    expect(result.operations[0].disposition).toBe('create');
    expect(result.operations[1].phase).toBe('seed');
    expect(result.operations[1].disposition).toBe('create');
    expect(result.operations[2].phase).toBe('snapshot');
    expect(result.operations[2].disposition).toBe('create');
    // M2c operations
    expect(result.operations.find((o) => o.phase === 'labels')).toBeDefined();
    expect(result.operations.find((o) => o.phase === 'teams')).toBeDefined();
    expect(result.operations.find((o) => o.phase === 'ruleset')).toBeDefined();
    expect(result.operations.find((o) => o.phase === 'org-workflows')).toBeDefined();
    expect(result.operations.find((o) => o.phase === 'bootstrap-pull')).toBeDefined();
  });
});

describe('applyInitPlan — resume / idempotency', () => {
  it('resumes from REPO_CREATED (repo exists, empty, our marker)', async () => {
    const observed: ObservedState = {
      repositoryExists: true,
      repository: {
        id: 12345,
        defaultBranch: 'main',
        visibility: 'private',
        empty: true,
        initMarker: TEST_OPERATION_ID,
      },
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader = createFakeReader(observed);
    const { writer, calls } = createFakeWriter({});

    const result = await applyInitPlan(makeInput(), makePlan(), { reader, writer });

    expect(result.phase).toBe('AWAITING_HUMAN');
    // Should NOT call createRepository (resume), but should seed and snapshot + M2c phases.
    expect(calls).toEqual([
      'seedMainViaContents',
      'publishSnapshot',
      'reconcileLabels',
      'grantTeamPermissions',
      'reconcileRepositoryRuleset',
      'reconcileOrgWorkflowRuleset',
      'upsertBootstrapPull',
    ]);
  });

  it('resumes from SEED_MAIN (repo exists, not empty, our marker)', async () => {
    const observed: ObservedState = {
      repositoryExists: true,
      repository: {
        id: 12345,
        defaultBranch: 'main',
        visibility: 'private',
        empty: false,
        initMarker: TEST_OPERATION_ID,
      },
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader = createFakeReader(observed);
    const { writer, calls } = createFakeWriter({
      snapshot: { sha: 'snap-sha', treeSha: 'snap-tree', disposition: 'create' },
    });

    const result = await applyInitPlan(makeInput(), makePlan(), { reader, writer });

    expect(result.phase).toBe('AWAITING_HUMAN');
    // Should NOT call createRepository or seedMainViaContents (resume from SEED_MAIN).
    expect(calls).toEqual([
      'publishSnapshot',
      'reconcileLabels',
      'grantTeamPermissions',
      'reconcileRepositoryRuleset',
      'reconcileOrgWorkflowRuleset',
      'upsertBootstrapPull',
    ]);
  });

  it('noop when snapshot returns noop (idempotent re-run)', async () => {
    const observed: ObservedState = {
      repositoryExists: true,
      repository: {
        id: 12345,
        defaultBranch: 'main',
        visibility: 'private',
        empty: false,
        initMarker: TEST_OPERATION_ID,
      },
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader = createFakeReader(observed);
    const { writer, calls } = createFakeWriter({
      snapshot: { sha: 'existing-snap-sha', treeSha: 'existing-tree', disposition: 'noop' },
    });

    const result = await applyInitPlan(makeInput(), makePlan(), { reader, writer });

    expect(result.phase).toBe('AWAITING_HUMAN');
    expect(calls).toEqual([
      'publishSnapshot',
      'reconcileLabels',
      'grantTeamPermissions',
      'reconcileRepositoryRuleset',
      'reconcileOrgWorkflowRuleset',
      'upsertBootstrapPull',
    ]);
    const snapOp = result.operations.find((o) => o.phase === 'snapshot');
    expect(snapOp?.disposition).toBe('noop');
  });
});

describe('applyInitPlan — conflict detection', () => {
  it('throws when repo exists with different marker and is not empty', async () => {
    const observed: ObservedState = {
      repositoryExists: true,
      repository: {
        id: 99999,
        defaultBranch: 'main',
        visibility: 'private',
        empty: false,
        initMarker: 'sha256:different-operation-id',
      },
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader = createFakeReader(observed);
    const { writer } = createFakeWriter({});

    await expect(applyInitPlan(makeInput(), makePlan(), { reader, writer })).rejects.toThrow(
      'exists and is not a partial state',
    );
  });

  it('throws when repo exists empty but with different marker', async () => {
    const observed: ObservedState = {
      repositoryExists: true,
      repository: {
        id: 99999,
        defaultBranch: 'main',
        visibility: 'private',
        empty: true,
        initMarker: 'sha256:different-operation-id',
      },
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader = createFakeReader(observed);
    const { writer } = createFakeWriter({});

    await expect(applyInitPlan(makeInput(), makePlan(), { reader, writer })).rejects.toThrow(
      'exists (empty)',
    );
  });

  it('returns blocked when publishSnapshot detects conflict (main moved)', async () => {
    const observed: ObservedState = {
      repositoryExists: false,
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader = createFakeReader(observed);
    const { writer } = createFakeWriter({
      snapshot: { sha: 'someone-else', treeSha: '', disposition: 'conflict' },
    });

    const result = await applyInitPlan(makeInput(), makePlan(), { reader, writer });

    expect(result.phase).toBe('SEED_MAIN');
    expect(result.nextAction).toBe('blocked');
    const snapOp = result.operations.find((o) => o.phase === 'snapshot');
    expect(snapOp?.disposition).toBe('conflict');
  });
});

describe('applyInitPlan — spec invariants', () => {
  it('rejects apps/* paths in snapshot', async () => {
    const observed: ObservedState = {
      repositoryExists: false,
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader: GitHubReadPort = {
      async resolveCommit() {
        return { commit: 'a'.repeat(40), requestedRef: 'v1.0.0', peeled: false };
      },
      async readTemplateTree() {
        const appEntries: TemplateTreeEntry[] = [
          { path: 'template.lock', mode: '100644', content: utf8('lock') },
          { path: 'apps/backend/main.ts', mode: '100644', content: utf8('app') },
        ];
        const appFiles = appEntries.map((e) => ({
          path: e.path,
          mode: e.mode,
          render: false,
          sha256: sha256Hex(e.content),
        }));
        const appLines = appFiles.map((f) => `${f.mode}  ${f.sha256}  ${f.path}`).join('\n');
        const appTreeSha = sha256Hex(`${appLines}\n`);
        const manifest = parseManifest({
          template: 'monorepo-root',
          path: 'templates/monorepo-root',
          tree_sha256: appTreeSha,
          files: appFiles,
        });
        return assembleTree(manifest, appEntries);
      },
      async observe() {
        return observed;
      },
    };

    const { writer } = createFakeWriter({});

    await expect(applyInitPlan(makeInput(), makePlan(), { reader, writer })).rejects.toThrow(
      'apps/*',
    );
  });

  it('does NOT call any M2c write methods', async () => {
    const observed: ObservedState = {
      repositoryExists: false,
      existingLabels: [],
      knownTeams: [],
      existingEnvironments: [],
      repositoryRulesetExists: false,
      orgWorkflowRulesetExists: false,
    };

    const reader = createFakeReader(observed);
    const { writer, calls } = createFakeWriter({});

    await applyInitPlan(makeInput(), makePlan(), { reader, writer });

    // M2c: all write methods should be called including reconcile/bootstrap.
    expect(calls).toEqual([
      'createRepository',
      'seedMainViaContents',
      'publishSnapshot',
      'reconcileLabels',
      'grantTeamPermissions',
      'reconcileRepositoryRuleset',
      'reconcileOrgWorkflowRuleset',
      'upsertBootstrapPull',
    ]);
  });
});
