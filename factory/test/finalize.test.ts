/**
 * finalize.test.ts — finalizeProtection tests.
 *
 * Covers the §2.3 step 6 evidence matrix:
 *   - Happy path: all evidence present → COMPLETE
 *   - Each evidence category missing → blocked (with the right message)
 *   - Idempotent path: already-active org ruleset + hardened product ruleset
 *   - Writer failure during mutate → blocked, not COMPLETE
 *   - template.lock parse failure → blocked
 */

import { describe, expect, it } from 'vitest';
import { finalizeProtection } from '../src/init.js';
import type {
  GitHubReadPort,
  GitHubWritePort,
  ObservedState,
  RepositoryIdentity,
} from '../src/types.js';

// ---- Fixtures --------------------------------------------------------------

const REPOSITORY: RepositoryIdentity = {
  owner: 'acme',
  name: 'demo',
  id: 12345,
  defaultBranch: 'main',
  visibility: 'private',
};

const FINAL_HEAD = 'a'.repeat(40);
const MERGE_COMMIT = 'b'.repeat(40);
const PINNED_SHA = 'c'.repeat(40);
const PLATFORM_REPO_ID = 99999;

function happyObserved(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    repositoryExists: true,
    repository: {
      id: REPOSITORY.id,
      defaultBranch: 'main',
      visibility: 'private',
      empty: false,
      mainSha: MERGE_COMMIT,
      templateLock: [
        'schema_version: 1',
        'source:',
        `  repository: acme/sdd-platform`,
        `  resolved_commit: ${PINNED_SHA}`,
      ].join('\n'),
    },
    existingLabels: [],
    knownTeams: [],
    existingEnvironments: [],
    repositoryRulesetExists: true,
    orgWorkflowRulesetExists: true,
    orgWorkflowRulesetEnforcement: 'evaluate',
    orgWorkflowRulesetSource: {
      workflows: [
        { repositoryId: PLATFORM_REPO_ID, path: '.github/workflows/ci-gate.yml', sha: PINNED_SHA },
        {
          repositoryId: PLATFORM_REPO_ID,
          path: '.github/workflows/pr-hygiene.yml',
          sha: PINNED_SHA,
        },
      ],
      targetRepoId: REPOSITORY.id,
      targetRefPattern: 'refs/heads/main',
    },
    bootstrapPullRequest: {
      number: 7,
      headSha: FINAL_HEAD,
      state: 'merged',
      mergeCommitSha: MERGE_COMMIT,
      author: 'author-login',
      approvals: [{ user: 'reviewer-1', headSha: FINAL_HEAD }],
    },
    bootstrapCheckRuns: [
      {
        context: 'CI Gate',
        conclusion: 'success',
        headSha: FINAL_HEAD,
        appId: 15368,
        checkSuiteId: 1,
        workflowRepository: 'acme/sdd-platform',
        workflowPath: '.github/workflows/ci-gate.yml',
        workflowSha: PINNED_SHA,
      },
      {
        context: 'PR hygiene',
        conclusion: 'success',
        headSha: FINAL_HEAD,
        appId: 15368,
        checkSuiteId: 2,
        workflowRepository: 'acme/sdd-platform',
        workflowPath: '.github/workflows/pr-hygiene.yml',
        workflowSha: PINNED_SHA,
      },
    ],
    ...overrides,
  };
}

function createFakeReader(observed: ObservedState): GitHubReadPort {
  return {
    async resolveCommit() {
      return { commit: PINNED_SHA, requestedRef: 'v1', peeled: false };
    },
    async readTemplateTree() {
      throw new Error('not used by finalize');
    },
    async observe(input) {
      if (input.target.repo === 'sdd-platform') {
        return {
          ...observed,
          repository: { ...observed.repository!, id: PLATFORM_REPO_ID },
        };
      }
      return observed;
    },
    async resolveTeamMembers(_org, teamSlug) {
      return teamSlug === 'reviewer-1' ? ['reviewer-1'] : [];
    },
    async isCommitReachable() {
      return true;
    },
  };
}

function createFakeWriter(overrides: { activateThrows?: Error; hardenThrows?: Error }): {
  writer: GitHubWritePort;
  calls: string[];
} {
  const calls: string[] = [];
  const writer: GitHubWritePort = {
    async createRepository() {
      throw new Error('not used');
    },
    async updateRepositorySettings() {
      throw new Error('not used');
    },
    async seedMainViaContents() {
      throw new Error('not used');
    },
    async publishSnapshot() {
      throw new Error('not used');
    },
    async reconcileLabels() {
      return { created: [], updated: [], noop: [] };
    },
    async grantTeamPermissions() {
      return { created: [], updated: [], noop: [] };
    },
    async reconcileEnvironments() {
      return { created: [], updated: [], noop: [] };
    },
    async reconcileRepositoryRuleset(input) {
      calls.push(`reconcileRepositoryRuleset:hardened=${input.hardened !== false}`);
      if (overrides.hardenThrows) throw overrides.hardenThrows;
      return { created: [], updated: ['sdd-main'], noop: [] };
    },
    async reconcileOrgWorkflowRuleset(input) {
      calls.push(`reconcileOrgWorkflowRuleset:${input.enforcement}`);
      if (overrides.activateThrows) throw overrides.activateThrows;
      return { created: [], updated: ['sdd-workflows'], noop: [] };
    },
    async upsertBootstrapPull() {
      throw new Error('not used');
    },
  };
  return { writer, calls };
}

// ---- Tests -----------------------------------------------------------------

describe('finalizeProtection', () => {
  const target = { owner: 'acme', repo: 'demo', visibility: 'private' as const };

  it('happy path: all evidence present → COMPLETE', async () => {
    const reader = createFakeReader(happyObserved());
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(
      target,
      { reader, writer },
      { bootstrapApprovers: ['reviewer-1'] },
    );
    expect(result.phase).toBe('COMPLETE');
    expect(result.nextAction).toBe('complete');
    expect(calls).toContain('reconcileOrgWorkflowRuleset:active');
    expect(calls).toContain('reconcileRepositoryRuleset:hardened=true');
  });

  it('idempotent: already-active org ruleset skips activate but still hardens', async () => {
    const reader = createFakeReader(happyObserved({ orgWorkflowRulesetEnforcement: 'active' }));
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.phase).toBe('COMPLETE');
    expect(calls).not.toContain('reconcileOrgWorkflowRuleset:active');
    expect(calls).toContain('reconcileRepositoryRuleset:hardened=true');
  });

  it('blocked: Bootstrap PR not merged', async () => {
    const reader = createFakeReader(
      happyObserved({
        bootstrapPullRequest: {
          number: 7,
          headSha: FINAL_HEAD,
          state: 'open',
          author: 'author-login',
          approvals: [],
        },
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.phase).toBe('BOOTSTRAP_MERGED');
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0); // no mutations
  });

  it('blocked: no approvals', async () => {
    const reader = createFakeReader(
      happyObserved({
        bootstrapPullRequest: {
          number: 7,
          headSha: FINAL_HEAD,
          state: 'merged',
          mergeCommitSha: MERGE_COMMIT,
          author: 'author-login',
          approvals: [],
        },
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: approval bound to wrong SHA', async () => {
    const reader = createFakeReader(
      happyObserved({
        bootstrapPullRequest: {
          number: 7,
          headSha: FINAL_HEAD,
          state: 'merged',
          mergeCommitSha: MERGE_COMMIT,
          author: 'author-login',
          approvals: [{ user: 'reviewer-1', headSha: 'd'.repeat(40) }], // stale
        },
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: self-approval', async () => {
    const reader = createFakeReader(
      happyObserved({
        bootstrapPullRequest: {
          number: 7,
          headSha: FINAL_HEAD,
          state: 'merged',
          mergeCommitSha: MERGE_COMMIT,
          author: 'author-login',
          approvals: [{ user: 'author-login', headSha: FINAL_HEAD }],
        },
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: reviewer not in bootstrapApprovers allow-list', async () => {
    const reader = createFakeReader(happyObserved());
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(
      target,
      { reader, writer },
      { bootstrapApprovers: ['someone-else'] },
    );
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: CI Gate check missing', async () => {
    const reader = createFakeReader(
      happyObserved({
        bootstrapCheckRuns: [
          { context: 'PR hygiene', conclusion: 'success', headSha: FINAL_HEAD, appId: 15368 },
        ],
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: CI Gate conclusion != success', async () => {
    const reader = createFakeReader(
      happyObserved({
        bootstrapCheckRuns: [
          { context: 'CI Gate', conclusion: 'failure', headSha: FINAL_HEAD, appId: 15368 },
          { context: 'PR hygiene', conclusion: 'success', headSha: FINAL_HEAD, appId: 15368 },
        ],
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: check run from wrong app id', async () => {
    const reader = createFakeReader(
      happyObserved({
        bootstrapCheckRuns: [
          { context: 'CI Gate', conclusion: 'success', headSha: FINAL_HEAD, appId: 12345 },
          { context: 'PR hygiene', conclusion: 'success', headSha: FINAL_HEAD, appId: 15368 },
        ],
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: check run on wrong head SHA', async () => {
    const reader = createFakeReader(
      happyObserved({
        bootstrapCheckRuns: [
          { context: 'CI Gate', conclusion: 'success', headSha: 'd'.repeat(40), appId: 15368 },
          { context: 'PR hygiene', conclusion: 'success', headSha: FINAL_HEAD, appId: 15368 },
        ],
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: same-name Actions check came from an untrusted workflow repository', async () => {
    const baseline = happyObserved();
    const checks = (baseline.bootstrapCheckRuns ?? []).map((check) =>
      check.context === 'CI Gate'
        ? { ...check, workflowRepository: 'acme/untrusted-workflows' }
        : check,
    );
    const reader = createFakeReader(happyObserved({ bootstrapCheckRuns: checks }));
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('blocked: template.lock missing', async () => {
    const observed = happyObserved();
    if (observed.repository) observed.repository.templateLock = undefined;
    const reader = createFakeReader(observed);
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: template.lock unparseable', async () => {
    const observed = happyObserved();
    if (observed.repository) observed.repository.templateLock = ':::not-yaml:::';
    const reader = createFakeReader(observed);
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: org ruleset missing', async () => {
    const reader = createFakeReader(
      happyObserved({ orgWorkflowRulesetExists: false, orgWorkflowRulesetSource: undefined }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: org ruleset pinned SHA mismatch', async () => {
    const reader = createFakeReader(
      happyObserved({
        orgWorkflowRulesetSource: {
          workflows: [
            {
              repositoryId: PLATFORM_REPO_ID,
              path: '.github/workflows/ci-gate.yml',
              sha: 'd'.repeat(40), // different from template.lock's PINNED_SHA
            },
            {
              repositoryId: PLATFORM_REPO_ID,
              path: '.github/workflows/pr-hygiene.yml',
              sha: PINNED_SHA,
            },
          ],
          targetRepoId: REPOSITORY.id,
          targetRefPattern: 'refs/heads/main',
        },
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: org ruleset targets wrong repo', async () => {
    const reader = createFakeReader(
      happyObserved({
        orgWorkflowRulesetSource: {
          workflows: [
            {
              repositoryId: PLATFORM_REPO_ID,
              path: '.github/workflows/ci-gate.yml',
              sha: PINNED_SHA,
            },
            {
              repositoryId: PLATFORM_REPO_ID,
              path: '.github/workflows/pr-hygiene.yml',
              sha: PINNED_SHA,
            },
          ],
          targetRepoId: 77777, // not our repo
          targetRefPattern: 'refs/heads/main',
        },
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('blocked: org ruleset omits its target repository evidence', async () => {
    const source = happyObserved().orgWorkflowRulesetSource;
    const reader = createFakeReader(
      happyObserved({
        orgWorkflowRulesetSource: source
          ? {
              workflows: source.workflows,
              targetRefPattern: 'refs/heads/main',
            }
          : undefined,
      }),
    );
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('blocked: merge commit != current main (drift)', async () => {
    const reader = createFakeReader(
      happyObserved({
        repository: {
          id: REPOSITORY.id,
          defaultBranch: 'main',
          visibility: 'private',
          empty: false,
          mainSha: 'd'.repeat(40), // different from MERGE_COMMIT
          templateLock: happyObserved().repository!.templateLock,
        },
      }),
    );
    reader.isCommitReachable = async () => false;
    const { writer, calls } = createFakeWriter({});
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls.length).toBe(0);
  });

  it('fail-closed: org ruleset activate throws → blocked, no harden', async () => {
    const reader = createFakeReader(happyObserved());
    const { writer, calls } = createFakeWriter({
      activateThrows: new Error('permission denied'),
    });
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    expect(calls).not.toContain('reconcileRepositoryRuleset:hardened=true');
  });

  it('fail-closed: product ruleset harden throws → blocked', async () => {
    const reader = createFakeReader(happyObserved());
    const { writer, calls } = createFakeWriter({
      hardenThrows: new Error('rate limited'),
    });
    const result = await finalizeProtection(target, { reader, writer });
    expect(result.nextAction).toBe('blocked');
    // The org ruleset WAS activated (that step succeeded), but harden failed.
    expect(calls).toContain('reconcileOrgWorkflowRuleset:active');
    expect(calls).toContain('reconcileRepositoryRuleset:hardened=true');
  });
});
