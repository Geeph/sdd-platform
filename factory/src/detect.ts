/**
 * detect.ts — `sdd gate detect` logic (M4).
 *
 * Determines which platforms are affected by a PR. Combines:
 *   - Path rules (§2.4 table)
 *   - sdd impact analysis (§2.5)
 *   - PR platform:* labels (§2.6)
 *   - existing[platform] AND gate (§2.3/D18/D25)
 *
 * Output: DetectResult with 4 platform booleans, 4 *_paths arrays,
 * contract_changed, product_repo, head_sha.
 */

import type { SDDProjects } from '@sdd/schemas';
import { validateProjectsDocument } from '@sdd/schemas';
import type { MinimalOctokit, RepoRef } from './github-minimal-client.js';
import {
  fetchBlobAtRef,
  fetchChangedFiles,
  fetchPullRequest,
  fetchRecursiveTree,
} from './github-minimal-client.js';
import type { ChangedPath } from './impact.js';
import { computeImpact, createApiImpactReader } from './impact.js';

// ---- Types ------------------------------------------------------------------

export interface DetectInput {
  octokit: MinimalOctokit;
  repo: RepoRef;
  pr: number;
}

export interface DetectResult {
  backend: boolean;
  web: boolean;
  ios: boolean;
  android: boolean;
  backend_paths: string[];
  web_paths: string[];
  ios_paths: string[];
  android_paths: string[];
  contract_changed: boolean;
  product_repo: string;
  head_sha: string;
}

interface ComponentRef {
  path: string;
  ci: 'java' | 'web' | 'ios' | 'android';
}

// ---- CI value to output field mapping ---------------------------------------

const CI_TO_OUTPUT: Record<
  string,
  keyof Pick<DetectResult, 'backend' | 'web' | 'ios' | 'android'>
> = {
  java: 'backend',
  web: 'web',
  ios: 'ios',
  android: 'android',
};

const CI_TO_PATHS: Record<
  string,
  keyof Pick<DetectResult, 'backend_paths' | 'web_paths' | 'ios_paths' | 'android_paths'>
> = {
  java: 'backend_paths',
  web: 'web_paths',
  ios: 'ios_paths',
  android: 'android_paths',
};

// ---- detectPlatforms --------------------------------------------------------

/**
 * Detect which platforms are affected by a PR. Implements the full 10-step
 * algorithm from §2.2:
 *   1. Read PR metadata (base/head SHA, labels, changed_files count)
 *   2. Read + validate base/head projects.yaml
 *   3. Build declared[platform] + headComponents; check existence (D25)
 *   4. Fetch PR changed files (full pagination, D22 count verification)
 *   5. Classify each changed path (§2.4 table, D19/D26 rename handling)
 *   6. If specs/design/contracts changed, call computeImpact (D22 pre-fetched)
 *   7. OR in platform:* labels (§2.6)
 *   8. AND existing[platform] (D4/D18/D25)
 *   9. Compute contract_changed (§2.7, narrow scope)
 *  10. Output JSON
 */
export async function detectPlatforms(input: DetectInput): Promise<DetectResult> {
  const { octokit, repo, pr } = input;

  // Step 1: Read PR metadata.
  const prInfo = await fetchPullRequest(octokit, repo, pr);
  const baseSha = prInfo.base.sha;
  const headSha = prInfo.head.sha;

  // Step 2: Read + validate base and head projects.yaml.
  const [baseProjects, headProjects] = await Promise.all([
    readAndValidateProjects(octokit, repo, baseSha),
    readAndValidateProjects(octokit, repo, headSha),
  ]);

  // Step 3: Build component lists and check existence (D25).
  const baseComponents = extractComponents(baseProjects);
  const headComponents = extractComponents(headProjects);

  // Check existence for each head-declared component (D25: check both base and head).
  const existence = await checkComponentExistence(octokit, repo, headComponents, baseSha, headSha);

  // Build declared[platform] and *_paths.
  const declared = { backend: false, web: false, ios: false, android: false };
  const pathsOutput = {
    backend_paths: [] as string[],
    web_paths: [] as string[],
    ios_paths: [] as string[],
    android_paths: [] as string[],
  };
  const existing = { backend: false, web: false, ios: false, android: false };

  for (const comp of headComponents) {
    const outputField = CI_TO_OUTPUT[comp.ci];
    if (!outputField) continue;
    declared[outputField] = true;

    const exist = existence.get(comp.path);
    if (!exist) continue; // Should not happen, but be safe.

    // D25: if exists at base but not at head, fail closed.
    if (exist.existsAtBase && !exist.existsAtHead) {
      throw new Error(
        `Component '${comp.path}' exists at base but not at head — still declared in projects.yaml. ` +
          `This is ambiguous (deleted but not removed from declaration?) — fail closed.`,
      );
    }

    // If exists at head, add to *_paths.
    if (exist.existsAtHead) {
      const pathsField = CI_TO_PATHS[comp.ci];
      if (pathsField) {
        pathsOutput[pathsField].push(comp.path);
      }
      existing[outputField] = true;
    }
  }

  // Step 4: Fetch PR changed files (D22: verify count).
  const changedFileEntries = await fetchChangedFiles(octokit, repo, pr, prInfo.changed_files);

  // Convert to ChangedPath format for impact.
  const changedPaths: ChangedPath[] = changedFileEntries.map((e) => {
    const entry: ChangedPath = { path: e.filename, status: e.status };
    if (e.status === 'renamed' && e.previous_filename) {
      entry.previousPath = e.previous_filename;
    }
    return entry;
  });

  // Step 5: Classify each changed path (§2.4 table, D19/D26).
  const pathSignal = { backend: false, web: false, ios: false, android: false };
  let needsImpact = false;

  for (const entry of changedPaths) {
    const path = entry.path;
    const previousPath = entry.previousPath;

    // Classify using head components for path, base components for previousPath (D26).
    const hits = classifyPath(path, previousPath, headComponents, baseComponents);

    for (const hit of hits) {
      const outputField = CI_TO_OUTPUT[hit.ci];
      if (outputField) {
        pathSignal[outputField] = true;
      }
    }

    // Check if this path needs impact analysis.
    if (needsImpactForPath(path, previousPath)) {
      needsImpact = true;
    }

    // Unmatched apps/** → all existing platforms (D5).
    if ((path.startsWith('apps/') || previousPath?.startsWith('apps/')) && hits.length === 0) {
      pathSignal.backend = true;
      pathSignal.web = true;
      pathSignal.ios = true;
      pathSignal.android = true;
    }
  }

  // Step 6: Call computeImpact if needed (D22: pass pre-fetched changedPaths).
  // The impact's changed.requirements/.screens/.operations and breaking are
  // used only in the SDDImpact document; detect's DetectResult doesn't expose
  // them directly (per M4 spec), so we only need the platform booleans here.
  const impactPlatforms = { backend: false, web: false, ios: false, android: false };

  if (needsImpact) {
    const reader = createApiImpactReader(octokit, repo);
    try {
      const impact = await computeImpact({
        reader,
        base: baseSha,
        head: headSha,
        changedPaths,
      });
      impactPlatforms.backend = impact.platforms.backend;
      impactPlatforms.web = impact.platforms.web;
      impactPlatforms.ios = impact.platforms.ios;
      impactPlatforms.android = impact.platforms.android;
    } catch (err) {
      // Fail closed: impact failure → detect failure (D13/§2.2 step 6).
      throw new Error(`sdd impact failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 7: OR in platform:* labels (§2.6).
  const labelSignal = { backend: false, web: false, ios: false, android: false };
  for (const label of prInfo.labels) {
    const match = label.name.match(/^platform:(backend|web|ios|android)$/);
    if (match) {
      const platform = match[1] as 'backend' | 'web' | 'ios' | 'android';
      labelSignal[platform] = true;
    }
  }

  // Combine: pathSignal OR impactPlatforms OR labelSignal.
  const combined = {
    backend: pathSignal.backend || impactPlatforms.backend || labelSignal.backend,
    web: pathSignal.web || impactPlatforms.web || labelSignal.web,
    ios: pathSignal.ios || impactPlatforms.ios || labelSignal.ios,
    android: pathSignal.android || impactPlatforms.android || labelSignal.android,
  };

  // Step 8: AND existing[platform] (D4/D18/D25).
  const final = {
    backend: combined.backend && existing.backend,
    web: combined.web && existing.web,
    ios: combined.ios && existing.ios,
    android: combined.android && existing.android,
  };

  // Step 9: Compute contract_changed (§2.7, narrow scope to openapi.yaml only).
  const contractChanged = changedFileEntries.some(
    (f) => f.filename === 'contracts/openapi.yaml' && f.status !== 'removed',
  );

  // Step 10: Output.
  return {
    backend: final.backend,
    web: final.web,
    ios: final.ios,
    android: final.android,
    ...pathsOutput,
    contract_changed: contractChanged,
    product_repo: prInfo.base.repo.full_name,
    head_sha: headSha,
  };
}

// ---- Helpers ----------------------------------------------------------------

async function readAndValidateProjects(
  octokit: MinimalOctokit,
  repo: RepoRef,
  ref: string,
): Promise<SDDProjects> {
  const content = await fetchBlobAtRef(octokit, repo, 'projects.yaml', ref);
  if (content === null) {
    throw new Error(`projects.yaml not found at ref ${ref.slice(0, 8)}`);
  }

  // Parse YAML.
  const { parse: parseYaml } = await import('yaml');
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new Error(
      `Failed to parse projects.yaml at ${ref.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Validate.
  const validation = await validateProjectsDocument(parsed);
  if (!validation.ok) {
    throw new Error(
      `projects.yaml at ${ref.slice(0, 8)} invalid: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`,
    );
  }

  return parsed as SDDProjects;
}

function extractComponents(projects: SDDProjects): ComponentRef[] {
  return projects.components.map((c) => ({
    path: c.path,
    ci: c.ci as ComponentRef['ci'],
  }));
}

async function checkComponentExistence(
  octokit: MinimalOctokit,
  repo: RepoRef,
  components: ComponentRef[],
  baseSha: string,
  headSha: string,
): Promise<Map<string, { existsAtBase: boolean; existsAtHead: boolean }>> {
  const result = new Map<string, { existsAtBase: boolean; existsAtHead: boolean }>();

  // Try recursive tree first (D18).
  const [baseTree, headTree] = await Promise.all([
    fetchRecursiveTree(octokit, repo, baseSha),
    fetchRecursiveTree(octokit, repo, headSha),
  ]);

  if (!baseTree.truncated && !headTree.truncated) {
    // Use tree for existence checks.
    const basePathSet = new Set(baseTree.entries.map((e) => e.path));
    const headPathSet = new Set(headTree.entries.map((e) => e.path));

    for (const comp of components) {
      const existsAtBase = hasContentUnderPath(comp.path, basePathSet);
      const existsAtHead = hasContentUnderPath(comp.path, headPathSet);
      result.set(comp.path, { existsAtBase, existsAtHead });
    }
    return result;
  }

  // Fallback: per-component Contents API checks (D18).
  // Only 404 means "does not exist"; any other error (403, network, etc.)
  // must propagate — fail closed (cannot prove existence either way).
  for (const comp of components) {
    const existsAtBase = await pathExistsOrThrows(octokit, repo, comp.path, baseSha);
    const existsAtHead = await pathExistsOrThrows(octokit, repo, comp.path, headSha);
    result.set(comp.path, { existsAtBase, existsAtHead });
  }

  return result;
}

function hasContentUnderPath(path: string, pathSet: Set<string>): boolean {
  // Check if any entry equals or starts with path + '/'.
  for (const p of pathSet) {
    if (p === path || p.startsWith(`${path}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether `path` has any content at the given ref. 404 → false
 * (path does not exist). Any other error (403, network, ref doesn't exist)
 * throws — fail closed. A non-empty directory listing means the path exists.
 */
async function pathExistsOrThrows(
  octokit: MinimalOctokit,
  repo: RepoRef,
  path: string,
  ref: string,
): Promise<boolean> {
  try {
    const resp = (await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner,
      repo: repo.repo,
      path,
      ref,
    })) as unknown;
    // A non-empty directory listing or a single file means the path exists.
    if (Array.isArray(resp)) return resp.length > 0;
    // Single file response (object with content) means the path exists.
    if (resp && typeof resp === 'object') return true;
    return false;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return false;
    throw err; // 403, network, etc. → fail closed.
  }
}

function classifyPath(
  path: string,
  previousPath: string | undefined,
  headComponents: ComponentRef[],
  baseComponents: ComponentRef[],
): ComponentRef[] {
  const hits: ComponentRef[] = [];

  // Classify path against head components.
  const headHit = mapPath(path, headComponents);
  if (headHit) hits.push(headHit);

  // Classify previousPath against base components (D26).
  if (previousPath) {
    const baseHit = mapPath(previousPath, baseComponents);
    if (baseHit && baseHit !== headHit) {
      hits.push(baseHit);
    }
  }

  return hits;
}

function mapPath(changedPath: string, components: ComponentRef[]): ComponentRef | undefined {
  return components.find((c) => changedPath === c.path || changedPath.startsWith(`${c.path}/`));
}

function needsImpactForPath(path: string, previousPath?: string): boolean {
  // specs/**, design/**, contracts/** need impact analysis.
  if (path.startsWith('specs/') || previousPath?.startsWith('specs/')) return true;
  if (path.startsWith('design/') || previousPath?.startsWith('design/')) return true;
  if (path.startsWith('contracts/') || previousPath?.startsWith('contracts/')) return true;
  return false;
}
