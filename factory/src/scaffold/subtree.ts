/**
 * scaffold/subtree.ts — D25 "component subtree integrity check" primitive.
 *
 * Shared by D20 (scaffold branch/PR reuse) and D24 (merge-time hygiene).
 * Given a component's path, its expected file set (each with
 * `output_sha256` = sha256(file-content)), and a target tree SHA,
 * recursively enumerate the target tree, restrict to entries under
 * `path + "/"`, assert set equality with the expected file set, then
 * fetch each blob content and compare `sha256(content)` against the
 * expected `output_sha256`.
 *
 * **Never** compare a Git blob SHA (`sha1("blob "+len+"\0"+content)`) to
 * `output_sha256` — they are different hash functions over different
 * inputs, and the comparison is always false regardless of content.
 */

import { sha256Hex } from '../resolve.js';
import type { RepoRef } from '../types.js';
import type { ScaffoldReadPort, TreeEntry } from './types.js';

export interface ExpectedFile {
  /** Path relative to the component root (e.g. "build.gradle.kts"). */
  path: string;
  /** POSIX mode. */
  mode: '100644' | '100755';
  /** Expected sha256 of the file's raw bytes. */
  output_sha256: string;
}

export interface SubtreeVerificationInput {
  /** Component's full path (e.g. "apps/backend"). */
  componentPath: string;
  /** Expected file set (paths relative to componentPath). */
  expectedFiles: ReadonlyArray<ExpectedFile>;
  /** Target tree SHA to verify (D20: branch tip; D24: PR head). */
  targetTreeSha: string;
  /** Read port for fetching tree entries and blob contents. */
  reader: ScaffoldReadPort;
  /** Target repo. */
  repo: RepoRef;
}

export interface SubtreeVerificationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify that a target tree contains exactly the expected file set under
 * `componentPath`, and that each file's content hashes to the expected
 * `output_sha256` (D25).
 */
export async function verifyComponentSubtree(
  input: SubtreeVerificationInput,
): Promise<SubtreeVerificationResult> {
  const prefix = `${input.componentPath}/`;

  // Step 1: recursively enumerate the target tree.
  const allEntries = await input.reader.readTreeRecursive(input.repo, input.targetTreeSha);

  // Step 2: restrict to entries under the component path prefix (blobs only).
  const inSubtree: TreeEntry[] = [];
  for (const entry of allEntries) {
    if (entry.path.startsWith(prefix) && entry.type === 'blob') {
      inSubtree.push(entry);
    }
  }

  // Build a map from component-relative path to tree entry.
  const actualByRelPath = new Map<string, TreeEntry>();
  for (const entry of inSubtree) {
    const relPath = entry.path.slice(prefix.length);
    actualByRelPath.set(relPath, entry);
  }

  // Step 3: set equality — expected paths must equal actual paths.
  const expectedByPath = new Map<string, ExpectedFile>();
  for (const ef of input.expectedFiles) {
    expectedByPath.set(ef.path, ef);
  }

  // Missing files (in expected but not in actual).
  const missing: string[] = [];
  for (const ef of input.expectedFiles) {
    if (!actualByRelPath.has(ef.path)) {
      missing.push(ef.path);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `subtree verification failed for '${input.componentPath}': missing files [${missing.join(', ')}]`,
    };
  }

  // Extra files (in actual but not in expected).
  const extra: string[] = [];
  for (const relPath of actualByRelPath.keys()) {
    if (!expectedByPath.has(relPath)) {
      extra.push(relPath);
    }
  }
  if (extra.length > 0) {
    return {
      ok: false,
      reason: `subtree verification failed for '${input.componentPath}': unexpected files [${extra.join(', ')}]`,
    };
  }

  // Step 4: per-file content comparison — fetch each blob by SHA, compute
  // sha256(content), compare to expected output_sha256.
  for (const ef of input.expectedFiles) {
    const entry = actualByRelPath.get(ef.path);
    if (!entry) continue; // Already handled above.

    // Mode check.
    if (entry.mode !== ef.mode) {
      return {
        ok: false,
        reason: `subtree verification failed for '${input.componentPath}/${ef.path}': mode mismatch (expected ${ef.mode}, actual ${entry.mode})`,
      };
    }

    // Fetch blob content by SHA (NOT by tree entry's blob SHA — we need
    // the actual bytes, not Git's sha1("blob "+len+"\0"+content) wrapper).
    const content = await input.reader.readBlobContent(input.repo, entry.sha);
    const actualSha256 = sha256Hex(content);
    if (actualSha256 !== ef.output_sha256) {
      return {
        ok: false,
        reason: `subtree verification failed for '${input.componentPath}/${ef.path}': content hash mismatch (expected ${ef.output_sha256}, actual ${actualSha256})`,
      };
    }
  }

  return { ok: true };
}
