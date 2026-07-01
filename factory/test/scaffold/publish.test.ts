/**
 * scaffold/publish.test.ts — `publishComponentBranch` + `upsertScaffoldPull`
 * tests (D4/D20/D23).
 */

import { describe, expect, it } from 'vitest';
import {
  type OctokitMutate,
  publishComponentBranch,
  upsertScaffoldPull,
} from '../../src/scaffold/publish.js';
import type {
  PublishComponentBranchInput,
  UpsertScaffoldPullInput,
} from '../../src/scaffold/types.js';

function createFakeOctokit(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const octokit: OctokitMutate = {
    request: async (route, params = {}) => {
      calls.push({ route, params: params as Record<string, unknown> });
      const handler = handlers[route];
      if (!handler) {
        throw new Error(`unexpected route: ${route}`);
      }
      return handler(params as Record<string, unknown>);
    },
  };
  return { octokit, calls };
}

describe('publishComponentBranch', () => {
  function baseInput(): PublishComponentBranchInput {
    return {
      target: { owner: 'acme', repo: 'demo' },
      baseTreeSha: 'main-tree-sha',
      baseCommitSha: 'main-commit-sha',
      branchName: 'sdd/scaffold-abc123',
      files: [
        {
          path: 'apps/backend/README.md',
          mode: '100644',
          content: new TextEncoder().encode('# backend\n'),
        },
        {
          path: 'apps/backend/template.lock',
          mode: '100644',
          content: new TextEncoder().encode('lock yaml\n'),
        },
      ],
      commitMessage: 'sdd-scaffold: backend',
      allowedPaths: new Set(['apps/backend']),
    };
  }

  it('refuses files outside allowed pending component paths (D4)', async () => {
    const { octokit } = createFakeOctokit({});
    const input = baseInput();
    input.files = [
      {
        path: 'specs/v1/spec.md',
        mode: '100644',
        content: new TextEncoder().encode('x'),
      },
    ];

    await expect(publishComponentBranch(octokit, input)).rejects.toThrow(
      /not under any pending component path/,
    );
  });

  it('refuses files under apps/ but not in the pending component set', async () => {
    const { octokit } = createFakeOctokit({});
    const input = baseInput();
    input.files = [
      {
        path: 'apps/web/package.json',
        mode: '100644',
        content: new TextEncoder().encode('{}'),
      },
    ];

    await expect(publishComponentBranch(octokit, input)).rejects.toThrow(
      /not under any pending component path/,
    );
  });

  it('creates blob + tree + commit + ref in order', async () => {
    const { octokit, calls } = createFakeOctokit({
      'POST /repos/{owner}/{repo}/git/blobs': () => ({ sha: 'blob-sha' }),
      'POST /repos/{owner}/{repo}/git/trees': () => ({ sha: 'tree-sha' }),
      'POST /repos/{owner}/{repo}/git/commits': () => ({ sha: 'commit-sha' }),
      'POST /repos/{owner}/{repo}/git/refs': () => ({}),
    });

    const result = await publishComponentBranch(octokit, baseInput());

    expect(result.commitSha).toBe('commit-sha');
    expect(result.treeSha).toBe('tree-sha');
    expect(result.created).toBe(true);
    expect(calls.length).toBe(5);
    expect(calls[0]!.route).toBe('POST /repos/{owner}/{repo}/git/blobs');
    expect(calls[2]!.route).toBe('POST /repos/{owner}/{repo}/git/trees');
    expect(calls[3]!.route).toBe('POST /repos/{owner}/{repo}/git/commits');
    expect(calls[4]!.route).toBe('POST /repos/{owner}/{repo}/git/refs');

    const treeCall = calls[2]!;
    expect((treeCall.params as { base_tree: string }).base_tree).toBe('main-tree-sha');
    const commitCall = calls[3]!;
    expect((commitCall.params as { parents: string[] }).parents).toEqual(['main-commit-sha']);
    const refCall = calls[4]!;
    expect((refCall.params as { ref: string }).ref).toBe('refs/heads/sdd/scaffold-abc123');
  });
});

describe('upsertScaffoldPull', () => {
  function baseInput(): UpsertScaffoldPullInput {
    return {
      target: { owner: 'acme', repo: 'demo' },
      headBranch: 'sdd/scaffold-abc123',
      baseBranch: 'main',
      title: 'sdd-scaffold: backend',
      body: 'body',
      teamReviewers: ['backend-team', 'web-team'],
      expectedHeadRepo: { owner: 'acme', repo: 'demo' },
      expectedBaseRef: 'main',
    };
  }

  it('reuses existing open PR when D20 verification passes', async () => {
    const { octokit, calls } = createFakeOctokit({
      'GET /repos/{owner}/{repo}/pulls': () => [
        {
          number: 42,
          head: {
            sha: 'existing-sha',
            ref: 'sdd/scaffold-abc123',
            repo: { owner: { login: 'acme' }, name: 'demo' },
          },
          base: {
            sha: 'base-sha',
            ref: 'main',
            repo: { owner: { login: 'acme' }, name: 'demo' },
          },
          html_url: 'https://example/42',
        },
      ],
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers': () => ({}),
    });

    const result = await upsertScaffoldPull(octokit, baseInput());

    expect(result.number).toBe(42);
    expect(result.created).toBe(false);
    expect(calls.length).toBe(2);
    expect(calls[1]!.route).toBe(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers',
    );
    const reviewersCall = calls[1]!.params as { team_reviewers: string[] };
    expect(reviewersCall.team_reviewers).toEqual(['backend-team', 'web-team']);
  });

  it('D20: rejects PR where head repo does not match expected', async () => {
    const { octokit } = createFakeOctokit({
      'GET /repos/{owner}/{repo}/pulls': () => [
        {
          number: 42,
          head: {
            sha: 'other-sha',
            ref: 'sdd/scaffold-abc123',
            repo: { owner: { login: 'fork-owner' }, name: 'demo' },
          },
          base: {
            sha: 'base-sha',
            ref: 'main',
            repo: { owner: { login: 'acme' }, name: 'demo' },
          },
          html_url: 'https://example/42',
        },
      ],
    });

    await expect(upsertScaffoldPull(octokit, baseInput())).rejects.toThrow(
      /head repo.*does not match expected/,
    );
  });

  it('D20: rejects PR where base ref is not main', async () => {
    const { octokit } = createFakeOctokit({
      'GET /repos/{owner}/{repo}/pulls': () => [
        {
          number: 42,
          head: {
            sha: 'existing-sha',
            ref: 'sdd/scaffold-abc123',
            repo: { owner: { login: 'acme' }, name: 'demo' },
          },
          base: {
            sha: 'base-sha',
            ref: 'develop',
            repo: { owner: { login: 'acme' }, name: 'demo' },
          },
          html_url: 'https://example/42',
        },
      ],
    });

    await expect(upsertScaffoldPull(octokit, baseInput())).rejects.toThrow(
      /base ref.*does not match/,
    );
  });

  it('D20: rejects PR where head ref is not the expected branch', async () => {
    const { octokit } = createFakeOctokit({
      'GET /repos/{owner}/{repo}/pulls': () => [
        {
          number: 42,
          head: {
            sha: 'existing-sha',
            ref: 'feature/other',
            repo: { owner: { login: 'acme' }, name: 'demo' },
          },
          base: {
            sha: 'base-sha',
            ref: 'main',
            repo: { owner: { login: 'acme' }, name: 'demo' },
          },
          html_url: 'https://example/42',
        },
      ],
    });

    await expect(upsertScaffoldPull(octokit, baseInput())).rejects.toThrow(
      /head ref.*does not match/,
    );
  });

  it('creates new PR when none exists', async () => {
    const { octokit, calls } = createFakeOctokit({
      'GET /repos/{owner}/{repo}/pulls': () => [],
      'POST /repos/{owner}/{repo}/pulls': () => ({
        number: 99,
        head: { sha: 'new-sha' },
        html_url: 'https://example/99',
      }),
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers': () => ({}),
    });

    const result = await upsertScaffoldPull(octokit, baseInput());

    expect(result.number).toBe(99);
    expect(result.created).toBe(true);
    expect(calls.length).toBe(3);
    expect(calls[1]!.route).toBe('POST /repos/{owner}/{repo}/pulls');
  });
});
