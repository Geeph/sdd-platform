/**
 * local-reader.test.ts — parseRemoteUrl + createLocalFsReadPort unit tests.
 *
 * These tests verify the source-identity invariants without depending on
 * the developer's local git state.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@sdd/factory';
import { describe, expect, it } from 'vitest';
import { createLocalFsReadPort, parseRemoteUrl } from '../src/local-reader.js';

describe('parseRemoteUrl', () => {
  it('parses HTTPS GitHub URLs', () => {
    expect(parseRemoteUrl('https://github.com/acme/sdd-platform.git')).toEqual({
      owner: 'acme',
      repo: 'sdd-platform',
    });
    // Owner is lowercased (GitHub orgs are case-insensitive).
    expect(parseRemoteUrl('https://github.com/Geeph/sdd-platform')).toEqual({
      owner: 'geeph',
      repo: 'sdd-platform',
    });
  });

  it('parses SSH GitHub URLs', () => {
    expect(parseRemoteUrl('git@github.com:acme/sdd-platform.git')).toEqual({
      owner: 'acme',
      repo: 'sdd-platform',
    });
    expect(parseRemoteUrl('git@github.com:Geeph/sdd-platform')).toEqual({
      owner: 'geeph',
      repo: 'sdd-platform',
    });
  });

  it('parses ssh:// URLs', () => {
    expect(parseRemoteUrl('ssh://git@github.com/acme/sdd-platform.git')).toEqual({
      owner: 'acme',
      repo: 'sdd-platform',
    });
  });

  it('returns null for unparseable URLs', () => {
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('not-a-url')).toBeNull();
    expect(parseRemoteUrl('https://example.com/acme/sdd-platform.git')).toBeNull();
    expect(parseRemoteUrl('git@example.com:acme/sdd-platform.git')).toBeNull();
  });
});

describe('createLocalFsReadPort', () => {
  it('reads template bytes from the resolved commit, ignoring dirty worktree content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdd-local-reader-'));
    const templateDir = join(root, 'templates', 'monorepo-root');
    const committed = 'committed\n';
    const sourceSha = sha256Hex(new TextEncoder().encode(committed));
    const manifest = {
      template: 'monorepo-root',
      path: 'templates/monorepo-root',
      tree_sha256: sha256Hex(`100644  ${sourceSha}  README.md\n`),
      files: [{ path: 'README.md', mode: '100644', render: false, sha256: sourceSha }],
    };

    try {
      await mkdir(templateDir, { recursive: true });
      await writeFile(join(templateDir, 'README.md'), committed, 'utf8');
      await writeFile(
        join(root, 'templates', 'monorepo-root.manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/sdd-platform.git'], {
        cwd: root,
      });

      const reader = createLocalFsReadPort(root);
      const repo = { owner: 'acme', repo: 'sdd-platform' };
      const resolved = await reader.resolveCommit(repo, '<unpinned>');
      await writeFile(join(templateDir, 'README.md'), 'dirty worktree\n', 'utf8');

      const tree = await reader.readTemplateTree(repo, resolved.commit, 'templates/monorepo-root');
      expect(new TextDecoder().decode(tree.entries[0]?.content)).toBe(committed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
