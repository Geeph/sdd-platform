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
import { Command, Flags } from '@oclif/core';
import type {
  RepoRef,
  ResolvedTemplate,
  ScaffoldAuthorization,
  ScaffoldPlan,
  ScaffoldProductObservation,
  ScaffoldProjects,
  ScaffoldReadPort,
} from '@sdd/factory';
import {
  compileScaffoldPlan,
  parseManifest,
  publishComponentBranch,
  sha256Hex,
  TEMPLATE_NAMES,
  upsertScaffoldPull,
  verifyRequiredWorkflowPin,
} from '@sdd/factory';
import { verifyGateApproval } from '@sdd/provenance';
import { validateProjectsDocument } from '@sdd/schemas';
import { parse as parseYaml } from 'yaml';
import { createGitHubRequestClient } from '../../github-client.js';

/**
 * Adapter: wrap a raw GitHubRequestClient to match provenance's OctokitLike
 * interface. The raw client returns bare JSON; Octokit wraps in { data }.
 * Each method below wraps the raw response accordingly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createOctokitAdapter(owner: string, repo: string): Promise<any> {
  const client = createGitHubRequestClient(process.env.GITHUB_TOKEN as string);
  async function r<T>(route: string, params: Record<string, unknown> = {}): Promise<{ data: T }> {
    const body = (await client.request(route, { owner, repo, ...params })) as T;
    return { data: body };
  }
  return {
    rest: {
      pulls: {
        get: (p: { pull_number: number }) => r(`GET /repos/{owner}/{repo}/pulls/${p.pull_number}`),
        listReviews: (p: { pull_number: number; per_page?: number; page?: number }) =>
          r(`GET /repos/{owner}/{repo}/pulls/${p.pull_number}/reviews`, {
            per_page: p.per_page,
            page: p.page,
          }),
        listFiles: (p: { pull_number: number; per_page?: number; page?: number }) =>
          r(`GET /repos/{owner}/{repo}/pulls/${p.pull_number}/files`, {
            per_page: p.per_page,
            page: p.page,
          }),
      },
      repos: {
        getBranch: (p: { branch: string }) => r(`GET /repos/{owner}/{repo}/branches/${p.branch}`),
        listPullRequestsAssociatedWithCommit: (p: {
          commit_sha: string;
          per_page?: number;
          page?: number;
        }) =>
          r(`GET /repos/{owner}/{repo}/commits/${p.commit_sha}/pulls`, {
            per_page: p.per_page,
            page: p.page,
          }),
        getCollaboratorPermissionLevel: (p: { username: string }) =>
          r(`GET /repos/{owner}/{repo}/collaborators/${p.username}/permission`),
      },
      checks: {
        listForRef: (p: { ref: string; per_page?: number; page?: number }) =>
          r(`GET /repos/{owner}/{repo}/commits/${p.ref}/check-runs`, {
            per_page: p.per_page,
            page: p.page,
          }),
      },
      teams: {
        getByName: (p: { org: string; team_slug: string }) =>
          (async () => {
            const body = (await client.request(`GET /orgs/${p.org}/teams/${p.team_slug}`)) as {
              id: number;
              slug: string;
              privacy?: string;
            };
            return { data: body };
          })(),
        checkPermissionsForRepoInOrg: (p: {
          org: string;
          team_slug: string;
          owner: string;
          repo: string;
          headers?: { accept: string };
        }) =>
          (async () => {
            const body = (await client.request(
              `GET /orgs/${p.org}/teams/${p.team_slug}/repos/${p.owner}/${p.repo}`,
              p.headers ? { headers: p.headers } : undefined,
            )) as {
              permissions?: {
                admin: boolean;
                pull: boolean;
                push: boolean;
                triage?: boolean;
                maintain?: boolean;
              };
              role_name?: string;
            };
            return { data: body };
          })(),
        listMembersInOrg: (p: {
          org: string;
          team_slug: string;
          per_page?: number;
          page?: number;
        }) =>
          (async () => {
            const body = (await client.request(`GET /orgs/${p.org}/teams/${p.team_slug}/members`, {
              per_page: p.per_page,
              page: p.page,
            })) as Array<{ login: string }>;
            return { data: body };
          })(),
      },
    },
  };
}

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

  function gitBytes(args: string[]): Buffer {
    return execFileSync('git', args, {
      cwd: platformPath,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024, // 50 MB for large files
    });
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
      const rawBytes = gitBytes(['show', `${commit}:${manifestPath}`]);
      const manifest = parseManifest(JSON.parse(rawBytes.toString('utf8')));
      const entries: Array<{ path: string; mode: '100644' | '100755'; content: Uint8Array }> = [];
      for (const mf of manifest.files) {
        const content = gitBytes(['show', `${commit}:${manifest.path}/${mf.path}`]);
        const actualSha256 = sha256Hex(content);
        if (actualSha256 !== mf.sha256) {
          throw new Error(
            `checksum mismatch on ${mf.path}: manifest=${mf.sha256}, actual=${actualSha256}`,
          );
        }
        entries.push({
          path: mf.path,
          mode: mf.mode,
          content: new Uint8Array(content),
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

function getPlatformHeadCommit(): string | undefined {
  const plat = resolvePlatformRoot();
  return plat?.headCommit;
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

      // Build observation: populate existingPaths from the product repo checkout.
      const existingPaths = new Set<string>();
      try {
        const lsTree = execFileSync('git', ['ls-tree', '--name-only', '-r', 'HEAD'], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        for (const line of lsTree.split('\n')) {
          if (line) existingPaths.add(line);
        }
      } catch {
        // If git fails (e.g., bare checkout), assume nothing exists.
      }

      const observation: ScaffoldProductObservation = {
        mainSha: '',
        mainTreeSha: '',
        mainProjectsYamlBlobSha: null,
        existingPaths,
        sourceTemplates,
      };

      // Read-only authorization check (dry-run but with approval refs).
      if (hasApproval) {
        try {
          const { createLocalGitReader } = await import('../../git-reader.js');
          const gitReader = createLocalGitReader({ repoRoot });
          // Only verify if the product repo can provide the necessary data.
          await gitReader.blobAt('HEAD', flags.projects).catch(() => null);
          authorization.reason =
            'dry-run: approval reference supplied but full verification not performed offline';
        } catch {
          authorization.reason = 'dry-run: could not verify approval locally';
        }
      }

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
          ...(getPlatformHeadCommit() ? { resolved_commit: getPlatformHeadCommit()! } : {}),
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
      const octokit = await createOctokitAdapter(remoteOwner, remoteRepo);
      const rawClient = createGitHubRequestClient(process.env.GITHUB_TOKEN as string);
      const { createLocalGitReader } = await import('../../git-reader.js');
      const gitReader = createLocalGitReader({ repoRoot });

      const generatorCommit = getPlatformHeadCommit();
      if (!generatorCommit || !/^[0-9a-f]{40}$/i.test(generatorCommit)) {
        this.error(
          'Generator pin check failed: this build does not contain a full platform commit SHA.',
          { exit: 7 },
        );
        return;
      }
      try {
        await verifyRequiredWorkflowPin({
          octokit: rawClient,
          target: { owner: remoteOwner, repo: remoteRepo },
          platform: { owner: platformParts[0]!, repo: platformParts[1]! },
          generatorCommit,
        });
      } catch (error) {
        this.error(`Generator pin check failed: ${(error as Error).message}`, { exit: 7 });
        return;
      }

      // Verify the ApprovalRef is correctly formed.
      let approvalRef: { pr: number } | { mergeCommitSha: string };
      if (flags['architecture-pr']) {
        approvalRef = { pr: flags['architecture-pr'] };
      } else {
        approvalRef = { mergeCommitSha: flags['architecture-merge-sha'] as string };
      }

      this.log('Verifying Architecture Gate approval...');
      const verifyResult = await verifyGateApproval({
        octokit,
        git: gitReader,
        repo: { owner: remoteOwner, name: remoteRepo },
        gate: 'architecture',
        version: flags['architecture-version'] as string,
        approval: approvalRef,
        artifactPath: flags.projects,
      });

      if (!verifyResult.ok) {
        authorization.verified = false;
        authorization.reason = verifyResult.reason ?? 'authorization failed';
        this.error(
          `Authorization failed: ${authorization.reason}\nscaffold aborted — no writes performed.`,
          { exit: 7 },
        );
        return;
      }

      const architecturePr = (await rawClient.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner: remoteOwner,
          repo: remoteRepo,
          pull_number: verifyResult.provenance.pr,
        },
      )) as { labels?: Array<{ name?: string }> };
      const versionLabels = (architecturePr.labels ?? [])
        .map((label) => label.name ?? '')
        .filter((label) => label.startsWith('version:'));
      const expectedVersion = `version:${flags['architecture-version'] as string}`;
      if (versionLabels.length !== 1 || versionLabels[0] !== expectedVersion) {
        this.error(
          `Authorization failed: Architecture Gate PR must have exactly one '${expectedVersion}' label.`,
          { exit: 7 },
        );
        return;
      }

      authorization.verified = true;
      authorization.reason = null;

      this.log('Authorization verified. Resolving templates from platform repo...');

      // Read main tree for existing path check (D18 main freshness).
      const mainResp = (await rawClient.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: remoteOwner,
        repo: remoteRepo,
        ref: 'heads/main',
      })) as { object: { sha: string } };
      const mainCommitSha = mainResp.object.sha;

      const mainCommitResp = (await rawClient.request(
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        { owner: remoteOwner, repo: remoteRepo, commit_sha: mainCommitSha },
      )) as { sha: string; tree: { sha: string } };
      const mainTreeSha = mainCommitResp.tree.sha;

      // D18: main freshness — verify remote projects.yaml matches local.
      // Fail-closed: missing sha → cannot verify freshness → reject.
      const remoteBlobResp = (await rawClient.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: remoteOwner,
        repo: remoteRepo,
        path: flags.projects,
        ref: mainCommitSha,
        mediaType: { format: 'raw' },
      })) as { content?: string; sha?: string };
      if (!remoteBlobResp.sha) {
        this.error('Main freshness check failed: remote projects.yaml has no sha (cannot verify)', {
          exit: 7,
        });
        return;
      }
      const localBlobSha = await gitReader.blobWorktree(flags.projects);
      if (remoteBlobResp.sha !== localBlobSha) {
        authorization.main_fresh = false;
        authorization.verified = false;
        authorization.reason =
          'projects.yaml differs from remote main — local may be stale or a newer Architecture Gate may have been merged';
        this.error(`Main freshness check failed: ${authorization.reason}`, { exit: 7 });
        return;
      }
      authorization.main_fresh = true;

      // Enumerate main tree to find existing paths.
      const mainTree = (await rawClient.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
        owner: remoteOwner,
        repo: remoteRepo,
        tree_sha: mainTreeSha,
        recursive: '1',
      })) as { tree: Array<{ path: string; type: string }> };
      const existingPaths = new Set<string>();
      for (const entry of mainTree.tree) {
        existingPaths.add(entry.path);
      }

      // D23: verify owner teams exist and have members.
      const teamSlugs = new Set(projects.components.map((c) => c.owner));
      for (const slug of teamSlugs) {
        try {
          const membersResp = (await octokit.rest.teams.listMembersInOrg({
            org: remoteOwner,
            team_slug: slug,
            per_page: 1,
          })) as { data: Array<{ login: string }> };
          if (!membersResp.data || membersResp.data.length === 0) {
            this.error(`Team '${slug}' has no active members — cannot assign as reviewer (D23).`, {
              exit: 3,
            });
            return;
          }
        } catch (err) {
          this.error(
            `Team '${slug}' does not exist or is inaccessible (D23): ${(err as Error).message}`,
            { exit: 3 },
          );
          return;
        }
      }

      // Resolve templates from platform repo, verifying checksums.
      const sourceTemplates = new Map<string, ResolvedTemplate>();
      for (const comp of projects.components) {
        const tmplName = comp.template;
        const tmplPath = `templates/${tmplName}`;
        const manifestResp = (await rawClient.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: platformParts[0]!,
          repo: platformParts[1]!,
          path: `${tmplPath}.manifest.json`,
          ref: comp.template_ref,
          mediaType: { format: 'raw' },
        })) as { content?: string };
        if (!manifestResp.content) {
          this.error(
            `Component '${comp.id}': manifest not found for ${tmplName} at ${comp.template_ref}`,
            { exit: 5 },
          );
          return;
        }
        const manifest = parseManifest(
          JSON.parse(Buffer.from(manifestResp.content, 'base64').toString('utf8')),
        );
        const entries: Array<{ path: string; mode: '100644' | '100755'; content: Uint8Array }> = [];
        const errors: string[] = [];
        for (const mf of manifest.files) {
          const fileResp = (await rawClient.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: platformParts[0]!,
            repo: platformParts[1]!,
            path: `${tmplPath}/${mf.path}`,
            ref: comp.template_ref,
            mediaType: { format: 'raw' },
          })) as { content?: string };
          if (!fileResp.content) {
            throw new Error(`file ${mf.path} not found in ${tmplName} at ${comp.template_ref}`);
          }
          const content = Buffer.from(fileResp.content, 'base64');
          const actual = sha256Hex(content);
          if (actual !== mf.sha256) {
            errors.push(`checksum mismatch on ${mf.path}: expected ${mf.sha256}, got ${actual}`);
          }
          entries.push({ path: mf.path, mode: mf.mode, content: new Uint8Array(content) });
        }
        if (errors.length > 0) {
          this.error(
            `Component '${comp.id}' template checksum verification failed:\n${errors.join('\n')}`,
            { exit: 5 },
          );
          return;
        }
        sourceTemplates.set(comp.id, {
          componentId: comp.id,
          commit: comp.template_ref,
          manifest,
          tree: entries,
          sourceTreeSha256: manifest.tree_sha256,
        });
      }

      const observation: ScaffoldProductObservation = {
        mainSha: mainCommitSha,
        mainTreeSha,
        mainProjectsYamlBlobSha: remoteBlobResp.sha ?? null,
        existingPaths,
        sourceTemplates,
      };

      // Compile plan.
      const compiled = compileScaffoldPlan({
        target: { owner: remoteOwner, name: remoteRepo, defaultBranch: 'main' },
        source: platformRepo,
        projects,
        observation,
        localProjectsBlobSha: localBlobSha,
        authorization,
        ...(flags['architecture-pr'] || flags['architecture-merge-sha']
          ? {
              approval: {
                ...(flags['architecture-pr'] ? { pr: flags['architecture-pr'] } : {}),
                ...(flags['architecture-merge-sha']
                  ? { mergeCommitSha: flags['architecture-merge-sha'] }
                  : {}),
              } as { pr?: number; mergeCommitSha?: string },
            }
          : {}),
        ...(flags['architecture-version'] ? { version: flags['architecture-version'] } : {}),
        ...(verifyResult.ok
          ? {
              provenance: verifyResult.provenance,
            }
          : {}),
        generator: {
          package: '@sdd/factory',
          version: '0.1.0',
          resolved_commit: generatorCommit,
        },
      });

      // Publish branch and PR.
      const pendingComponents = compiled.plan.components.filter((c) => c.disposition === 'create');
      if (pendingComponents.length === 0) {
        this.log('No pending components to scaffold. Nothing to do.');
        this.exit(0);
        return;
      }

      const branchName = compiled.plan.operations.find((o) => o.kind === 'branch.create')?.target;
      if (!branchName) {
        this.error('No branch operation in plan — cannot publish.', { exit: 5 });
        return;
      }

      const files: Array<{ path: string; mode: '100644' | '100755'; content: Uint8Array }> = [];
      const allowedPaths = new Set<string>();
      for (const comp of pendingComponents) {
        const renderedComp = compiled.rendered.get(comp.id);
        const lockContent = compiled.lockContents.get(comp.id);
        if (!renderedComp || !lockContent) continue;
        allowedPaths.add(comp.path);
        for (const rf of renderedComp.files) {
          files.push({
            path: `${comp.path}/${rf.path}`,
            mode: rf.mode,
            content: rf.content,
          });
        }
        files.push({
          path: `${comp.path}/template.lock`,
          mode: '100644',
          content: new TextEncoder().encode(lockContent),
        });
      }

      // D20: check if branch already exists before creating it.
      let branchExists = false;
      try {
        await rawClient.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner: remoteOwner,
          repo: remoteRepo,
          ref: `heads/${branchName}`,
        });
        branchExists = true;
      } catch (err) {
        // Only HTTP 404 means branch doesn't exist. Any other error
        // (network, 403, 500) is a real failure — surface it.
        const httpStatus = (err as { status?: number }).status;
        if (httpStatus !== 404) throw err;
      }

      if (!branchExists) {
        this.log(`Publishing branch ${branchName}...`);
        await publishComponentBranch(rawClient, {
          target: { owner: remoteOwner, repo: remoteRepo },
          baseTreeSha: mainTreeSha,
          baseCommitSha: mainCommitSha,
          branchName,
          files,
          commitMessage: `sdd-scaffold: ${pendingComponents.map((c) => c.id).join(', ')}`,
          allowedPaths,
        });
      } else {
        this.log(`Branch ${branchName} already exists — skipping branch creation (D20).`);
      }

      // Open PR (idempotent — upsertScaffoldPull checks for existing).
      const prResult = await upsertScaffoldPull(rawClient, {
        target: { owner: remoteOwner, repo: remoteRepo },
        headBranch: branchName,
        baseBranch: 'main',
        title: `sdd-scaffold: ${pendingComponents.map((c) => c.id).join(', ')}`,
        body: `Scaffold PR generated by sdd product scaffold.\n\noperation_id: ${compiled.plan.operation_id}`,
        teamReviewers: [...new Set(pendingComponents.map((c) => c.owner))],
        expectedHeadRepo: { owner: remoteOwner, repo: remoteRepo },
        expectedBaseRef: 'main',
      });

      this.log(`Scaffold PR #${prResult.number} created: ${prResult.htmlUrl}`);
      this.log('Awaiting human review and merge.');
      this.exit(4);
      return;
    } catch (err) {
      // Re-throw oclif exit/error signals so exit codes propagate correctly.
      const cliErr = err as { oclif?: { exit?: number }; code?: string; exitCode?: number };
      if (cliErr.oclif?.exit !== undefined || cliErr.code === 'EEXIT') throw err;
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
