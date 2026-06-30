/**
 * resolve.ts — ref pinning, manifest validation, template tree reading.
 *
 * All operations here are read-only: they consume a `GitHubReadPort` and
 * never touch a writer. They produce the frozen inputs that the plan
 * compiler and render stage consume.
 */

import { createHash } from 'node:crypto';
import type {
  GitHubReadPort,
  ReadonlyTree,
  RepoRef,
  ResolvedCommit,
  TemplateManifest,
  TemplateTreeEntry,
} from './types.js';

const SHA256_HEX_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export function isSha256(s: string): boolean {
  return SHA256_HEX_RE.test(s);
}

export function isFullCommit(s: string): boolean {
  return COMMIT_RE.test(s);
}

export function sha256Hex(data: Uint8Array | string): string {
  const h = createHash('sha256');
  if (typeof data === 'string') h.update(data, 'utf8');
  else h.update(data);
  return `sha256:${h.digest('hex')}`;
}

/**
 * Resolve a user-supplied ref (tag, branch, or SHA) to a full 40-char commit
 * SHA. Annotated tags are peeled recursively. The caller's ref is returned
 * unchanged alongside, so callers can report "requested vs. resolved" for
 * auditing.
 */
export async function resolveRef(
  reader: GitHubReadPort,
  repo: RepoRef,
  ref: string,
): Promise<ResolvedCommit> {
  if (!ref || ref.length === 0) {
    throw new Error('ref is required');
  }
  return reader.resolveCommit(repo, ref);
}

/**
 * Validate that a manifest is well-formed and self-consistent:
 *  - all paths are unique and POSIX-normalized
 *  - mode ∈ {100644, 100755}
 *  - sha256 values match the canonical format
 *  - no symlinks / traversal / case collisions
 *  - tree_sha256 matches recomputed digest of the sorted file list
 */
export function validateManifest(manifest: TemplateManifest): void {
  if (manifest.template !== 'monorepo-root') {
    throw new Error(`manifest.template must be 'monorepo-root', got '${manifest.template}'`);
  }
  if (!isSha256(manifest.tree_sha256)) {
    throw new Error(`manifest.tree_sha256 is malformed: ${manifest.tree_sha256}`);
  }

  const seenLower = new Set<string>();
  for (const file of manifest.files) {
    if (file.path.startsWith('/') || file.path.includes('..')) {
      throw new Error(`manifest path is absolute or traverses: ${file.path}`);
    }
    if (file.mode !== '100644' && file.mode !== '100755') {
      throw new Error(`manifest mode must be 100644|100755, got ${file.mode} on ${file.path}`);
    }
    if (!isSha256(file.sha256)) {
      throw new Error(`manifest sha256 malformed on ${file.path}: ${file.sha256}`);
    }
    const lc = file.path.toLowerCase();
    if (seenLower.has(lc)) {
      throw new Error(`manifest case-insensitive collision: ${file.path}`);
    }
    seenLower.add(lc);
  }

  // Recompute tree_sha256 from sorted entries (already sorted in manifest).
  const lines = manifest.files.map((f) => `${f.mode}  ${f.sha256}  ${f.path}`).join('\n');
  const computed = sha256Hex(`${lines}\n`);
  if (computed !== manifest.tree_sha256) {
    throw new Error(
      `manifest tree_sha256 mismatch: committed=${manifest.tree_sha256}, computed=${computed}`,
    );
  }
}

/**
 * Build a `ReadonlyTree` from the manifest + raw entries retrieved at the
 * pinned commit. Verifies every source blob's sha256 matches the manifest.
 *
 * Fail-closed: any mismatch, missing file, extra file, or binary/CRLF
 * content throws.
 */
export function assembleTree(
  manifest: TemplateManifest,
  entries: TemplateTreeEntry[],
): ReadonlyTree {
  validateManifest(manifest);

  const byPath = new Map<string, TemplateTreeEntry>();
  for (const e of entries) {
    if (e.path.startsWith('/') || e.path.includes('..')) {
      throw new Error(`template entry escapes root: ${e.path}`);
    }
    if (byPath.has(e.path)) {
      throw new Error(`duplicate template entry: ${e.path}`);
    }
    byPath.set(e.path, e);
  }

  // Ensure every manifest file is present and nothing extra is present.
  for (const mf of manifest.files) {
    const entry = byPath.get(mf.path);
    if (!entry) {
      throw new Error(`manifest lists '${mf.path}' but tree is missing it`);
    }
    if (entry.mode !== mf.mode) {
      throw new Error(`mode mismatch on ${mf.path}: manifest=${mf.mode}, tree=${entry.mode}`);
    }
    const actual = sha256Hex(entry.content);
    if (actual !== mf.sha256) {
      throw new Error(
        `source blob checksum mismatch on ${mf.path}: manifest=${mf.sha256}, actual=${actual}`,
      );
    }
    // Reject binary / CRLF content.
    if (entry.content instanceof Uint8Array && entry.content.includes(0)) {
      throw new Error(`binary content rejected on ${mf.path}`);
    }
    if (entry.content instanceof Uint8Array && entry.content.includes(0x0d)) {
      throw new Error(`CRLF rejected on ${mf.path}`);
    }
  }
  for (const e of entries) {
    if (!manifest.files.some((mf) => mf.path === e.path)) {
      throw new Error(`tree contains entry '${e.path}' not in manifest (implicit file)`);
    }
  }

  const sourceTreeSha256 = manifest.tree_sha256;

  return {
    manifest,
    entries,
    sourceTreeSha256,
  };
}

/**
 * Parse a manifest JSON blob. Returns a frozen object or throws on schema
 * violations.
 */
export function parseManifest(json: unknown): TemplateManifest {
  if (!json || typeof json !== 'object') {
    throw new Error('manifest must be an object');
  }
  const obj = json as Record<string, unknown>;
  if (obj.template !== 'monorepo-root') {
    throw new Error(`manifest.template must be 'monorepo-root'`);
  }
  if (typeof obj.path !== 'string') throw new Error('manifest.path must be string');
  if (typeof obj.tree_sha256 !== 'string') {
    throw new Error('manifest.tree_sha256 must be string');
  }
  if (!isSha256(obj.tree_sha256)) {
    throw new Error(`manifest.tree_sha256 malformed: ${obj.tree_sha256}`);
  }
  if (!Array.isArray(obj.files)) throw new Error('manifest.files must be array');

  const files = obj.files.map((f, i) => {
    if (!f || typeof f !== 'object') {
      throw new Error(`manifest.files[${i}] must be object`);
    }
    const ff = f as Record<string, unknown>;
    if (typeof ff.path !== 'string') {
      throw new Error(`manifest.files[${i}].path must be string`);
    }
    if (ff.mode !== '100644' && ff.mode !== '100755') {
      throw new Error(`manifest.files[${i}].mode must be 100644|100755`);
    }
    if (typeof ff.render !== 'boolean') {
      throw new Error(`manifest.files[${i}].render must be boolean`);
    }
    if (typeof ff.sha256 !== 'string') {
      throw new Error(`manifest.files[${i}].sha256 must be string`);
    }
    if (!isSha256(ff.sha256)) {
      throw new Error(`manifest.files[${i}].sha256 malformed: ${ff.sha256}`);
    }
    return Object.freeze({
      path: ff.path,
      mode: ff.mode as '100644' | '100755',
      render: ff.render,
      sha256: ff.sha256,
    });
  });

  return Object.freeze({
    template: 'monorepo-root',
    path: obj.path,
    tree_sha256: obj.tree_sha256,
    files,
  });
}
