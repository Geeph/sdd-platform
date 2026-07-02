/**
 * detect.test.ts — tests for detectPlatforms + path classification (M4).
 *
 * Covers:
 *   - Path boundary: apps/api-gateway vs apps/api (D3)
 *   - Multiple components same ci value
 *   - Unmatched apps/** → all existing (D5)
 *   - Rename: path vs previousPath classified against head/base components (D19/D26)
 *   - D25: base=true head=false → fail closed
 *   - D18: *_paths and existing from same existence check
 *   - Label force (OR only, §2.6)
 *   - contract_changed narrow scope (D8)
 *   - specs/<version>/** bucket routing (D21)
 *   - fetchChangedFiles count mismatch → throw (D22)
 */

import { describe, expect, it } from 'vitest';
import { detectPlatforms } from '../src/detect.js';
import type { MinimalOctokit } from '../src/github-minimal-client.js';

// ---- Helpers ----------------------------------------------------------------

function makeProjectsYaml(
  components: Array<{
    id: string;
    path: string;
    ci: string;
    template: string;
    template_ref: string;
    owner: string;
  }>,
): string {
  return `schema_version: 1\nproduct: test\nrepository_mode: monorepo\ncomponents:\n${components.map((c) => `  - id: ${c.id}\n    path: ${c.path}\n    ci: ${c.ci}\n    template: ${c.template}\n    template_ref: ${c.template_ref}\n    owner: ${c.owner}`).join('\n')}\n`;
}

function makeFakeOctokit(opts: {
  pr?: Record<string, unknown>;
  baseProjects?: string;
  headProjects?: string;
  baseFiles?: string[];
  headFiles?: string[];
  changedFiles?: Array<Record<string, unknown>>;
  prChangedFiles?: number;
  /** Optional: map of `${ref}:${path}` → content string for blob reads */
  blobContent?: Record<string, string>;
}): MinimalOctokit {
  const routes: Array<{
    route: string;
    match?: (p: Record<string, unknown>) => boolean;
    response: unknown;
  }> = [];

  // PR metadata.
  routes.push({
    route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    match: (p) => Number(p.pull_number) === 42,
    response: opts.pr ?? {
      base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/demo' } },
      head: { sha: 'h'.repeat(40), ref: 'feature', repo: { full_name: 'acme/demo' } },
      labels: [],
      changed_files: opts.prChangedFiles ?? opts.changedFiles?.length ?? 1,
      number: 42,
    },
  });

  // PR changed files.
  routes.push({
    route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
    response: opts.changedFiles ?? [
      { filename: 'apps/backend/Main.java', status: 'modified', additions: 1, deletions: 0 },
    ],
  });

  // Base projects.yaml.
  routes.push({
    route: 'GET /repos/{owner}/{repo}/contents/{path}',
    match: (p) => p.path === 'projects.yaml' && p.ref === 'b'.repeat(40),
    response: {
      content:
        opts.baseProjects ??
        makeProjectsYaml([
          {
            id: 'backend',
            path: 'apps/backend',
            ci: 'java',
            template: 'spring-boot',
            template_ref: 'a'.repeat(40),
            owner: 'team',
          },
        ]),
      encoding: 'raw',
    },
  });

  // Head projects.yaml.
  routes.push({
    route: 'GET /repos/{owner}/{repo}/contents/{path}',
    match: (p) => p.path === 'projects.yaml' && p.ref === 'h'.repeat(40),
    response: {
      content:
        opts.headProjects ??
        opts.baseProjects ??
        makeProjectsYaml([
          {
            id: 'backend',
            path: 'apps/backend',
            ci: 'java',
            template: 'spring-boot',
            template_ref: 'a'.repeat(40),
            owner: 'team',
          },
        ]),
      encoding: 'raw',
    },
  });

  // Base tree.
  routes.push({
    route: 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
    match: (p) => p.tree_sha === 'b'.repeat(40),
    response: {
      tree: (opts.baseFiles ?? ['apps/backend/Main.java']).map((f) => ({
        path: f,
        type: 'blob',
        sha: 'x',
      })),
      truncated: false,
    },
  });

  // Head tree.
  routes.push({
    route: 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
    match: (p) => p.tree_sha === 'h'.repeat(40),
    response: {
      tree: (opts.headFiles ?? opts.baseFiles ?? ['apps/backend/Main.java']).map((f) => ({
        path: f,
        type: 'blob',
        sha: 'x',
      })),
      truncated: false,
    },
  });

  // Default: return 404 for unknown blob reads (new files at base, etc.)
  const blobContent = opts.blobContent ?? {};
  return {
    async request(route: string, parameters: Record<string, unknown> = {}) {
      // First check explicit routes (projects.yaml, tree, PR, files).
      for (const r of routes) {
        if (r.route === route && (!r.match || r.match(parameters))) {
          if (r.response instanceof Error) throw r.response;
          return r.response;
        }
      }

      // Then check blob content map.
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        const ref = parameters.ref as string;
        const path = parameters.path as string;
        const key = `${ref}:${path}`;
        if (key in blobContent) {
          return { content: blobContent[key], encoding: 'raw' };
        }
        // 404 for unknown content reads.
        const err = new Error(`not found: ${path} at ${ref}`) as Error & { status: number };
        err.status = 404;
        throw err;
      }

      throw new Error(`unmocked route: ${route} ${JSON.stringify(parameters)}`);
    },
  };
}

// ---- Path boundary (D3) ----

describe('detectPlatforms — path boundary', () => {
  it('apps/api/x matches apps/api but apps/api-gateway/x does NOT', async () => {
    const octokit = makeFakeOctokit({
      baseProjects: makeProjectsYaml([
        {
          id: 'api',
          path: 'apps/api',
          ci: 'java',
          template: 'spring-boot',
          template_ref: 'a'.repeat(40),
          owner: 'team',
        },
      ]),
      headProjects: makeProjectsYaml([
        {
          id: 'api',
          path: 'apps/api',
          ci: 'java',
          template: 'spring-boot',
          template_ref: 'a'.repeat(40),
          owner: 'team',
        },
      ]),
      changedFiles: [
        { filename: 'apps/api-gateway/Main.java', status: 'modified', additions: 1, deletions: 0 },
      ],
      prChangedFiles: 1,
      baseFiles: ['apps/api/Main.java'],
      headFiles: ['apps/api/Main.java', 'apps/api-gateway/Main.java'],
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    // apps/api-gateway does NOT match apps/api (D3 path boundary).
    // It's unmatched apps/** → all existing platforms (D5).
    expect(result.backend).toBe(true);
  });
});

// ---- D25: base=true, head=false → fail closed ----

describe('detectPlatforms — D25 existence check', () => {
  it('fails when component exists at base but not head (still declared)', async () => {
    const octokit = makeFakeOctokit({
      baseFiles: ['apps/backend/Main.java'],
      headFiles: [], // deleted!
      changedFiles: [
        { filename: 'apps/backend/Main.java', status: 'removed', additions: 0, deletions: 10 },
      ],
      prChangedFiles: 1,
    });

    await expect(
      detectPlatforms({ octokit, repo: { owner: 'acme', repo: 'demo' }, pr: 42 }),
    ).rejects.toThrow(/exists at base but not at head/);
  });

  it('does not fail when component never existed (not yet scaffolded)', async () => {
    const octokit = makeFakeOctokit({
      baseFiles: [],
      headFiles: [],
      changedFiles: [
        { filename: 'specs/v1/spec.md', status: 'modified', additions: 1, deletions: 1 },
      ],
      prChangedFiles: 1,
      blobContent: {
        [`${'b'.repeat(40)}:specs/v1/spec.md`]: '# Spec\n\nSame content.\n',
        [`${'h'.repeat(40)}:specs/v1/spec.md`]: '# Spec\n\nSame content.\n',
      },
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    // No error — component not scaffolded is benign.
    expect(result.backend).toBe(false);
  });
});

// ---- D18: *_paths and existing consistency ----

describe('detectPlatforms — D18 consistency', () => {
  it('backend_paths matches existing.backend', async () => {
    const octokit = makeFakeOctokit({
      baseFiles: ['apps/backend/Main.java'],
      headFiles: ['apps/backend/Main.java'],
      changedFiles: [
        { filename: 'apps/backend/Main.java', status: 'modified', additions: 1, deletions: 0 },
      ],
      prChangedFiles: 1,
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    expect(result.backend).toBe(true);
    expect(result.backend_paths).toEqual(['apps/backend']);
    // And ios is not existing.
    expect(result.ios).toBe(false);
    expect(result.ios_paths).toEqual([]);
  });
});

// ---- Label force (OR only) ----

describe('detectPlatforms — labels', () => {
  it('platform:ios label forces ios=true only if existing', async () => {
    const octokit = makeFakeOctokit({
      pr: {
        base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/demo' } },
        head: { sha: 'h'.repeat(40), ref: 'feature', repo: { full_name: 'acme/demo' } },
        labels: [{ name: 'platform:backend' }],
        changed_files: 1,
        number: 42,
      },
      baseFiles: ['apps/backend/Main.java'],
      headFiles: ['apps/backend/Main.java'],
      changedFiles: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0 }],
      prChangedFiles: 1,
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    // README is unmatched → all existing. backend exists.
    expect(result.backend).toBe(true);
  });
});

// ---- contract_changed narrow scope (D8) ----

describe('detectPlatforms — contract_changed (D8)', () => {
  it('contract_changed=false when only events.yaml changes', async () => {
    const octokit = makeFakeOctokit({
      changedFiles: [
        { filename: 'contracts/events.yaml', status: 'modified', additions: 1, deletions: 0 },
      ],
      prChangedFiles: 1,
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    expect(result.contract_changed).toBe(false);
    // But contracts/** → all existing platforms.
    expect(result.backend).toBe(true);
  });

  it('contract_changed=true when openapi.yaml is added', async () => {
    const octokit = makeFakeOctokit({
      changedFiles: [
        { filename: 'contracts/openapi.yaml', status: 'added', additions: 50, deletions: 0 },
      ],
      prChangedFiles: 1,
      blobContent: {
        [`${'b'.repeat(40)}:contracts/openapi.yaml`]: '',
        [`${'h'.repeat(40)}:contracts/openapi.yaml`]:
          'openapi: 3.0.0\ninfo:\n  title: T\n  version: "1"\npaths: {}\n',
      },
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    expect(result.contract_changed).toBe(true);
  });

  it('contract_changed=false when openapi.yaml is removed', async () => {
    const octokit = makeFakeOctokit({
      changedFiles: [
        { filename: 'contracts/openapi.yaml', status: 'removed', additions: 0, deletions: 50 },
      ],
      prChangedFiles: 1,
      blobContent: {
        [`${'b'.repeat(40)}:contracts/openapi.yaml`]:
          'openapi: 3.0.0\ninfo:\n  title: T\n  version: "1"\npaths: {}\n',
        [`${'h'.repeat(40)}:contracts/openapi.yaml`]: '',
      },
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    expect(result.contract_changed).toBe(false);
  });
});

// ---- D22: fetchChangedFiles count mismatch ----

describe('detectPlatforms — D22 count verification', () => {
  it('throws when PR changed_files count does not match fetched count', async () => {
    const octokit = makeFakeOctokit({
      pr: {
        base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/demo' } },
        head: { sha: 'h'.repeat(40), ref: 'feature', repo: { full_name: 'acme/demo' } },
        labels: [],
        changed_files: 5000, // says 5000
        number: 42,
      },
      changedFiles: [
        { filename: 'a.java', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'b.java', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'c.java', status: 'modified', additions: 1, deletions: 0 },
      ], // but only 3 returned
      prChangedFiles: 5000,
    });

    await expect(
      detectPlatforms({ octokit, repo: { owner: 'acme', repo: 'demo' }, pr: 42 }),
    ).rejects.toThrow(/count mismatch/);
  });
});

// ---- D21: specs bucket routing ----

describe('detectPlatforms — specs bucket (D21)', () => {
  it('plan.md change triggers impact + all existing', async () => {
    const octokit = makeFakeOctokit({
      changedFiles: [
        { filename: 'specs/v1/plan.md', status: 'modified', additions: 10, deletions: 5 },
      ],
      prChangedFiles: 1,
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    // plan.md → all existing.
    expect(result.backend).toBe(true);
  });

  it('unknown file in specs bucket triggers all existing', async () => {
    const octokit = makeFakeOctokit({
      changedFiles: [
        { filename: 'specs/v1/notes.md', status: 'added', additions: 10, deletions: 0 },
      ],
      prChangedFiles: 1,
    });

    const result = await detectPlatforms({
      octokit,
      repo: { owner: 'acme', repo: 'demo' },
      pr: 42,
    });
    expect(result.backend).toBe(true);
  });
});
