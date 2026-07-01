/**
 * product init CLI test — dry-run only.
 *
 * These tests run against the local platform checkout, so the
 * --platform-repo flag must match the git remote's owner/repo. We derive
 * it from `git remote get-url origin` at test time so the tests work in
 * any developer's checkout (acme, Geeph, etc.).
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../../../src/local-reader.js';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(__dirname, '../../../..');
const CLI_BIN = resolve(REPO_ROOT, 'cli/bin/run.js');
const FIXTURES = resolve(REPO_ROOT, 'cli/test/fixtures');

function normalizeError(s: string): string {
  // Collapse oclif's `›` decoration and any whitespace so multi-line error
  // messages become one line we can match against.
  return s.replace(/[\s›]+/g, ' ');
}

/**
 * Derive owner/repo from the local git remote so tests work regardless of
 * which developer's checkout runs them.
 */
function derivePlatformRepo(): { owner: string; repo: string } {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const parsed = parseRemoteUrl(url);
    if (parsed) return parsed;
  } catch {
    // Fall through.
  }
  // Test environment where git isn't available — fall back to a fixed pair.
  return { owner: 'test', repo: 'sdd-platform' };
}

async function runCli(
  args: string[],
  cwd?: string,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP('node', [CLI_BIN, ...args], {
      cwd: cwd ?? REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', ...envOverrides },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('sdd product init', () => {
  it('shows help', async () => {
    const { stdout, code } = await runCli(['product', 'init', '--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Bootstrap a product repository/);
  });

  it('requires a pinned platform ref for real execution', async () => {
    const platform = derivePlatformRepo();
    const { stderr, code } = await runCli([
      'product',
      'init',
      'demo',
      '--owner',
      platform.owner,
      '--platform-repo',
      `${platform.owner}/${platform.repo}`,
      '--config',
      resolve(FIXTURES, 'product-init-valid.yaml'),
    ]);
    expect(code).not.toBe(0);
    expect(normalizeError(stderr)).toMatch(/--platform-ref is required/);
  });

  it('requires GITHUB_TOKEN for real execution', async () => {
    const platform = derivePlatformRepo();
    const { stderr, code } = await runCli(
      [
        'product',
        'init',
        'demo',
        '--owner',
        platform.owner,
        '--platform-repo',
        `${platform.owner}/${platform.repo}`,
        '--platform-ref',
        'a'.repeat(40),
        '--config',
        resolve(FIXTURES, 'product-init-valid.yaml'),
      ],
      undefined,
      { GITHUB_TOKEN: '' },
    );
    expect(code).toBe(2);
    expect(normalizeError(stderr)).toMatch(/GITHUB_TOKEN/);
  });

  it('requires config for finalize so bootstrap approver policy cannot be skipped', async () => {
    const platform = derivePlatformRepo();
    const { stderr, code } = await runCli(
      [
        'product',
        'init',
        'demo',
        '--owner',
        platform.owner,
        '--platform-repo',
        `${platform.owner}/${platform.repo}`,
        '--finalize-protection',
      ],
      undefined,
      { GITHUB_TOKEN: 'test-token' },
    );
    expect(code).toBe(2);
    expect(normalizeError(stderr)).toMatch(/--config is required/);
  });

  it('dry-run JSON produces byte-identical output', async () => {
    const platform = derivePlatformRepo();
    const args = [
      'product',
      'init',
      'demo',
      '--owner',
      platform.owner,
      '--platform-repo',
      `${platform.owner}/${platform.repo}`,
      '--config',
      resolve(FIXTURES, 'product-init-valid.yaml'),
      '--dry-run',
      '--format',
      'json',
    ];
    const r1 = await runCli(args);
    const r2 = await runCli(args);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(r1.stdout).toBe(r2.stdout);
    const plan = JSON.parse(r1.stdout);
    expect(plan.plan_version).toBe(1);
    expect(plan.operation_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.target.owner).toBe(platform.owner);
    expect(plan.target.repository).toBe('demo');
  });

  it('dry-run text output includes key sections', async () => {
    const platform = derivePlatformRepo();
    const { stdout, code } = await runCli([
      'product',
      'init',
      'demo',
      '--owner',
      platform.owner,
      '--platform-repo',
      `${platform.owner}/${platform.repo}`,
      '--config',
      resolve(FIXTURES, 'product-init-valid.yaml'),
      '--dry-run',
      '--format',
      'text',
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/operation_id:/);
    expect(stdout).toMatch(new RegExp(`target:\\s+${platform.owner}\\/demo`));
    expect(stdout).toMatch(/Operations/);
    expect(stdout).toMatch(/Requirements/);
    expect(stdout).toMatch(/Template files/);
  });

  it('fails with invalid config', async () => {
    const platform = derivePlatformRepo();
    const tempDir = await mkdtemp(join(tmpdir(), 'sdd-product-init-'));
    try {
      const badYaml = join(tempDir, 'product-init-bad.yaml');
      await writeFile(badYaml, 'schema_version: 1\nunknown_key: oops\n', 'utf8');
      const { stderr, code } = await runCli([
        'product',
        'init',
        'demo',
        '--owner',
        platform.owner,
        '--platform-repo',
        `${platform.owner}/${platform.repo}`,
        '--config',
        badYaml,
        '--dry-run',
      ]);
      expect(code).not.toBe(0);
      expect(normalizeError(stderr)).toMatch(/additionalProperties/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses cross-org --platform-repo (same-org invariant)', async () => {
    const platform = derivePlatformRepo();
    // Pass an --owner that differs from the platform-repo owner.
    const otherOwner = platform.owner === 'acme' ? 'acme-other' : 'acme';
    const { stderr, code } = await runCli([
      'product',
      'init',
      'demo',
      '--owner',
      otherOwner,
      '--platform-repo',
      `${platform.owner}/${platform.repo}`,
      '--config',
      resolve(FIXTURES, 'product-init-valid.yaml'),
      '--dry-run',
    ]);
    expect(code).not.toBe(0);
    expect(normalizeError(stderr)).toMatch(/same-org invariant/);
  });

  it('refuses --platform-repo that does not match local git remote', async () => {
    const platform = derivePlatformRepo();
    // Use an owner that DOES match --owner (so same-org passes) but differs
    // from the local remote.
    const fakeOwner = 'not-the-local-remote-owner';
    const { stderr, code } = await runCli([
      'product',
      'init',
      'demo',
      '--owner',
      fakeOwner,
      '--platform-repo',
      `${fakeOwner}/${platform.repo}`,
      '--config',
      resolve(FIXTURES, 'product-init-valid.yaml'),
      '--dry-run',
    ]);
    expect(code).not.toBe(0);
    expect(normalizeError(stderr)).toMatch(/local git remote/);
  });
});
