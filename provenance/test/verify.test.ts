import { describe, expect, it } from 'vitest';
import type {
  CheckRun,
  CodeownersEntry,
  GitReader,
  OctokitLike,
  PullData,
  PullFile,
  PullReview,
  VerifyInput,
} from '../src/types.js';
import { verifyGateApproval } from '../src/verify.js';

// --- Fake builders ---

function fakePr(overrides: Partial<PullData> = {}): PullData {
  return {
    number: 1,
    state: 'closed',
    merged: true,
    merge_commit_sha: 'merge111',
    head: { sha: 'head111', ref: 'gate/spec-v1' },
    base: { ref: 'main', sha: 'base111' },
    labels: [{ name: 'gate:spec' }, { name: 'version:v1' }],
    merged_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function fakeReview(overrides: Partial<PullReview> = {}): PullReview {
  return {
    id: 1,
    user: { login: 'codeowner' },
    state: 'APPROVED',
    commit_id: 'head111',
    author_association: 'MEMBER',
    submitted_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function fakeFile(overrides: Partial<PullFile> = {}): PullFile {
  return {
    filename: 'projects.yaml',
    status: 'added',
    sha: 'blob111',
    ...overrides,
  };
}

function fakeCheck(overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 1,
    name: 'Contract Gate',
    head_sha: 'head111',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function fakeGit(overrides: Partial<GitReader> = {}): GitReader {
  return {
    blobAt: async (_commit, _path) => 'local-blob-sha',
    blobWorktree: async (_path) => 'local-blob-sha',
    isClean: async (_path) => true,
    codeownersAt: async (_commit) => [{ pattern: '/projects.yaml', owners: ['@codeowner'] }],
    ...overrides,
  };
}

function fakeOctokit(
  overrides: {
    pr?: Partial<PullData>;
    reviews?: PullReview[];
    files?: PullFile[];
    branchProtected?: boolean;
    checks?: CheckRun[];
    prsForCommit?: PullData[];
    throwOn?: string;
  } = {},
): OctokitLike {
  const pr = fakePr(overrides.pr);
  const reviews = overrides.reviews ?? [fakeReview()];
  const files = overrides.files ?? [fakeFile()];
  const branchProtected = overrides.branchProtected ?? true;
  const checks = overrides.checks ?? [];
  const prsForCommit = overrides.prsForCommit ?? [pr];

  return {
    rest: {
      pulls: {
        get: async () => ({ data: pr }),
        listReviews: async () => ({ data: reviews }),
        listFiles: async () => ({ data: files }),
      },
      repos: {
        getBranch: async () => ({
          data: {
            name: 'main',
            protected: branchProtected,
            commit: { sha: 'basesha' },
          },
        }),
        listCommitStatusesForRef: async () => ({
          data: { statuses: [] },
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: prsForCommit,
        }),
      },
      checks: {
        listForRef: async () => ({ data: { check_runs: checks } }),
      },
    },
  } as OctokitLike;
}

function baseInput(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return {
    octokit: fakeOctokit(),
    git: fakeGit(),
    repo: { owner: 'demo-org', name: 'demo-product' },
    gate: 'spec',
    version: 'v1',
    approval: { pr: 1 },
    artifactPath: 'projects.yaml',
    ...overrides,
  };
}

// --- Tests ---

describe('verifyGateApproval', () => {
  it('returns ok for a properly approved PR', async () => {
    const result = await verifyGateApproval(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.gate).toBe('spec');
      expect(result.provenance.version).toBe('v1');
      expect(result.provenance.pr).toBe(1);
      expect(result.provenance.approved_head_sha).toBe('head111');
      expect(result.provenance.merge_commit_sha).toBe('merge111');
    }
  });

  it('resolves PR by merge commit SHA', async () => {
    const pr = fakePr();
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({ prsForCommit: [pr] }),
        approval: { mergeCommitSha: 'merge111' },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when PR is not merged', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({ pr: { merged: false, merge_commit_sha: null } }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not merged/);
    }
  });

  it('fails when PR does not target main', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({ pr: { base: { ref: 'develop', sha: 'b' } } }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/targets 'develop'/);
    }
  });

  it('fails when main is not protected', async () => {
    const result = await verifyGateApproval(
      baseInput({ octokit: fakeOctokit({ branchProtected: false }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not protected/);
    }
  });

  it('fails when approval is not from a CODEOWNER', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          reviews: [fakeReview({ user: { login: 'outsider' } })],
        }),
        git: fakeGit({
          codeownersAt: async () => [{ pattern: '/projects.yaml', owners: ['@actual-owner'] }],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/CODEOWNER/);
    }
  });

  it('fails when approval is stale (commit_id does not match head SHA)', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          reviews: [fakeReview({ commit_id: 'old-sha', state: 'APPROVED' })],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no approval/);
    }
  });

  it('fails when gate label conflicts', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          pr: {
            labels: [{ name: 'gate:architecture' }, { name: 'version:v1' }],
          },
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/gate:architecture/);
    }
  });

  it('fails when version label conflicts', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          pr: {
            labels: [{ name: 'gate:spec' }, { name: 'version:v2' }],
          },
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/version:v2/);
    }
  });

  it('fails when artifact is not in PR changed files (only in merge tree)', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          files: [fakeFile({ filename: 'specs/v1/spec.md' })],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not in PR.*changed files/);
    }
  });

  it('fails when artifact was removed in PR', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          files: [fakeFile({ filename: 'projects.yaml', status: 'removed' })],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/removed/);
    }
  });

  it('fails when local blob does not match PR blob', async () => {
    const result = await verifyGateApproval(
      baseInput({
        git: fakeGit({
          blobAt: async () => 'remote-blob',
          blobWorktree: async () => 'different-local-blob',
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not match/);
    }
  });

  it('fails when worktree is dirty', async () => {
    const result = await verifyGateApproval(
      baseInput({
        git: fakeGit({
          isClean: async () => false,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/dirty/);
    }
  });

  it('fails closed on API error', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: {
          rest: {
            pulls: {
              get: async () => {
                throw new Error('rate limit');
              },
              listReviews: async () => ({ data: [] }),
              listFiles: async () => ({ data: [] }),
            },
            repos: {
              getBranch: async () => ({
                data: { name: 'main', protected: true, commit: { sha: 'b' } },
              }),
              listCommitStatusesForRef: async () => ({
                data: { statuses: [] },
              }),
              listPullRequestsAssociatedWithCommit: async () => ({
                data: [],
              }),
            },
            checks: {
              listForRef: async () => ({ data: { check_runs: [] } }),
            },
          },
        } as OctokitLike,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/API error/);
    }
  });

  it('returns no required_checks for non-contract gates', async () => {
    const result = await verifyGateApproval(baseInput({ gate: 'spec' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.required_checks).toEqual([]);
    }
  });
});

describe('verifyGateApproval - Contract Gate', () => {
  it('succeeds with Contract Gate check success at current head SHA', async () => {
    const result = await verifyGateApproval(
      baseInput({
        gate: 'contract',
        octokit: fakeOctokit({
          pr: {
            labels: [{ name: 'gate:contract' }, { name: 'version:v1' }],
          },
          checks: [fakeCheck()],
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.required_checks).toHaveLength(1);
      expect(result.provenance.required_checks[0]?.name).toBe('Contract Gate');
      expect(result.provenance.required_checks[0]?.conclusion).toBe('success');
    }
  });

  it('fails when Contract Gate check is missing', async () => {
    const result = await verifyGateApproval(
      baseInput({
        gate: 'contract',
        octokit: fakeOctokit({
          pr: {
            labels: [{ name: 'gate:contract' }, { name: 'version:v1' }],
          },
          checks: [],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Contract Gate check not found/);
    }
  });

  it('fails when Contract Gate check is for old SHA', async () => {
    const result = await verifyGateApproval(
      baseInput({
        gate: 'contract',
        octokit: fakeOctokit({
          pr: {
            labels: [{ name: 'gate:contract' }, { name: 'version:v1' }],
          },
          checks: [fakeCheck({ head_sha: 'old-sha' })],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/different head SHA|not found/);
    }
  });

  it('fails when Contract Gate check is skipped', async () => {
    const result = await verifyGateApproval(
      baseInput({
        gate: 'contract',
        octokit: fakeOctokit({
          pr: {
            labels: [{ name: 'gate:contract' }, { name: 'version:v1' }],
          },
          checks: [fakeCheck({ conclusion: 'skipped' })],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/skipped/);
    }
  });

  it('fails when Contract Gate check is failure', async () => {
    const result = await verifyGateApproval(
      baseInput({
        gate: 'contract',
        octokit: fakeOctokit({
          pr: {
            labels: [{ name: 'gate:contract' }, { name: 'version:v1' }],
          },
          checks: [fakeCheck({ conclusion: 'failure' })],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/failure/);
    }
  });

  it('fails when Contract Gate check is cancelled', async () => {
    const result = await verifyGateApproval(
      baseInput({
        gate: 'contract',
        octokit: fakeOctokit({
          pr: {
            labels: [{ name: 'gate:contract' }, { name: 'version:v1' }],
          },
          checks: [fakeCheck({ conclusion: 'cancelled' })],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cancelled/);
    }
  });
});

describe('verifyGateApproval - API pagination', () => {
  it('paginates through listFiles to find artifact', async () => {
    // Build 150 fake files across 2 pages
    const page1: PullFile[] = [];
    for (let i = 0; i < 100; i++) {
      page1.push(fakeFile({ filename: `file-${i}.md`, status: 'modified' }));
    }
    const page2: PullFile[] = [fakeFile({ filename: 'projects.yaml', status: 'added' })];
    let callCount = 0;
    const octokit = fakeOctokit();
    (octokit.rest.pulls.listFiles as unknown) = async (params: { page?: number }) => {
      callCount++;
      if ((params.page ?? 1) === 1) return { data: page1 };
      return { data: page2 };
    };
    const result = await verifyGateApproval(baseInput({ octokit }));
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it('paginates through listReviews to find approval', async () => {
    const page1: PullReview[] = [];
    for (let i = 0; i < 100; i++) {
      page1.push(
        fakeReview({
          id: i,
          user: { login: `user-${i}` },
          state: 'COMMENTED',
        }),
      );
    }
    const page2: PullReview[] = [fakeReview()];
    const octokit = fakeOctokit();
    (octokit.rest.pulls.listReviews as unknown) = async (params: { page?: number }) => {
      if ((params.page ?? 1) === 1) return { data: page1 };
      return { data: page2 };
    };
    const result = await verifyGateApproval(baseInput({ octokit }));
    expect(result.ok).toBe(true);
  });

  it('paginates through check runs', async () => {
    const page1: CheckRun[] = [];
    for (let i = 0; i < 100; i++) {
      page1.push(fakeCheck({ id: i, name: `check-${i}` }));
    }
    const page2: CheckRun[] = [fakeCheck()];
    const octokit = fakeOctokit({
      pr: {
        labels: [{ name: 'gate:contract' }, { name: 'version:v1' }],
      },
    });
    (octokit.rest.checks.listForRef as unknown) = async (params: { page?: number }) => {
      if ((params.page ?? 1) === 1) return { data: { check_runs: page1 } };
      return { data: { check_runs: page2 } };
    };
    const result = await verifyGateApproval(baseInput({ gate: 'contract', octokit }));
    expect(result.ok).toBe(true);
  });
});
