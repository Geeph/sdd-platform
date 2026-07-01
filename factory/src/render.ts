/**
 * render.ts — apply allowlist tokens to the template tree and produce
 * `template.lock` (canonical YAML).
 *
 * Tokens allowed:
 *   {{product}}           → product slug
 *   {{repo}}              → target GitHub org
 *   {{owners.<key>}}      → team slug from config.owners
 *
 * Rendering is purely textual: no shell / helpers / partials / code execution.
 * After substitution, any residual `{{...}}` is an error (unknown token).
 */

import { createHash } from 'node:crypto';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { sha256Hex } from './resolve.js';
import type {
  ComponentRenderContext,
  RenderContext,
  RenderedTree,
  RenderInput,
  TemplateManifest,
} from './types.js';

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Build a token→replacement lookup from the render context. */
function tokenMap(context: RenderContext | ComponentRenderContext): Map<string, string> {
  const m = new Map<string, string>();
  m.set('product', context.product);
  m.set('repo', context.repo);
  const adminsFallback = context.owners.admins;
  for (const [k, v] of Object.entries(context.owners)) {
    if (typeof v === 'string') m.set(`owners.${k}`, v);
  }
  // Bootstrap fallback: any optional owner slot (backend/web/ios/android)
  // not provided in the config falls back to `admins`. This preserves the
  // "admins own everything unspecified at init" semantic — see §1 / §3.3
  // of the M2 spec. The template can reference `{{owners.backend}}`
  // unconditionally without failing when only the 4 required owners are
  // configured.
  for (const k of ['backend', 'web', 'ios', 'android'] as const) {
    if (!m.has(`owners.${k}`) && adminsFallback) {
      m.set(`owners.${k}`, adminsFallback);
    }
  }
  // M3: per-component tokens (D2 / §1.0).
  if ('component' in context && context.component) {
    m.set('component_id', context.component.id);
    m.set('component_owner', context.component.owner);
    m.set('component_path', context.component.path);
  }
  return m;
}

/**
 * Apply token substitution. Returns the rendered content (UTF-8 bytes).
 * Throws if any `{{...}}` remains after substitution (unknown token).
 */
export function renderContent(source: Uint8Array, tokens: Map<string, string>): Uint8Array {
  const text = new TextDecoder().decode(source);
  TOKEN_RE.lastIndex = 0;
  let remaining: string | null = null;
  const out = text.replace(TOKEN_RE, (_match, token: string) => {
    const replacement = tokens.get(token);
    if (replacement === undefined) {
      remaining = token;
      return _match;
    }
    return replacement;
  });
  if (remaining !== null) {
    throw new Error(`render failed: unknown or unresolved token '{{${remaining}}}'`);
  }
  return new TextEncoder().encode(out);
}

/**
 * Compute the sha256 of the concatenation of all rendered file digests
 * (sorted by path), each prefixed with its POSIX mode. The template.lock
 * file itself is NOT included.
 *
 * Mode is part of the identity because a tree with identical content but
 * different mode (e.g. a script flipped from 100644 to 100755) is a
 * different tree.
 */
function outputTreeDigest(
  files: ReadonlyArray<{ path: string; mode: '100644' | '100755'; content: Uint8Array }>,
): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.map((f) => `${f.mode}  ${sha256Hex(f.content)}  ${f.path}`).join('\n');
  return sha256Hex(`${lines}\n`);
}

/**
 * Produce the rendered tree and `template.lock`.
 *
 * Invariants:
 *   - Files marked render=false pass through verbatim.
 *   - Files marked render=true are run through the token map; residual
 *     `{{...}}` throws.
 *   - The lock file YAML is canonical (fixed key order, sorted files array,
 *     no timestamps) and is NOT part of output_tree_sha256.
 */
export function renderTree(input: RenderInput): RenderedTree {
  const tokens = tokenMap(input.context);
  const manifest: TemplateManifest = input.tree.manifest;

  const rendered: Array<{
    path: string;
    mode: '100644' | '100755';
    content: Uint8Array;
  }> = [];
  const fileDigests: Array<{
    path: string;
    mode: '100644' | '100755';
    source_sha256: string;
    output_sha256: string;
  }> = [];

  // Render in manifest order.
  for (const mf of manifest.files) {
    const entry = input.tree.entries.find((e) => e.path === mf.path);
    if (!entry) {
      throw new Error(`manifest lists '${mf.path}' but tree is missing it`);
    }
    const sourceSha = sha256Hex(entry.content);
    const renderedContent = mf.render ? renderContent(entry.content, tokens) : entry.content;
    const outputSha = sha256Hex(renderedContent);
    rendered.push({ path: mf.path, mode: mf.mode, content: renderedContent });
    fileDigests.push({
      path: mf.path,
      mode: mf.mode,
      source_sha256: sourceSha,
      output_sha256: outputSha,
    });
  }

  // Extra validation: ensure no `{{` remains in any rendered output, even for
  // files marked render=false (they shouldn't contain tokens, but guard
  // anyway).
  for (const r of rendered) {
    const text = new TextDecoder().decode(r.content);
    TOKEN_RE.lastIndex = 0;
    const m = TOKEN_RE.exec(text);
    if (m) {
      throw new Error(`rendered output of ${r.path} still contains unresolved token '{{${m[1]}}}'`);
    }
  }

  const outputTreeSha256 = outputTreeDigest(rendered);

  // Build template.lock as canonical YAML (fixed key order, sorted files).
  // Template name/path come from the manifest (D2: no longer hardcoded to
  // monorepo-root).
  const sortedDigests = [...fileDigests].sort((a, b) => a.path.localeCompare(b.path));
  const lock = {
    schema_version: 1,
    generator: { package: input.generator.package, version: input.generator.version },
    source: {
      repository: input.source.repository,
      requested_ref: input.source.requestedRef,
      resolved_commit: input.source.resolvedCommit,
    },
    template: {
      name: manifest.template,
      path: manifest.path,
      manifest_sha256: sha256Hex(
        new TextEncoder().encode(`${JSON.stringify(canonicalManifestJson(manifest), null, 2)}\n`),
      ),
      source_tree_sha256: input.tree.sourceTreeSha256,
      output_tree_sha256: outputTreeSha256,
    },
    files: sortedDigests.map((d) => ({
      path: d.path,
      mode: d.mode,
      source_sha256: d.source_sha256,
      output_sha256: d.output_sha256,
    })),
  };
  const lockYaml = yamlStringify(lock, {
    lineWidth: 0,
    singleQuote: false,
    strict: true,
  });

  return {
    entries: rendered,
    outputTreeSha256,
    lockYaml,
    fileDigests: sortedDigests,
  };
}

/**
 * Manifest serialized as canonical JSON (same shape as the on-disk manifest).
 * Used only to compute manifest_sha256 for the lock file.
 */
function canonicalManifestJson(manifest: TemplateManifest): unknown {
  return {
    template: manifest.template,
    path: manifest.path,
    tree_sha256: manifest.tree_sha256,
    files: manifest.files.map((f) => ({
      path: f.path,
      mode: f.mode,
      render: f.render,
      sha256: f.sha256,
    })),
  };
}

/**
 * Helper for callers that need to verify the lock file content parses back
 * to the expected structure (round-trip check in tests).
 */
export function parseLockYaml(yaml: string): unknown {
  return yamlParse(yaml);
}

/**
 * Compute sha256 for a Uint8Array using node:crypto. Exported for callers
 * that need to re-digest rendered output without going through renderTree.
 */
export { sha256Hex };

// Export for tests — deterministic digest of the concatenation.
export function computeOutputTreeDigest(
  files: ReadonlyArray<{ path: string; mode: '100644' | '100755'; content: Uint8Array }>,
): string {
  return outputTreeDigest(files);
}

// Export createHash for tests that need raw sha256 without sha256: prefix.
export function rawSha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
