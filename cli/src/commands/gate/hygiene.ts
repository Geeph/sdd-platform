/**
 * `sdd gate hygiene` — PR hygiene checker (M2c, §3.5).
 *
 * Called from the PR hygiene CI workflow. Reads the PR via GitHub API
 * and validates all §3.5 rules. Non-Gate PRs (no gate:* label) only do
 * generic checks and pass.
 *
 * Usage:
 *   sdd gate hygiene --repo <owner/name> --pr <number>
 *
 * Environment:
 *   GITHUB_TOKEN — required for API access.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — violations found
 *   2 — input error
 *   3 — API error (fail closed)
 */

import { Command, Flags } from '@oclif/core';
import { checkPrHygiene } from '@sdd/factory';
import { createMinimalOctokit } from '../../octokit-client.js';

export default class GateHygiene extends Command {
  static override description = 'Check PR hygiene rules (§3.5)';

  static override examples = ['<%= config.bin %> gate hygiene --repo acme/demo --pr 42'];

  static override flags = {
    repo: Flags.string({
      description: 'Target repository (owner/name)',
      required: true,
    }),
    pr: Flags.integer({
      description: 'Pull request number',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GateHygiene);

    // Parse repo flag.
    const repoMatch = flags.repo.match(/^([^/]+)\/([^/]+)$/);
    if (!repoMatch) {
      this.error(`--repo must be '<owner>/<name>', got '${flags.repo}'`, { exit: 2 });
    }
    const owner = repoMatch[1] as string;
    const repo = repoMatch[2] as string;

    // Get GitHub token.
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      this.error('GITHUB_TOKEN environment variable is required', { exit: 2 });
    }

    // Create a minimal octokit-like client.
    const octokit = createMinimalOctokit(token);

    try {
      const trustedWorkflow = readTrustedWorkflowIdentity();
      const result = await checkPrHygiene({
        octokit,
        repo: { owner, repo },
        pr: flags.pr,
        ...(trustedWorkflow ? { trustedWorkflow } : {}),
      });

      if (result.ok) {
        this.log('PR hygiene: all checks passed');
        return;
      }

      this.log('PR hygiene: violations found');
      for (const v of result.violations) {
        this.log(`  - ${v}`);
      }
      this.exit(1);
    } catch (err) {
      // Fail closed (§3.5.7).
      const msg = err instanceof Error ? err.message : String(err);
      this.error(`hygiene check failed: ${msg}`, { exit: 3 });
    }
  }
}

function readTrustedWorkflowIdentity(): { repository: string; commit: string } | undefined {
  const workflowRef = process.env.GITHUB_WORKFLOW_REF;
  const workflowSha = process.env.GITHUB_WORKFLOW_SHA;
  if (!workflowRef || !workflowSha) return undefined;
  const match = workflowRef.match(/^([^/]+\/[^/]+)\/\.github\/workflows\/pr-hygiene\.yml@.+$/);
  if (!match?.[1] || !/^[0-9a-f]{40}$/i.test(workflowSha)) return undefined;
  return { repository: match[1], commit: workflowSha.toLowerCase() };
}
