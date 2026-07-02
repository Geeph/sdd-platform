import type { RepoRef } from '../types.js';
import type { ExpectedFile } from './subtree.js';
import { verifyComponentSubtree } from './subtree.js';
import type { PullCandidate, ScaffoldReadPort } from './types.js';

export interface ScaffoldReuseClient {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

export interface ExpectedComponentSubtree {
  path: string;
  expectedFiles: ReadonlyArray<ExpectedFile>;
}

export type ScaffoldReuseState =
  | { kind: 'new' }
  | { kind: 'resume-without-pr'; headSha: string }
  | { kind: 'reuse-open-pr'; pull: PullCandidate }
  | { kind: 'blocked'; reason: string }
  | { kind: 'conflict'; reason: string };

export async function inspectScaffoldReuse(input: {
  octokit: ScaffoldReuseClient;
  reader: ScaffoldReadPort;
  target: RepoRef;
  branchName: string;
  components: ReadonlyArray<ExpectedComponentSubtree>;
}): Promise<ScaffoldReuseState> {
  let pull: PullCandidate | null;
  try {
    pull = await input.reader.findPullByHead(input.target, input.branchName);
  } catch (error) {
    return { kind: 'conflict', reason: (error as Error).message };
  }

  if (pull) {
    const targetOwner = input.target.owner.toLowerCase();
    const targetRepo = input.target.repo.toLowerCase();
    if (
      pull.baseRepoOwner.toLowerCase() !== targetOwner ||
      pull.baseRepoName.toLowerCase() !== targetRepo ||
      pull.baseRef !== 'main' ||
      pull.headRepoOwner.toLowerCase() !== targetOwner ||
      pull.headRepoName.toLowerCase() !== targetRepo ||
      pull.headRef !== input.branchName
    ) {
      return {
        kind: 'conflict',
        reason: `candidate PR #${pull.number} does not match ${input.target.owner}/${input.target.repo}:${input.branchName} -> main`,
      };
    }
  }

  let branchHeadSha: string | undefined;
  if (!pull) {
    try {
      const branch = (await input.octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: input.target.owner,
        repo: input.target.repo,
        ref: `heads/${input.branchName}`,
      })) as { object?: { sha?: string } };
      branchHeadSha = branch.object?.sha;
      if (!branchHeadSha) throw new Error(`branch '${input.branchName}' has no commit SHA`);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }

  if (!pull && !branchHeadSha) return { kind: 'new' };
  const headSha = pull?.headSha ?? branchHeadSha;
  if (!headSha) return { kind: 'conflict', reason: 'existing scaffold state has no head SHA' };

  const commit = (await input.octokit.request(
    'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
    {
      owner: input.target.owner,
      repo: input.target.repo,
      commit_sha: headSha,
    },
  )) as { tree?: { sha?: string } };
  const treeSha = commit.tree?.sha;
  if (!treeSha) throw new Error(`commit '${headSha}' has no tree SHA`);

  for (const component of input.components) {
    const result = await verifyComponentSubtree({
      componentPath: component.path,
      expectedFiles: component.expectedFiles,
      targetTreeSha: treeSha,
      reader: input.reader,
      repo: input.target,
    });
    if (!result.ok) {
      return {
        kind: 'conflict',
        reason: `branch '${input.branchName}' content does not match the scaffold plan: ${result.reason}`,
      };
    }
  }

  if (!pull) return { kind: 'resume-without-pr', headSha };
  if (pull.state === 'open') return { kind: 'reuse-open-pr', pull };
  if (pull.state === 'merged') {
    return { kind: 'conflict', reason: `candidate PR #${pull.number} is already merged` };
  }
  return {
    kind: 'blocked',
    reason: `candidate PR #${pull.number} is closed without merge; reopen it or remove the branch`,
  };
}
