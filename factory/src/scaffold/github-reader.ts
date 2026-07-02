import { createReadonlyGitHubPort } from '../github-read.js';
import type { RepoRef } from '../types.js';
import type { ScaffoldReadPort, TreeEntry } from './types.js';

export interface ScaffoldGitHubClient {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

export function createOctokitScaffoldReadPort(octokit: ScaffoldGitHubClient): ScaffoldReadPort {
  const templates = createReadonlyGitHubPort(octokit);
  return {
    resolveCommit: (repo, ref) => templates.resolveCommit(repo, ref),
    readTemplateTree: (repo, commit, templateName) =>
      templates.readTemplateTree(repo, commit, `templates/${templateName}`),
    async observeProduct() {
      throw new Error('observeProduct is not supported by the scaffold integrity reader');
    },
    async readBlobContent(repo, blobSha) {
      const response = (await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{blob_sha}', {
        owner: repo.owner,
        repo: repo.repo,
        blob_sha: blobSha,
      })) as { content?: string; encoding?: string };
      if (response.content === undefined) throw new Error(`blob not found: ${blobSha}`);
      return new Uint8Array(
        response.encoding === 'base64'
          ? Buffer.from(response.content, 'base64')
          : Buffer.from(response.content, 'utf8'),
      );
    },
    async readTreeRecursive(repo, treeSha): Promise<TreeEntry[]> {
      const response = (await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
        owner: repo.owner,
        repo: repo.repo,
        tree_sha: treeSha,
        recursive: '1',
      })) as { tree?: Array<{ path: string; mode: string; type: string; sha: string }> };
      if (!response.tree) throw new Error(`tree not found: ${treeSha}`);
      return response.tree.map((entry) => ({
        path: entry.path,
        mode: entry.mode as TreeEntry['mode'],
        type: entry.type as TreeEntry['type'],
        sha: entry.sha,
      }));
    },
    async findPullByHead(repo: RepoRef, headBranch: string) {
      const pulls = (await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner: repo.owner,
        repo: repo.repo,
        head: `${repo.owner}:${headBranch}`,
        state: 'all',
        per_page: 100,
      })) as Array<{
        number: number;
        state: 'open' | 'closed';
        merged_at?: string | null;
        head: { sha: string; ref: string; repo: { owner: { login: string }; name: string } };
        base: { ref: string; repo: { owner: { login: string }; name: string } };
      }>;
      if (pulls.length === 0) return null;
      if (pulls.length !== 1) throw new Error(`multiple pull requests found for '${headBranch}'`);
      const pull = pulls[0];
      if (!pull) return null;
      return {
        number: pull.number,
        state: pull.merged_at ? 'merged' : pull.state,
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        baseRepoOwner: pull.base.repo.owner.login,
        baseRepoName: pull.base.repo.name,
        headRef: pull.head.ref,
        headRepoOwner: pull.head.repo.owner.login,
        headRepoName: pull.head.repo.name,
      };
    },
  };
}
