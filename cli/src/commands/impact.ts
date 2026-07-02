/**
 * `sdd impact` — impact analysis (M4).
 *
 * Reports which platforms are affected by changes between two refs,
 * and which requirements/screens/operations changed.
 *
 * Two modes:
 *   - API mode (--repo): uses GitHub API, refs must be 40-hex SHA
 *   - Local mode (no --repo): uses local git, refs can be any git expression
 *
 * Usage:
 *   sdd impact --base <ref> --head <ref> [--repo owner/name] [--format json|text]
 *
 * Exit codes:
 *   0 — success
 *   2 — input error
 *   3 — analysis failure (fail closed)
 */

import { Command, Flags } from '@oclif/core';
import { computeImpact, createApiImpactReader, createLocalGitImpactReader } from '@sdd/factory';
import type { SDDImpact } from '@sdd/schemas';
import { createMinimalOctokit } from '../octokit-client.js';

export default class Impact extends Command {
  static override description = 'Compute impact of changes between two refs';

  static override examples = [
    '<%= config.bin %> impact --base origin/main --head HEAD',
    '<%= config.bin %> impact --base abc123... --head def456... --repo acme/demo',
  ];

  static override flags = {
    base: Flags.string({
      description: 'Base ref (commit SHA, branch, tag)',
      required: true,
    }),
    head: Flags.string({
      description: 'Head ref (commit SHA, branch, tag)',
      required: true,
    }),
    repo: Flags.string({
      description: 'Repository (owner/name) for API mode',
      required: false,
    }),
    format: Flags.string({
      description: 'Output format',
      options: ['json', 'text'],
      default: 'json',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Impact);

    // Input validation (exit 2) — before try block so validation errors
    // are not wrapped as exit 3 by the catch below.
    if (flags.repo) {
      if (!/^[0-9a-f]{40}$/i.test(flags.base)) {
        this.error(`--base must be a 40-hex SHA in --repo mode, got '${flags.base}'`, { exit: 2 });
      }
      if (!/^[0-9a-f]{40}$/i.test(flags.head)) {
        this.error(`--head must be a 40-hex SHA in --repo mode, got '${flags.head}'`, { exit: 2 });
      }

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        this.error('GITHUB_TOKEN environment variable is required for --repo mode', { exit: 2 });
      }

      const repoMatch = flags.repo.match(/^([^/]+)\/([^/]+)$/);
      if (!repoMatch) {
        this.error(`--repo must be '<owner>/<name>', got '${flags.repo}'`, { exit: 2 });
      }
    }

    try {
      let impact: SDDImpact;

      if (flags.repo) {
        const token = process.env.GITHUB_TOKEN as string;
        const repoMatch = flags.repo.match(/^([^/]+)\/([^/]+)$/)!;
        const owner = repoMatch[1] as string;
        const repo = repoMatch[2] as string;

        const octokit = createMinimalOctokit(token);
        const reader = createApiImpactReader(octokit, { owner, repo });
        impact = await computeImpact({
          reader,
          base: flags.base,
          head: flags.head,
        });
      } else {
        // Local mode: use local git.
        const reader = createLocalGitImpactReader(process.cwd());
        impact = await computeImpact({
          reader,
          base: flags.base,
          head: flags.head,
        });
      }

      // Output.
      if (flags.format === 'json') {
        this.log(JSON.stringify(impact, null, 2));
      } else {
        this.log(renderTextImpact(impact));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.error(`impact analysis failed: ${msg}`, { exit: 3 });
    }
  }
}

function renderTextImpact(impact: SDDImpact): string {
  const lines: string[] = [];
  lines.push(`Impact: ${impact.base.slice(0, 8)} → ${impact.head.slice(0, 8)}`);
  lines.push('');

  lines.push('Platforms:');
  for (const [platform, affected] of Object.entries(impact.platforms)) {
    lines.push(`  ${platform}: ${affected ? 'yes' : 'no'}`);
  }
  lines.push('');

  if (impact.changed.requirements.length > 0) {
    lines.push(`Changed requirements (${impact.changed.requirements.length}):`);
    for (const req of impact.changed.requirements) {
      lines.push(`  - ${req}`);
    }
    lines.push('');
  }

  if (impact.changed.screens.length > 0) {
    lines.push(`Changed screens (${impact.changed.screens.length}):`);
    for (const scr of impact.changed.screens) {
      lines.push(`  - ${scr}`);
    }
    lines.push('');
  }

  if (impact.changed.operations.length > 0) {
    lines.push(`Changed operations (${impact.changed.operations.length}):`);
    for (const op of impact.changed.operations) {
      lines.push(`  - ${op}`);
    }
    lines.push('');
  }

  lines.push(`Breaking: ${impact.breaking ? 'yes' : 'no'}`);

  return lines.join('\n');
}
