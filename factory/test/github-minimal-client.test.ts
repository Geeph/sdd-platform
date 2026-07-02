/**
 * github-minimal-client.test.ts — tests for shared GitHub helpers (M4, D16/D22).
 *
 * Covers:
 *   - fetchChangedFiles count verification (D22): mismatch → throw
 *   - fetchBlobAtRef: 404 → null, other errors → throw
 *   - fetchPullRequest: validates required fields
 *   - fetchChangedFiles: rename previous_filename → previousPath (D19)
 */

import { describe, expect, it } from 'vitest';
import type { MinimalOctokit } from '../src/github-minimal-client.js';
import {
  fetchBlobAtRef,
  fetchChangedFiles,
  fetchPullRequest,
} from '../src/github-minimal-client.js';

function makeOctokit(routes: Record<string, unknown>): MinimalOctokit {
  return {
    async request(route: string, params: Record<string, unknown> = {}) {
      const key = `${route}:${JSON.stringify(params)}`;
      if (key in routes) {
        const val = routes[key];
        if (val instanceof Error) throw val;
        return val;
      }
      // Try route prefix match.
      for (const [pattern, response] of Object.entries(routes)) {
        if (route === pattern.split(':')[0]) {
          if (response instanceof Error) throw response;
          return response;
        }
      }
      throw new Error(`unmocked: ${route}`);
    },
  };
}

describe('fetchPullRequest', () => {
  it('returns required fields', async () => {
    const octokit = makeOctokit({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': {
        base: { sha: 'aaa', ref: 'main', repo: { full_name: 'acme/demo' } },
        head: { sha: 'bbb', ref: 'feature', repo: { full_name: 'acme/demo' } },
        labels: [{ name: 'platform:ios' }],
        changed_files: 5,
        number: 42,
      },
    });

    const pr = await fetchPullRequest(octokit, { owner: 'acme', repo: 'demo' }, 42);
    expect(pr.base.sha).toBe('aaa');
    expect(pr.head.sha).toBe('bbb');
    expect(pr.labels).toEqual([{ name: 'platform:ios' }]);
    expect(pr.changed_files).toBe(5);
  });

  it('throws if base.sha is missing', async () => {
    const octokit = makeOctokit({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': {
        base: { ref: 'main', repo: { full_name: 'acme/demo' } },
        head: { sha: 'bbb', ref: 'feature', repo: { full_name: 'acme/demo' } },
        labels: [],
        changed_files: 1,
      },
    });

    await expect(fetchPullRequest(octokit, { owner: 'acme', repo: 'demo' }, 42)).rejects.toThrow(
      /missing base\.sha/,
    );
  });
});

describe('fetchChangedFiles (D22)', () => {
  it('returns files when count matches', async () => {
    const octokit: MinimalOctokit = {
      async request(route: string, params: Record<string, unknown> = {}) {
        if (params.page === 1) {
          return [
            { filename: 'a.java', status: 'modified', additions: 1, deletions: 0 },
            { filename: 'b.java', status: 'added', additions: 10, deletions: 0 },
          ];
        }
        return [];
      },
    };

    const files = await fetchChangedFiles(
      octokit,
      { owner: 'acme', repo: 'demo' },
      42,
      2, // expected count
    );
    expect(files).toHaveLength(2);
    expect(files[0].filename).toBe('a.java');
    expect(files[1].status).toBe('added');
  });

  it('throws when count mismatch (D22 — GitHub 3000 hard limit scenario)', async () => {
    const octokit: MinimalOctokit = {
      async request() {
        // Simulate GitHub returning only 3000 when PR says 5000.
        return Array.from({ length: 3000 }, (_, i) => ({
          filename: `file${i}.java`,
          status: 'modified',
          additions: 1,
          deletions: 0,
        }));
      },
    };

    await expect(
      fetchChangedFiles(octokit, { owner: 'acme', repo: 'demo' }, 42, 5000),
    ).rejects.toThrow(/count mismatch/);
  });

  it('captures previous_filename for renamed files (D19)', async () => {
    const octokit: MinimalOctokit = {
      async request() {
        return [
          {
            filename: 'new/path.java',
            status: 'renamed',
            previous_filename: 'old/path.java',
            additions: 0,
            deletions: 0,
          },
        ];
      },
    };

    const files = await fetchChangedFiles(octokit, { owner: 'acme', repo: 'demo' }, 42, 1);
    expect(files[0].status).toBe('renamed');
    expect(files[0].previous_filename).toBe('old/path.java');
  });
});

describe('fetchBlobAtRef', () => {
  it('returns content for existing file', async () => {
    const octokit: MinimalOctokit = {
      async request() {
        return { content: 'hello world', encoding: 'raw' };
      },
    };

    const content = await fetchBlobAtRef(
      octokit,
      { owner: 'acme', repo: 'demo' },
      'README.md',
      'main',
    );
    expect(content).toBe('hello world');
  });

  it('returns null for 404 (file not found)', async () => {
    const octokit: MinimalOctokit = {
      async request() {
        const err = new Error('not found') as Error & { status: number };
        err.status = 404;
        throw err;
      },
    };

    const content = await fetchBlobAtRef(
      octokit,
      { owner: 'acme', repo: 'demo' },
      'missing.md',
      'main',
    );
    expect(content).toBeNull();
  });

  it('throws for non-404 errors', async () => {
    const octokit: MinimalOctokit = {
      async request() {
        const err = new Error('forbidden') as Error & { status: number };
        err.status = 403;
        throw err;
      },
    };

    await expect(
      fetchBlobAtRef(octokit, { owner: 'acme', repo: 'demo' }, 'README.md', 'main'),
    ).rejects.toThrow(/forbidden/);
  });
});
