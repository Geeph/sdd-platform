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

/** Build a fake OctokitMutate that tracks calls and responds to known routes. */
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
  const baseInput = (): PublishComponentBranchInput => ({
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
  });

  it('refuses files outside apps/ prefix (D4 safety)', async () => {
    const { octokit } = createFakeOctokit({});
    const input = baseInput();
    input.files = [
      { path: 'specs/v1/spec.md', mode: '100644', content: new TextEncoder().encode('x') },
    ];

    await expect(publishComponentBranch(octokit, input)).rejects.toThrow(/not under apps\//);
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

    // Order: 2 blob calls, 1 tree, 1 commit, 1 ref = 5 calls.
    expect(calls.length).toBe(5);
    expect(calls[0]!.route).toBe('POST /repos/{owner}/{repo}/git/blobs');
    expect(calls[2]!.route).toBe('POST /repos/{owner}/{repo}/git/trees');
    expect(calls[3]!.route).toBe('POST /repos/{owner}/{repo}/git/commits');
    expect(calls[4]!.route).toBe('POST /repos/{owner}/{repo}/git/refs');

    // Tree uses base_tree from main.
    const treeCall = calls[2]!;
    expect((treeCall.params as { base_tree: string }).base_tree).toBe('main-tree-sha');

    // Commit uses main tip as parent.
    const commitCall = calls[3]!;
    expect((commitCall.params as { parents: string[] }).parents).toEqual(['main-commit-sha']);

    // Ref uses the branch name.
    const refCall = calls[4]!;
    expect((refCall.params as { ref: string }).ref).toBe('refs/heads/sdd/scaffold-abc123');
  });
});

describe('upsertScaffoldPull', () => {
  const baseInput = (): UpsertScaffoldPullInput => ({
    target: { owner: 'acme', repo: 'demo' },
    headBranch: 'sdd/scaffold-abc123',
    baseBranch: 'main',
    title: 'sdd-scaffold: backend',
    body: 'body',
    teamReviewers: ['backend-team', 'web-team'],
  });

  it('reuses existing open PR without creating a new one', async () => {
    const { octokit, calls } = createFakeOctokit({
      'GET /repos/{owner}/{repo}/pulls': () => [
        { number: 42, head: { sha: 'existing-sha' }, html_url: 'https://example/42' },
      ],
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers': () => ({}),
    });

    const result = await upsertScaffoldPull(octokit, baseInput());

    expect(result.number).toBe(42);
    expect(result.created).toBe(false);
    // No PR create call — only the reviewers request.
    expect(calls.length).toBe(2);
    expect(calls[1]!.route).toBe(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers',
    );
    // team_reviewers is used (D23), not reviewers.
    const reviewersCall = calls[1]!.params as { team_reviewers: string[] };
    expect(reviewersCall.team_reviewers).toEqual(['backend-team', 'web-team']);
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
    // GET + POST (create) + POST (reviewers).
    expect(calls.length).toBe(3);
    expect(calls[1]!.route).toBe('POST /repos/{owner}/{repo}/pulls');
  });
});
