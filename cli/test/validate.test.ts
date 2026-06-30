import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');
const cliBin = join(__dirname, '..', 'bin', 'run.js');

const exec = promisify(execFile);

interface ExecError extends Error {
  stdout: string;
  stderr: string;
  code?: number;
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec('node', [cliBin, ...args], {
      timeout: 10000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as ExecError;
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

describe('sdd validate', () => {
  beforeAll(() => {
    if (!existsSync(cliBin)) {
      throw new Error(`CLI binary not found at ${cliBin}. Run \`pnpm build\` first.`);
    }
  });

  describe('projects.yaml', () => {
    it('returns 0 for a valid projects.yaml', async () => {
      const result = await runCli(['validate', '--repo', join(fixturesDir, 'repo-valid')]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/ok/);
      expect(result.stderr).toBe('');
    });

    it('returns non-zero for duplicate component IDs', async () => {
      const result = await runCli(['validate', '--repo', join(fixturesDir, 'repo-duplicate-id')]);
      expect(result.code).not.toBe(0);
      const output = result.stderr + result.stdout;
      expect(output).toMatch(/duplicated/);
    });

    it('returns non-zero for nested component paths', async () => {
      const result = await runCli(['validate', '--repo', join(fixturesDir, 'repo-nested-paths')]);
      expect(result.code).not.toBe(0);
      const output = result.stderr + result.stdout;
      expect(output).toMatch(/nested/);
    });

    it('returns non-zero for template/ci mismatch', async () => {
      const result = await runCli([
        'validate',
        '--repo',
        join(fixturesDir, 'repo-template-ci-mismatch'),
      ]);
      expect(result.code).not.toBe(0);
      const output = result.stderr + result.stdout;
      expect(output).toMatch(/must pair with ci/);
    });
  });

  describe('--kind task', () => {
    it('returns 0 for a valid task', async () => {
      const result = await runCli([
        'validate',
        '--kind',
        'task',
        join(fixturesDir, 'task-valid.yaml'),
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    });
  });

  describe('--kind impact', () => {
    it('returns 0 for a valid impact document', async () => {
      const result = await runCli([
        'validate',
        '--kind',
        'impact',
        join(fixturesDir, 'impact-valid.yaml'),
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    });
  });

  describe('--kind without file', () => {
    it('returns non-zero when file is missing', async () => {
      const result = await runCli(['validate', '--kind', 'task']);
      expect(result.code).not.toBe(0);
    });
  });
});
