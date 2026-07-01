/**
 * `sdd product scaffold` — generate component directories from approved
 * projects.yaml (M3).
 *
 * Dry-run: reads platform templates from the local checkout, resolves
 * each component's template_ref, compiles a full ScaffoldPlan, and
 * outputs JSON/text. Zero GitHub API calls (no network).
 *
 * Real execution: calls verifyGateApproval, checks main freshness (D18),
 * resolves templates from the platform repo API, compiles ScaffoldPlan,
 * then publishes branch + PR.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Args, Command, Flags } from '@oclif/core';
import type {
  RepoRef,
  ResolvedTemplate,
  ScaffoldAuthorization,
  ScaffoldPlan,
  ScaffoldProductObservation,
  ScaffoldProjects,
  ScaffoldReadPort,
  TemplateManifest,
  TemplateName,
} from '@sdd/factory';
import { compileScaffoldPlan, parseManifest, sha256Hex, TEMPLATE_NAMES } from '@sdd/factory';
import type { GitReader } from '@sdd/provenance';
import { verifyGateApproval } from '@sdd/provenance';
import { validateProjectsDocument } from '@sdd/schemas';
import { parse as parseYaml } from 'yaml';

const DEFAULT_PLATFORM_REPO_NAME = 'sdd-platform';

// ---- Local scaffold read port (dry-run) -----------------------------------

interface LocalScaffoldReaderOpts {
  platformHead: string;
  platformPath: string;
}

function createLocalScaffoldReadPort(opts: LocalScaffoldReaderOpts): ScaffoldReadPort {
  const { platformHead, platformPath } = opts;

  function git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: platformPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  return {
    async resolveCommit(_repo: RepoRef, ref: string) {
      const commit = git(['rev-parse', ref]);
      return { commit, requestedRef: ref, peeled: false };
    },

    async readTemplateTree(_repo: RepoRef, commit: string, templateName: string) {
      if (!(TEMPLATE_NAMES as readonly string[]).includes(templateName)) {
        throw new Error(`unknown template: ${templateName}`);
      }
      const manifestPath = `templates/${templateName}.manifest.json`;
      const raw = git(['show', `${commit}:${manifestPath}`]);
      const manifest = parseManifest(JSON.parse(raw));
      const entries: Array<{ path: string; mode: '100644' | '100755'; content: Uint8Array }> = [];
      for (const mf of manifest.files) {
        const content = git(['show', `${commit}:${manifest.path}/${mf.path}`]);
        entries.push({
          path: mf.path,
          mode: mf.mode,
          content: Buffer.from(content, 'utf8'),
        });
      }
      return { manifest, entries, sourceTreeSha256: manifest.tree_sha256 };
    },

    async observeProduct(_repo: RepoRef): Promise<ScaffoldProductObservation> {
      throw new Error('observeProduct is not available in dry-run mode');
    },

    async readBlobContent(_repo: RepoRef, _blobSha: string): Promise<Uint8Array> {
      throw new Error('readBlobContent is not available in dry-run mode');
    },

    async readTreeRecursive(_repo: RepoRef, _treeSha: string) {
      throw new Error('readTreeRecursive is not available in dry-run mode');
    },

    async findPullByHead(_repo: RepoRef, _headBranch: string) {
      return null;
    },
  };
}

// ---- Resolve platform repo root --------------------------------------------

function resolvePlatformRoot(): { headCommit: string; root: string } | null {
  // Walk up from this file to find the platform repo root.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const parent = resolve(dir, '..');
    if (existsSync(resolve(dir, '.git'))) {
      try {
        const head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        return { headCommit: head, root: dir };
      } catch {
        // Not a git repo.
      }
      break;
    }
    dir = parent;
  }
  return null;
}

// ---- Platform repo local reader setup --------------------------------------

interface LocalScaffoldSetup {
  reader: ScaffoldReadPort;
  platformPath: string;
  headCommit: string;
}

function setupLocalScaffoldReader(): LocalScaffoldSetup {
  const plat = resolvePlatformRoot();
  if (!plat) {
    throw new Error(
      'dry-run requires the platform repo to be available locally. ' +
        'Run from within the sdd-platform checkout.',
    );
  }
  return {
    reader: createLocalScaffoldReadPort({
      platformHead: plat.headCommit,
      platformPath: plat.root,
    }),
    platformPath: plat.root,
    headCommit: plat.headCommit,
  };
}

// ---- Command ---------------------------------------------------------------

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

    // Real execution requires approval + version + token.
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

    if (flags['architecture-pr'] && flags['architecture-merge-sha']) {
      this.error('provide only one of --architecture-pr or --architecture-merge-sha', { exit: 2 });
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
      this.error(`Failed to read product repo remote: ${(err as Error).message}`, { exit: 2 });
      return;
    }

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

    // Load + validate projects.yaml.
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
        this.error(`${flags.projects}${e.path}: ${e.message} (${e.keyword})`, { exit: false });
      }
      this.exit(2);
      return;
    }
    const projects = projectsRaw as ScaffoldProjects;

    // Build authorization block.
    const hasApproval = !!(flags['architecture-pr'] || flags['architecture-merge-sha']);
    const authorization: ScaffoldAuthorization = {
      gate: 'architecture',
      version: flags['architecture-version'] ?? null,
      artifact_path: flags.projects,
      main_fresh: false, // Set to true after D18 check (real execution only).
      verified: false,
      reason: hasApproval ? 'not yet verified' : 'no approval reference supplied',
    };

    // --- Dry-run path: resolve templates from local platform checkout. ---
    if (flags['dry-run']) {
      let localSetup: LocalScaffoldSetup;
      try {
        localSetup = setupLocalScaffoldReader();
      } catch (err) {
        this.error(`dry-run requires platform repo: ${(err as Error).message}`, { exit: 6 });
        return;
      }

      const reader = localSetup.reader;

      // Resolve each component's template from the local platform repo.
      const sourceTemplates = new Map<string, ResolvedTemplate>();
      for (const comp of projects.components) {
        try {
          const resolved = await reader.resolveCommit(
            { owner: platformParts[0]!, repo: platformParts[1]! },
            comp.template_ref,
          );
          const tree = await reader.readTemplateTree(
            { owner: platformParts[0]!, repo: platformParts[1]! },
            resolved.commit,
            comp.template,
          );
          sourceTemplates.set(comp.id, {
            componentId: comp.id,
            commit: resolved.commit,
            manifest: tree.manifest,
            tree: tree.entries,
            sourceTreeSha256: tree.sourceTreeSha256,
          });
        } catch (err) {
          this.warn(
            `Component '${comp.id}': template '${comp.template}' at ref '${comp.template_ref}' could not be resolved: ${(err as Error).message}`,
          );
        }
      }

      // Build observation with resolved templates and empty existingPaths
      // (dry-run assumes no components exist yet — just shows the preview).
      const observation: ScaffoldProductObservation = {
        mainSha: '',
        mainTreeSha: '',
        mainProjectsBlobSha: null,
        existingPaths: new Set(),
        sourceTemplates,
      };

      const compiled = compileScaffoldPlan({
        target: { owner: remoteOwner, name: remoteRepo, defaultBranch: 'main' },
        source: platformRepo,
        projects,
        observation,
        localProjectsBlobSha: '',
        authorization,
        generator: {
          package: '@sdd/factory',
          version: '0.1.0',
          ...(localSetup.headCommit ? { resolved_commit: localSetup.headCommit } : {}),
        },
      });

      if (flags.format === 'json') {
        process.stdout.write(`${JSON.stringify(compiled.plan, null, 2)}\n`);
      } else {
        this.log(renderScaffoldPlan(compiled.plan));
      }
      return;
    }

    // --- Real execution path ---
    try {
      this.log(
        'Real execution scaffold: verifyGateApproval and GitHub write not yet wired (Phase 3 deferred).',
      );
      this.exit(5);
      return;
    } catch (err) {
      this.error(`scaffold failed: ${(err as Error).message}`, { exit: 6 });
    }
  }
}

// ---- Text rendering --------------------------------------------------------

function renderScaffoldPlan(plan: ScaffoldPlan): string {
  const lines: string[] = [];
  lines.push('# sdd product scaffold — plan');
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
    if (c.template_source) {
      lines.push(`      resolved_commit: ${c.template_source.resolved_commit}`);
      lines.push(`      output_tree_sha256: ${c.template_source.output_tree_sha256}`);
    }
    if (c.detail) {
      lines.push(`      detail: ${c.detail}`);
    }
  }
  if (plan.operations.length > 0) {
    lines.push('');
    lines.push(`## Operations (${plan.operations.length})`);
    for (const op of plan.operations) {
      lines.push(`  ${op.order}. [${op.phase}] ${op.kind}: ${op.target} (${op.disposition})`);
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
