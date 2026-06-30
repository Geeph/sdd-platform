export type GateKind = 'spec' | 'architecture' | 'design' | 'plan' | 'contract';

export type ApprovalRef =
  | { pr: number; mergeCommitSha?: never }
  | { mergeCommitSha: string; pr?: never };

export interface VerifyInput {
  octokit: OctokitLike;
  git: GitReader;
  repo: { owner: string; name: string };
  gate: GateKind;
  version: string;
  approval: ApprovalRef;
  artifactPath: string;
}

export interface RequiredCheck {
  name: string;
  head_sha: string;
  conclusion: 'success';
}

export interface Provenance {
  gate: GateKind;
  version: string;
  pr: number;
  approved_head_sha: string;
  merge_commit_sha: string;
  approved_at: string;
  authorization_policy: 'current-codeowners';
  required_checks: RequiredCheck[];
}

export type VerifyResult = { ok: true; provenance: Provenance } | { ok: false; reason: string };

// --- Abstractions for dependency injection ---

export interface OctokitLike {
  rest: {
    pulls: {
      get: (params: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => Promise<{ data: PullData }>;
      listReviews: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: PullReview[] }>;
      listFiles: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: PullFile[] }>;
    };
    repos: {
      getBranch: (params: {
        owner: string;
        repo: string;
        branch: string;
      }) => Promise<{ data: BranchData }>;
      listCommitStatusesForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: { statuses: unknown[] } }>;
      listPullRequestsAssociatedWithCommit: (params: {
        owner: string;
        repo: string;
        commit_sha: string;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: PullData[] }>;
      getCollaboratorPermissionLevel: (params: {
        owner: string;
        repo: string;
        username: string;
      }) => Promise<{ data: { permission: string; role_name?: string } }>;
    };
    checks: {
      listForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: { check_runs: CheckRun[] } }>;
    };
    teams: {
      getByName: (params: {
        org: string;
        team_slug: string;
      }) => Promise<{ data: { id: number; slug: string; privacy?: string } }>;
      checkPermissionsForRepoInOrg: (params: {
        org: string;
        team_slug: string;
        owner: string;
        repo: string;
        headers?: { accept: string };
      }) => Promise<{
        data?: {
          permissions?: {
            admin: boolean;
            pull: boolean;
            triage?: boolean;
            push: boolean;
            maintain?: boolean;
          };
          role_name?: string;
        };
      }>;
      listMembersInOrg: (params: {
        org: string;
        team_slug: string;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: TeamMember[] }>;
    };
  };
}

export interface PullData {
  number: number;
  state: string;
  merged: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string };
  base: { ref: string; sha: string };
  labels: Array<{ name: string }>;
  merged_at: string | null;
}

export interface PullReview {
  id: number;
  user: { login: string } | null;
  state: string;
  commit_id: string;
  author_association: string;
  submitted_at: string | null;
}

export interface PullFile {
  filename: string;
  status: string; // added, modified, removed, renamed, changed
  sha: string;
  previous_filename?: string;
}

export interface BranchData {
  name: string;
  protected: boolean;
  commit: { sha: string };
}

export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
  completed_at?: string;
}

export interface CodeownersEntry {
  pattern: string;
  owners: string[];
}

export interface TeamMember {
  login: string;
}

// --- Git reader abstraction ---

export interface GitReader {
  /** Get the git blob SHA for a file at a specific commit. */
  blobAt(commit: string, path: string): Promise<string>;
  /** Get the git blob SHA for the current working tree version of a file. */
  blobWorktree(path: string): Promise<string>;
  /** Check whether the worktree is clean for the given path. */
  isClean(path: string): Promise<boolean>;
  /** Get the CODEOWNERS file contents at a commit. Returns parsed entries. */
  codeownersAt(commit: string): Promise<CodeownersEntry[]>;
}
