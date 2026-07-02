/**
 * scaffold/plan.test.ts — `compileScaffoldPlan` determinism + behavior.
 */

import { describe, expect, it } from 'vitest';
import type {
  CompileScaffoldPlanInput,
  ScaffoldProductObservation,
  ScaffoldProjects,
} from '../../src/index.js';
import { compileScaffoldPlan, sha256Hex, TEMPLATE_NAMES } from '../../src/index.js';

function makeProjects(): ScaffoldProjects {
  return {
    schema_version: 1,
    product: 'demo',
    repository_mode: 'monorepo',
    components: [
      {
        id: 'backend',
        path: 'apps/backend',
        template: 'spring-boot',
        template_ref: 'a'.repeat(40),
        owner: 'backend-team',
        ci: 'java',
      },
      {
        id: 'web',
        path: 'apps/web',
        template: 'web',
        template_ref: 'b'.repeat(40),
        owner: 'web-team',
        ci: 'web',
      },
    ],
  };
}

function makeObservation(): ScaffoldProductObservation {
  const manifest = {
    template: 'spring-boot' as const,
    path: 'templates/spring-boot',
    tree_sha256: 'sha256:' + 'a'.repeat(64),
    files: [
      {
        path: 'README.md',
        mode: '100644' as const,
        render: true,
        sha256: 'sha256:' + 'a'.repeat(64),
      },
    ],
  };
  const webManifest = {
    template: 'web' as const,
    path: 'templates/web',
    tree_sha256: 'sha256:' + 'b'.repeat(64),
    files: [
      {
        path: 'package.json',
        mode: '100644' as const,
        render: true,
        sha256: 'sha256:' + 'b'.repeat(64),
      },
    ],
  };
  return {
    mainSha: 'c'.repeat(40),
    mainTreeSha: 'd'.repeat(40),
    mainProjectsBlobSha: 'sha256:' + 'e'.repeat(64),
    existingPaths: new Set(), // nothing exists yet → all components are "create"
    sourceTemplates: new Map([
      [
        'backend',
        {
          componentId: 'backend',
          commit: 'a'.repeat(40),
          manifest,
          tree: [
            {
              path: 'README.md',
              mode: '100644' as const,
              content: new TextEncoder().encode('# hello\n'),
            },
          ],
          sourceTreeSha256: 'sha256:' + 'a'.repeat(64),
        },
      ],
      [
        'web',
        {
          componentId: 'web',
          commit: 'b'.repeat(40),
          manifest: webManifest,
          tree: [
            {
              path: 'package.json',
              mode: '100644' as const,
              content: new TextEncoder().encode('{}\n'),
            },
          ],
          sourceTreeSha256: 'sha256:' + 'b'.repeat(64),
        },
      ],
    ]),
  };
}

function makeInput(overrides: Partial<CompileScaffoldPlanInput> = {}): CompileScaffoldPlanInput {
  return {
    target: { owner: 'acme', name: 'demo', defaultBranch: 'main' },
    source: 'acme/sdd-platform',
    projects: makeProjects(),
    observation: makeObservation(),
    localProjectsBlobSha: 'sha256:' + 'e'.repeat(64),
    authorization: {
      gate: 'architecture',
      version: 'v1',
      artifact_path: 'projects.yaml',
      main_fresh: true,
      verified: true,
      reason: null,
      provenance: {
        pr: 42,
        approved_head_sha: 'a'.repeat(40),
        merge_commit_sha: 'b'.repeat(40),
        approved_at: '2026-01-01T00:00:00Z',
        authorization_policy: 'current-codeowners',
      },
    },
    generator: { package: '@sdd/factory', version: '0.1.0', resolved_commit: 'x'.repeat(40) },
    ...overrides,
  };
}

describe('compileScaffoldPlan', () => {
  it('produces deterministic operation_id', () => {
    const a = compileScaffoldPlan(makeInput());
    const b = compileScaffoldPlan(makeInput());
    expect(a.plan.operation_id).toBe(b.plan.operation_id);
    // operation_id should be sha256-prefixed.
    expect(a.plan.operation_id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('marks all components as create when none exist on main', () => {
    const { plan } = compileScaffoldPlan(makeInput());
    for (const c of plan.components) {
      expect(c.disposition).toBe('create');
    }
    expect(plan.operations.length).toBeGreaterThan(0);
  });

  it('marks existing components as noop', () => {
    const obs = makeObservation();
    obs.existingPaths.add('apps/backend');
    const { plan } = compileScaffoldPlan(makeInput({ observation: obs }));
    const backend = plan.components.find((c) => c.id === 'backend');
    const web = plan.components.find((c) => c.id === 'web');
    expect(backend?.disposition).toBe('noop');
    expect(web?.disposition).toBe('create');
  });

  it('no pending components → no operations', () => {
    const obs = makeObservation();
    obs.existingPaths.add('apps/backend');
    obs.existingPaths.add('apps/web');
    const { plan } = compileScaffoldPlan(makeInput({ observation: obs }));
    expect(plan.operations).toEqual([]);
  });

  it('produces branch.create and pull.upsert operations when pending', () => {
    const { plan } = compileScaffoldPlan(makeInput());
    expect(plan.operations.some((o) => o.kind === 'branch.create')).toBe(true);
    expect(plan.operations.some((o) => o.kind === 'pull.upsert')).toBe(true);
  });

  it('branch name is derived from operation_id (first 12 hex)', () => {
    const { plan } = compileScaffoldPlan(makeInput());
    const branch = plan.operations.find((o) => o.kind === 'branch.create');
    expect(branch).toBeDefined();
    const expected = `sdd/scaffold-${plan.operation_id.slice(7, 19)}`;
    expect(branch!.target).toBe(expected);
  });

  it('only pending components participate in operation_id (noop changes do not affect it)', () => {
    // Two plans: one with all components pending, one where backend is already
    // existing (noop). operation_id should differ because the pending set changed.
    const base = compileScaffoldPlan(makeInput());

    const obs = makeObservation();
    obs.existingPaths.add('apps/backend');
    const withNoop = compileScaffoldPlan(makeInput({ observation: obs }));

    expect(base.plan.operation_id).not.toBe(withNoop.plan.operation_id);
  });

  it('canonical JSON: byte-identical for same inputs', () => {
    const a = JSON.stringify(compileScaffoldPlan(makeInput()).plan);
    const b = JSON.stringify(compileScaffoldPlan(makeInput()).plan);
    expect(a).toBe(b);
  });
});
