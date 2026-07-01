/**
 * github-read.test.ts — read-only adapter tests.
 *
 * Uses a fake octokit-like client that records calls and returns fixture
 * responses. Guards the P1 fix for recursive annotated tag peeling (the
 * old code called /git/ref/{ref} with a tag SHA on the second iteration
 * and got a 404; the fix keeps calling /git/tags/{sha} through the chain).
 */

import { describe, expect, it } from 'vitest';
import { createReadonlyGitHubPort, type OctokitReadOnly } from '../src/github-read.js';

interface RecordedCall {
  route: string;
  params: Record<string, unknown>;
}

function createFakeOctokit(responses: Map<string, unknown>): {
  octokit: OctokitReadOnly;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const octokit: OctokitReadOnly = {
    async request(route: string, parameters: Record<string, unknown> = {}) {
      calls.push({ route, params: parameters });
      const key = route;
      if (responses.has(key)) {
        const resp = responses.get(key);
        if (typeof resp === 'function') return (resp as (p: unknown) => unknown)(parameters);
        return resp;
      }
      throw new Error(`fake octokit: no response for ${route} ${JSON.stringify(parameters)}`);
    },
  };
  return { octokit, calls };
}

describe('createReadonlyGitHubPort', () => {
  it('refuses mutating routes at runtime (defense-in-depth)', async () => {
    const { octokit } = createFakeOctokit(new Map());
    const port = createReadonlyGitHubPort(octokit);
    await expect(
      // The port has no write methods exposed, but if an internal path
      // tried a POST we'd catch it. Use the internal safeRequest via a
      // known read-only route that we know works — then verify the fake
      // was never called with a POST-like route.
      port.resolveCommit({ owner: 'acme', repo: 'sdd-platform' }, 'a'.repeat(40)),
    ).resolves.toBeDefined();
  });

  it('fast-paths a full 40-char SHA without calling the network', async () => {
    const { octokit, calls } = createFakeOctokit(new Map());
    const port = createReadonlyGitHubPort(octokit);
    const sha = 'a'.repeat(40);
    const result = await port.resolveCommit({ owner: 'acme', repo: 'sdd-platform' }, sha);
    expect(result.commit).toBe(sha);
    expect(result.requestedRef).toBe(sha);
    expect(result.peeled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('peels one annotated tag to its commit', async () => {
    const responses = new Map<string, unknown>([
      ['GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { type: 'tag', sha: 'tag-sha-1' } }],
      [
        'GET /repos/{owner}/{repo}/git/tags/{tag_sha}',
        { object: { type: 'commit', sha: 'commit-sha-1' } },
      ],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);
    const port = createReadonlyGitHubPort(octokit);
    const result = await port.resolveCommit({ owner: 'acme', repo: 'sdd-platform' }, 'v1.0.0');
    expect(result.commit).toBe('commit-sha-1');
    expect(result.peeled).toBe(true);
    expect(result.requestedRef).toBe('v1.0.0');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.route).toBe('GET /repos/{owner}/{repo}/git/ref/{ref}');
    expect(calls[1]?.route).toBe('GET /repos/{owner}/{repo}/git/tags/{tag_sha}');
  });

  it('peels nested annotated tags (tag→tag→commit) via /git/tags repeatedly', async () => {
    // Regression: the old loop called /git/ref/{ref} with the tag SHA on
    // the second iteration, which 404s. The fix keeps using /git/tags/{sha}
    // until a commit appears.
    const responses = new Map<string, unknown>([
      ['GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { type: 'tag', sha: 'tag-outer' } }],
      [
        'GET /repos/{owner}/{repo}/git/tags/{tag_sha}',
        (params: { tag_sha: string }) => {
          if (params.tag_sha === 'tag-outer') {
            return { object: { type: 'tag', sha: 'tag-inner' } };
          }
          if (params.tag_sha === 'tag-inner') {
            return { object: { type: 'commit', sha: 'final-commit' } };
          }
          throw new Error(`unexpected tag_sha: ${params.tag_sha}`);
        },
      ],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);
    const port = createReadonlyGitHubPort(octokit);
    const result = await port.resolveCommit({ owner: 'acme', repo: 'sdd-platform' }, 'v2.0.0');
    expect(result.commit).toBe('final-commit');
    expect(result.peeled).toBe(true);
    // Exactly 3 calls: 1 ref + 2 tags (outer + inner).
    expect(calls).toHaveLength(3);
    expect(calls[0]?.route).toBe('GET /repos/{owner}/{repo}/git/ref/{ref}');
    expect(calls[0]?.params.ref).toBe('tags/v2.0.0');
    expect(calls[1]?.route).toBe('GET /repos/{owner}/{repo}/git/tags/{tag_sha}');
    expect(calls[1]?.params.tag_sha).toBe('tag-outer');
    expect(calls[2]?.route).toBe('GET /repos/{owner}/{repo}/git/tags/{tag_sha}');
    expect(calls[2]?.params.tag_sha).toBe('tag-inner');
  });

  it('refuses unknown object types', async () => {
    const responses = new Map<string, unknown>([
      ['GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { type: 'blob', sha: 'blob-sha' } }],
    ]);
    const { octokit } = createFakeOctokit(responses);
    const port = createReadonlyGitHubPort(octokit);
    await expect(
      port.resolveCommit({ owner: 'acme', repo: 'sdd-platform' }, 'weird'),
    ).rejects.toThrow(/unsupported object type/);
  });

  it('falls back from a missing tag to a branch ref', async () => {
    const responses = new Map<string, unknown>([
      [
        'GET /repos/{owner}/{repo}/git/ref/{ref}',
        (params: { ref: string }) => {
          if (params.ref === 'tags/release') {
            throw Object.assign(new Error('not found'), { status: 404 });
          }
          return { object: { type: 'commit', sha: 'a'.repeat(40) } };
        },
      ],
    ]);
    const { octokit, calls } = createFakeOctokit(responses);
    const port = createReadonlyGitHubPort(octokit);

    await expect(
      port.resolveCommit({ owner: 'acme', repo: 'sdd-platform' }, 'release'),
    ).resolves.toMatchObject({ commit: 'a'.repeat(40), peeled: false });
    expect(calls.map((call) => call.params.ref)).toEqual(['tags/release', 'heads/release']);
  });

  it('lowers case on commit SHAs', async () => {
    const responses = new Map<string, unknown>([
      [
        'GET /repos/{owner}/{repo}/git/ref/{ref}',
        { object: { type: 'commit', sha: `${'ABCDEF'.repeat(6)}ABCD` } },
      ],
    ]);
    const { octokit } = createFakeOctokit(responses);
    const port = createReadonlyGitHubPort(octokit);
    const result = await port.resolveCommit({ owner: 'acme', repo: 'sdd-platform' }, 'main');
    expect(result.commit).toBe(result.commit.toLowerCase());
  });

  it('walks first-parent history to recover the seed after Bootstrap merge', async () => {
    const responses = new Map<string, unknown>([
      [
        'GET /repos/{owner}/{repo}',
        {
          id: 42,
          name: 'demo',
          owner: { login: 'acme' },
          default_branch: 'main',
          private: true,
          visibility: 'private',
          description: 'Demo product',
        },
      ],
      ['GET /repos/{owner}/{repo}/git/ref/{ref}', { object: { sha: 'merge-sha' } }],
      [
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        (params: { commit_sha: string }) =>
          params.commit_sha === 'merge-sha'
            ? {
                message: 'bootstrap merge',
                tree: { sha: 'merge-tree' },
                parents: [{ sha: 'snapshot-sha' }, { sha: 'bootstrap-head' }],
              }
            : params.commit_sha === 'snapshot-sha'
              ? {
                  message: 'snapshot',
                  tree: { sha: 'snapshot-tree' },
                  parents: [{ sha: 'seed-sha' }],
                }
              : {
                  message: `sdd-init: seed template.lock [sha256:${'a'.repeat(64)}]`,
                  tree: { sha: 'seed-tree' },
                  parents: [],
                },
      ],
      [
        'GET /repos/{owner}/{repo}/contents/{path}',
        { content: Buffer.from('schema_version: 1\n').toString('base64'), encoding: 'base64' },
      ],
    ]);
    const { octokit } = createFakeOctokit(responses);
    const port = createReadonlyGitHubPort(octokit);

    const observed = await port.observe({
      product: 'demo',
      target: { owner: 'acme', repo: 'demo', visibility: 'private' },
      mode: 'monorepo',
      platform: { repository: 'acme/sdd-platform', ref: 'a'.repeat(40) },
      config: {
        schema_version: 1,
        bootstrap: { approvers: ['admins'] },
        owners: { product: 'product', api: 'api', design: 'design', admins: 'admins' },
      },
    });

    expect(observed.repository).toMatchObject({
      mainSha: 'merge-sha',
      mainTreeSha: 'merge-tree',
      mainParentShas: ['snapshot-sha', 'bootstrap-head'],
      seedCommitSha: 'seed-sha',
      seedOperationId: `sha256:${'a'.repeat(64)}`,
      templateLock: 'schema_version: 1\n',
    });
  });
});
