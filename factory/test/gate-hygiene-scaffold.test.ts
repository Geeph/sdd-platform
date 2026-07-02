import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { HygieneOctokit } from '../src/gate-hygiene.js';
import { checkPrHygiene } from '../src/gate-hygiene.js';
import { assembleTree, parseManifest, sha256Hex } from '../src/resolve.js';
import { renderComponent } from '../src/scaffold/render.js';
import type { ComponentLock } from '../src/scaffold/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = { owner: 'acme', repo: 'demo' };
const PLATFORM = { owner: 'acme', repo: 'sdd-platform' };
const WORKFLOW_COMMIT = 'd'.repeat(40);
const TEMPLATE_COMMIT = 'c'.repeat(40);
const SCAFFOLD_HEAD = 'a'.repeat(40);
const GATE_HEAD = 'e'.repeat(40);
const GATE_BASE = 'b'.repeat(40);
const GATE_MERGE = 'f'.repeat(40);

interface FixtureOptions {
  mutateLock?: (lock: ComponentLock) => void;
  mutateFiles?: (files: Map<string, Uint8Array>) => void;
  trustedWorkflow?: boolean;
  workflowPin?: string;
}

function fakeOctokit(
  handler: (route: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
): HygieneOctokit {
  return { request: async (route, params = {}) => handler(route, params) };
}

async function createFixture(options: FixtureOptions = {}) {
  const projectsYaml = `schema_version: 1
product: demo
repository_mode: monorepo
components:
  - id: backend
    path: apps/backend
    template: spring-boot
    template_ref: ${TEMPLATE_COMMIT}
    owner: backend-team
    ci: java
`;
  const manifestBytes = await readFile(resolve(ROOT, 'templates/spring-boot.manifest.json'));
  const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
  const entries = await Promise.all(
    manifest.files.map(async (file) => ({
      path: file.path,
      mode: file.mode,
      content: new Uint8Array(await readFile(resolve(ROOT, manifest.path, file.path))),
    })),
  );
  const tree = assembleTree(manifest, entries);
  const provenance = {
    gate: 'architecture' as const,
    version: 'v1',
    pr: 1,
    approved_head_sha: GATE_HEAD,
    merge_commit_sha: GATE_MERGE,
    approved_at: '2026-01-01T00:00:00Z',
    authorization_policy: 'current-codeowners' as const,
    required_checks: [],
  };
  const rendered = renderComponent({
    product: 'demo',
    repo: TARGET.repo,
    platformRepo: `${PLATFORM.owner}/${PLATFORM.repo}`,
    component: {
      id: 'backend',
      path: 'apps/backend',
      template: 'spring-boot',
      template_ref: TEMPLATE_COMMIT,
      owner: 'backend-team',
      ci: 'java',
    },
    resolvedTemplate: {
      componentId: 'backend',
      commit: TEMPLATE_COMMIT,
      manifest,
      tree: tree.entries,
      sourceTreeSha256: tree.sourceTreeSha256,
    },
    generator: {
      package: '@sdd/factory',
      version: '0.1.0',
      resolved_commit: WORKFLOW_COMMIT,
    },
    version: 'v1',
    provenance,
  });

  const lock = parseYaml(rendered.lockYaml) as ComponentLock;
  options.mutateLock?.(lock);
  const lockYaml = stringifyYaml(lock, { lineWidth: 0, sortMapEntries: false });
  const files = new Map<string, Uint8Array>(
    rendered.files.map((file) => [`apps/backend/${file.path}`, file.content]),
  );
  files.set('apps/backend/template.lock', new TextEncoder().encode(lockYaml));
  options.mutateFiles?.(files);

  const blobs = new Map<string, Uint8Array>();
  const treeEntries = [...files].map(([path, content], index) => {
    const sha = `blob-${index}`;
    blobs.set(sha, content);
    return { path, mode: path.endsWith('gradlew') ? '100755' : '100644', type: 'blob', sha };
  });
  treeEntries.push({ path: 'README.md', mode: '100644', type: 'blob', sha: 'outside' });

  const octokit = fakeOctokit(async (route, p) => {
    if (route === 'GET /repos/{owner}/{repo}') {
      return p.repo === TARGET.repo ? { id: 101 } : { id: 202 };
    }
    if (route === 'GET /orgs/{org}/rulesets') {
      return [{ id: 303, name: 'sdd-workflows-101' }];
    }
    if (route === 'GET /orgs/{org}/rulesets/{ruleset_id}') {
      return {
        enforcement: 'active',
        conditions: {
          repository_id: { repository_ids: [101] },
          ref_name: { include: ['refs/heads/main'], exclude: [] },
        },
        rules: [
          {
            type: 'workflows',
            parameters: {
              workflows: [
                {
                  repository_id: 202,
                  path: '.github/workflows/pr-hygiene.yml',
                  sha: options.workflowPin ?? WORKFLOW_COMMIT,
                },
              ],
            },
          },
        ],
      };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
      if (p.pull_number === 42) {
        return {
          number: 42,
          state: 'open',
          merged: false,
          merge_commit_sha: null,
          head: { sha: SCAFFOLD_HEAD, ref: 'sdd/scaffold' },
          base: { sha: GATE_MERGE, ref: 'main' },
          labels: [],
          body: null,
          user: { login: 'author' },
          merged_at: null,
        };
      }
      return {
        number: 1,
        state: 'closed',
        merged: true,
        merge_commit_sha: GATE_MERGE,
        head: { sha: GATE_HEAD, ref: 'architecture' },
        base: { sha: GATE_BASE, ref: 'main' },
        labels: [{ name: 'gate:architecture' }, { name: 'version:v1' }],
        merged_at: provenance.approved_at,
      };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files') {
      return p.pull_number === 42
        ? [{ filename: 'apps/backend/template.lock', status: 'added', additions: 50, deletions: 0 }]
        : [{ filename: 'projects.yaml', status: 'modified', sha: 'projects-blob' }];
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
      return [
        {
          id: 1,
          user: { login: 'alice' },
          state: 'APPROVED',
          commit_id: GATE_HEAD,
          author_association: 'MEMBER',
          submitted_at: provenance.approved_at,
        },
      ];
    }
    if (route === 'GET /repos/{owner}/{repo}/branches/{branch}') {
      return { name: 'main', protected: true, commit: { sha: GATE_MERGE } };
    }
    if (route === 'GET /repos/{owner}/{repo}/collaborators/{username}/permission') {
      return { permission: 'write', role_name: 'write' };
    }
    if (route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}') {
      return { sha: SCAFFOLD_HEAD, tree: { sha: 'scaffold-tree' } };
    }
    if (route === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
      return { tree: treeEntries };
    }
    if (route === 'GET /repos/{owner}/{repo}/git/blobs/{blob_sha}') {
      const bytes = blobs.get(String(p.blob_sha));
      if (!bytes) throw new Error(`unknown blob ${String(p.blob_sha)}`);
      return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
    }
    if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
      const path = String(p.path);
      const ref = String(p.ref);
      if (path === 'projects.yaml') {
        return {
          sha: 'projects-blob',
          content: Buffer.from(projectsYaml).toString('base64'),
          encoding: 'base64',
        };
      }
      if (path === '.github/CODEOWNERS' && ref === GATE_BASE) {
        return {
          sha: 'codeowners-blob',
          content: Buffer.from('projects.yaml @alice\n').toString('base64'),
          encoding: 'base64',
        };
      }
      if (path === 'apps/backend/template.lock' && ref === SCAFFOLD_HEAD) {
        return { content: Buffer.from(lockYaml).toString('base64'), encoding: 'base64' };
      }
      if (path === 'templates/spring-boot.manifest.json' && ref === TEMPLATE_COMMIT) {
        return { content: manifestBytes.toString('base64'), encoding: 'base64' };
      }
      const manifestFile = manifest.files.find((file) => `${manifest.path}/${file.path}` === path);
      if (manifestFile && ref === TEMPLATE_COMMIT) {
        const entry = entries.find((item) => item.path === manifestFile.path)!;
        return { content: Buffer.from(entry.content).toString('base64'), encoding: 'base64' };
      }
    }
    throw new Error(`unexpected request ${route} ${JSON.stringify(p)}`);
  });

  return {
    octokit,
    input: {
      octokit,
      repo: TARGET,
      pr: 42,
      ...(options.trustedWorkflow === false
        ? {}
        : {
            trustedWorkflow: {
              repository: `${PLATFORM.owner}/${PLATFORM.repo}`,
              commit: WORKFLOW_COMMIT,
            },
          }),
    },
  };
}

describe('Scaffold PR hygiene (D24/D26)', () => {
  it('accepts an untampered independently re-rendered Scaffold PR', async () => {
    const fixture = await createFixture();
    await expect(checkPrHygiene(fixture.input)).resolves.toEqual({ ok: true });
  });

  it('rejects coordinated application and lock digest tampering', async () => {
    const fixture = await createFixture({
      mutateLock(lock) {
        const file = lock.files.find((entry) => entry.path === 'build.gradle.kts')!;
        (file as { output_sha256: string }).output_sha256 = sha256Hex(
          new TextEncoder().encode('tampered'),
        );
      },
      mutateFiles(files) {
        files.set('apps/backend/build.gradle.kts', new TextEncoder().encode('tampered'));
      },
    });
    const result = await checkPrHygiene(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.join('\n')).toContain('subtree verification failed');
  });

  it('rejects an owner copied from the untrusted lock instead of current main', async () => {
    const fixture = await createFixture({
      mutateLock(lock) {
        lock.component.owner = 'attacker-team';
      },
    });
    const result = await checkPrHygiene(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.join('\n')).toContain('component.owner differs');
  });

  it('rejects a lock whose generator is not the required-workflow commit', async () => {
    const fixture = await createFixture({
      mutateLock(lock) {
        lock.generator.resolved_commit = '9'.repeat(40);
      },
    });
    const result = await checkPrHygiene(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.violations.join('\n')).toContain('generator.resolved_commit differs');
  });

  it('fails closed without a trusted workflow identity', async () => {
    const fixture = await createFixture({ trustedWorkflow: false });
    const result = await checkPrHygiene(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.violations.join('\n')).toContain('trusted required-workflow identity');
  });

  it('fails closed when the running generator differs from the managed workflow pin', async () => {
    const fixture = await createFixture({ workflowPin: '8'.repeat(40) });
    const result = await checkPrHygiene(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.violations.join('\n')).toContain('does not match required workflow');
  });
});
