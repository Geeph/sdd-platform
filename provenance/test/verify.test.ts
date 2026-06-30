import { describe, expect, it } from 'vitest';
import type {
  CheckRun,
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
    // CODEOWNERS is evaluated at base commit; default returns a rule
    // that matches projects.yaml with @codeowner as the owner.
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
    teamMembers?: Record<string, string[]>;
    teamPrivacy?: Record<string, string>;
    teamHasWrite?: Record<string, boolean>;
    userPermissions?: Record<string, string>;
    throwOn?: string;
  } = {},
): OctokitLike {
  const pr = fakePr(overrides.pr);
  const reviews = overrides.reviews ?? [fakeReview()];
  const files = overrides.files ?? [fakeFile()];
  const branchProtected = overrides.branchProtected ?? true;
  const checks = overrides.checks ?? [];
  const prsForCommit = overrides.prsForCommit ?? [pr];
  const teamMembers = overrides.teamMembers ?? {};
  const teamPrivacy = overrides.teamPrivacy ?? {};
  const teamHasWrite = overrides.teamHasWrite ?? {};
  const userPermissions = overrides.userPermissions ?? {};

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
        getCollaboratorPermissionLevel: async (params: { username: string }) => ({
          data: {
            permission: userPermissions[params.username] ?? 'write',
            role_name: userPermissions[params.username] ?? 'write',
          },
        }),
      },
      checks: {
        listForRef: async () => ({ data: { check_runs: checks } }),
      },
      teams: {
        getByName: async (params: { org: string; team_slug: string }) => ({
          data: {
            id: 1,
            slug: params.team_slug,
            privacy: teamPrivacy[`${params.org}/${params.team_slug}`] ?? 'closed',
          },
        }),
        checkPermissionsForRepoInOrg: async (params: { org: string; team_slug: string }) => ({
          data: {
            permissions: {
              admin: false,
              pull: true,
              push: teamHasWrite[`${params.org}/${params.team_slug}`] ?? true,
            },
          },
        }),
        listMembersInOrg: async (params: { org: string; team_slug: string }) => ({
          data: (teamMembers[`${params.org}/${params.team_slug}`] ?? []).map((login) => ({
            login,
          })),
        }),
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
      expect(result.provenance.authorization_policy).toBe('current-codeowners');
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
      expect(result.reason).toMatch(/CODEOWNER/);
    }
  });

  it('resolves @org/team owners to their team members', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          reviews: [fakeReview({ user: { login: 'team-member' } })],
          teamMembers: { 'demo-org/spec-approvers': ['team-member'] },
        }),
        git: fakeGit({
          codeownersAt: async () => [
            { pattern: '/projects.yaml', owners: ['@demo-org/spec-approvers'] },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects team member who is not currently in the team', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          reviews: [fakeReview({ user: { login: 'former-member' } })],
          teamMembers: { 'demo-org/spec-approvers': ['other-member'] },
        }),
        git: fakeGit({
          codeownersAt: async () => [
            { pattern: '/projects.yaml', owners: ['@demo-org/spec-approvers'] },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/CODEOWNER/);
    }
  });

  it('rejects a plain user CODEOWNER without current write permission', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({ userPermissions: { codeowner: 'read' } }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no resolvable owners/);
  });

  it('rejects a CODEOWNER team from a different organization', async () => {
    const result = await verifyGateApproval(
      baseInput({
        git: fakeGit({
          codeownersAt: async () => [
            { pattern: '/projects.yaml', owners: ['@other-org/spec-approvers'] },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no resolvable owners/);
  });

  it('rejects a secret CODEOWNER team', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          teamMembers: { 'demo-org/spec-approvers': ['codeowner'] },
          teamPrivacy: { 'demo-org/spec-approvers': 'secret' },
        }),
        git: fakeGit({
          codeownersAt: async () => [
            { pattern: '/projects.yaml', owners: ['@demo-org/spec-approvers'] },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no resolvable owners/);
  });

  it('rejects a CODEOWNER team without write permission', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          teamMembers: { 'demo-org/spec-approvers': ['codeowner'] },
          teamHasWrite: { 'demo-org/spec-approvers': false },
        }),
        git: fakeGit({
          codeownersAt: async () => [
            { pattern: '/projects.yaml', owners: ['@demo-org/spec-approvers'] },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no resolvable owners/);
  });

  it('uses only the last matching CODEOWNERS rule (last-match-wins)', async () => {
    // First rule assigns @first-owner, second rule overrides to @second-owner.
    // If approval is from @first-owner only, it must be rejected because the
    // effective owner is @second-owner.
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          reviews: [fakeReview({ user: { login: 'first-owner' } })],
        }),
        git: fakeGit({
          codeownersAt: async () => [
            { pattern: '/projects.yaml', owners: ['@first-owner'] },
            { pattern: '*.yaml', owners: ['@second-owner'] },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/CODEOWNER/);
    }
  });

  it('fails when approval is later revoked by the same reviewer', async () => {
    // Same reviewer first APPROVED, then CHANGES_REQUESTED — latest state wins.
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          reviews: [
            fakeReview({
              id: 1,
              state: 'APPROVED',
              submitted_at: '2026-06-01T00:00:00Z',
            }),
            fakeReview({
              id: 2,
              state: 'CHANGES_REQUESTED',
              submitted_at: '2026-06-01T01:00:00Z',
            }),
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/CODEOWNER/);
    }
  });

  it('does not treat a later comment as revoking an approval', async () => {
    const result = await verifyGateApproval(
      baseInput({
        octokit: fakeOctokit({
          reviews: [
            fakeReview({ id: 1, state: 'APPROVED', submitted_at: '2026-06-01T00:00:00Z' }),
            fakeReview({ id: 2, state: 'COMMENTED', submitted_at: '2026-06-01T01:00:00Z' }),
          ],
        }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('reads CODEOWNERS at base commit, not head', async () => {
    // Git reader must be called with the PR's base.sha, not head.sha.
    let codeownersCommit = '';
    const result = await verifyGateApproval(
      baseInput({
        git: fakeGit({
          codeownersAt: async (commit) => {
            codeownersCommit = commit;
            return [{ pattern: '/projects.yaml', owners: ['@codeowner'] }];
          },
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(codeownersCommit).toBe('base111'); // pr.base.sha, NOT 'head111'
  });

  it('accepts approval for any artifact path via the matching CODEOWNERS rule', async () => {
    // Verify that the CODEOWNERS matching uses the artifact path, not
    // a hardcoded file. The default fake CODEOWNERS matches projects.yaml.
    const result = await verifyGateApproval(
      baseInput({
        artifactPath: 'projects.yaml',
        octokit: fakeOctokit({
          files: [fakeFile({ filename: 'projects.yaml', status: 'added' })],
        }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('matches a slashless CODEOWNERS pattern at nested paths', async () => {
    const artifactPath = 'specs/v1/spec.md';
    const result = await verifyGateApproval(
      baseInput({
        artifactPath,
        octokit: fakeOctokit({
          files: [fakeFile({ filename: artifactPath, status: 'added' })],
        }),
        git: fakeGit({
          codeownersAt: async () => [{ pattern: '*.md', owners: ['@codeowner'] }],
        }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when no CODEOWNERS rule matches the artifact path', async () => {
    const result = await verifyGateApproval(
      baseInput({
        artifactPath: 'specs/v1/spec.md',
        octokit: fakeOctokit({
          files: [fakeFile({ filename: 'specs/v1/spec.md', status: 'added' })],
        }),
        git: fakeGit({
          // Only rule is for projects.yaml; won't match spec.md
          codeownersAt: async () => [{ pattern: '/projects.yaml', owners: ['@codeowner'] }],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no CODEOWNERS rule matches/);
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
              getCollaboratorPermissionLevel: async () => ({
                data: { permission: 'write' },
              }),
            },
            checks: {
              listForRef: async () => ({ data: { check_runs: [] } }),
            },
            teams: {
              getByName: async () => ({ data: { id: 1, slug: 't', privacy: 'closed' } }),
              checkPermissionsForRepoInOrg: async () => ({
                data: { permissions: { admin: false, pull: true, push: true } },
              }),
              listMembersInOrg: async () => ({ data: [] }),
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

  it('paginates through team members', async () => {
    const octokit = fakeOctokit({
      reviews: [fakeReview({ user: { login: 'codeowner' } })],
    });
    (octokit.rest.teams.listMembersInOrg as unknown) = async (params: { page?: number }) => ({
      data:
        (params.page ?? 1) === 1
          ? Array.from({ length: 100 }, (_, i) => ({ login: `member-${i}` }))
          : [{ login: 'codeowner' }],
    });
    const result = await verifyGateApproval(
      baseInput({
        octokit,
        git: fakeGit({
          codeownersAt: async () => [
            { pattern: '/projects.yaml', owners: ['@demo-org/spec-approvers'] },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(true);
  });
});
