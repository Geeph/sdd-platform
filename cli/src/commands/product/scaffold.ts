/**
 * `sdd product scaffold` — generate component directories from approved
 * projects.yaml (M3).
 *
 * M3 Phase 2: read-side (dry-run) + preflight.
 *
 * Flags:
 *   --repo <path>           Target product repo checkout (default `.`).
 *   --projects <path>       Path to projects.yaml (default `projects.yaml`).
 *   --platform-repo <o/r>   Platform repo (owner/repo).
 *   --architecture-pr <n>   Gate PR number (one of pr/merge-sha required
 *                           for real execution; dry-run can omit).
 *   --architecture-merge-sha <sha>  Gate merge commit SHA.
 *   --architecture-version <v>      Version label (e.g. `v1`).
 *   --format text|json      Output format (default text).
 *   --dry-run               Preview only; zero GitHub writes.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import type { ScaffoldAuthorization, ScaffoldPlan } from '@sdd/factory';
import { sha256Hex } from '@sdd/factory';
import { validateProjectsDocument } from '@sdd/schemas';
import { parse as parseYaml } from 'yaml';

const DEFAULT_PLATFORM_REPO_NAME = 'sdd-platform';

export default class ProductScaffold extends Command {
  static override description = 'Generate component directories from approved projects.yaml (M3)';

  static override examples = [
    '<%= config.bin %> product scaffold --repo . --platform-repo acme/sdd-platform --dry-run --format json',
  ];

  static override flags = {
    repo: Flags.string({
      description: 'Target product repo checkout (default `.`)',
      default: '.',
    }),
    projects: Flags.string({
      description: 'Path to projects.yaml (default `projects.yaml`)',
      default: 'projects.yaml',
    }),
    'platform-repo': Flags.string({
      description: "Platform repo as 'owner/repo'. Defaults to '<org>/sdd-platform'.",
    }),
    'architecture-pr': Flags.integer({
      description: 'Architecture Gate PR number',
    }),
    'architecture-merge-sha': Flags.string({
      description: 'Architecture Gate merge commit SHA',
    }),
    'architecture-version': Flags.string({
      description: 'Version label (e.g. v1)',
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
  };

  static override args = {};

  async run(): Promise<void> {
    const { flags } = await this.parse(ProductScaffold);

    // Real execution requires approval + version.
    if (!flags['dry-run']) {
      if (!flags['architecture-pr'] && !flags['architecture-merge-sha']) {
        this.error('real execution requires --architecture-pr or --architecture-merge-sha', {
          exit: 2,
        });
      }
      if (!flags['architecture-version']) {
        this.error('real execution requires --architecture-version', { exit: 2 });
      }
      if (!process.env.GITHUB_TOKEN) {
        this.error('GITHUB_TOKEN environment variable is required', { exit: 2 });
      }
    }

    // Validate mutually exclusive approval flags.
    if (flags['architecture-pr'] && flags['architecture-merge-sha']) {
      this.error('provide only one of --architecture-pr or --architecture-merge-sha', {
        exit: 2,
      });
    }

    // Resolve the product repo root and derive org from git remote.
    const repoRoot = resolve(flags.repo);
    let remoteOwner: string;
    let remoteRepo: string;
    try {
      const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const match = remote.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
      if (!match) throw new Error(`could not parse remote URL: '${remote}'`);
      remoteOwner = match[1] as string;
      remoteRepo = match[2] as string;
    } catch (err) {
      this.error(`Failed to read product repo remote: ${(err as Error).message}`, {
        exit: 2,
      });
      return; // TypeScript control flow.
    }

    // Derive platform repo.
    const platformRepo = flags['platform-repo'] ?? `${remoteOwner}/${DEFAULT_PLATFORM_REPO_NAME}`;
    const platformParts = platformRepo.split('/');
    if (platformParts.length !== 2 || !platformParts[0] || !platformParts[1]) {
      this.error(`--platform-repo must be 'owner/repo': '${platformRepo}'`, { exit: 2 });
    }
    if (platformParts[0] !== remoteOwner) {
      this.error(
        `--platform-repo owner '${platformParts[0]}' must match product repo org '${remoteOwner}'`,
        { exit: 2 },
      );
    }

    // Load + validate projects.yaml via @sdd/schemas.
    let projectsRaw: unknown;
    try {
      const projectsPath = resolve(repoRoot, flags.projects);
      const content = await readFile(projectsPath, 'utf8');
      projectsRaw = parseYaml(content);
    } catch (err) {
      this.error(`Failed to read projects.yaml: ${(err as Error).message}`, { exit: 2 });
      return;
    }

    const projectsResult = await validateProjectsDocument(projectsRaw);
    if (!projectsResult.ok) {
      for (const e of projectsResult.errors) {
        this.error(`${flags.projects}${e.path}: ${e.message} (${e.keyword})`, {
          exit: false,
        });
      }
      this.exit(2);
      return;
    }
    const projects = projectsRaw as {
      schema_version: 1;
      product: string;
      repository_mode: 'monorepo';
      components: Array<{
        id: string;
        path: string;
        template: 'spring-boot' | 'web' | 'ios-tuist' | 'android';
        template_ref: string;
        owner: string;
        ci: 'java' | 'web' | 'ios' | 'android';
      }>;
    };

    // Build the authorization block.
    const authorization: ScaffoldAuthorization = {
      gate: 'architecture',
      version: flags['architecture-version'] ?? null,
      artifact_path: flags.projects,
      main_fresh: true, // Placeholder — real check in preflight.
      verified: false,
      reason:
        flags['dry-run'] && !flags['architecture-pr'] && !flags['architecture-merge-sha']
          ? 'no approval reference supplied'
          : 'not verified (dry-run preflight not yet implemented)',
    };

    // Build a minimal plan.
    const plan: ScaffoldPlan = {
      plan_version: 1,
      operation_id: sha256Hex(
        JSON.stringify({
          target: { owner: remoteOwner, name: remoteRepo },
          source: { repository: platformRepo },
          components: projects.components
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((c) => ({ id: c.id, path: c.path, template: c.template })),
        }),
      ),
      target: {
        owner: remoteOwner,
        repository: remoteRepo,
        default_branch: 'main',
      },
      source: { repository: platformRepo },
      authorization,
      components: projects.components
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => ({
          id: c.id,
          path: c.path,
          owner: c.owner,
          template: c.template,
          disposition: 'create' as const,
        })),
      operations: [],
      warnings: [],
    };

    if (flags.format === 'json') {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      this.log(renderScaffoldPlan(plan));
    }
  }
}

function renderScaffoldPlan(plan: ScaffoldPlan): string {
  const lines: string[] = [];
  lines.push(`# sdd product scaffold — plan`);
  lines.push(`operation_id: ${plan.operation_id}`);
  lines.push(`target: ${plan.target.owner}/${plan.target.repository}`);
  lines.push(`source: ${plan.source.repository}`);
  lines.push(`authorization.verified: ${plan.authorization.verified}`);
  if (plan.authorization.reason) {
    lines.push(`authorization.reason: ${plan.authorization.reason}`);
  }
  lines.push('');
  lines.push(`## Components (${plan.components.length})`);
  for (const c of plan.components) {
    lines.push(`  - ${c.id} (${c.path}) [${c.template}] → ${c.disposition}`);
  }
  if (plan.operations.length > 0) {
    lines.push('');
    lines.push(`## Operations (${plan.operations.length})`);
    for (const op of plan.operations) {
      lines.push(`  ${op.order}. [${op.phase}] ${op.kind}: ${op.target}`);
    }
  }
  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    for (const w of plan.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join('\n');
}
