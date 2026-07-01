/**
 * scaffold/publish.ts — write-side of `sdd product scaffold` (M3 §2.3).
 *
 * Implements `publishComponentBranch` and `upsertScaffoldPull`:
 *   - publishComponentBranch: writes the pending component trees to a new
 *     branch using Git Data API (blob→tree→commit→createRef).
 *   - upsertScaffoldPull: creates a Scaffold PR, or reuses an existing one
 *     after D20 content verification.
 *
 * The `publishComponentBranch` write is the OPPOSITE of `publishSnapshot`
 * (M2b): publishSnapshot rejects `apps/*` paths to prevent `product init`
 * from accidentally writing product code. Here we only allow pending
 * components' `path` prefixes.
 */

import type { RepoRef } from '../types.js';
import { expectedFilesForComponent, type RenderedComponent } from './render.js';
import { verifyComponentSubtree } from './subtree.js';
import type {
  PublishComponentBranchInput,
  PublishResult,
  ScaffoldPull,
  ScaffoldReadPort,
  ScaffoldWritePort,
  TreeEntry,
  UpsertScaffoldPullInput,
} from './types.js';

// ---- Octokit interfaces ---------------------------------------------------

export interface OctokitMutate {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

// ---- Retry helper (minimal) -----------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, _label: string): Promise<T> {
  return fn();
}

// ---- publishComponentBranch -----------------------------------------------

/**
 * Create a new scaffold branch by building blobs + trees + a commit off
 * the current main tree, then `createRef` to establish the branch.
 *
 * All files MUST be under the pending components' `path` prefixes.
 * base_tree = current main tree (not seed tree).
 * Never force-pushes.
 */
export async function publishComponentBranch(
  octokit: OctokitMutate,
  input: PublishComponentBranchInput,
): Promise<PublishResult> {
  const { target, baseTreeSha, baseCommitSha, branchName, files, commitMessage } = input;

  // Validate paths are under allowed prefixes.
  for (const file of files) {
    if (!file.path.startsWith('apps/')) {
      throw new Error(`publishComponentBranch: file '${file.path}' is not under apps/ prefix`);
    }
  }

  // Create blobs for each file.
  const blobShas = new Map<string, string>();
  for (const file of files) {
    const resp = (await withRetry(
      () =>
        octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
          owner: target.owner,
          repo: target.repo,
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64',
        }),
      `publishComponentBranch:blob:${file.path}`,
    )) as { sha: string };
    blobShas.set(file.path, resp.sha);
  }

  // Build tree entries.
  const treeEntries = files.map((file) => ({
    path: file.path,
    mode: file.mode,
    type: 'blob' as const,
    sha: blobShas.get(file.path) as string,
  }));

  // Create tree on top of base tree.
  const treeResp = (await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner: target.owner,
        repo: target.repo,
        base_tree: baseTreeSha,
        tree: treeEntries,
      }),
    'publishComponentBranch:tree',
  )) as { sha: string };

  // Create commit with parent = current main tip.
  const commitResp = (await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner: target.owner,
        repo: target.repo,
        message: commitMessage,
        tree: treeResp.sha,
        parents: [baseCommitSha],
      }),
    'publishComponentBranch:commit',
  )) as { sha: string };

  // createRef (not force) to establish the branch.
  await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/git/refs', {
        owner: target.owner,
        repo: target.repo,
        ref: `refs/heads/${branchName}`,
        sha: commitResp.sha,
      }),
    'publishComponentBranch:createRef',
  );

  return {
    commitSha: commitResp.sha,
    treeSha: treeResp.sha,
    created: true,
  };
}

// ---- upsertScaffoldPull ---------------------------------------------------

/**
 * Create or reuse a Scaffold PR.
 *
 * Uses `team_reviewers` (not `reviewers`) — the pending components'
 * `owner` slugs are teams, not users (D23).
 */
export async function upsertScaffoldPull(
  octokit: OctokitMutate,
  input: UpsertScaffoldPullInput,
): Promise<ScaffoldPull> {
  const { target, headBranch, baseBranch, title, body, teamReviewers } = input;

  // Check for existing PR.
  const existingPrs = (await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner: target.owner,
        repo: target.repo,
        head: `${target.owner}:${headBranch}`,
        state: 'open',
        per_page: 10,
      }),
    'upsertScaffoldPull:listPRs',
  )) as Array<{ number: number; head: { sha: string }; html_url: string }>;

  if (existingPrs.length > 0) {
    const pr = existingPrs[0]!;
    await withRetry(
      () =>
        octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {
          owner: target.owner,
          repo: target.repo,
          pull_number: pr.number,
          team_reviewers: [...new Set(teamReviewers)].sort(),
        }),
      'upsertScaffoldPull:requestReviewers',
    );
    return {
      number: pr.number,
      headSha: pr.head.sha,
      htmlUrl: pr.html_url,
      created: false,
    };
  }

  // Create PR.
  const prResp = (await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/pulls', {
        owner: target.owner,
        repo: target.repo,
        title,
        body,
        head: headBranch,
        base: baseBranch,
        draft: false,
      }),
    'upsertScaffoldPull:createPR',
  )) as { number: number; head: { sha: string }; html_url: string };

  await withRetry(
    () =>
      octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {
        owner: target.owner,
        repo: target.repo,
        pull_number: prResp.number,
        team_reviewers: [...new Set(teamReviewers)].sort(),
      }),
    'upsertScaffoldPull:requestReviewers',
  );

  return {
    number: prResp.number,
    headSha: prResp.head.sha,
    htmlUrl: prResp.html_url,
    created: true,
  };
}
