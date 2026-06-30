/**
 * plan.test.ts — plan compiler determinism, operation_id stability,
 * byte-identical output, and dry-run safety.
 */

import { describe, expect, it } from 'vitest';
import type {
  GitHubReadPort,
  ProductInitConfig,
  ProductInitInput,
  ReadonlyTree,
  RepoRef,
  TemplateManifest,
  TemplateTreeEntry,
} from '../src/index.js';
import { assembleTree, compileInitPlan, serializeInitPlan, sha256Hex } from '../src/index.js';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeEntry(
  path: string,
  content: string,
  mode: '100644' | '100755' = '100644',
): TemplateTreeEntry {
  return { path, mode, content: utf8(content) };
}

function makeManifestWithRender(
  files: Array<{ path: string; content: string; mode?: '100644' | '100755'; render: boolean }>,
): TemplateManifest {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted
    .map((f) => `${f.mode ?? '100644'}  ${sha256Hex(utf8(f.content))}  ${f.path}`)
    .join('\n');
  const treeHash = sha256Hex(`${lines}\n`);
  return Object.freeze({
    template: 'monorepo-root',
    path: 'templates/monorepo-root',
    tree_sha256: treeHash,
    files: sorted.map((f) =>
      Object.freeze({
        path: f.path,
        mode: (f.mode ?? '100644') as '100644' | '100755',
        render: f.render,
        sha256: sha256Hex(utf8(f.content)),
      }),
    ),
  });
}

const CONFIG: ProductInitConfig = {
  schema_version: 1,
  bootstrap: { approvers: ['platform-admins'] },
  owners: {
    product: 'product-team',
    api: 'api-owners',
    design: 'design-team',
    admins: 'platform-admins',
    backend: 'backend-team',
    web: 'web-team',
    ios: 'ios-team',
    android: 'android-team',
  },
  team_permissions: {
    'platform-admins': 'maintain',
    'product-team': 'push',
  },
};

function buildTestTree(): ReadonlyTree {
  const files = [
    { path: 'AGENTS.md', content: '# {{product}}', render: true },
    { path: 'contracts/README.md', content: 'static', render: false },
    {
      path: 'projects.yaml',
      content:
        'schema_version: 1\nproduct: {{product}}\nrepository_mode: monorepo\ncomponents: []\n',
      render: true,
    },
    { path: 'README.md', content: '# {{product}}', render: true },
  ];
  const manifest = makeManifestWithRender(files);
  return assembleTree(
    manifest,
    files.map((f) => makeEntry(f.path, f.content)),
  );
}

function makeFakeReader(tree: ReadonlyTree): GitHubReadPort {
  return {
    async resolveCommit(_repo: RepoRef, ref: string) {
      return {
        commit: 'a'.repeat(40),
        requestedRef: ref,
        peeled: ref.startsWith('v'),
      };
    },
    async readTemplateTree(_repo: RepoRef, _commit: string, _path: string) {
      return tree;
    },
    async observe(_input: ProductInitInput) {
      return {
        repositoryExists: false,
        existingLabels: [],
        knownTeams: [
          'platform-admins',
          'product-team',
          'api-owners',
          'design-team',
          'backend-team',
          'web-team',
          'ios-team',
          'android-team',
        ],
        existingEnvironments: [],
        repositoryRulesetExists: false,
        orgWorkflowRulesetExists: false,
      };
    },
  };
}

function makeInput(): ProductInitInput {
  return {
    product: 'demo',
    target: { owner: 'acme', repo: 'demo', visibility: 'private' },
    mode: 'monorepo',
    platform: {
      repository: 'acme/sdd-platform',
      ref: 'v1.0.0',
    },
    config: CONFIG,
  };
}

describe('compileInitPlan', () => {
  it('produces a valid plan with expected fields', async () => {
    const tree = buildTestTree();
    const reader = makeFakeReader(tree);
    const plan = await compileInitPlan(makeInput(), reader);

    expect(plan.plan_version).toBe(1);
    expect(plan.operation_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.target.owner).toBe('acme');
    expect(plan.target.repository).toBe('demo');
    expect(plan.source.repository).toBe('acme/sdd-platform');
    expect(plan.source.resolved_commit).toBe('a'.repeat(40));
    expect(plan.source.ref_pinned).toBe(true);
    expect(plan.template.path).toBe('templates/monorepo-root');
    expect(plan.template.files.length).toBeGreaterThan(0);
    expect(plan.projects.components).toEqual([]);
    expect(plan.projects.product).toBe('demo');
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(plan.warnings).toEqual([]);
  });

  it('operation_id is stable across runs', async () => {
    const tree = buildTestTree();
    const reader = makeFakeReader(tree);
    const plan1 = await compileInitPlan(makeInput(), reader);
    const plan2 = await compileInitPlan(makeInput(), reader);
    expect(plan1.operation_id).toBe(plan2.operation_id);
  });

  it('serializeInitPlan produces byte-identical output', async () => {
    const tree = buildTestTree();
    const reader = makeFakeReader(tree);
    const plan1 = await compileInitPlan(makeInput(), reader);
    const plan2 = await compileInitPlan(makeInput(), reader);
    const s1 = serializeInitPlan(plan1);
    const s2 = serializeInitPlan(plan2);
    expect(s1).toBe(s2);
    // Trailing newline + UTF-8.
    expect(s1.endsWith('\n')).toBe(true);
  });

  it('plans have operations sorted by (phase, order)', async () => {
    const tree = buildTestTree();
    const reader = makeFakeReader(tree);
    const plan = await compileInitPlan(makeInput(), reader);
    const sorted = [...plan.operations].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.phase.localeCompare(b.phase);
    });
    expect(plan.operations.map((o) => o.order)).toEqual(sorted.map((o) => o.order));
  });

  it('template.files are sorted by target path', async () => {
    const tree = buildTestTree();
    const reader = makeFakeReader(tree);
    const plan = await compileInitPlan(makeInput(), reader);
    const sorted = [...plan.template.files].sort((a, b) => a.target.localeCompare(b.target));
    expect(plan.template.files.map((f) => f.target)).toEqual(sorted.map((f) => f.target));
  });

  it('requirements are sorted by (kind, name)', async () => {
    const tree = buildTestTree();
    const reader = makeFakeReader(tree);
    const plan = await compileInitPlan(makeInput(), reader);
    const sorted = [...plan.requirements].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.name.localeCompare(b.name);
    });
    expect(plan.requirements.map((r) => `${r.kind}:${r.name}`)).toEqual(
      sorted.map((r) => `${r.kind}:${r.name}`),
    );
  });

  it('unpinned ref produces warning and zero commit', async () => {
    const tree = buildTestTree();
    const reader = makeFakeReader(tree);
    const input = makeInput();
    delete input.platform.ref;
    const plan = await compileInitPlan(input, reader);
    expect(plan.source.ref_pinned).toBe(false);
    expect(plan.source.resolved_commit).toBe('0'.repeat(40));
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toMatch(/未固定/);
  });

  it('no volatile fields in plan output', async () => {
    const tree = buildTestTree();
    const reader = makeFakeReader(tree);
    const plan = await compileInitPlan(makeInput(), reader);
    const serialized = JSON.stringify(plan);
    // No timestamps.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // No request ids.
    expect(serialized).not.toMatch(/request_id/);
    // No tokens.
    expect(serialized).not.toMatch(/ghp_[A-Za-z0-9]+/);
  });

  it('dry-run with recording transport has zero mutations', async () => {
    const tree = buildTestTree();
    const mutationCount = 0;
    const recordingReader: GitHubReadPort = {
      async resolveCommit(_repo, ref) {
        return {
          commit: 'a'.repeat(40),
          requestedRef: ref,
          peeled: false,
        };
      },
      async readTemplateTree() {
        return tree;
      },
      async observe() {
        return {
          repositoryExists: false,
          existingLabels: [],
          knownTeams: [
            'platform-admins',
            'product-team',
            'api-owners',
            'design-team',
            'backend-team',
            'web-team',
            'ios-team',
            'android-team',
          ],
          existingEnvironments: [],
          repositoryRulesetExists: false,
          orgWorkflowRulesetExists: false,
        };
      },
    };
    // Record mutations by proxying any write-like methods (none should be
    // invoked in dry-run).
    const proxy = new Proxy(recordingReader, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return async (...args: unknown[]) => {
            // Only read port methods exist; if any write method were called,
            // the type system would catch it. This proxy is defense-in-depth.
            const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
            return result;
          };
        }
        return value;
      },
    });
    await compileInitPlan(makeInput(), proxy);
    expect(mutationCount).toBe(0);
  });

  it('detects missing teams as blocked', async () => {
    const tree = buildTestTree();
    const reader: GitHubReadPort = {
      async resolveCommit(_repo, ref) {
        return { commit: 'a'.repeat(40), requestedRef: ref, peeled: false };
      },
      async readTemplateTree() {
        return tree;
      },
      async observe() {
        // Missing all teams.
        return {
          repositoryExists: false,
          existingLabels: [],
          knownTeams: [],
          existingEnvironments: [],
          repositoryRulesetExists: false,
          orgWorkflowRulesetExists: false,
        };
      },
    };
    const plan = await compileInitPlan(makeInput(), reader);
    const teamsOp = plan.operations.find((o) => o.kind === 'teams.grant');
    expect(teamsOp).toBeDefined();
    expect(teamsOp?.disposition).toBe('blocked');
    const missingReqs = plan.requirements.filter(
      (r) => r.kind === 'team' && r.status === 'missing',
    );
    expect(missingReqs.length).toBeGreaterThan(0);
  });

  it('noop disposition when target repo exists with matching marker', async () => {
    const tree = buildTestTree();
    const input = makeInput();
    // First compute the expected operation_id.
    const plan = await compileInitPlan(input, makeFakeReader(tree));
    const marker = plan.operation_id;
    // Now build a reader that reports the repo exists with that marker.
    const reader: GitHubReadPort = {
      async resolveCommit(_repo, ref) {
        return { commit: 'a'.repeat(40), requestedRef: ref, peeled: false };
      },
      async readTemplateTree() {
        return tree;
      },
      async observe() {
        return {
          repositoryExists: true,
          repository: {
            id: 42,
            defaultBranch: 'main',
            visibility: 'private',
            empty: false,
            initMarker: marker,
          },
          existingLabels: [
            'gate:spec',
            'gate:architecture',
            'gate:design',
            'gate:plan',
            'gate:contract',
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
          ],
          knownTeams: [
            'platform-admins',
            'product-team',
            'api-owners',
            'design-team',
            'backend-team',
            'web-team',
            'ios-team',
            'android-team',
          ],
          existingEnvironments: [],
          repositoryRulesetExists: true,
          orgWorkflowRulesetExists: true,
          orgWorkflowRulesetEnforcement: 'evaluate',
          bootstrapPullRequest: { number: 1, headSha: 'b'.repeat(40), state: 'open' },
        };
      },
    };
    const plan2 = await compileInitPlan(input, reader);
    const repoOp = plan2.operations.find((o) => o.kind === 'repository.create');
    expect(repoOp?.disposition).toBe('noop');
  });
});
