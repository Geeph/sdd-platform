/**
 * `sdd product init` — bootstrap a product repository.
 *
 * M2b real execution establishes the repository through SNAPSHOT_MAIN and
 * returns `configure-repository`; M2c continues with GitHub configuration.
 *
 * Flags:
 *   --dry-run             Preview only; zero GitHub writes.
 *   --format text|json    Output format (default text).
 *   --owner <org>         Target GitHub org (required).
 *   --mode monorepo       Only "monorepo" supported.
 *   --platform-repo <o/n> Platform repo (owner/repo); must share org with
 *                         --owner (same-org invariant).
 *   --platform-ref <ref>  Release tag or full commit SHA (optional in
 *                         dry-run; required for real execution).
 *   --config <path>       Path to product-init.yaml (required).
 *   --finalize-protection Activate required checks after the Bootstrap PR
 *                         has been merged and all evidence is verified
 *                         (§2.3 step 6). Idempotent, fail-closed.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import {
  applyInitPlan,
  createReadonlyGitHubPort,
  createWriteGitHubPort,
  type FinalizeConfig,
  finalizeProtection,
  type InitResult,
  type ProductInitConfig,
  type ProductInitInput,
} from '@sdd/factory';
import { validateProductInitDocument } from '@sdd/schemas';
import { parse as parseYaml } from 'yaml';
import { createGitHubRequestClient } from '../../github-client.js';
import { compileInitPlan, serializeInitPlan, validateProductInitConfig } from '../../init-lib.js';

const DEFAULT_PLATFORM_REPO_NAME = 'sdd-platform';

export default class ProductInit extends Command {
  static override description = 'Bootstrap a product repository';

  static override examples = [
    '<%= config.bin %> product init demo --owner acme --platform-repo acme/sdd-platform --config product-init.yaml --dry-run --format json',
  ];

  static override flags = {
    owner: Flags.string({
      description: 'Target GitHub organization',
      required: true,
    }),
    mode: Flags.string({
      description: 'Repository mode',
      options: ['monorepo'],
      default: 'monorepo',
    }),
    'platform-repo': Flags.string({
      description:
        "Platform repo as 'owner/repo'. Defaults to '<owner>/sdd-platform' when omitted (same-org invariant enforced).",
    }),
    'platform-ref': Flags.string({
      description:
        'Platform repo release tag or full commit SHA (optional in dry-run; required for real execution)',
    }),
    config: Flags.string({
      description: 'Path to product-init.yaml',
      required: true,
    }),
    format: Flags.string({
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
    'dry-run': Flags.boolean({
      description: 'Preview only; zero GitHub writes',
      default: false,
    }),
    'finalize-protection': Flags.boolean({
      description:
        'Activate required checks after the Bootstrap PR has merged. Idempotent, fail-closed (§2.3 step 6).',
      default: false,
    }),
  };

  static override args = {
    product: Args.string({
      description: 'Product slug (matches projects.yaml `product` pattern)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { flags, args } = await this.parse(ProductInit);

    if (!flags['dry-run'] && !flags['platform-ref']) {
      this.error('--platform-ref is required for real execution', { exit: 2 });
    }
    const githubToken = flags['dry-run'] ? undefined : process.env.GITHUB_TOKEN;
    if (!flags['dry-run'] && !githubToken) {
      this.error('GITHUB_TOKEN environment variable is required', { exit: 2 });
    }

    // Detect whether user passed --platform-repo explicitly.
    const platformRepoExplicit = process.argv.some(
      (a) => a === '--platform-repo' || a.startsWith('--platform-repo='),
    );

    // Derive platform repo: explicit value wins; otherwise `${owner}/sdd-platform`.
    // This ensures the default always satisfies the same-org invariant.
    const platformRepo =
      platformRepoExplicit && flags['platform-repo']
        ? flags['platform-repo']
        : `${flags.owner}/${DEFAULT_PLATFORM_REPO_NAME}`;

    // Same-org invariant: the platform repo owner must equal the target org.
    // This is a security property — required workflows can only be consumed
    // by repos in the same org, and the Bootstrap PR reviewers live there.
    const platformRepoParts = platformRepo.split('/');
    if (platformRepoParts.length !== 2 || !platformRepoParts[0] || !platformRepoParts[1]) {
      this.error(`--platform-repo must be 'owner/repo': '${platformRepo}'`, {
        exit: 2,
      });
    }
    const platformOwner = platformRepoParts[0];
    if (platformOwner !== flags.owner) {
      this.error(
        `--platform-repo owner '${platformOwner}' must match --owner '${flags.owner}' (same-org invariant).`,
        { exit: 2 },
      );
    }

    // Load + validate the product-init.yaml config.
    let rawConfig: unknown;
    try {
      const configPath = resolve(flags.config);
      const content = await readFile(configPath, 'utf8');
      rawConfig = parseYaml(content);
    } catch (err) {
      this.error(`Failed to read --config: ${(err as Error).message}`, { exit: 2 });
    }
    const configResult = await validateProductInitDocument(rawConfig);
    if (!configResult.ok) {
      for (const e of configResult.errors) {
        this.error(`${flags.config}${e.path}: ${e.message} (${e.keyword})`, {
          exit: false,
        });
      }
      this.exit(2);
    }
    const config = validateProductInitConfig(rawConfig as ProductInitConfig);

    // Visibility: CLI flag not exposed in M2a, fall back to config or default.
    const visibility = config.repository?.visibility ?? 'private';

    const platform: ProductInitInput['platform'] = {
      repository: platformRepo,
    };
    if (flags['platform-ref']) {
      platform.ref = flags['platform-ref'];
    }
    const input: ProductInitInput = {
      product: args.product,
      target: {
        owner: flags.owner,
        repo: args.product,
        visibility,
      },
      mode: 'monorepo',
      platform,
      config,
    };

    try {
      if (flags['finalize-protection']) {
        // --finalize-protection path: does not take a plan, does not write
        // a repo. Recovers platform identity from template.lock + org
        // ruleset, verifies all evidence, then hardens.
        if (flags['dry-run']) {
          this.error('--finalize-protection cannot be combined with --dry-run', { exit: 2 });
        }
        const client = createGitHubRequestClient(githubToken as string);
        const reader = createReadonlyGitHubPort(client);
        const writer = createWriteGitHubPort(client);

        const finalizeConfig: FinalizeConfig = {
          bootstrapApprovers: config.bootstrap.approvers,
        };

        const result = await finalizeProtection(
          { owner: flags.owner, repo: args.product, visibility },
          { reader, writer },
          finalizeConfig,
        );

        if (flags.format === 'json') {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          this.log(renderFinalizeResult(result));
        }

        const hasBlocked = result.operations.some((o) => o.disposition === 'blocked');
        if (hasBlocked) process.exitCode = 3;
        else if (result.phase !== 'COMPLETE') process.exitCode = 4;
        return;
      }

      if (!flags['dry-run']) {
        const client = createGitHubRequestClient(githubToken as string);
        const reader = createReadonlyGitHubPort(client);
        const writer = createWriteGitHubPort(client);
        const plan = await compileInitPlan(input, reader);
        const result = await applyInitPlan(input, plan, {
          reader,
          writer,
          stopAfterSnapshot: true,
        });
        if (flags.format === 'json') {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          this.log(renderTextResult(result));
        }
        const hasConflict = result.operations.some(
          (operation) => operation.disposition === 'conflict',
        );
        if (hasConflict) process.exitCode = 5;
        else if (result.nextAction === 'blocked') process.exitCode = 3;
        return;
      }

      // dry-run uses only local commit blobs and never constructs a writer.
      const reader = await createLocalFsReader();
      const plan = await compileInitPlan(input, reader);

      // Post-process warnings: surface that teams aren't verified in local
      // mode and that --platform-repo was defaulted.
      if (!platformRepoExplicit) {
        plan.warnings.unshift(
          `--platform-repo defaulted to '${platformRepo}'; pass it explicitly for production runs.`,
        );
      }
      const uncheckedTeams = plan.requirements.filter(
        (r) => r.kind === 'team' && r.status === 'missing',
      );
      if (uncheckedTeams.length > 0) {
        plan.warnings.push(
          `本地模式下无法校验 team 存在性（${uncheckedTeams.length} 个 team 标记为 missing）；实际执行前将由 GitHub API 验证。`,
        );
      }
      if (flags.format === 'json') {
        process.stdout.write(serializeInitPlan(plan));
      } else {
        this.log(renderTextPlan(plan));
      }
    } catch (err) {
      const error = err as Error & { status?: number; transient?: boolean };
      const status = error.status;
      const exit =
        error.transient === true ||
        status === 429 ||
        (status !== undefined && status >= 500) ||
        /rate limit/i.test(error.message)
          ? 6
          : status === 401 || status === 403
            ? 3
            : status === 409 || status === 422 || /conflict|marker mismatch/i.test(error.message)
              ? 5
              : 2;
      this.error(error.message, { exit });
    }
  }
}

function renderFinalizeResult(result: InitResult): string {
  const lines = [
    '# sdd product init --finalize-protection',
    '',
    `phase:       ${result.phase}`,
    `next_action: ${result.nextAction}`,
  ];
  if (result.repository) {
    lines.push(`repository:  ${result.repository.owner}/${result.repository.name}`);
  }
  if (result.mainSha) lines.push(`main:        ${result.mainSha}`);
  lines.push('', '## Evidence & operations');
  for (const operation of result.operations) {
    const resultSuffix = operation.result ? ` — ${operation.result}` : '';
    lines.push(
      `  [${operation.disposition.padEnd(8)}] ${operation.phase.padEnd(16)} ${operation.kind}${resultSuffix}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderTextResult(result: InitResult): string {
  const lines = [
    '# sdd product init',
    '',
    `phase:       ${result.phase}`,
    `next_action: ${result.nextAction}`,
  ];
  if (result.repository) {
    lines.push(`repository:  ${result.repository.owner}/${result.repository.name}`);
  }
  if (result.mainSha) lines.push(`main:        ${result.mainSha}`);
  lines.push('', '## Operations');
  for (const operation of result.operations) {
    lines.push(
      `  [${operation.disposition.padEnd(8)}] ${operation.phase.padEnd(16)} ${operation.kind}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build a `GitHubReadPort` backed entirely by the local filesystem. Used for
 * dry-run previews: no network calls, fully deterministic.
 */
async function createLocalFsReader() {
  const { createLocalFsReadPort } = await import('../../local-reader.js');
  return createLocalFsReadPort();
}

/**
 * Render the plan as human-readable text.
 */
function renderTextPlan(plan: import('@sdd/factory').InitPlan): string {
  const lines: string[] = [];
  lines.push(`# sdd product init — dry-run`);
  lines.push('');
  lines.push(`operation_id: ${plan.operation_id}`);
  lines.push(
    `target:     ${plan.target.owner}/${plan.target.repository} (${plan.target.visibility})`,
  );
  lines.push(
    `source:     ${plan.source.repository}@${plan.source.resolved_commit}${plan.source.ref_pinned ? '' : ' (UNPINNED, preview only)'}`,
  );
  lines.push(`template:   ${plan.template.path}  tree=${plan.template.output_tree_sha256}`);
  lines.push('');

  if (plan.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of plan.warnings) lines.push(`  - ${w}`);
    lines.push('');
  }

  lines.push('## Operations');
  for (const op of plan.operations) {
    const extra = op.detail ? ` — ${op.detail}` : '';
    lines.push(`  [${op.disposition.padEnd(8)}] ${op.phase.padEnd(16)} ${op.kind}${extra}`);
  }
  lines.push('');

  lines.push('## Requirements');
  for (const r of plan.requirements) {
    lines.push(`  [${r.status.padEnd(9)}] ${r.kind}:${r.name}`);
  }
  lines.push('');

  lines.push(`## Template files (${plan.template.files.length})`);
  for (const f of plan.template.files) {
    lines.push(`  ${f.mode} ${f.render ? 'render' : 'verbatim'} ${f.target}`);
  }

  return `${lines.join('\n')}\n`;
}
