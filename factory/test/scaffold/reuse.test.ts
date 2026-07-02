import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/resolve.js';
import { inspectScaffoldReuse } from '../../src/scaffold/reuse.js';
import type { PullCandidate, ScaffoldReadPort, TreeEntry } from '../../src/scaffold/types.js';

const target = { owner: 'acme', repo: 'demo' };
const branchName = 'sdd/scaffold-abc';
const content = new TextEncoder().encode('expected\n');
const expectedFiles = [
  { path: 'README.md', mode: '100644' as const, output_sha256: sha256Hex(content) },
];

function pull(state: PullCandidate['state'] = 'open'): PullCandidate {
  return {
    number: 42,
    state,
    headSha: 'pr-head',
    baseRef: 'main',
    baseRepoOwner: 'acme',
    baseRepoName: 'demo',
    headRef: branchName,
    headRepoOwner: 'acme',
    headRepoName: 'demo',
  };
}

function fixture(options: {
  candidate?: PullCandidate | null;
  branchSha?: string | null;
  blob?: Uint8Array;
}) {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const entries: TreeEntry[] = [
    { path: 'apps/backend/README.md', mode: '100644', type: 'blob', sha: 'blob-1' },
  ];
  const reader = {
    async findPullByHead() {
      return options.candidate ?? null;
    },
    async readTreeRecursive() {
      return entries;
    },
    async readBlobContent() {
      return options.blob ?? content;
    },
    async resolveCommit() {
      throw new Error('unused');
    },
    async readTemplateTree() {
      throw new Error('unused');
    },
    async observeProduct() {
      throw new Error('unused');
    },
  } as ScaffoldReadPort;
  const octokit = {
    async request(route: string, params: Record<string, unknown> = {}) {
      calls.push({ route, params });
      if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
        if (options.branchSha === null || options.branchSha === undefined) {
          throw Object.assign(new Error('not found'), { status: 404 });
        }
        return { object: { sha: options.branchSha } };
      }
      if (route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}') {
        return { tree: { sha: 'tree-1' } };
      }
      throw new Error(`unexpected route ${route}`);
    },
  };
  return { reader, octokit, calls };
}

const components = [{ path: 'apps/backend', expectedFiles }];

describe('inspectScaffoldReuse (D20/D25)', () => {
  it('returns new when neither branch nor PR exists', async () => {
    const f = fixture({ branchSha: null });
    await expect(inspectScaffoldReuse({ ...f, target, branchName, components })).resolves.toEqual({
      kind: 'new',
    });
  });

  it('verifies an orphaned branch and resumes PR creation', async () => {
    const f = fixture({ branchSha: 'branch-head' });
    await expect(inspectScaffoldReuse({ ...f, target, branchName, components })).resolves.toEqual({
      kind: 'resume-without-pr',
      headSha: 'branch-head',
    });
  });

  it('uses the identity-checked PR head SHA and reuses an open PR', async () => {
    const candidate = pull('open');
    const f = fixture({ candidate, branchSha: 'different-branch-read' });
    await expect(inspectScaffoldReuse({ ...f, target, branchName, components })).resolves.toEqual({
      kind: 'reuse-open-pr',
      pull: candidate,
    });
    const commitRead = f.calls.find(
      (call) => call.route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
    );
    expect(commitRead?.params.commit_sha).toBe('pr-head');
    expect(f.calls.some((call) => call.route.includes('/git/ref/'))).toBe(false);
  });

  it('returns conflict when existing content was tampered', async () => {
    const f = fixture({ branchSha: 'branch-head', blob: new TextEncoder().encode('tampered') });
    const result = await inspectScaffoldReuse({ ...f, target, branchName, components });
    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') expect(result.reason).toContain('content hash mismatch');
  });

  it('returns conflict before content reads for a mismatched PR identity', async () => {
    const candidate = { ...pull('open'), headRepoOwner: 'attacker' };
    const f = fixture({ candidate, branchSha: 'branch-head' });
    const result = await inspectScaffoldReuse({ ...f, target, branchName, components });
    expect(result.kind).toBe('conflict');
    expect(f.calls.some((call) => call.route.includes('/git/commits/'))).toBe(false);
  });

  it('returns blocked for a closed unmerged PR after content verification', async () => {
    const f = fixture({ candidate: pull('closed'), branchSha: 'branch-head' });
    const result = await inspectScaffoldReuse({ ...f, target, branchName, components });
    expect(result.kind).toBe('blocked');
  });

  it('returns conflict for an unexpectedly merged candidate', async () => {
    const f = fixture({ candidate: pull('merged'), branchSha: 'branch-head' });
    const result = await inspectScaffoldReuse({ ...f, target, branchName, components });
    expect(result.kind).toBe('conflict');
  });
});
