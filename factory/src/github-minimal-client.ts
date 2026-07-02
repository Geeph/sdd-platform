/**
 * github-minimal-client.ts — shared GitHub API helpers (M4, D16).
 *
 * Extracted from `gate-hygiene.ts` so that `detect.ts`, `impact.ts`, and
 * `gate-hygiene.ts` can share the same PR-file pagination, blob fetch, and
 * ID-pattern logic. The null/throw distinction in `fetchBlobAtRef` is
 * deliberate: callers decide whether "not found" is an error.
 */

// ---- MinimalOctokit interface -----------------------------------------------

/**
 * The subset of octokit surface used by M4 shared helpers. Mirrors the
 * `HygieneOctokit` / `createMinimalOctokit` shape: a single `request` method
 * that takes a route string and parameters.
 */
export interface MinimalOctokit {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

// ---- Shared types -----------------------------------------------------------

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequestInfo {
  base: { sha: string; ref: string; repo: { full_name: string } };
  head: { sha: string; ref: string; repo: { full_name: string } };
  labels: Array<{ name: string }>;
  changed_files: number;
  number: number;
}

export interface ChangedFileEntry {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  previous_filename?: string;
  additions: number;
  deletions: number;
}

// ---- fetchPullRequest -------------------------------------------------------

/**
 * Fetch PR metadata needed by detect/hygiene. Returns the fields detect needs:
 * base/head SHA, labels, repo info, and `changed_files` count (D22).
 */
export async function fetchPullRequest(
  octokit: MinimalOctokit,
  repo: RepoRef,
  pr: number,
): Promise<PullRequestInfo> {
  const resp = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: pr,
  })) as {
    base?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    labels?: Array<{ name?: string }>;
    changed_files?: number;
    number?: number;
  };

  if (!resp.base?.sha || !resp.head?.sha) {
    throw new Error('PR response missing base.sha or head.sha');
  }
  if (!resp.base.repo?.full_name || !resp.head.repo?.full_name) {
    throw new Error('PR response missing base.repo.full_name or head.repo.full_name');
  }
  if (typeof resp.changed_files !== 'number') {
    throw new Error('PR response missing changed_files count');
  }
  return {
    base: {
      sha: resp.base.sha,
      ref: resp.base.ref ?? '',
      repo: { full_name: resp.base.repo.full_name },
    },
    head: {
      sha: resp.head.sha,
      ref: resp.head.ref ?? '',
      repo: { full_name: resp.head.repo.full_name },
    },
    labels: (resp.labels ?? [])
      .filter((l) => typeof l.name === 'string')
      .map((l) => ({ name: l.name as string })),
    changed_files: resp.changed_files,
    number: resp.number ?? pr,
  };
}

// ---- fetchChangedFiles (D22) ------------------------------------------------

/**
 * Paginate through all PR changed files (per_page=100). After pagination,
 * the total count MUST equal `pr.changed_files`; if not, throw (D22).
 *
 * Supports `previous_filename` for renamed files (D19).
 *
 * `maxPages` is a pure loop-prevention guard, NOT a completeness proof —
 * completeness is proven by the changed_files count check.
 */
export async function fetchChangedFiles(
  octokit: MinimalOctokit,
  repo: RepoRef,
  pr: number,
  expectedCount: number,
  maxPages = 200,
): Promise<ChangedFileEntry[]> {
  const files: ChangedFileEntry[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= maxPages) {
    const resp = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pr,
      page,
      per_page: perPage,
    })) as Array<{
      filename: string;
      status: string;
      previous_filename?: string;
      additions: number;
      deletions: number;
    }>;

    if (!Array.isArray(resp) || resp.length === 0) break;

    for (const f of resp) {
      const status = normalizeFileStatus(f.status);
      const entry: ChangedFileEntry = {
        filename: f.filename,
        status,
        additions: f.additions,
        deletions: f.deletions,
      };
      if (status === 'renamed' && f.previous_filename) {
        entry.previous_filename = f.previous_filename;
      }
      files.push(entry);
    }

    if (resp.length < perPage) break;
    page++;
  }

  // D22: verify completeness against the PR's own changed_files count.
  if (files.length !== expectedCount) {
    throw new Error(
      `PR changed_files count mismatch: expected ${expectedCount}, got ${files.length}. ` +
        `Cannot prove pagination is complete — fail closed.`,
    );
  }

  return files;
}

function normalizeFileStatus(status: string): 'added' | 'modified' | 'removed' | 'renamed' {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    case 'modified':
    case 'changed':
      return 'modified';
    default:
      // Treat unknown statuses as modified (conservative).
      return 'modified';
  }
}

// ---- fetchBlobAtRef ---------------------------------------------------------

/**
 * Fetch blob content at a given ref. Returns `null` for 404 (file does not
 * exist at that ref — a normal situation for new files on the base side).
 * All other errors (auth, network, ref doesn't exist, etc.) throw.
 *
 * This null/throw distinction is deliberate (D16): callers decide whether
 * "not found" is an error in their context.
 */
export async function fetchBlobAtRef(
  octokit: MinimalOctokit,
  repo: RepoRef,
  path: string,
  ref: string,
): Promise<string | null> {
  let resp: { content?: string; encoding?: string };
  try {
    resp = (await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner,
      repo: repo.repo,
      path,
      ref,
      mediaType: { format: 'raw' },
    })) as { content?: string; encoding?: string };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return null;
    throw err;
  }

  if (!resp.content) return null;
  if (resp.encoding === 'base64') {
    return Buffer.from(resp.content.replace(/\n/g, ''), 'base64').toString('utf8');
  }
  return resp.content;
}

// ---- fetchRecursiveTree -----------------------------------------------------

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
}

/**
 * Fetch a full recursive tree for a given SHA. Returns `{ entries, truncated }`.
 * When `truncated=true`, callers should fall back to per-path Contents API
 * checks (D18).
 */
export async function fetchRecursiveTree(
  octokit: MinimalOctokit,
  repo: RepoRef,
  sha: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const resp = (await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    owner: repo.owner,
    repo: repo.repo,
    tree_sha: sha,
    recursive: '1',
  })) as { tree?: Array<{ path: string; type: string; sha: string }>; truncated?: boolean };

  return {
    entries: (resp.tree ?? []).map((t) => ({
      path: t.path,
      type: (t.type === 'tree' ? 'tree' : 'blob') as 'blob' | 'tree',
      sha: t.sha,
    })),
    truncated: resp.truncated === true,
  };
}

// ---- Shared ID patterns (moved from gate-hygiene.ts) ------------------------

export const REQ_ID_RE = /^REQ-[A-Z0-9]+-\d+$/;
export const SCR_ID_RE = /^SCR-[A-Z0-9-]+$/;
export const OPERATION_ID_RE = /^[a-z][a-zA-Z0-9_-]*$/;
