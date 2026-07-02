import type { CodeownersEntry, GitReader, OctokitLike } from '@sdd/provenance';

export interface ProvenanceGitHubClient {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

export function parseCodeowners(content: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern && owners.length > 0) entries.push({ pattern, owners });
  }
  return entries;
}

export function createProvenanceOctokit(octokit: ProvenanceGitHubClient): OctokitLike {
  const wrapped = async <T>(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data: T }> => ({ data: (await octokit.request(route, parameters)) as T });
  return {
    rest: {
      pulls: {
        get: (p) => wrapped('GET /repos/{owner}/{repo}/pulls/{pull_number}', p),
        listReviews: (p) => wrapped('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', p),
        listFiles: (p) => wrapped('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', p),
      },
      repos: {
        getBranch: (p) => wrapped('GET /repos/{owner}/{repo}/branches/{branch}', p),
        listPullRequestsAssociatedWithCommit: (p) =>
          wrapped('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', p),
        getCollaboratorPermissionLevel: (p) =>
          wrapped('GET /repos/{owner}/{repo}/collaborators/{username}/permission', p),
      },
      checks: {
        listForRef: (p) => wrapped('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', p),
      },
      teams: {
        getByName: (p) => wrapped('GET /orgs/{org}/teams/{team_slug}', p),
        checkPermissionsForRepoInOrg: (p) =>
          wrapped('GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}', p),
        listMembersInOrg: (p) => wrapped('GET /orgs/{org}/teams/{team_slug}/members', p),
      },
    },
  };
}

export function createRemoteGitReader(
  octokit: ProvenanceGitHubClient,
  repo: { owner: string; repo: string },
): GitReader {
  const contentAt = async (
    ref: string,
    path: string,
  ): Promise<{ sha: string; content: Buffer }> => {
    const response = (await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner,
      repo: repo.repo,
      path,
      ref,
    })) as { sha?: string; content?: string; encoding?: string };
    if (!response.sha) throw new Error(`GitHub content '${path}' at '${ref}' has no blob SHA`);
    if (response.content === undefined) throw new Error(`${path} at ${ref} was not found`);
    return {
      sha: response.sha,
      content:
        response.encoding === 'base64'
          ? Buffer.from(response.content, 'base64')
          : Buffer.from(response.content, 'utf8'),
    };
  };
  return {
    async blobAt(commit, path) {
      return (await contentAt(commit, path)).sha;
    },
    async blobWorktree(path) {
      return (await contentAt('main', path)).sha;
    },
    async isClean() {
      return true;
    },
    async codeownersAt(commit) {
      try {
        return parseCodeowners(
          (await contentAt(commit, '.github/CODEOWNERS')).content.toString('utf8'),
        );
      } catch (error) {
        if ((error as { status?: number }).status === 404) return [];
        throw error;
      }
    },
  };
}
