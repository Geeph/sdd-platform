/**
 * `sdd product init` — bootstrap a product repository.
 *
 * M2a scope: only `--dry-run` is implemented. The real execution path is
 * stubbed (prints "not implemented in M2a").
 *
 * Flags:
 *   --dry-run             Required in M2a; zero GitHub writes.
 *   --format text|json    Output format (default text).
 *   --owner <org>         Target GitHub org (required).
 *   --mode monorepo       Only "monorepo" supported.
 *   --platform-ref <ref>  Release tag or full commit SHA (optional in
 *                         dry-run; required for real execution).
 *   --config <path>       Path to product-init.yaml (required).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import type { ProductInitConfig, ProductInitInput } from '@sdd/factory';
import { validateProductInitDocument } from '@sdd/schemas';
import { parse as parseYaml } from 'yaml';
import { compileInitPlan, serializeInitPlan, validateProductInitConfig } from '../../init-lib.js';

export default class ProductInit extends Command {
  static override description = 'Bootstrap a product repository (M2a: dry-run only)';

  static override examples = [
    '<%= config.bin %> product init demo --owner acme --mode monorepo --config product-init.yaml --dry-run --format json',
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
      description: 'Preview only; zero GitHub writes (M2a only supports this mode)',
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

    if (!flags['dry-run']) {
      this.error('Real execution is not implemented in M2a. Use --dry-run to preview.', {
        exit: 2,
      });
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
      repository: 'acme/sdd-platform', // Placeholder; in M2b/c this is a flag.
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

    // Compile the plan using the local-fs reader (no GitHub calls needed for
    // a deterministic preview against the local templates tree).
    try {
      const reader = await createLocalFsReader();
      const plan = await compileInitPlan(input, reader);
      if (flags.format === 'json') {
        process.stdout.write(serializeInitPlan(plan));
      } else {
        this.log(renderTextPlan(plan));
      }
    } catch (err) {
      this.error((err as Error).message, { exit: 2 });
    }
  }
}

/**
 * Build a `GitHubReadPort` backed entirely by the local filesystem. Used for
 * dry-run previews: no network calls, fully deterministic.
 */
async function createLocalFsReader() {
  // Lazy import to avoid bundling node:fs into browser targets.
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
