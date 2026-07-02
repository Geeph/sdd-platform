import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../../../src/local-reader.js';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(__dirname, '../../../..');
const CLI_BIN = resolve(REPO_ROOT, 'cli/bin/run.js');
const cleanup: string[] = [];

async function runCli(args: string[], cwd = REPO_ROOT) {
  try {
    const { stdout, stderr } = await execFileP('node', [CLI_BIN, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

function platformIdentity(): { owner: string; repo: string; head: string } {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const parsed = parseRemoteUrl(remote);
  if (!parsed) throw new Error(`cannot parse platform remote '${remote}'`);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return { ...parsed, head };
}

async function createProductRepo(): Promise<{
  path: string;
  platform: ReturnType<typeof platformIdentity>;
}> {
  const platform = platformIdentity();
  const path = await mkdtemp(join(tmpdir(), 'sdd-scaffold-cli-'));
  cleanup.push(path);
  const projects = `schema_version: 1
product: demo
repository_mode: monorepo
components:
  - id: backend
    path: apps/backend
    template: spring-boot
    template_ref: ${platform.head}
    owner: backend-team
    ci: java
`;
  await writeFile(join(path, 'projects.yaml'), projects);
  execFileSync('git', ['init', '-b', 'main'], { cwd: path });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', `https://github.com/${platform.owner}/demo.git`],
    { cwd: path },
  );
  execFileSync('git', ['add', 'projects.yaml'], { cwd: path });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'],
    { cwd: path },
  );
  return { path, platform };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('sdd product scaffold', () => {
  it('shows command help', async () => {
    const result = await runCli(['product', 'scaffold', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Generate component directories');
  });

  it('produces a deterministic dry-run plan without GitHub writes', async () => {
    const fixture = await createProductRepo();
    const args = [
      'product',
      'scaffold',
      '--repo',
      fixture.path,
      '--platform-repo',
      `${fixture.platform.owner}/${fixture.platform.repo}`,
      '--dry-run',
      '--format',
      'json',
    ];
    const first = await runCli(args, fixture.path);
    const second = await runCli(args, fixture.path);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    const plan = JSON.parse(first.stdout);
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0].template_source.resolved_commit).toBe(fixture.platform.head);
    expect(
      plan.operations.some((operation: { kind: string }) => operation.kind === 'branch.create'),
    ).toBe(true);
  });
});
