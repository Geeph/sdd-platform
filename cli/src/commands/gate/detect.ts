/**
 * `sdd gate detect` — platform detection for CI (M4).
 *
 * Called from the CI Gate workflow. Determines which platforms are affected
 * by a PR and outputs JSON for the workflow to consume.
 *
 * Usage:
 *   sdd gate detect --repo <owner/name> --pr <number>
 *
 * Environment:
 *   GITHUB_TOKEN — required for API access.
 *
 * Exit codes:
 *   0 — detection completed (regardless of which platforms are affected)
 *   2 — input error
 *   3 — detection failure (fail closed)
 */

import { Command, Flags } from '@oclif/core';
import { detectPlatforms } from '@sdd/factory';
import { createMinimalOctokit } from '../../octokit-client.js';

export default class GateDetect extends Command {
  static override description = 'Detect affected platforms for a PR (CI)';

  static override examples = ['<%= config.bin %> gate detect --repo acme/demo --pr 42'];

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
    const { flags } = await this.parse(GateDetect);

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

    const octokit = createMinimalOctokit(token);

    try {
      const result = await detectPlatforms({
        octokit,
        repo: { owner, repo },
        pr: flags.pr,
      });

      // Output JSON for CI workflow consumption.
      this.log(JSON.stringify(result, null, 2));
    } catch (err) {
      // Fail closed (§2.2 step 6).
      const msg = err instanceof Error ? err.message : String(err);
      this.error(`detect failed: ${msg}`, { exit: 3 });
    }
  }
}
