/**
 * resolve.test.ts — manifest validation, tag peeling, tree assembly.
 */

import { describe, expect, it } from 'vitest';
import type { GitHubReadPort, TemplateManifest, TemplateTreeEntry } from '../src/index.js';
import {
  assembleTree,
  isFullCommit,
  isSha256,
  parseManifest,
  resolveRef,
  sha256Hex,
  validateManifest,
} from '../src/index.js';

function makeEntry(
  path: string,
  content: string,
  mode: '100644' | '100755' = '100644',
): TemplateTreeEntry {
  return {
    path,
    mode,
    content: new TextEncoder().encode(content),
  };
}

function makeManifest(files: TemplateTreeEntry[]): TemplateManifest {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.map((f) => `${f.mode}  ${sha256Hex(f.content)}  ${f.path}`).join('\n');
  const treeHash = sha256Hex(`${lines}\n`);
  return Object.freeze({
    template: 'monorepo-root',
    path: 'templates/monorepo-root',
    tree_sha256: treeHash,
    files: sorted.map((f) =>
      Object.freeze({
        path: f.path,
        mode: f.mode,
        render: false,
        sha256: sha256Hex(f.content),
      }),
    ),
  });
}

describe('resolve', () => {
  it('isSha256 recognizes canonical sha256:<hex>', () => {
    expect(isSha256(sha256Hex(Buffer.from('x')))).toBe(true);
    expect(isSha256('sha256:abc')).toBe(false);
    expect(isSha256('abcdef0123456789'.repeat(4))).toBe(false);
  });

  it('isFullCommit recognizes 40-char lowercase hex', () => {
    expect(isFullCommit('a'.repeat(40))).toBe(true);
    expect(isFullCommit('A'.repeat(40))).toBe(false);
    expect(isFullCommit('a'.repeat(39))).toBe(false);
    expect(isFullCommit('g'.repeat(40))).toBe(false);
  });

  it('parseManifest rejects non-object / wrong template / bad sha', () => {
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest({})).toThrow();
    expect(() =>
      parseManifest({ template: 'other', path: 'x', tree_sha256: 'x', files: [] }),
    ).toThrow(/monorepo-root/);
    expect(() =>
      parseManifest({
        template: 'monorepo-root',
        path: 'templates/monorepo-root',
        tree_sha256: 'not-a-sha',
        files: [],
      }),
    ).toThrow(/malformed/);
  });

  it('validateManifest detects tree_sha256 drift', () => {
    const manifest = makeManifest([makeEntry('README.md', 'hi')]);
    const tampered: TemplateManifest = {
      ...manifest,
      tree_sha256: sha256Hex(Buffer.from('tampered')),
    };
    expect(() => validateManifest(tampered)).toThrow(/tree_sha256 mismatch/);
  });

  it('validateManifest detects case-insensitive collision', () => {
    const manifest: TemplateManifest = Object.freeze({
      template: 'monorepo-root',
      path: 'templates/monorepo-root',
      tree_sha256: sha256Hex(Buffer.from('x')),
      files: [
        Object.freeze({
          path: 'README.md',
          mode: '100644' as const,
          render: false,
          sha256: sha256Hex(Buffer.from('a')),
        }),
        Object.freeze({
          path: 'readme.md',
          mode: '100644' as const,
          render: false,
          sha256: sha256Hex(Buffer.from('b')),
        }),
      ],
    });
    expect(() => validateManifest(manifest)).toThrow(/case-insensitive collision/);
  });

  it('validateManifest rejects traversal / absolute paths', () => {
    const manifest: TemplateManifest = Object.freeze({
      template: 'monorepo-root',
      path: 'templates/monorepo-root',
      tree_sha256: sha256Hex(Buffer.from('x')),
      files: [
        Object.freeze({
          path: '../escape.txt',
          mode: '100644' as const,
          render: false,
          sha256: sha256Hex(Buffer.from('a')),
        }),
      ],
    });
    expect(() => validateManifest(manifest)).toThrow(/absolute or traverses/);
  });

  it('assembleTree rejects missing file', () => {
    const manifest = makeManifest([makeEntry('README.md', 'hi'), makeEntry('missing.txt', 'gone')]);
    const entries: TemplateTreeEntry[] = [makeEntry('README.md', 'hi')];
    expect(() => assembleTree(manifest, entries)).toThrow(/missing/);
  });

  it('assembleTree rejects extra file', () => {
    const manifest = makeManifest([makeEntry('README.md', 'hi')]);
    const entries: TemplateTreeEntry[] = [
      makeEntry('README.md', 'hi'),
      makeEntry('extra.txt', 'not in manifest'),
    ];
    expect(() => assembleTree(manifest, entries)).toThrow(/not in manifest/);
  });

  it('assembleTree rejects checksum mismatch', () => {
    const manifest = makeManifest([makeEntry('README.md', 'hi')]);
    const entries: TemplateTreeEntry[] = [makeEntry('README.md', 'DIFFERENT')];
    expect(() => assembleTree(manifest, entries)).toThrow(/checksum mismatch/);
  });

  it('assembleTree rejects binary content', () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02]);
    // Compute manifest based on actual binary content.
    const manifest: TemplateManifest = Object.freeze({
      template: 'monorepo-root',
      path: 'templates/monorepo-root',
      tree_sha256: sha256Hex(
        new TextEncoder().encode(`100644  ${sha256Hex(binary)}  binary.bin\n`),
      ),
      files: [
        Object.freeze({
          path: 'binary.bin',
          mode: '100644' as const,
          render: false,
          sha256: sha256Hex(binary),
        }),
      ],
    });
    expect(() =>
      assembleTree(manifest, [{ path: 'binary.bin', mode: '100644', content: binary }]),
    ).toThrow(/binary/);
  });

  it('assembleTree rejects CRLF', () => {
    const crlf = new TextEncoder().encode('line1\r\nline2\n');
    const manifest: TemplateManifest = Object.freeze({
      template: 'monorepo-root',
      path: 'templates/monorepo-root',
      tree_sha256: sha256Hex(new TextEncoder().encode(`100644  ${sha256Hex(crlf)}  crlf.txt\n`)),
      files: [
        Object.freeze({
          path: 'crlf.txt',
          mode: '100644' as const,
          render: false,
          sha256: sha256Hex(crlf),
        }),
      ],
    });
    expect(() =>
      assembleTree(manifest, [{ path: 'crlf.txt', mode: '100644', content: crlf }]),
    ).toThrow(/CRLF/);
  });

  it('assembleTree accepts a valid tree', () => {
    const entries = [makeEntry('README.md', 'hi'), makeEntry('nested/file.txt', 'there')];
    const manifest = makeManifest(entries);
    const tree = assembleTree(manifest, entries);
    expect(tree.entries.length).toBe(2);
    expect(tree.sourceTreeSha256).toBe(manifest.tree_sha256);
  });
});

describe('resolveRef', () => {
  it('delegates to reader.resolveCommit', async () => {
    const fake: GitHubReadPort = {
      async resolveCommit(_repo, ref) {
        return {
          commit: 'a'.repeat(40),
          requestedRef: ref,
          peeled: true,
        };
      },
      async readTemplateTree() {
        throw new Error('unused');
      },
      async observe() {
        throw new Error('unused');
      },
    };
    const result = await resolveRef(fake, { owner: 'acme', repo: 'sdd-platform' }, 'v1.0.0');
    expect(result.commit).toBe('a'.repeat(40));
    expect(result.peeled).toBe(true);
    expect(result.requestedRef).toBe('v1.0.0');
  });

  it('rejects empty ref', async () => {
    const fake: GitHubReadPort = {
      async resolveCommit() {
        throw new Error('should not be called');
      },
      async readTemplateTree() {
        throw new Error('unused');
      },
      async observe() {
        throw new Error('unused');
      },
    };
    await expect(resolveRef(fake, { owner: 'acme', repo: 'sdd-platform' }, '')).rejects.toThrow(
      /ref is required/,
    );
  });
});
