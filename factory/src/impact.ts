/**
 * impact.ts — `sdd impact` logic (M4).
 *
 * Computes the impact of changes between two refs: which platforms are
 * affected, which requirements/screens/operations changed, and whether
 * any breaking changes occurred.
 *
 * Two reader backends:
 *   - API reader: uses GitHub API (compare + contents endpoints)
 *   - Local git reader: uses local git commands (git diff, git show)
 *
 * The API reader is authoritative for CI; the local reader is for preview.
 */

import { execFileSync } from 'node:child_process';
import type { SDDImpact } from '@sdd/schemas';
import { validateImpactDocument } from '@sdd/schemas';
import type { MinimalOctokit, RepoRef } from './github-minimal-client.js';
import { fetchBlobAtRef, OPERATION_ID_RE } from './github-minimal-client.js';

// ---- Types ------------------------------------------------------------------

export interface ChangedPath {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  /** Only present when status === 'renamed': the path before rename (D19). */
  previousPath?: string;
}

export interface ImpactReader {
  listChangedPaths(base: string, head: string): Promise<ChangedPath[]>;
  /**
   * Read file content at a given ref. Returns null if the file does not exist
   * at that ref (normal for new files on base side). Throws on other errors
   * (auth, network, ref doesn't exist).
   */
  readFileAt(ref: string, path: string): Promise<string | null>;
}

export interface ComputeImpactInput {
  reader: ImpactReader;
  base: string;
  head: string;
  /**
   * Pre-fetched changed paths (D22). detectPlatforms always passes this
   * (using its own verified PR-files list). When omitted, computeImpact
   * calls reader.listChangedPaths itself.
   */
  changedPaths?: ChangedPath[];
}

// ---- API Reader -------------------------------------------------------------

/**
 * Create an ImpactReader backed by the GitHub API. Uses compare API for
 * listing changed files and contents API for reading blobs.
 *
 * IMPORTANT: The Compare API has a known file limit — changed files only
 * appear in the first response (up to ~300 files). The `page`/`per_page`
 * parameters paginate commits, NOT files. `total_count` refers to commit
 * count, not file count. Therefore:
 *   - `truncated=true` → fail closed (defensive explicit signal)
 *   - A response containing 300 files → fail closed because the API may have
 *     silently reached its documented changed-file cap
 *   - For authoritative CI usage, `detectPlatforms` (PR-files endpoint
 *     with D22 count verification) is the correct path — this reader is
 *     for standalone preview only (D9).
 *
 * If the compare response signals truncation OR if we cannot confirm the
 * file list is complete, this reader throws (fail closed).
 */
export function createApiImpactReader(octokit: MinimalOctokit, repo: RepoRef): ImpactReader {
  return {
    async listChangedPaths(base: string, head: string): Promise<ChangedPath[]> {
      // Single compare API call — files only appear in the first response.
      const resp = (await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
        owner: repo.owner,
        repo: repo.repo,
        base,
        head,
        per_page: 1, // minimize commit pagination; files come regardless.
      })) as {
        files?: Array<{
          filename: string;
          status: string;
          previous_filename?: string;
        }>;
        truncated?: boolean;
      };

      // Explicit truncation signal → fail closed.
      if (resp.truncated) {
        throw new Error(
          `Compare API response truncated — cannot prove complete file list (fail closed)`,
        );
      }

      const files = resp.files ?? [];

      // GitHub documents that compare responses include at most 300 changed
      // files. At the cap there is no independent file count, so exactly 300
      // is ambiguous: it may mean either complete or silently truncated.
      if (files.length >= 300) {
        throw new Error(
          `Compare API returned ${files.length} files, reaching its 300-file cap — ` +
            `cannot prove the file list is complete (fail closed). ` +
            `For authoritative results, use sdd gate detect which uses the PR-files endpoint.`,
        );
      }

      return files.map((f) => {
        const status = normalizeStatus(f.status);
        const entry: ChangedPath = { path: f.filename, status };
        if (status === 'renamed' && f.previous_filename) {
          entry.previousPath = f.previous_filename;
        }
        return entry;
      });
    },

    async readFileAt(ref: string, path: string): Promise<string | null> {
      return fetchBlobAtRef(octokit, repo, path, ref);
    },
  };
}

function normalizeStatus(status: string): 'added' | 'modified' | 'removed' | 'renamed' {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

// ---- Local Git Reader -------------------------------------------------------

/**
 * Create an ImpactReader backed by local git commands. Uses `git diff` for
 * listing changed files and `git show` for reading blobs.
 *
 * This is for local preview only, not authoritative for CI.
 */
export function createLocalGitImpactReader(repoRoot: string): ImpactReader {
  return {
    async listChangedPaths(base: string, head: string): Promise<ChangedPath[]> {
      // Use git diff --name-status -M to detect renames.
      const output = execFileSync('git', ['diff', '--name-status', '-M', base, head], {
        cwd: repoRoot,
        encoding: 'utf8',
      });

      const entries: ChangedPath[] = [];
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const code = parts[0];
        if (!code) continue;

        if (code.startsWith('R')) {
          // Rename: R<score>\t<old>\t<new>
          const oldPath = parts[1];
          const newPath = parts[2];
          if (oldPath && newPath) {
            entries.push({
              path: newPath,
              status: 'renamed',
              previousPath: oldPath,
            });
          }
        } else {
          const path = parts[1];
          if (!path) continue;
          let status: 'added' | 'modified' | 'removed';
          if (code === 'A') status = 'added';
          else if (code === 'D') status = 'removed';
          else status = 'modified';
          entries.push({ path, status });
        }
      }
      return entries;
    },

    async readFileAt(ref: string, path: string): Promise<string | null> {
      try {
        return execFileSync('git', ['show', `${ref}:${path}`], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
      } catch (err) {
        // git show exits non-zero if the path doesn't exist at that ref.
        const status = (err as { status?: number }).status;
        if (status === 128 || status === 1) return null;
        throw err;
      }
    },
  };
}

// ---- computeImpact ----------------------------------------------------------

/**
 * Compute the impact of changes between base and head. Returns an SDDImpact
 * document conforming to impact.schema.json.
 *
 * Platform boolean logic (§2.5):
 *   - contracts/**: all existing platforms (static rule)
 *   - design/tokens/**, specs/<version>/design.md: web+ios+android (no backend)
 *   - specs/<version>/architecture.md, plan.md: all existing platforms
 *   - specs/<version>/spec.md: if normalized content differs → all existing
 *   - apps/<component>/**: the component's ci platform
 *   - Unmatched apps/**: all existing platforms (conservative)
 *
 * The "existing" set is determined by which platforms have at least one
 * component whose path exists in the head tree. For computeImpact, we
 * conservatively assume all platforms are existing (the caller — detect —
 * applies the actual existing filter).
 */
export async function computeImpact(input: ComputeImpactInput): Promise<SDDImpact> {
  const { reader, base, head } = input;

  // Get changed paths (either pre-fetched or via reader).
  const changedPaths = input.changedPaths ?? (await reader.listChangedPaths(base, head));

  // Classify each changed path and accumulate platform signals.
  const platforms = { backend: false, web: false, ios: false, android: false };
  const needsImpact: string[] = []; // paths that need impact analysis

  for (const entry of changedPaths) {
    const path = entry.path;
    const previousPath = entry.previousPath;

    // contracts/** → all platforms
    if (path.startsWith('contracts/') || previousPath?.startsWith('contracts/')) {
      platforms.backend = true;
      platforms.web = true;
      platforms.ios = true;
      platforms.android = true;
      needsImpact.push(path);
      continue;
    }

    // design/tokens/** → web+ios+android (no backend)
    if (path.startsWith('design/tokens/') || previousPath?.startsWith('design/tokens/')) {
      platforms.web = true;
      platforms.ios = true;
      platforms.android = true;
      needsImpact.push(path);
      continue;
    }

    // specs/<version>/** → depends on file
    const specsMatch = path.match(/^specs\/([^/]+)\/(.+)$/);
    const prevSpecsMatch = previousPath?.match(/^specs\/([^/]+)\/(.+)$/);
    const match = specsMatch ?? prevSpecsMatch;
    if (match) {
      const fileName = match[2];
      if (fileName === 'architecture.md' || fileName === 'plan.md') {
        // architecture.md, plan.md → all platforms
        platforms.backend = true;
        platforms.web = true;
        platforms.ios = true;
        platforms.android = true;
        needsImpact.push(path);
      } else if (fileName === 'design.md') {
        // design.md → web+ios+android
        platforms.web = true;
        platforms.ios = true;
        platforms.android = true;
        needsImpact.push(path);
      } else if (fileName === 'spec.md') {
        // spec.md → check if content actually changed (normalized diff)
        needsImpact.push(path);
      } else {
        // Other specs files → all platforms (conservative, D21)
        platforms.backend = true;
        platforms.web = true;
        platforms.ios = true;
        platforms.android = true;
        needsImpact.push(path);
      }
      continue;
    }

    // apps/<component>/** → component's ci platform
    // For now, we can't determine the ci platform without reading projects.yaml.
    // The caller (detect) has that info. Here we conservatively mark all.
    if (path.startsWith('apps/') || previousPath?.startsWith('apps/')) {
      // Unmatched apps/** → all existing platforms (conservative, D5)
      platforms.backend = true;
      platforms.web = true;
      platforms.ios = true;
      platforms.android = true;
      continue;
    }

    // projects.yaml, .github/**, etc. → all existing platforms (conservative)
    if (path === 'projects.yaml' || path.startsWith('.github/')) {
      platforms.backend = true;
      platforms.web = true;
      platforms.ios = true;
      platforms.android = true;
      if (path === 'projects.yaml') {
        needsImpact.push(path);
      }
    }
  }

  // Run impact analysis for specs/design/contracts files (D20).
  const changed = {
    requirements: [] as string[],
    screens: [] as string[],
    operations: [] as string[],
  };
  let breaking = false;

  for (const path of needsImpact) {
    // Determine the read path for base (use previousPath for renames, D19).
    const entry = changedPaths.find((e) => e.path === path || e.previousPath === path);
    const basePath = entry?.previousPath ?? path;

    // specs/<version>/spec.md → whole-doc normalized diff (§2.5).
    if (path.match(/^specs\/[^/]+\/spec\.md$/)) {
      const baseContent = await reader.readFileAt(base, basePath);
      const headContent = await reader.readFileAt(head, path);
      if (hasSubstantiveChange(baseContent, headContent)) {
        // Spec changed → all existing platforms.
        platforms.backend = true;
        platforms.web = true;
        platforms.ios = true;
        platforms.android = true;
        // Also extract changed requirements (D20).
        const reqDiff = diffRequirementSections(baseContent ?? '', headContent ?? '');
        changed.requirements.push(...reqDiff.added, ...reqDiff.removed, ...reqDiff.changed);
      }
      continue;
    }

    // specs/<version>/architecture.md → extract requirements + operations.
    if (path.match(/^specs\/[^/]+\/architecture\.md$/)) {
      const baseContent = await reader.readFileAt(base, basePath);
      const headContent = await reader.readFileAt(head, path);
      const reqDiff = diffRequirementSections(baseContent ?? '', headContent ?? '');
      changed.requirements.push(...reqDiff.added, ...reqDiff.removed, ...reqDiff.changed);
      continue;
    }

    // specs/<version>/design.md → extract screens (D20).
    if (path.match(/^specs\/[^/]+\/design\.md$/)) {
      const baseContent = await reader.readFileAt(base, basePath);
      const headContent = await reader.readFileAt(head, path);
      const scrDiff = diffDesignScreens(baseContent ?? '', headContent ?? '');
      changed.screens.push(...scrDiff.added, ...scrDiff.removed, ...scrDiff.changed);
      continue;
    }

    // contracts/openapi.yaml → extract operations + breaking (D20).
    if (path === 'contracts/openapi.yaml') {
      const baseContent = await reader.readFileAt(base, basePath);
      const headContent = await reader.readFileAt(head, path);
      const opDiff = await diffOpenApiOperationsAsync(baseContent ?? '', headContent ?? '');
      changed.operations.push(...opDiff.added, ...opDiff.removed, ...opDiff.changed);
      breaking = opDiff.removed.length > 0;
    }
  }

  // Deduplicate changed IDs.
  changed.requirements = [...new Set(changed.requirements)];
  changed.screens = [...new Set(changed.screens)];
  changed.operations = [...new Set(changed.operations)];

  const result: SDDImpact = {
    base,
    head,
    changed,
    platforms,
    breaking,
    affected_issues: [],
    suggested_change_issues: [],
  };

  // Self-validate against schema (fail closed if invalid).
  const validation = await validateImpactDocument(result);
  if (!validation.ok) {
    throw new Error(
      `computeImpact produced invalid output: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`,
    );
  }

  return result;
}

// ---- Normalized text diff (§2.5) --------------------------------------------

/**
 * Normalize text for comparison: strip leading/trailing whitespace, collapse
 * consecutive blank lines to one. Used for spec.md whole-doc diff.
 */
function normalizeText(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Check if two texts have substantive changes after normalization.
 * Returns true if they differ, false if they're equivalent.
 */
function hasSubstantiveChange(baseContent: string | null, headContent: string | null): boolean {
  if (baseContent === null && headContent === null) return false;
  if (baseContent === null || headContent === null) return true;
  return normalizeText(baseContent) !== normalizeText(headContent);
}

// ---- D20: Artifact-specific semantic diff -----------------------------------

interface DiffResult {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Diff requirement sections by canonical heading (§2.5/D20).
 * Only recognizes `### REQ-<AREA>-<n>` as canonical declarations.
 * Section runs from that heading to the next same-or-higher-level heading or EOF.
 */
export function diffRequirementSections(baseContent: string, headContent: string): DiffResult {
  const baseSections = extractRequirementSections(baseContent);
  const headSections = extractRequirementSections(headContent);

  const baseIds = new Set(baseSections.keys());
  const headIds = new Set(headSections.keys());

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const id of headIds) {
    if (!baseIds.has(id)) {
      added.push(id);
    } else {
      const baseText = normalizeText(baseSections.get(id) ?? '');
      const headText = normalizeText(headSections.get(id) ?? '');
      if (baseText !== headText) {
        changed.push(id);
      }
    }
  }

  for (const id of baseIds) {
    if (!headIds.has(id)) {
      removed.push(id);
    }
  }

  return { added, removed, changed };
}

/**
 * Extract requirement sections by canonical heading.
 * Returns a Map from REQ-ID to section content (from heading to next heading or EOF).
 */
function extractRequirementSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split('\n');
  let currentId: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^### (REQ-[A-Z0-9]+-\d+)\s*$/);
    if (match) {
      // Save previous section.
      if (currentId) {
        sections.set(currentId, currentLines.join('\n'));
      }
      currentId = match[1] as string;
      currentLines = [line];
    } else if (line.match(/^#{1,3}\s/)) {
      // Same or higher level heading → end current section.
      if (currentId) {
        sections.set(currentId, currentLines.join('\n'));
        currentId = null;
        currentLines = [];
      }
    } else if (currentId) {
      currentLines.push(line);
    }
    // Lines before first REQ heading are ignored.
  }

  // Save last section.
  if (currentId) {
    sections.set(currentId, currentLines.join('\n'));
  }

  return sections;
}

/**
 * Diff design screens by canonical screen list (§2.5/D20).
 * Only recognizes SCR-IDs in the "## 2. 屏幕清单" table as canonical.
 * If body text changes can't be attributed to a specific screen, conservatively
 * report all canonical screens from both base and head.
 *
 * For screens present in both base and head, the full canonical row is compared
 * so that name/platform/description changes are reported as changed (not just
 * ID additions/removals).
 */
export function diffDesignScreens(baseContent: string, headContent: string): DiffResult {
  const baseScreens = extractCanonicalScreens(baseContent);
  const headScreens = extractCanonicalScreens(headContent);

  const baseIds = new Set(baseScreens.keys());
  const headIds = new Set(headScreens.keys());

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  // Check if body text (outside the canonical table) changed.
  const baseBody = removeCanonicalScreenTable(baseContent);
  const headBody = removeCanonicalScreenTable(headContent);
  const bodyChanged = normalizeText(baseBody) !== normalizeText(headBody);

  if (bodyChanged) {
    // Can't attribute body changes to specific screens → report all.
    const allIds = new Set([...baseIds, ...headIds]);
    return { added: [], removed: [], changed: [...allIds] };
  }

  // Body unchanged → diff the canonical table.
  for (const id of headIds) {
    if (!baseIds.has(id)) {
      added.push(id);
    } else {
      // Same ID present in both — compare full row content to catch
      // name/platform/description changes (P1 #3 fix).
      const baseRow = normalizeText(baseScreens.get(id) ?? '');
      const headRow = normalizeText(headScreens.get(id) ?? '');
      if (baseRow !== headRow) {
        changed.push(id);
      }
    }
  }

  for (const id of baseIds) {
    if (!headIds.has(id)) {
      removed.push(id);
    }
  }

  return { added, removed, changed };
}

/**
 * Extract canonical screen rows from the "## 2. 屏幕清单" table.
 * Returns a Map from SCR-ID to the full table row text (normalized).
 * Only IDs in that specific table are canonical; other SCR-* mentions are not.
 */
function extractCanonicalScreens(content: string): Map<string, string> {
  const screens = new Map<string, string>();
  const lines = content.split('\n');
  let inScreenTable = false;

  for (const line of lines) {
    if (line.match(/^## 2\.\s*屏幕清单/)) {
      inScreenTable = true;
      continue;
    }
    if (inScreenTable) {
      if (line.match(/^## /)) {
        // Next section → stop.
        break;
      }
      // Look for SCR-ID in table rows.
      const match = line.match(/\|?\s*(SCR-[A-Z0-9-]+)\s*\|?/);
      if (match) {
        const id = match[1] as string;
        // Only record first occurrence (canonical declaration).
        if (!screens.has(id)) {
          screens.set(id, line);
        }
      }
    }
  }

  return screens;
}

/**
 * Remove the canonical screen table from content, leaving the rest.
 */
function removeCanonicalScreenTable(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inScreenTable = false;

  for (const line of lines) {
    if (line.match(/^## 2\.\s*屏幕清单/)) {
      inScreenTable = true;
      continue;
    }
    if (inScreenTable) {
      if (line.match(/^## /)) {
        inScreenTable = false;
        result.push(line);
      }
      // Skip lines in the screen table.
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Diff OpenAPI operations by parsing YAML and comparing operation objects (§2.5/D20).
 * Uses operationId as the key; compares full operation objects with key-sorted
 * stable serialization to avoid false positives from key reordering.
 * Async because it needs to import the yaml parser.
 */
export async function diffOpenApiOperationsAsync(
  baseContent: string,
  headContent: string,
): Promise<DiffResult> {
  const baseOps = await extractOpenApiOperationsAsync(baseContent);
  const headOps = await extractOpenApiOperationsAsync(headContent);

  const baseIds = new Set(Object.keys(baseOps));
  const headIds = new Set(Object.keys(headOps));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const id of headIds) {
    if (!baseIds.has(id)) {
      added.push(id);
    } else {
      const baseJson = stableJsonStringify(baseOps[id]);
      const headJson = stableJsonStringify(headOps[id]);
      if (baseJson !== headJson) {
        changed.push(id);
      }
    }
  }

  for (const id of baseIds) {
    if (!headIds.has(id)) {
      removed.push(id);
    }
  }

  return { added, removed, changed };
}

/**
 * Extract OpenAPI operations by parsing YAML and traversing paths.<path>.<method>.
 * Returns a Map from operationId to the full operation object.
 * Uses the project's `yaml` dependency for proper parsing so that YAML key
 * ordering does not affect comparison.
 */
async function extractOpenApiOperationsAsync(content: string): Promise<Record<string, unknown>> {
  const ops: Record<string, unknown> = {};

  if (!content.trim()) return ops;

  const { parse: parseYaml } = await import('yaml');
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    throw new Error(
      `Failed to parse OpenAPI YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!doc || typeof doc !== 'object') return ops;
  const root = doc as Record<string, unknown>;
  const paths = root.paths;
  if (!paths || typeof paths !== 'object') return ops;

  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

  for (const [pathKey, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!methods.has(method)) continue;
      if (!operation || typeof operation !== 'object') continue;
      const op = operation as Record<string, unknown>;
      const operationId = op.operationId;
      if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) {
        throw new Error(
          `Operation at ${method} ${pathKey} has no valid operationId ` +
            `(must match ${OPERATION_ID_RE.source}, got '${String(operationId)}')`,
        );
      }
      if (ops[operationId]) {
        throw new Error(`Duplicate operationId: ${operationId}`);
      }
      ops[operationId] = op;
    }
  }

  return ops;
}

/**
 * Recursively sort all object keys for stable comparison. YAML key ordering
 * changes must not produce false positives at any nesting depth (D20).
 */
function stableJsonStringify(obj: unknown): string {
  return JSON.stringify(deepSortKeys(obj));
}

/**
 * Recursively sort object keys. Arrays preserve order. Non-objects pass through.
 */
function deepSortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepSortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}
