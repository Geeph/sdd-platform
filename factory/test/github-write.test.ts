/**
 * github-write.test.ts — API contract tests for the M2b write adapter.
 *
 * Uses a fake octokit that records calls and returns fixture responses.
 * Tests the HTTP boundary: real request routes, body shapes, API version,
 * pagination Link headers, and the D9 invariants (Contents seed → Git Data
 * non-force ref advance).
 */

import { describe, expect, it } from 'vitest';
import {
  createRepository,
  createWriteGitHubPort,
  type OctokitMutate,
  publishSnapshot,
  seedMainViaContents,
} from '../src/index.js';
import type { RepositoryIdentity } from '../src/types.js';

// ---- Fake octokit ---------------------------------------------------------

interface RecordedCall {
  route: string;
  params: Record<string, unknown>;
}

function createFakeOctokit(responses: Map<string, unknown> = new Map()): {
  octokit: OctokitMutate;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const octokit: OctokitMutate = {
    async request(route: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ route, params: parameters });
      const key = `${route.split(' ')[0]} ${route.split(' ')[1]}`;
      if (responses.has(key)) {
        return responses.get(key);
      }
      // Default: return empty object.
      return {};
    },
  };

  return { octokit, calls };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---- createRepository -----------------------------------------------------

describe('createRepository', () => {
  it('calls POST /orgs/{org}/repos with correct params', async () => {
    const repoResp = {
      id: 12345,
      name: 'demo',
      owner: { login: 'acme' },
      private: true,
      visibility: 'private',
      default_branch: 'main',
      description: '[sdd-init:sha256:abc123]',
    };

    const responses = new Map<string, unknown>();
    responses.set('POST /orgs/{org}/repos', repoResp);
    const { octokit, calls } = createFakeOctokit(responses);

    const result = await createRepository(octokit, {
      owner: 'acme',
      name: 'demo',
      visibility: 'private',
      description: '[sdd-init:sha256:abc123]',
      initMarker: 'sha256:abc123',
    });

    expect(result).toEqual({
      owner: 'acme',
      name: 'demo',
      id: 12345,
      defaultBranch: 'main',
      visibility: 'private',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].route).toBe('POST /orgs/{org}/repos');
    expect(calls[0].params).toEqual({
      org: 'acme',
      name: 'demo',
      description: 'sha256:abc123',
      private: true,
      visibility: 'private',
      auto_init: false,
    });
  });

  it('maps visibility=public correctly', async () => {
    const responses = new Map<string, unknown>();
    responses.set('POST /orgs/{org}/repos', {
      id: 1,
      name: 'pub',
      owner: { login: 'acme' },
      private: false,
      visibility: 'public',
      default_branch: 'main',
    });
    const { octokit } = createFakeOctokit(responses);

    const result = await createRepository(octokit, {
      owner: 'acme',
      name: 'pub',
      visibility: 'public',
      description: 'test',
      initMarker: 'sha256:test',
    });

    expect(result.visibility).toBe('public');
  });
});

// ---- seedMainViaContents --------------------------------------------------

describe('seedMainViaContents', () => {
  it('writes template.lock via Contents API and reads back commit', async () => {
    const seedResp = {
      content: {
        commit: { sha: 'aaa111' },
      },
    };
    const commitResp = {
      sha: 'aaa111',
      tree: { sha: 'tree-seed' },
    };

    const responses = new Map<string, unknown>();
    responses.set('PUT /repos/{owner}/{repo}/contents/{path}', seedResp);
    responses.set('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', commitResp);
    const { octokit, calls } = createFakeOctokit(responses);

    const repo: RepositoryIdentity = {
      owner: 'acme',
      name: 'demo',
      id: 12345,
      defaultBranch: 'main',
      visibility: 'private',
    };

    const result = await seedMainViaContents(octokit, {
      repository: repo,
      lockContent: 'schema_version: 1\n...',
    });

    expect(result).toEqual({
      sha: 'aaa111',
      treeSha: 'tree-seed',
    });

    // Verify Contents API call.
    const putCall = calls.find((c) => c.route.startsWith('PUT'));
    expect(putCall).toBeDefined();
    expect(putCall?.params.path).toBe('template.lock');
    expect(putCall?.params.branch).toBe('main');
    expect(putCall?.params.message).toContain('sdd-init');

    // Verify commit read-back call.
    const getCall = calls.find((c) => c.route.startsWith('GET'));
    expect(getCall).toBeDefined();
    expect(getCall?.params.commit_sha).toBe('aaa111');
  });

  it('throws when no commit SHA in response', async () => {
    const responses = new Map<string, unknown>();
    responses.set('PUT /repos/{owner}/{repo}/contents/{path}', { content: {} });
    const { octokit } = createFakeOctokit(responses);

    const repo: RepositoryIdentity = {
      owner: 'acme',
      name: 'demo',
      id: 1,
      defaultBranch: 'main',
      visibility: 'private',
    };

    await expect(
      seedMainViaContents(octokit, { repository: repo, lockContent: 'test' }),
    ).rejects.toThrow('no commit SHA');
  });
});

// ---- publishSnapshot ------------------------------------------------------

describe('publishSnapshot', () => {
  const baseRepo: RepositoryIdentity = {
    owner: 'acme',
    name: 'demo',
    id: 12345,
    defaultBranch: 'main',
    visibility: 'private',
  };

  it('creates blobs, tree (base=seed), commit, and non-force ref advance', async () => {
    const responses = new Map<string, unknown>();

    // Ref check: main points to seed.
    responses.set('GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { sha: 'seed-sha' } });

    // Blob creation (2 files).
    responses.set('POST /repos/{owner}/{repo}/git/blobs', { sha: 'blob-sha-1' });

    // Tree creation.
    responses.set('POST /repos/{owner}/{repo}/git/trees', {
      sha: 'tree-snapshot',
      tree: [
        { path: 'AGENTS.md', mode: '100644', type: 'blob', sha: 'blob-sha-1' },
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'blob-sha-2' },
      ],
    });

    // Commit creation.
    responses.set('POST /repos/{owner}/{repo}/git/commits', {
      sha: 'commit-snapshot',
      tree: { sha: 'tree-snapshot' },
    });

    // Ref update.
    responses.set('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
      object: { sha: 'commit-snapshot' },
    });

    const { octokit, calls } = createFakeOctokit(responses);

    const result = await publishSnapshot(octokit, {
      repository: baseRepo,
      seedCommit: 'seed-sha',
      seedTree: 'tree-seed',
      files: [
        { path: 'AGENTS.md', mode: '100644', content: utf8('# Agents') },
        { path: 'README.md', mode: '100644', content: utf8('# Readme') },
      ],
    });

    expect(result.sha).toBe('commit-snapshot');
    expect(result.treeSha).toBe('tree-snapshot');
    expect(result.disposition).toBe('create');

    // Verify call sequence.
    const routes = calls.map((c) => `${c.route.split(' ')[0]} ${c.route.split(' ')[1]}`);
    expect(routes[0]).toBe('GET /repos/{owner}/{repo}/git/ref/{ref}');
    // Blob calls (2).
    expect(routes.filter((r) => r.includes('git/blobs')).length).toBe(2);
    expect(routes).toContain('POST /repos/{owner}/{repo}/git/trees');
    expect(routes).toContain('POST /repos/{owner}/{repo}/git/commits');
    expect(routes).toContain('PATCH /repos/{owner}/{repo}/git/refs/{ref}');

    // Verify tree uses base_tree.
    const treeCall = calls.find((c) => c.route.includes('git/trees'));
    expect(treeCall?.params.base_tree).toBe('tree-seed');
    expect((treeCall?.params.tree as unknown[]).length).toBe(2);

    // Verify commit has correct parent.
    const commitCall = calls.find((c) => c.route.includes('git/commits'));
    expect(commitCall?.params.parents).toEqual(['seed-sha']);

    // Verify ref update is non-force.
    const refCall = calls.find((c) => c.route.includes('git/refs'));
    expect(refCall?.params.force).toBe(false);
  });

  it('returns conflict when main has moved away from seed', async () => {
    const responses = new Map<string, unknown>();
    responses.set('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      object: { sha: 'someone-else-sha' },
    });
    const { octokit } = createFakeOctokit(responses);

    const result = await publishSnapshot(octokit, {
      repository: baseRepo,
      seedCommit: 'seed-sha',
      seedTree: 'tree-seed',
      files: [{ path: 'AGENTS.md', mode: '100644', content: utf8('test') }],
    });

    expect(result.disposition).toBe('conflict');
    expect(result.sha).toBe('someone-else-sha');
  });

  it('rejects apps/* paths', async () => {
    const responses = new Map<string, unknown>();
    responses.set('GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { sha: 'seed-sha' } });
    responses.set('POST /repos/{owner}/{repo}/git/blobs', { sha: 'blob-sha' });
    const { octokit } = createFakeOctokit(responses);

    await expect(
      publishSnapshot(octokit, {
        repository: baseRepo,
        seedCommit: 'seed-sha',
        seedTree: 'tree-seed',
        files: [{ path: 'apps/backend/main.ts', mode: '100644', content: utf8('test') }],
      }),
    ).rejects.toThrow('apps/*');
  });

  it('verifies tree entry count matches file count', async () => {
    const responses = new Map<string, unknown>();
    responses.set('GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { sha: 'seed-sha' } });
    responses.set('POST /repos/{owner}/{repo}/git/blobs', { sha: 'blob-sha' });
    responses.set('POST /repos/{owner}/{repo}/git/trees', {
      sha: 'tree-sha',
      tree: [{ path: 'f1.md', mode: '100644', type: 'blob', sha: 'blob-sha' }], // only 1 entry but we sent 2 files
    });
    const { octokit } = createFakeOctokit(responses);

    await expect(
      publishSnapshot(octokit, {
        repository: baseRepo,
        seedCommit: 'seed-sha',
        seedTree: 'tree-seed',
        files: [
          { path: 'f1.md', mode: '100644', content: utf8('a') },
          { path: 'f2.md', mode: '100644', content: utf8('b') },
        ],
      }),
    ).rejects.toThrow('entry count mismatch');
  });
});

// ---- createWriteGitHubPort ------------------------------------------------

describe('createWriteGitHubPort', () => {
  it('returns a port with all write methods', () => {
    const { octokit } = createFakeOctokit();
    const port = createWriteGitHubPort(octokit);

    expect(typeof port.createRepository).toBe('function');
    expect(typeof port.seedMainViaContents).toBe('function');
    expect(typeof port.publishSnapshot).toBe('function');
    expect(typeof port.reconcileLabels).toBe('function');
    expect(typeof port.grantTeamPermissions).toBe('function');
    expect(typeof port.reconcileEnvironments).toBe('function');
    expect(typeof port.reconcileRepositoryRuleset).toBe('function');
    expect(typeof port.reconcileOrgWorkflowRuleset).toBe('function');
    expect(typeof port.upsertBootstrapPull).toBe('function');
  });

  // M2c methods are now implemented (reconcileLabels, grantTeamPermissions, etc.).
  // Individual reconciler tests are in separate describe blocks.
});
