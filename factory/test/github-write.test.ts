/**
 * github-write.test.ts — API contract tests for the M2b write adapter.
 *
 * Uses a fake octokit that records calls and returns fixture responses.
 * Tests the HTTP boundary: real request routes, body shapes, API version,
 * pagination Link headers, and the D9 invariants (Contents seed → Git Data
 * non-force ref advance).
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createRepository,
  createWriteGitHubPort,
  type OctokitMutate,
  publishSnapshot,
  seedMainViaContents,
  updateRepositorySettings,
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
        const response = responses.get(key);
        if (typeof response === 'function') {
          return (response as (parameters: Record<string, unknown>) => unknown)(parameters);
        }
        return response;
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

function blobSha(content: Uint8Array | string): string {
  const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const OPERATION_ID = `sha256:${'a'.repeat(64)}`;
const SEED_MESSAGE = `sdd-init: seed template.lock [${OPERATION_ID}]`;

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
      description: '[sdd-init:sha256:abc123]',
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
      description: 'test',
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

  it('confirms an ambiguous create failure without replaying POST', async () => {
    const error = Object.assign(new Error('response lost'), { status: 500 });
    const responses = new Map<string, unknown>([
      [
        'POST /orgs/{org}/repos',
        () => {
          throw error;
        },
      ],
      [
        'GET /repos/{owner}/{repo}',
        {
          id: 7,
          name: 'demo',
          owner: { login: 'acme' },
          private: true,
          visibility: 'private',
          default_branch: 'main',
          description: '[sdd-init:sha256:abc123]',
        },
      ],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);

    const result = await createRepository(octokit, {
      owner: 'acme',
      name: 'demo',
      visibility: 'private',
      description: '[sdd-init:sha256:abc123]',
      initMarker: 'sha256:abc123',
    });

    expect(result.id).toBe(7);
    expect(calls.filter((call) => call.route.startsWith('POST'))).toHaveLength(1);
  });
});

// ---- updateRepositorySettings -------------------------------------------

describe('updateRepositorySettings', () => {
  it('sets main + description and verifies both by read-back', async () => {
    const observed = {
      id: 12345,
      name: 'demo',
      owner: { login: 'acme' },
      private: true,
      visibility: 'private',
      default_branch: 'main',
      description: 'Demo monorepo',
    };
    const responses = new Map<string, unknown>([
      ['PATCH /repos/{owner}/{repo}', observed],
      ['GET /repos/{owner}/{repo}', observed],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);
    const repository: RepositoryIdentity = {
      owner: 'acme',
      name: 'demo',
      id: 12345,
      defaultBranch: 'master',
      visibility: 'private',
    };

    await expect(
      updateRepositorySettings(octokit, {
        repository,
        description: 'Demo monorepo',
        defaultBranch: 'main',
      }),
    ).resolves.toMatchObject({ defaultBranch: 'main' });
    expect(calls[0]?.params).toMatchObject({
      description: 'Demo monorepo',
      default_branch: 'main',
    });
  });
});

// ---- seedMainViaContents --------------------------------------------------

describe('seedMainViaContents', () => {
  it('writes template.lock via Contents API and reads back commit', async () => {
    const seedResp = {
      content: { path: 'template.lock' },
      commit: { sha: 'aaa111' },
    };
    const commitResp = {
      sha: 'aaa111',
      message: SEED_MESSAGE,
      tree: { sha: 'tree-seed' },
      parents: [],
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
      operationId: OPERATION_ID,
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
      seedMainViaContents(octokit, {
        repository: repo,
        lockContent: 'test',
        operationId: OPERATION_ID,
      }),
    ).rejects.toThrow('no commit SHA');
  });

  it('confirms exact lock content after an ambiguous PUT failure', async () => {
    const error = Object.assign(new Error('response lost'), { status: 500 });
    const lockContent = 'schema_version: 1\n';
    const responses = new Map<string, unknown>([
      [
        'PUT /repos/{owner}/{repo}/contents/{path}',
        () => {
          throw error;
        },
      ],
      [
        'GET /repos/{owner}/{repo}/contents/{path}',
        { content: Buffer.from(lockContent).toString('base64'), encoding: 'base64' },
      ],
      ['GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { sha: 'seed-sha' } }],
      [
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        { sha: 'seed-sha', message: SEED_MESSAGE, tree: { sha: 'seed-tree' }, parents: [] },
      ],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);
    const repository: RepositoryIdentity = {
      owner: 'acme',
      name: 'demo',
      id: 1,
      defaultBranch: 'main',
      visibility: 'private',
    };

    await expect(
      seedMainViaContents(octokit, { repository, lockContent, operationId: OPERATION_ID }),
    ).resolves.toEqual({
      sha: 'seed-sha',
      treeSha: 'seed-tree',
    });
    expect(calls.filter((call) => call.route.startsWith('PUT'))).toHaveLength(1);
  });

  it('recovers the root seed when a concurrent run already published the snapshot', async () => {
    const error = Object.assign(new Error('already exists'), { status: 422 });
    const lockContent = 'schema_version: 1\n';
    const responses = new Map<string, unknown>([
      [
        'PUT /repos/{owner}/{repo}/contents/{path}',
        () => {
          throw error;
        },
      ],
      [
        'GET /repos/{owner}/{repo}/contents/{path}',
        { content: Buffer.from(lockContent).toString('base64'), encoding: 'base64' },
      ],
      ['GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { sha: 'snapshot-sha' } }],
      [
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        (parameters: Record<string, unknown>) =>
          parameters.commit_sha === 'snapshot-sha'
            ? {
                sha: 'snapshot-sha',
                tree: { sha: 'snapshot-tree' },
                parents: [{ sha: 'seed-sha' }],
              }
            : {
                sha: 'seed-sha',
                message: SEED_MESSAGE,
                tree: { sha: 'seed-tree' },
                parents: [],
              },
      ],
    ]);
    const { octokit } = createFakeOctokit(responses);
    const repository: RepositoryIdentity = {
      owner: 'acme',
      name: 'demo',
      id: 1,
      defaultBranch: 'main',
      visibility: 'private',
    };

    await expect(
      seedMainViaContents(octokit, { repository, lockContent, operationId: OPERATION_ID }),
    ).resolves.toEqual({ sha: 'seed-sha', treeSha: 'seed-tree' });
  });

  it('rejects an ambiguous PUT owned by a different seed operation', async () => {
    const error = Object.assign(new Error('already exists'), { status: 422 });
    const lockContent = 'schema_version: 1\n';
    const responses = new Map<string, unknown>([
      [
        'PUT /repos/{owner}/{repo}/contents/{path}',
        () => {
          throw error;
        },
      ],
      [
        'GET /repos/{owner}/{repo}/contents/{path}',
        { content: Buffer.from(lockContent).toString('base64'), encoding: 'base64' },
      ],
      ['GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { sha: 'seed-sha' } }],
      [
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        {
          sha: 'seed-sha',
          message: `sdd-init: seed template.lock [sha256:${'b'.repeat(64)}]`,
          tree: { sha: 'seed-tree' },
          parents: [],
        },
      ],
    ]);
    const { octokit } = createFakeOctokit(responses);
    const repository: RepositoryIdentity = {
      owner: 'acme',
      name: 'demo',
      id: 1,
      defaultBranch: 'main',
      visibility: 'private',
    };

    await expect(
      seedMainViaContents(octokit, { repository, lockContent, operationId: OPERATION_ID }),
    ).rejects.toThrow('not this operation');
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
    responses.set('POST /repos/{owner}/{repo}/git/blobs', (params: Record<string, unknown>) => ({
      sha: blobSha(Buffer.from(params.content as string, 'base64')),
    }));

    // Tree creation.
    responses.set('POST /repos/{owner}/{repo}/git/trees', {
      sha: 'tree-snapshot',
    });
    responses.set('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      tree: [
        { path: 'template.lock', mode: '100644', type: 'blob', sha: blobSha('lock') },
        { path: 'AGENTS.md', mode: '100644', type: 'blob', sha: blobSha('# Agents') },
        { path: 'README.md', mode: '100644', type: 'blob', sha: blobSha('# Readme') },
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
      lockContent: 'lock',
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
    responses.set('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
      tree: { sha: 'foreign-tree' },
      parents: [{ sha: 'different-parent' }],
    });
    const { octokit } = createFakeOctokit(responses);

    const result = await publishSnapshot(octokit, {
      repository: baseRepo,
      seedCommit: 'seed-sha',
      seedTree: 'tree-seed',
      lockContent: 'lock',
      files: [{ path: 'AGENTS.md', mode: '100644', content: utf8('test') }],
    });

    expect(result.disposition).toBe('conflict');
    expect(result.sha).toBe('someone-else-sha');
  });

  it('returns noop when main already contains the exact snapshot', async () => {
    const responses = new Map<string, unknown>();
    responses.set('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      object: { sha: 'snapshot-sha' },
    });
    responses.set('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
      tree: { sha: 'snapshot-tree' },
      parents: [{ sha: 'seed-sha' }],
    });
    responses.set('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      tree: [
        { path: 'template.lock', mode: '100644', type: 'blob', sha: blobSha('lock') },
        { path: 'AGENTS.md', mode: '100644', type: 'blob', sha: blobSha('agents') },
      ],
    });
    const { octokit, calls } = createFakeOctokit(responses);

    const result = await publishSnapshot(octokit, {
      repository: baseRepo,
      seedCommit: 'seed-sha',
      lockContent: 'lock',
      files: [{ path: 'AGENTS.md', mode: '100644', content: utf8('agents') }],
    });

    expect(result).toEqual({
      sha: 'snapshot-sha',
      treeSha: 'snapshot-tree',
      disposition: 'noop',
    });
    expect(calls.some((call) => call.route.startsWith('POST'))).toBe(false);
    expect(calls.some((call) => call.route.startsWith('PATCH'))).toBe(false);
  });

  it('confirms ref state after a lost PATCH response without replaying PATCH', async () => {
    let refReads = 0;
    const responses = new Map<string, unknown>();
    responses.set('GET /repos/{owner}/{repo}/git/ref/{ref}', () => {
      refReads++;
      return { object: { sha: refReads === 1 ? 'seed-sha' : 'snapshot-sha' } };
    });
    responses.set('POST /repos/{owner}/{repo}/git/blobs', (params: Record<string, unknown>) => ({
      sha: blobSha(Buffer.from(params.content as string, 'base64')),
    }));
    responses.set('POST /repos/{owner}/{repo}/git/trees', { sha: 'snapshot-tree' });
    responses.set('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      tree: [
        { path: 'template.lock', mode: '100644', type: 'blob', sha: blobSha('lock') },
        { path: 'README.md', mode: '100644', type: 'blob', sha: blobSha('readme') },
      ],
    });
    responses.set('POST /repos/{owner}/{repo}/git/commits', {
      sha: 'snapshot-sha',
      tree: { sha: 'snapshot-tree' },
    });
    responses.set('PATCH /repos/{owner}/{repo}/git/refs/{ref}', () => {
      throw Object.assign(new Error('response lost'), { status: 500 });
    });
    const { octokit, calls } = createFakeOctokit(responses);

    await expect(
      publishSnapshot(octokit, {
        repository: baseRepo,
        seedCommit: 'seed-sha',
        seedTree: 'seed-tree',
        lockContent: 'lock',
        files: [{ path: 'README.md', mode: '100644', content: utf8('readme') }],
      }),
    ).resolves.toEqual({
      sha: 'snapshot-sha',
      treeSha: 'snapshot-tree',
      disposition: 'create',
    });
    expect(calls.filter((call) => call.route.startsWith('PATCH'))).toHaveLength(1);
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
        lockContent: 'lock',
        files: [{ path: 'apps/backend/main.ts', mode: '100644', content: utf8('test') }],
      }),
    ).rejects.toThrow('apps/*');
  });

  it('rejects duplicate and reserved paths before any GitHub write', async () => {
    const duplicate = createFakeOctokit();
    await expect(
      publishSnapshot(duplicate.octokit, {
        repository: baseRepo,
        seedCommit: 'seed-sha',
        lockContent: 'lock',
        files: [
          { path: 'README.md', mode: '100644', content: utf8('a') },
          { path: 'README.md', mode: '100644', content: utf8('b') },
        ],
      }),
    ).rejects.toThrow('duplicate path');
    expect(duplicate.calls).toHaveLength(0);

    const reserved = createFakeOctokit();
    await expect(
      publishSnapshot(reserved.octokit, {
        repository: baseRepo,
        seedCommit: 'seed-sha',
        lockContent: 'lock',
        files: [{ path: 'template.lock', mode: '100644', content: utf8('other') }],
      }),
    ).rejects.toThrow('must only come from the seed tree');
    expect(reserved.calls).toHaveLength(0);
  });

  it('verifies recursive tree content instead of trusting create-tree array length', async () => {
    const responses = new Map<string, unknown>();
    responses.set('GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { sha: 'seed-sha' } });
    responses.set('POST /repos/{owner}/{repo}/git/blobs', { sha: 'blob-sha' });
    responses.set('POST /repos/{owner}/{repo}/git/trees', {
      sha: 'tree-sha',
    });
    responses.set('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      tree: [
        { path: 'template.lock', mode: '100644', type: 'blob', sha: blobSha('lock') },
        { path: 'f1.md', mode: '100644', type: 'blob', sha: blobSha('a') },
      ],
    });
    const { octokit } = createFakeOctokit(responses);

    await expect(
      publishSnapshot(octokit, {
        repository: baseRepo,
        seedCommit: 'seed-sha',
        seedTree: 'tree-seed',
        lockContent: 'lock',
        files: [
          { path: 'f1.md', mode: '100644', content: utf8('a') },
          { path: 'f2.md', mode: '100644', content: utf8('b') },
        ],
      }),
    ).rejects.toThrow('leaf count mismatch');
  });
});

// ---- createWriteGitHubPort ------------------------------------------------

describe('createWriteGitHubPort', () => {
  it('returns a port with all write methods', () => {
    const { octokit } = createFakeOctokit();
    const port = createWriteGitHubPort(octokit);

    expect(typeof port.createRepository).toBe('function');
    expect(typeof port.updateRepositorySettings).toBe('function');
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
