/**
 * scaffold/subtree.test.ts — D25 "component subtree integrity check" tests.
 *
 * Critical regression tests:
 *   - Hash-space regression: verify that `verifyComponentSubtree` compares
 *     sha256(content) against output_sha256 (NOT Git blob SHA). If the
 *     implementation mistakenly compared Git blob SHA (sha1-prefixed),
 *     the test would fail.
 *   - Subtree scope: paths outside the component path prefix are ignored.
 *   - Missing/extra/mismatched files each detected separately.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ExpectedFile,
  type ScaffoldReadPort,
  type TreeEntry,
  verifyComponentSubtree,
} from '../../src/index.js';

/** Git blob SHA: sha1("blob " + byteLength + "\0" + content). */
function gitBlobSha(content: Uint8Array): string {
  const header = `blob ${content.byteLength}\0`;
  const h = createHash('sha1');
  h.update(header, 'utf8');
  h.update(content);
  return h.digest('hex');
}

function sha256Hex(data: Uint8Array | string): string {
  const h = createHash('sha256');
  if (typeof data === 'string') h.update(data, 'utf8');
  else h.update(data);
  return `sha256:${h.digest('hex')}`;
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build a fake ScaffoldReadPort backed by a fixed tree entries list + blobs. */
function fakeReader(treeEntries: TreeEntry[], blobs: Map<string, Uint8Array>): ScaffoldReadPort {
  return {
    readTemplateTree: async () => {
      throw new Error('not used');
    },
    observeProduct: async () => {
      throw new Error('not used');
    },
    readBlobContent: async (_repo, blobSha) => {
      const b = blobs.get(blobSha);
      if (!b) throw new Error(`blob not found: ${blobSha}`);
      return b;
    },
    readTreeRecursive: async () => treeEntries,
    resolveCommit: async () => {
      throw new Error('not used');
    },
    findPullByHead: async () => null,
  };
}

describe('verifyComponentSubtree (D25)', () => {
  const componentPath = 'apps/backend';
  const expectedFiles: ExpectedFile[] = [
    { path: 'build.gradle.kts', mode: '100644', output_sha256: '' },
    { path: 'README.md', mode: '100644', output_sha256: '' },
  ];

  // Pre-compute expected output_sha256 values (sha256 of content).
  const buildGradleContent = textBytes('plugins { java }');
  const readmeContent = textBytes('# backend\n');
  const buildGradleSha256 = sha256Hex(buildGradleContent);
  const readmeSha256 = sha256Hex(readmeContent);

  // The Git blob SHA of the same content (DIFFERENT from sha256).
  const buildGradleGitSha = gitBlobSha(buildGradleContent);
  const readmeGitSha = gitBlobSha(readmeContent);

  // Assign the correct sha256 values to expected files.
  expectedFiles[0]!.output_sha256 = buildGradleSha256;
  expectedFiles[1]!.output_sha256 = readmeSha256;

  it('passes when content matches exactly (hash-space regression)', async () => {
    // Build a tree with correct content. Each blob SHA is the Git blob SHA
    // (sha1-based) — D25 must fetch the content, NOT compare Git blob SHA
    // directly against output_sha256 (sha256-based).
    const blobs = new Map<string, Uint8Array>();
    blobs.set(buildGradleGitSha, buildGradleContent);
    blobs.set(readmeGitSha, readmeContent);

    const treeEntries: TreeEntry[] = [
      {
        path: `${componentPath}/build.gradle.kts`,
        mode: '100644',
        type: 'blob',
        sha: buildGradleGitSha,
      },
      { path: `${componentPath}/README.md`, mode: '100644', type: 'blob', sha: readmeGitSha },
    ];

    const result = await verifyComponentSubtree({
      componentPath,
      expectedFiles,
      targetTreeSha: 'fake-tree',
      reader: fakeReader(treeEntries, blobs),
      repo: { owner: 'acme', repo: 'demo' },
    });

    // Must pass. If the implementation compared Git blob SHA directly
    // against output_sha256, this would fail (sha1 hex != sha256 hex).
    expect(result.ok).toBe(true);
  });

  it('hash-space regression: content hash is sha256, not Git blob sha1', async () => {
    // Prove that sha256(content) != Git blob SHA for the same content.
    expect(buildGradleSha256).not.toBe(buildGradleGitSha);
    expect(readmeSha256).not.toBe(readmeGitSha);
    // And sha256 starts with "sha256:" prefix.
    expect(buildGradleSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Git blob SHA is a 40-char hex (sha1) with no prefix.
    expect(buildGradleGitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('fails when a file is missing from the subtree', async () => {
    const blobs = new Map<string, Uint8Array>();
    blobs.set(buildGradleGitSha, buildGradleContent);
    // README.md is missing.

    const treeEntries: TreeEntry[] = [
      {
        path: `${componentPath}/build.gradle.kts`,
        mode: '100644',
        type: 'blob',
        sha: buildGradleGitSha,
      },
    ];

    const result = await verifyComponentSubtree({
      componentPath,
      expectedFiles,
      targetTreeSha: 'fake-tree',
      reader: fakeReader(treeEntries, blobs),
      repo: { owner: 'acme', repo: 'demo' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing files.*README\.md/);
  });

  it('fails when an extra file is in the subtree', async () => {
    const blobs = new Map<string, Uint8Array>();
    blobs.set(buildGradleGitSha, buildGradleContent);
    blobs.set(readmeGitSha, readmeContent);
    const extraContent = textBytes('secret');
    const extraGitSha = gitBlobSha(extraContent);
    blobs.set(extraGitSha, extraContent);

    const treeEntries: TreeEntry[] = [
      {
        path: `${componentPath}/build.gradle.kts`,
        mode: '100644',
        type: 'blob',
        sha: buildGradleGitSha,
      },
      { path: `${componentPath}/README.md`, mode: '100644', type: 'blob', sha: readmeGitSha },
      { path: `${componentPath}/secret.txt`, mode: '100644', type: 'blob', sha: extraGitSha },
    ];

    const result = await verifyComponentSubtree({
      componentPath,
      expectedFiles,
      targetTreeSha: 'fake-tree',
      reader: fakeReader(treeEntries, blobs),
      repo: { owner: 'acme', repo: 'demo' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unexpected files.*secret\.txt/);
  });

  it('fails when content hash does not match (tampered file)', async () => {
    const tamperedContent = textBytes('plugins { java }\n// tampered');
    const tamperedGitSha = gitBlobSha(tamperedContent);
    const blobs = new Map<string, Uint8Array>();
    blobs.set(tamperedGitSha, tamperedContent); // Different content, same expected output_sha256.
    blobs.set(readmeGitSha, readmeContent);

    const treeEntries: TreeEntry[] = [
      {
        path: `${componentPath}/build.gradle.kts`,
        mode: '100644',
        type: 'blob',
        sha: tamperedGitSha,
      },
      { path: `${componentPath}/README.md`, mode: '100644', type: 'blob', sha: readmeGitSha },
    ];

    const result = await verifyComponentSubtree({
      componentPath,
      expectedFiles,
      targetTreeSha: 'fake-tree',
      reader: fakeReader(treeEntries, blobs),
      repo: { owner: 'acme', repo: 'demo' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/build\.gradle\.kts.*content hash mismatch/);
  });

  it('ignores paths outside the component subtree (other apps, root files)', async () => {
    const blobs = new Map<string, Uint8Array>();
    blobs.set(buildGradleGitSha, buildGradleContent);
    blobs.set(readmeGitSha, readmeContent);
    const otherContent = textBytes('other');
    const otherGitSha = gitBlobSha(otherContent);
    blobs.set(otherGitSha, otherContent);

    const treeEntries: TreeEntry[] = [
      // The component's subtree.
      {
        path: `${componentPath}/build.gradle.kts`,
        mode: '100644',
        type: 'blob',
        sha: buildGradleGitSha,
      },
      { path: `${componentPath}/README.md`, mode: '100644', type: 'blob', sha: readmeGitSha },
      // Other paths — should be IGNORED, not flagged as "extra".
      { path: 'apps/web/package.json', mode: '100644', type: 'blob', sha: otherGitSha },
      { path: 'template.lock', mode: '100644', type: 'blob', sha: otherGitSha },
      { path: 'projects.yaml', mode: '100644', type: 'blob', sha: otherGitSha },
      { path: 'specs/v1/spec.md', mode: '100644', type: 'blob', sha: otherGitSha },
    ];

    const result = await verifyComponentSubtree({
      componentPath,
      expectedFiles,
      targetTreeSha: 'fake-tree',
      reader: fakeReader(treeEntries, blobs),
      repo: { owner: 'acme', repo: 'demo' },
    });

    expect(result.ok).toBe(true);
  });

  it('fails when mode does not match', async () => {
    const blobs = new Map<string, Uint8Array>();
    blobs.set(buildGradleGitSha, buildGradleContent);
    blobs.set(readmeGitSha, readmeContent);

    const treeEntries: TreeEntry[] = [
      // Wrong mode on README.md.
      {
        path: `${componentPath}/build.gradle.kts`,
        mode: '100644',
        type: 'blob',
        sha: buildGradleGitSha,
      },
      { path: `${componentPath}/README.md`, mode: '100755', type: 'blob', sha: readmeGitSha },
    ];

    const result = await verifyComponentSubtree({
      componentPath,
      expectedFiles,
      targetTreeSha: 'fake-tree',
      reader: fakeReader(treeEntries, blobs),
      repo: { owner: 'acme', repo: 'demo' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mode mismatch/);
  });
});
