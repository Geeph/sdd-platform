import type {
  CheckRun,
  CodeownersEntry,
  PullData,
  PullFile,
  PullReview,
  RequiredCheck,
  VerifyInput,
  VerifyResult,
} from './types.js';

const CONTRACT_GATE_CHECK = 'Contract Gate';

/**
 * Verify that a Gate artifact was properly approved.
 *
 * This function implements fail-closed semantics: any API error, missing
 * evidence, or consistency violation produces `{ ok: false }`.
 */
export async function verifyGateApproval(input: VerifyInput): Promise<VerifyResult> {
  const { octokit, git, repo, gate, version, approval, artifactPath } = input;
  const { owner, name } = repo;

  try {
    // Step 1: Locate the PR (by number or by merge commit SHA)
    const pr = await resolvePr(octokit, owner, name, approval);

    // Step 2: Verify PR is merged to the protected `main` branch
    if (!pr.merged) {
      return { ok: false, reason: `PR #${pr.number} is not merged` };
    }
    if (pr.base.ref !== 'main') {
      return {
        ok: false,
        reason: `PR #${pr.number} targets '${pr.base.ref}', not 'main'`,
      };
    }
    const branchInfo = await octokit.rest.repos.getBranch({
      owner,
      repo: name,
      branch: 'main',
    });
    if (!branchInfo.data.protected) {
      return { ok: false, reason: 'target branch main is not protected' };
    }

    const headSha = pr.head.sha;
    const mergeCommitSha = pr.merge_commit_sha;
    if (!mergeCommitSha) {
      return { ok: false, reason: 'PR has no merge commit SHA' };
    }

    // Step 3: Label consistency check (labels are not used for PR selection)
    const gateLabel = `gate:${gate}`;
    const versionLabel = `version:${version}`;
    const prLabels = pr.labels.map((l) => l.name);
    for (const label of prLabels) {
      if (label.startsWith('gate:') && label !== gateLabel) {
        return {
          ok: false,
          reason: `PR label '${label}' conflicts with expected gate '${gateLabel}'`,
        };
      }
      if (label.startsWith('version:') && label !== versionLabel) {
        return {
          ok: false,
          reason: `PR label '${label}' conflicts with expected version '${versionLabel}'`,
        };
      }
    }

    // Step 4: Verify CODEOWNER approval on final head SHA
    const approval_ = await getCodeownerApproval(octokit, git, owner, name, pr, headSha);
    if (!approval_.ok) {
      return { ok: false, reason: approval_.reason ?? 'approval check failed' };
    }

    // Step 5: Confirm artifactPath is in the PR's changed files
    const changedFiles = await listAllFiles(octokit, owner, name, pr.number);
    const fileInPr = changedFiles.find((f) => f.filename === artifactPath);
    if (!fileInPr) {
      return {
        ok: false,
        reason: `artifact '${artifactPath}' not in PR #${pr.number} changed files`,
      };
    }
    if (fileInPr.status === 'removed') {
      return {
        ok: false,
        reason: `artifact '${artifactPath}' was removed in PR #${pr.number}`,
      };
    }
    // status must be added or modified
    if (fileInPr.status !== 'added' && fileInPr.status !== 'modified') {
      return {
        ok: false,
        reason: `artifact '${artifactPath}' has unexpected status '${fileInPr.status}' in PR`,
      };
    }

    // Step 6: Verify local blob matches PR blob and worktree is clean
    const worktreeClean = await git.isClean(artifactPath);
    if (!worktreeClean) {
      return {
        ok: false,
        reason: `worktree is dirty for '${artifactPath}'`,
      };
    }
    // Compare against both head SHA and merge commit SHA (either should match)
    const prHeadBlob = await git.blobAt(headSha, artifactPath);
    const mergeBlob = await git.blobAt(mergeCommitSha, artifactPath);
    const localBlob = await git.blobWorktree(artifactPath);
    if (localBlob !== prHeadBlob && localBlob !== mergeBlob) {
      return {
        ok: false,
        reason: `local blob for '${artifactPath}' does not match PR head/merge version`,
      };
    }

    // Step 7: For contract gate, verify check runs
    const required_checks: RequiredCheck[] = [];
    if (gate === 'contract') {
      const checkResult = await verifyContractGateCheck(octokit, owner, name, headSha);
      if (!checkResult.ok) {
        return { ok: false, reason: checkResult.reason ?? 'contract gate check failed' };
      }
      if (checkResult.check) {
        required_checks.push(checkResult.check);
      }
    }

    return {
      ok: true,
      provenance: {
        gate,
        version,
        pr: pr.number,
        approved_head_sha: headSha,
        merge_commit_sha: mergeCommitSha,
        approved_at: pr.merged_at ?? '',
        required_checks,
      },
    };
  } catch (err) {
    // Fail closed on API errors
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `API error: ${message}` };
  }
}

// --- Internal helpers ---

async function resolvePr(
  octokit: VerifyInput['octokit'],
  owner: string,
  repo: string,
  approval: VerifyInput['approval'],
): Promise<PullData> {
  if ('pr' in approval && approval.pr !== undefined) {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: approval.pr,
    });
    return data;
  }
  // Lookup by merge commit SHA
  const sha = (approval as { mergeCommitSha: string }).mergeCommitSha;
  const prs = await listAllPrsForCommit(octokit, owner, repo, sha);
  const match = prs.find((p) => p.merged && p.merge_commit_sha === sha && p.base.ref === 'main');
  if (!match) {
    throw new Error(`No merged PR found for merge commit ${sha}`);
  }
  return match;
}

async function listAllPrsForCommit(
  octokit: VerifyInput['octokit'],
  owner: string,
  repo: string,
  sha: string,
): Promise<PullData[]> {
  const all: PullData[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: sha,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return all;
}

async function listAllFiles(
  octokit: VerifyInput['octokit'],
  owner: string,
  repo: string,
  pull_number: number,
): Promise<PullFile[]> {
  const all: PullFile[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return all;
}

async function listAllReviews(
  octokit: VerifyInput['octokit'],
  owner: string,
  repo: string,
  pull_number: number,
): Promise<PullReview[]> {
  const all: PullReview[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return all;
}

interface ApprovalResult {
  ok: boolean;
  reason?: string;
}

async function getCodeownerApproval(
  octokit: VerifyInput['octokit'],
  git: VerifyInput['git'],
  owner: string,
  repo: string,
  pr: PullData,
  headSha: string,
): Promise<ApprovalResult> {
  const codeowners = await git.codeownersAt(headSha);
  const reviews = await listAllReviews(octokit, owner, repo, pr.number);

  // Find approved reviews on the final head SHA
  const approvalsOnHead = reviews.filter((r) => r.state === 'APPROVED' && r.commit_id === headSha);
  if (approvalsOnHead.length === 0) {
    return { ok: false, reason: 'no approval review on final head SHA' };
  }

  // Each approval must be from a CODEOWNER for the artifact path
  const codeownerLogins = new Set<string>();
  for (const entry of codeowners) {
    if (matchCodeownersPattern(entry.pattern, 'projects.yaml')) {
      for (const o of entry.owners) {
        codeownerLogins.add(normalizeLogin(o));
      }
    }
  }

  const validApprovals = approvalsOnHead.filter((r) => {
    if (!r.user) return false;
    return codeownerLogins.has(normalizeLogin(r.user.login));
  });

  if (validApprovals.length === 0) {
    return {
      ok: false,
      reason: 'no approval from a CODEOWNER for the artifact',
    };
  }
  return { ok: true };
}

/** Normalize a GitHub login (strip leading @ and lowercase). */
function normalizeLogin(login: string): string {
  return login.replace(/^@/, '').toLowerCase();
}

/** Match a CODEOWNERS pattern against a file path. */
function matchCodeownersPattern(pattern: string, filePath: string): boolean {
  // Normalize: strip leading slash if present
  const normalizedPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

  // Convert CODEOWNERS pattern to regex
  let regex = normalizedPattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  // If pattern ends with /, match directory prefix
  if (normalizedPattern.endsWith('/')) {
    regex = regex.replace(/\/$/, '(/.*)?$');
  } else if (!normalizedPattern.includes('*')) {
    // Literal pattern matches as prefix
    regex = `${regex}(/.*)?$`;
  } else {
    // Full regex match
    regex = `^${regex}$`;
  }

  return new RegExp(`^${regex}`).test(normalizedPath);
}

async function verifyContractGateCheck(
  octokit: VerifyInput['octokit'],
  owner: string,
  repo: string,
  headSha: string,
): Promise<{ ok: boolean; reason?: string; check?: RequiredCheck }> {
  const checks = await listAllCheckRuns(octokit, owner, repo, headSha);
  const contractGate = checks.find((c) => c.name === CONTRACT_GATE_CHECK);
  if (!contractGate) {
    return { ok: false, reason: 'Contract Gate check not found at head SHA' };
  }
  if (contractGate.head_sha !== headSha) {
    return {
      ok: false,
      reason: 'Contract Gate check is for a different head SHA',
    };
  }
  if (contractGate.conclusion !== 'success') {
    return {
      ok: false,
      reason: `Contract Gate conclusion is '${contractGate.conclusion}', not 'success'`,
    };
  }
  return {
    ok: true,
    check: {
      name: contractGate.name,
      head_sha: contractGate.head_sha,
      conclusion: 'success',
    },
  };
}

async function listAllCheckRuns(
  octokit: VerifyInput['octokit'],
  owner: string,
  repo: string,
  ref: string,
): Promise<CheckRun[]> {
  const all: CheckRun[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref,
      per_page: 100,
      page,
    });
    const runs = data.check_runs;
    if (runs.length === 0) break;
    all.push(...runs);
    if (runs.length < 100) break;
    page++;
  }
  return all;
}
