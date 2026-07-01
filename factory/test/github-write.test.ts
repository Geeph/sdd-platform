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
  reconcileEnvironments,
  reconcileOrgWorkflowRuleset,
  reconcileRepositoryRuleset,
  seedMainViaContents,
  updateRepositorySettings,
  upsertBootstrapPull,
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

// ---- upsertBootstrapPull --------------------------------------------------

describe('upsertBootstrapPull', () => {
  it('re-requests configured approver teams when converging an existing PR', async () => {
    const responses = new Map<string, unknown>([
      [
        'GET /repos/{owner}/{repo}/pulls',
        [
          {
            number: 7,
            head: { sha: 'head-sha', ref: 'sdd/bootstrap' },
            html_url: 'https://github.com/acme/demo/pull/7',
            state: 'open',
          },
        ],
      ],
      ['POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {}],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);

    await upsertBootstrapPull(octokit, {
      repository: {
        owner: 'acme',
        name: 'demo',
        id: 12345,
        defaultBranch: 'main',
        visibility: 'private',
      },
      title: 'bootstrap',
      body: 'body',
      headBranch: 'sdd/bootstrap',
      baseBranch: 'main',
      reviewers: ['platform-admins'],
      owners: {
        product: 'product-team',
        api: 'api-team',
        design: 'design-team',
        admins: 'platform-admins',
      },
    });

    const request = calls.find((call) => call.route.includes('requested_reviewers'));
    expect(request?.params).toMatchObject({
      pull_number: 7,
      team_reviewers: ['platform-admins'],
    });
  });
});

// ---- reconcileEnvironments -----------------------------------------------

describe('reconcileEnvironments', () => {
  const repository: RepositoryIdentity = {
    owner: 'acme',
    name: 'demo',
    id: 12345,
    defaultBranch: 'main',
    visibility: 'private',
  };

  it('writes and reads back team reviewers and prevent_self_review', async () => {
    const responses = new Map<string, unknown>([
      ['GET /repos/{owner}/{repo}/environments', { environments: [] }],
      ['GET /orgs/{org}/teams/{team_slug}', { id: 88 }],
      ['PUT /repos/{owner}/{repo}/environments/{environment_name}', { id: 1, name: 'preview' }],
      [
        'GET /repos/{owner}/{repo}/environments/{environment_name}',
        {
          id: 1,
          name: 'preview',
          protection_rules: [
            {
              type: 'required_reviewers',
              prevent_self_review: true,
              reviewers: [{ type: 'Team', reviewer: { id: 88 } }],
            },
          ],
        },
      ],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);

    await expect(
      reconcileEnvironments(octokit, {
        repository,
        desired: [{ name: 'preview', reviewers: ['product-team'], preventSelfReview: true }],
      }),
    ).resolves.toEqual({ created: ['preview'], updated: [], noop: [] });
    const put = calls.find((call) => call.route.startsWith('PUT'));
    expect(put?.params).toMatchObject({
      reviewers: [{ type: 'Team', id: 88 }],
      prevent_self_review: true,
    });
  });

  it('fails before environment mutation when a reviewer team cannot be resolved', async () => {
    const responses = new Map<string, unknown>([
      ['GET /repos/{owner}/{repo}/environments', { environments: [] }],
      ['GET /orgs/{org}/teams/{team_slug}', {}],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);

    await expect(
      reconcileEnvironments(octokit, {
        repository,
        desired: [{ name: 'preview', reviewers: ['missing-team'], preventSelfReview: true }],
      }),
    ).rejects.toThrow('has no id');
    expect(calls.some((call) => call.route.startsWith('PUT'))).toBe(false);
  });
});

// ---- reconcileRepositoryRuleset -------------------------------------------

describe('reconcileRepositoryRuleset', () => {
  const repository: RepositoryIdentity = {
    owner: 'acme',
    name: 'demo',
    id: 12345,
    defaultBranch: 'main',
    visibility: 'private',
  };

  it('creates initial ruleset with conditions as an object (not array)', async () => {
    const responses = new Map<string, unknown>();
    let detail: Record<string, unknown> = {};
    responses.set('GET /repos/{owner}/{repo}/rulesets', []);
    responses.set('POST /repos/{owner}/{repo}/rulesets', (params: Record<string, unknown>) => {
      detail = { ...params, id: 1 };
      return detail;
    });
    responses.set('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', () => detail);

    const { octokit, calls } = createFakeOctokit(responses);
    await reconcileRepositoryRuleset(octokit, { repository, hardened: false });

    const createCall = calls.find((c) => c.route.startsWith('POST /repos'));
    expect(createCall).toBeDefined();
    const conditions = (createCall!.params as { conditions: unknown }).conditions;
    // §P0 #2 fix: conditions must be a plain object, not an array
    expect(Array.isArray(conditions)).toBe(false);
    expect(typeof conditions).toBe('object');
    expect(conditions).toEqual({
      ref_name: { include: ['refs/heads/main'], exclude: [] },
    });
  });

  it('hardened=true adds required_status_checks with integration_id', async () => {
    const responses = new Map<string, unknown>();
    let detail: Record<string, unknown> = {};
    responses.set('GET /repos/{owner}/{repo}/rulesets', []);
    responses.set('POST /repos/{owner}/{repo}/rulesets', (params: Record<string, unknown>) => {
      detail = { ...params, id: 1 };
      return detail;
    });
    responses.set('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', () => detail);

    const { octokit, calls } = createFakeOctokit(responses);
    await reconcileRepositoryRuleset(octokit, {
      repository,
      hardened: {
        requiredCheckContexts: ['CI Gate', 'PR hygiene'],
        integrationId: 15368,
      },
    });

    const createCall = calls.find((c) => c.route.startsWith('POST /repos'));
    expect(createCall).toBeDefined();
    const rules = (createCall!.params as { rules: Array<Record<string, unknown>> }).rules;
    const statusChecksRule = rules.find((r) => r.type === 'required_status_checks');
    expect(statusChecksRule).toBeDefined();
    const params = statusChecksRule!.parameters as {
      required_status_checks: Array<{ context: string; integration_id: number }>;
    };
    expect(params.required_status_checks).toEqual([
      { context: 'CI Gate', integration_id: 15368 },
      { context: 'PR hygiene', integration_id: 15368 },
    ]);
  });

  it('hardened without explicit integration_id defaults to 15368 (GitHub Actions)', async () => {
    const responses = new Map<string, unknown>();
    let detail: Record<string, unknown> = {};
    responses.set('GET /repos/{owner}/{repo}/rulesets', []);
    responses.set('POST /repos/{owner}/{repo}/rulesets', (params: Record<string, unknown>) => {
      detail = { ...params, id: 1 };
      return detail;
    });
    responses.set('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', () => detail);

    const { octokit, calls } = createFakeOctokit(responses);
    await reconcileRepositoryRuleset(octokit, {
      repository,
      hardened: { requiredCheckContexts: ['CI Gate', 'PR hygiene'] },
    });

    const createCall = calls.find((c) => c.route.startsWith('POST /repos'));
    const rules = (createCall!.params as { rules: Array<Record<string, unknown>> }).rules;
    const statusChecksRule = rules.find((r) => r.type === 'required_status_checks');
    const params = statusChecksRule!.parameters as {
      required_status_checks: Array<{ context: string; integration_id: number }>;
    };
    expect(params.required_status_checks[0]!.integration_id).toBe(15368);
  });
});

// ---- reconcileOrgWorkflowRuleset ------------------------------------------

describe('reconcileOrgWorkflowRuleset', () => {
  const repository: RepositoryIdentity = {
    owner: 'acme',
    name: 'demo',
    id: 12345,
    defaultBranch: 'main',
    visibility: 'private',
  };

  it('uses repository_id.repository_ids (nested) and sha: for pinned commit', async () => {
    const responses = new Map<string, unknown>();
    let detail: Record<string, unknown> = {};
    responses.set('GET /orgs/{org}/rulesets', []);
    responses.set('POST /orgs/{org}/rulesets', (params: Record<string, unknown>) => {
      detail = { ...params, id: 1 };
      return detail;
    });
    responses.set('GET /orgs/{org}/rulesets/{ruleset_id}', () => detail);

    const { octokit, calls } = createFakeOctokit(responses);
    await reconcileOrgWorkflowRuleset(octokit, {
      repository,
      platformRepoId: 99999,
      pinnedSha: 'a'.repeat(40),
      enforcement: 'evaluate',
    });

    const createCall = calls.find((c) => c.route.startsWith('POST /orgs'));
    expect(createCall).toBeDefined();
    const params = createCall!.params as {
      conditions: Record<string, unknown>;
      rules: Array<Record<string, unknown>>;
    };

    // conditions must be an object, not an array (P0 #2 fix)
    expect(Array.isArray(params.conditions)).toBe(false);

    // Must use repository_id.repository_ids (nested form per GitHub official schema)
    const repoIdCond = params.conditions.repository_id as { repository_ids?: number[] } | undefined;
    expect(repoIdCond?.repository_ids).toEqual([12345]);

    // ref_name is a nested condition inside the same conditions object
    expect(params.conditions.ref_name).toEqual({
      include: ['refs/heads/main'],
      exclude: [],
    });

    // Workflow source must use sha: (not ref:) for pinned commits (P0 #2 fix)
    const workflowsRule = params.rules.find((r) => r.type === 'workflows');
    expect(workflowsRule).toBeDefined();
    const wfParams = workflowsRule!.parameters as {
      workflows: Array<{ repository_id: number; path: string; sha: string; ref?: string }>;
    };
    expect(wfParams.workflows.length).toBe(2);
    for (const wf of wfParams.workflows) {
      expect(wf.repository_id).toBe(99999);
      expect(wf.sha).toBe('a'.repeat(40));
      // ref must NOT be present for pinned commits (P0 #2 fix)
      expect(wf.ref).toBeUndefined();
    }
    expect(wfParams.workflows.map((w) => w.path)).toEqual([
      '.github/workflows/ci-gate.yml',
      '.github/workflows/pr-hygiene.yml',
    ]);
  });

  it('honors enforcement=active for finalize', async () => {
    const responses = new Map<string, unknown>();
    let detail: Record<string, unknown> = {
      id: 1,
      name: 'sdd-workflows-12345',
      target: 'branch',
      enforcement: 'evaluate',
      conditions: {
        repository_id: { repository_ids: [12345] },
        ref_name: { include: ['refs/heads/main'], exclude: [] },
      },
      rules: [
        {
          type: 'workflows',
          parameters: {
            workflows: [
              {
                repository_id: 99999,
                path: '.github/workflows/ci-gate.yml',
                sha: 'a'.repeat(40),
              },
              {
                repository_id: 99999,
                path: '.github/workflows/pr-hygiene.yml',
                sha: 'a'.repeat(40),
              },
            ],
          },
        },
      ],
    };
    responses.set('GET /orgs/{org}/rulesets', [
      {
        id: 1,
        name: 'sdd-workflows-12345',
        enforcement: 'evaluate',
      },
    ]);
    responses.set('GET /orgs/{org}/rulesets/{ruleset_id}', () => detail);
    responses.set('PUT /orgs/{org}/rulesets/{ruleset_id}', (params: Record<string, unknown>) => {
      detail = { ...params, id: 1 };
      return detail;
    });

    const { octokit, calls } = createFakeOctokit(responses);
    const result = await reconcileOrgWorkflowRuleset(octokit, {
      repository,
      platformRepoId: 99999,
      pinnedSha: 'a'.repeat(40),
      enforcement: 'active',
    });

    expect(result.updated).toEqual(['sdd-workflows-12345']);
    const putCall = calls.find((c) => c.route.startsWith('PUT /orgs'));
    expect(putCall).toBeDefined();
    expect((putCall!.params as { enforcement: string }).enforcement).toBe('active');
  });

  it('detects conflict when existing ruleset has different target repo', async () => {
    const responses = new Map<string, unknown>();
    const existing = {
      id: 1,
      name: 'sdd-workflows-12345',
      enforcement: 'evaluate',
      conditions: { repository_id: { repository_ids: [77777] } }, // different repo id
      rules: [],
    };
    responses.set('GET /orgs/{org}/rulesets', [existing]);
    responses.set('GET /orgs/{org}/rulesets/{ruleset_id}', existing);

    const { octokit } = createFakeOctokit(responses);
    await expect(
      reconcileOrgWorkflowRuleset(octokit, {
        repository,
        platformRepoId: 99999,
        pinnedSha: 'a'.repeat(40),
        enforcement: 'evaluate',
      }),
    ).rejects.toThrow(/conflict/);
  });

  it('detects conflict when pinned SHA has drifted', async () => {
    const responses = new Map<string, unknown>();
    const existing = {
      id: 1,
      name: 'sdd-workflows-12345',
      enforcement: 'evaluate',
      conditions: { repository_id: { repository_ids: [12345] } },
      rules: [
        {
          type: 'workflows',
          parameters: {
            workflows: [
              {
                repository_id: 99999,
                path: '.github/workflows/ci-gate.yml',
                sha: 'b'.repeat(40),
              },
            ],
          },
        },
      ],
    };
    responses.set('GET /orgs/{org}/rulesets', [existing]);
    responses.set('GET /orgs/{org}/rulesets/{ruleset_id}', existing);

    const { octokit } = createFakeOctokit(responses);
    await expect(
      reconcileOrgWorkflowRuleset(octokit, {
        repository,
        platformRepoId: 99999,
        pinnedSha: 'a'.repeat(40), // different from existing 'b'.repeat(40)
        enforcement: 'evaluate',
      }),
    ).rejects.toThrow(/conflict/);
  });
});
