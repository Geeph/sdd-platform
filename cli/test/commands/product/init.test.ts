/**
 * product init CLI test — dry-run only.
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(__dirname, '../../../..');
const CLI_BIN = resolve(REPO_ROOT, 'cli/bin/run.js');
const FIXTURES = resolve(REPO_ROOT, 'cli/test/fixtures');

async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP('node', [CLI_BIN, ...args], {
      cwd: cwd ?? REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
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

  it('refuses real execution in M2a', async () => {
    const { stderr, code } = await runCli([
      'product',
      'init',
      'demo',
      '--owner',
      'acme',
      '--config',
      resolve(FIXTURES, 'product-init-valid.yaml'),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/not implemented in M2a/);
  });

  it('dry-run JSON produces byte-identical output', async () => {
    const args = [
      'product',
      'init',
      'demo',
      '--owner',
      'acme',
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
    expect(plan.target.owner).toBe('acme');
    expect(plan.target.repository).toBe('demo');
  });

  it('dry-run text output includes key sections', async () => {
    const { stdout, code } = await runCli([
      'product',
      'init',
      'demo',
      '--owner',
      'acme',
      '--config',
      resolve(FIXTURES, 'product-init-valid.yaml'),
      '--dry-run',
      '--format',
      'text',
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/operation_id:/);
    expect(stdout).toMatch(/target:\s+acme\/demo/);
    expect(stdout).toMatch(/Operations/);
    expect(stdout).toMatch(/Requirements/);
    expect(stdout).toMatch(/Template files/);
  });

  it('fails with invalid config', async () => {
    const badYaml = resolve(FIXTURES, 'product-init-bad.yaml');
    await writeFile(badYaml, 'schema_version: 1\nunknown_key: oops\n', 'utf8');
    const { stderr, code } = await runCli([
      'product',
      'init',
      'demo',
      '--owner',
      'acme',
      '--config',
      badYaml,
      '--dry-run',
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/additionalProperties/);
  });
});
