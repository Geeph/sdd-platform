/**
 * render.test.ts — token substitution and template.lock generation.
 */

import { describe, expect, it } from 'vitest';
import type { RenderContext, TemplateManifest, TemplateTreeEntry } from '../src/index.js';
import {
  assembleTree,
  computeOutputTreeDigest,
  parseLockYaml,
  renderContent,
  renderTree,
  sha256Hex,
} from '../src/index.js';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeEntry(
  path: string,
  content: string,
  mode: '100644' | '100755' = '100644',
): TemplateTreeEntry {
  return { path, mode, content: utf8(content) };
}

function makeManifestWithRender(
  files: Array<{ path: string; content: string; mode?: '100644' | '100755'; render: boolean }>,
): TemplateManifest {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted
    .map((f) => `${f.mode ?? '100644'}  ${sha256Hex(utf8(f.content))}  ${f.path}`)
    .join('\n');
  const treeHash = sha256Hex(`${lines}\n`);
  return Object.freeze({
    template: 'monorepo-root',
    path: 'templates/monorepo-root',
    tree_sha256: treeHash,
    files: sorted.map((f) =>
      Object.freeze({
        path: f.path,
        mode: (f.mode ?? '100644') as '100644' | '100755',
        render: f.render,
        sha256: sha256Hex(utf8(f.content)),
      }),
    ),
  });
}

const CONTEXT: RenderContext = {
  product: 'demo',
  repo: 'acme',
  owners: {
    product: 'product-team',
    api: 'api-owners',
    design: 'design-team',
    admins: 'platform-admins',
    backend: 'backend-team',
    web: 'web-team',
    ios: 'ios-team',
    android: 'android-team',
  },
};

describe('renderContent', () => {
  it('substitutes product and repo tokens', () => {
    const tokens = new Map<string, string>([
      ['product', 'demo'],
      ['repo', 'acme'],
    ]);
    const out = renderContent(utf8('product={{product}}, repo={{repo}}'), tokens);
    expect(new TextDecoder().decode(out)).toBe('product=demo, repo=acme');
  });

  it('substitutes owners.<key> tokens', () => {
    const tokens = new Map<string, string>([['owners.admins', 'platform-admins']]);
    const out = renderContent(
      utf8('@{{repo}}/{{owners.admins}}'),
      new Map([['repo', 'acme'], ...tokens]),
    );
    expect(new TextDecoder().decode(out)).toBe('@acme/platform-admins');
  });

  it('throws on unknown token', () => {
    const tokens = new Map<string, string>([['product', 'demo']]);
    expect(() => renderContent(utf8('{{unknown}}'), tokens)).toThrow(/unknown or unresolved token/);
  });

  it('throws on partially unknown tokens', () => {
    const tokens = new Map<string, string>([['product', 'demo']]);
    expect(() => renderContent(utf8('{{product}} {{other}}'), tokens)).toThrow(
      /unknown or unresolved token/,
    );
  });

  it('handles no tokens', () => {
    const tokens = new Map<string, string>();
    const out = renderContent(utf8('plain text'), tokens);
    expect(new TextDecoder().decode(out)).toBe('plain text');
  });
});

describe('renderTree', () => {
  it('renders a full tree with render and verbatim files', () => {
    const files = [
      { path: 'README.md', content: '# {{product}}', render: true },
      { path: 'contracts/README.md', content: 'static', render: false },
    ];
    const manifest = makeManifestWithRender(files);
    const tree = assembleTree(
      manifest,
      files.map((f) => makeEntry(f.path, f.content)),
    );
    const result = renderTree({
      tree,
      context: CONTEXT,
      source: {
        repository: 'acme/sdd-platform',
        requestedRef: 'v1.0.0',
        resolvedCommit: 'a'.repeat(40),
      },
      generator: { package: '@sdd/factory', version: '0.1.0' },
    });
    const readme = result.entries.find((e) => e.path === 'README.md');
    expect(readme).toBeDefined();
    expect(new TextDecoder().decode(readme?.content)).toBe('# demo');

    const contracts = result.entries.find((e) => e.path === 'contracts/README.md');
    expect(contracts).toBeDefined();
    expect(new TextDecoder().decode(contracts?.content)).toBe('static');

    expect(result.outputTreeSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('throws if rendered output still contains token', () => {
    const files = [{ path: 'README.md', content: '{{product}} {{unknown}}', render: true }];
    const manifest = makeManifestWithRender(files);
    const tree = assembleTree(
      manifest,
      files.map((f) => makeEntry(f.path, f.content)),
    );
    expect(() =>
      renderTree({
        tree,
        context: CONTEXT,
        source: {
          repository: 'acme/sdd-platform',
          requestedRef: 'v1.0.0',
          resolvedCommit: 'a'.repeat(40),
        },
        generator: { package: '@sdd/factory', version: '0.1.0' },
      }),
    ).toThrow(/unknown or unresolved token/);
  });

  it('produces a parseable template.lock', () => {
    const files = [{ path: 'README.md', content: '# {{product}}', render: true }];
    const manifest = makeManifestWithRender(files);
    const tree = assembleTree(
      manifest,
      files.map((f) => makeEntry(f.path, f.content)),
    );
    const result = renderTree({
      tree,
      context: CONTEXT,
      source: {
        repository: 'acme/sdd-platform',
        requestedRef: 'v1.0.0',
        resolvedCommit: 'a'.repeat(40),
      },
      generator: { package: '@sdd/factory', version: '0.1.0' },
    });
    const lock = parseLockYaml(result.lockYaml) as {
      schema_version: number;
      generator: { package: string; version: string };
      source: { repository: string; requested_ref: string; resolved_commit: string };
      template: {
        name: string;
        path: string;
        manifest_sha256: string;
        source_tree_sha256: string;
        output_tree_sha256: string;
      };
      files: Array<{ path: string; mode: string; source_sha256: string; output_sha256: string }>;
    };
    expect(lock.schema_version).toBe(1);
    expect(lock.generator.package).toBe('@sdd/factory');
    expect(lock.source.resolved_commit).toBe('a'.repeat(40));
    expect(lock.template.output_tree_sha256).toBe(result.outputTreeSha256);
    expect(lock.files).toHaveLength(1);
    expect(lock.files[0]?.path).toBe('README.md');
  });

  it('lock file itself is not counted in output_tree_sha256', () => {
    const files = [{ path: 'README.md', content: '# {{product}}', render: true }];
    const manifest = makeManifestWithRender(files);
    const tree = assembleTree(
      manifest,
      files.map((f) => makeEntry(f.path, f.content)),
    );
    const result = renderTree({
      tree,
      context: CONTEXT,
      source: {
        repository: 'acme/sdd-platform',
        requestedRef: 'v1.0.0',
        resolvedCommit: 'a'.repeat(40),
      },
      generator: { package: '@sdd/factory', version: '0.1.0' },
    });
    // Recompute digest without template.lock.
    const filesWithoutLock = result.entries.filter((e) => e.path !== 'template.lock');
    const recomputed = computeOutputTreeDigest(filesWithoutLock);
    expect(recomputed).toBe(result.outputTreeSha256);
  });

  it('output tree digest differs when mode differs (100644 vs 100755)', () => {
    // Same content, different mode → different digest. This guards against
    // silently hashing all files as 100644 and missing an executable bit flip.
    const content = utf8('#!/bin/sh\necho hello\n');
    const tree100644 = computeOutputTreeDigest([{ path: 'script.sh', mode: '100644', content }]);
    const tree100755 = computeOutputTreeDigest([{ path: 'script.sh', mode: '100755', content }]);
    expect(tree100644).not.toBe(tree100755);
  });

  it('renders CODEOWNERS with admins fallback when optional owners are absent', () => {
    // The template references {{owners.backend}}, {{owners.web}}, etc. but
    // the config only provides the 4 required owners. The renderer must
    // fall back to {{owners.admins}} for the missing optional slots.
    const files = [
      {
        path: '.github/CODEOWNERS',
        content:
          '*                @{{repo}}/{{owners.admins}}\n/apps/backend/     @{{repo}}/{{owners.backend}}\n/apps/web/         @{{repo}}/{{owners.web}}\n',
        render: true,
      },
    ];
    const manifest = makeManifestWithRender(files);
    const tree = assembleTree(
      manifest,
      files.map((f) => makeEntry(f.path, f.content)),
    );
    const minimalContext: RenderContext = {
      product: 'demo',
      repo: 'acme',
      owners: {
        product: 'product-team',
        api: 'api-owners',
        design: 'design-team',
        admins: 'platform-admins',
        // No backend/web/ios/android — the template should still render.
      },
    };
    const result = renderTree({
      tree,
      context: minimalContext,
      source: {
        repository: 'acme/sdd-platform',
        requestedRef: 'v1.0.0',
        resolvedCommit: 'a'.repeat(40),
      },
      generator: { package: '@sdd/factory', version: '0.1.0' },
    });
    const rendered = new TextDecoder().decode(result.entries[0]?.content);
    expect(rendered).toContain('*                @acme/platform-admins');
    expect(rendered).toContain('/apps/backend/     @acme/platform-admins');
    expect(rendered).toContain('/apps/web/         @acme/platform-admins');
  });
});
