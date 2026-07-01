/**
 * gate-hygiene.ts — `sdd gate hygiene` logic (M2c).
 *
 * Implements §3.5 PR hygiene rules:
 *   1. Gate type/version: exactly one gate:<gate> label; marker matches label;
 *      marker.version matches ^v\d+$; all changed specs/** paths are under
 *      specs/<version>/; version:* label consistent if present.
 *   2. Required artifacts: spec→spec.md; architecture→architecture.md +
 *      projects.yaml; design→design.md; plan→plan.md.
 *   3. Stable IDs: spec has ≥1 REQ-…; design has ≥1 SCR-…; operationId valid
 *      and unique within document.
 *   4. Upstream approvals: architecture/design/plan reference PR/SHA that
 *      exists, merged to main, with correct gate:* label. Plan with no UI
 *      has design=skipped and non-empty skip_design_gate_reason.
 *   5. CODEOWNER: changed paths fall under matching CODEOWNERS rules, read
 *      from the BASE branch SHA (PR must not be able to rewrite its own
 *      CODEOWNERS verdict — §3.6 / D10).
 *   6. Read method: full pagination for changed files; artifact blobs at PR
 *      head SHA, CODEOWNERS at PR base SHA.
 *   7. Fail closed: any parse/API/validation failure → non-zero exit.
 *
 * Non-Gate PRs (no gate:* label, e.g. Bootstrap PR) only do generic checks
 * and pass.
 */

// ---- Octokit-like interface for hygiene checks -----------------------------

export interface HygieneOctokit {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

export interface HygieneInput {
  octokit: HygieneOctokit;
  repo: { owner: string; repo: string };
  pr: number;
}

export type HygieneResult = { ok: true } | { ok: false; violations: string[] };

// ---- Gate marker parsing (§1.4) -------------------------------------------

interface GateMarker {
  gate: string;
  version: string;
  upstream_approvals: Record<string, string>;
  skip_design_gate_reason?: string;
}

const GATE_MARKER_RE = /<!--\s*sdd:gate\s*\n([\s\S]*?)-->/;
const GATE_LABEL_RE = /^gate:(spec|architecture|design|plan|contract)$/;
const VERSION_LABEL_RE = /^version:(v\d+)$/;
const VERSION_MARKER_RE = /^v\d+$/;
const REQ_ID_RE = /^REQ-[A-Z0-9]+-\d+$/;
const SCR_ID_RE = /^SCR-[A-Z0-9-]+$/;
const OPERATION_ID_RE = /^[a-z][a-zA-Z0-9_-]*$/;
const UPSTREAM_PR_REF_RE = /^#(\d+)$/;
const UPSTREAM_SHA_REF_RE = /^[0-9a-f]{40}$/;

const VALID_GATES = new Set(['spec', 'architecture', 'design', 'plan', 'contract']);

// Map from current gate type → upstream gate types that must have been
// approved before this gate can proceed. Spec has no upstream; architecture
// depends on spec; design depends on spec+architecture; plan depends on
// spec+architecture+design.
const UPSTREAM_GATES_FOR: Record<string, string[]> = {
  spec: [],
  architecture: ['spec'],
  design: ['spec', 'architecture'],
  plan: ['spec', 'architecture', 'design'],
  contract: ['spec', 'architecture'],
};

// ---- Public API ------------------------------------------------------------

/**
 * Check PR hygiene for a given PR. Returns `{ ok: true }` if all rules pass,
 * or `{ ok: false, violations: [...] }` with a list of violation descriptions.
 *
 * Non-Gate PRs (no gate:* label) only do generic checks and pass.
 * Fails closed on any API or parse error.
 */
export async function checkPrHygiene(input: HygieneInput): Promise<HygieneResult> {
  const violations: string[] = [];

  try {
    // Fetch PR details.
    const pr = (await input.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: input.repo.owner,
      repo: input.repo.repo,
      pull_number: input.pr,
    })) as {
      head: { sha: string };
      base: { sha: string; ref: string };
      labels: Array<{ name: string }>;
      body: string | null;
      user: { login: string };
    };

    const headSha = pr.head.sha;
    const baseSha = pr.base.sha;

    // Extract gate labels.
    const gateLabels = pr.labels.map((l) => l.name).filter((name) => GATE_LABEL_RE.test(name));

    // Non-Gate PR: only generic checks, pass.
    if (gateLabels.length === 0) {
      return { ok: true };
    }

    // §3.5.1: Exactly one gate:<gate> label.
    if (gateLabels.length > 1) {
      violations.push(
        `multiple gate labels found: ${gateLabels.join(', ')} (expected exactly one)`,
      );
      return { ok: false, violations };
    }

    const gateLabel = gateLabels[0]!;
    const gateType = gateLabel.replace('gate:', '');

    if (!VALID_GATES.has(gateType)) {
      violations.push(`invalid gate type: '${gateType}'`);
      return { ok: false, violations };
    }

    // Parse the gate marker from PR body.
    const marker = parseGateMarker(pr.body ?? '');
    if (!marker) {
      violations.push('PR body missing sdd:gate marker block');
      return { ok: false, violations };
    }

    // §3.5.1: marker.gate must match label.
    if (marker.gate !== gateType) {
      violations.push(`marker gate '${marker.gate}' does not match label '${gateLabel}'`);
    }

    // §3.5.1: marker.version must match ^v\d+$.
    if (!VERSION_MARKER_RE.test(marker.version)) {
      violations.push(`marker version '${marker.version}' does not match ^v\\d+$`);
    }

    // Check version:* label consistency if present.
    const versionLabels = pr.labels
      .map((l) => l.name)
      .filter((name) => VERSION_LABEL_RE.test(name));

    if (versionLabels.length > 0) {
      const versionLabel = versionLabels[0]!;
      const labelVersion = versionLabel.replace('version:', '');
      if (labelVersion !== marker.version) {
        violations.push(
          `version label '${versionLabel}' does not match marker version '${marker.version}'`,
        );
      }
    }

    // Fetch changed files (full pagination).
    const changedFiles = await fetchAllChangedFiles(input.octokit, input.repo, input.pr);

    // §3.5.1: All changed specs/** paths must be under specs/<version>/.
    const version = marker.version;
    const specPaths = changedFiles.filter(
      (f) => f.filename.startsWith('specs/') && !f.filename.startsWith('specs/_template/'),
    );

    for (const sp of specPaths) {
      if (!sp.filename.startsWith(`specs/${version}/`)) {
        violations.push(`changed file '${sp.filename}' is not under specs/${version}/`);
      }
    }

    // §3.5.2: Required artifacts for this gate type.
    const requiredArtifacts = getRequiredArtifacts(gateType, version);
    const changedFilenames = new Set(changedFiles.map((f) => f.filename));

    for (const artifact of requiredArtifacts) {
      if (!changedFilenames.has(artifact)) {
        violations.push(`required artifact '${artifact}' not in changed files`);
      }
    }

    // §3.5.3: Stable IDs — fetch blobs at PR head SHA and check content.
    // Artifact blobs are read at head SHA because that is what the PR is
    // proposing; CODEOWNERS (below) is read at base SHA (D10).
    if (gateType === 'spec') {
      const specPath = `specs/${version}/spec.md`;
      if (changedFilenames.has(specPath)) {
        const content = await fetchBlobContentStrict(input.octokit, input.repo, specPath, headSha);
        const reqIds = extractReqIds(content);
        if (reqIds.length === 0) {
          violations.push('spec.md must contain at least one REQ-<AREA>-<n> ID');
        }
      }
    }

    if (gateType === 'design') {
      const designPath = `specs/${version}/design.md`;
      if (changedFilenames.has(designPath)) {
        const content = await fetchBlobContentStrict(
          input.octokit,
          input.repo,
          designPath,
          headSha,
        );
        const scrIds = extractScrIds(content);
        if (scrIds.length === 0) {
          violations.push('design.md must contain at least one SCR-<NAME> ID');
        }
      }
    }

    // operationId validation in OpenAPI artifacts (architecture gate).
    if (gateType === 'architecture') {
      const openapiPath = 'contracts/openapi.yaml';
      if (changedFilenames.has(openapiPath)) {
        const content = await fetchBlobContentStrict(
          input.octokit,
          input.repo,
          openapiPath,
          headSha,
        );
        const opIds = extractOperationIds(content);
        const invalid = opIds.filter((id) => !OPERATION_ID_RE.test(id));
        if (invalid.length > 0) {
          violations.push(
            `openapi.yaml has operationId(s) failing ^[a-z][a-z0-9_-]*$: ${invalid.join(', ')}`,
          );
        }
        const unique = new Set(opIds);
        if (unique.size !== opIds.length) {
          const seen = new Set<string>();
          const dupes: string[] = [];
          for (const id of opIds) {
            if (seen.has(id)) dupes.push(id);
            seen.add(id);
          }
          violations.push(
            `openapi.yaml has duplicate operationIds: ${[...new Set(dupes)].join(', ')}`,
          );
        }
      }
    }

    // §3.5.4: Upstream approvals for architecture/design/plan.
    //
    // Each non-skipped reference must point at a PR/SHA that:
    //   (a) exists,
    //   (b) is merged into main,
    //   (c) carried the correct gate:<upstream-type> label.
    //
    // This is the anti-spoof core (D10): we do NOT trust the marker's free
    // text — every reference is re-verified against GitHub state.
    if (['architecture', 'design', 'plan'].includes(gateType)) {
      const upstreamApprovals = marker.upstream_approvals;
      const requiredUpstream = UPSTREAM_GATES_FOR[gateType] ?? [];

      // All required upstream gates must be present in the marker.
      for (const upstream of requiredUpstream) {
        if (!(upstream in upstreamApprovals)) {
          violations.push(`${gateType} gate requires upstream_approvals.${upstream} in marker`);
        }
      }

      // For plan with no UI: design=skipped + skip_design_gate_reason non-empty.
      if (gateType === 'plan') {
        const designApproval = upstreamApprovals.design;
        if (designApproval === 'skipped') {
          if (!marker.skip_design_gate_reason || marker.skip_design_gate_reason.trim() === '') {
            violations.push('plan with design=skipped must have non-empty skip_design_gate_reason');
          }
        }
      }

      // Verify each reference against GitHub state.
      for (const [upstream, reference] of Object.entries(upstreamApprovals)) {
        if (!requiredUpstream.includes(upstream)) {
          // Marker references an upstream gate that this gate doesn't depend
          // on — not an error per se, but don't verify it.
          continue;
        }
        if (reference === 'skipped') {
          // Only valid for design in plan gate — already checked above.
          if (!(gateType === 'plan' && upstream === 'design')) {
            violations.push(
              `upstream_approvals.${upstream} = 'skipped' is only valid for plan gate's design reference`,
            );
          }
          continue;
        }

        const verified = await verifyUpstreamReference(
          input.octokit,
          input.repo,
          upstream,
          reference,
          baseSha,
        );
        if (!verified.ok) {
          violations.push(`upstream_approvals.${upstream}: ${verified.reason}`);
        }
      }
    }

    // §3.5.5: CODEOWNER check — changed paths fall under matching rules.
    //
    // CODEOWNERS is read from the PR base SHA (not head SHA): a PR must NOT
    // be able to rewrite the CODEOWNERS file it is being judged against.
    // See §3.6 / D10 — the trusted verifier reads base-state CODEOWNERS.
    //
    // Fail closed: if the base-state CODEOWNERS cannot be read (including
    // 404 on the very first bootstrap PR), that is a violation — not a pass.
    const codeownersContent = await fetchBlobContentStrict(
      input.octokit,
      input.repo,
      '.github/CODEOWNERS',
      baseSha,
    );
    const codeownersRules = parseCodeowners(codeownersContent);
    if (codeownersRules.length === 0) {
      violations.push('CODEOWNERS at base SHA is empty or unparseable');
    } else {
      for (const cf of changedFiles) {
        const owner = findCodeownerForPath(codeownersRules, cf.filename);
        if (!owner) {
          violations.push(`changed file '${cf.filename}' has no CODEOWNER`);
        }
      }
    }

    if (violations.length > 0) {
      return { ok: false, violations };
    }

    return { ok: true };
  } catch (err) {
    // Fail closed: any error → violation.
    const errMsg = err instanceof Error ? err.message : String(err);
    violations.push(`hygiene check failed: ${errMsg}`);
    return { ok: false, violations };
  }
}

// ---- Helpers ---------------------------------------------------------------

function parseGateMarker(body: string): GateMarker | null {
  const match = GATE_MARKER_RE.exec(body);
  if (!match) return null;

  const content = match[1]!;
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const marker: GateMarker = {
    gate: '',
    version: '',
    upstream_approvals: {},
  };

  for (const line of lines) {
    if (line.startsWith('gate:')) {
      marker.gate = line.slice(5).trim();
    } else if (line.startsWith('version:')) {
      marker.version = line.slice(8).trim();
    } else if (line.startsWith('upstream_approvals:')) {
      // Parse YAML-like key-value pairs on subsequent lines.
      // This is a simplified parser; real YAML parsing would be more robust.
      const idx = lines.indexOf(line);
      for (let i = idx + 1; i < lines.length; i++) {
        const nextLine = lines[i]!;
        if (nextLine.startsWith('skip_design_gate_reason:') || nextLine.startsWith('gate:')) {
          break;
        }
        if (nextLine.includes(':')) {
          const [key, value] = nextLine.split(':').map((s) => s.trim());
          if (key && value !== undefined) {
            marker.upstream_approvals[key] = value;
          }
        }
      }
    } else if (line.startsWith('skip_design_gate_reason:')) {
      marker.skip_design_gate_reason = line.slice(24).trim();
    }
  }

  if (!marker.gate) return null;
  return marker;
}

interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

async function fetchAllChangedFiles(
  octokit: HygieneOctokit,
  repo: { owner: string; repo: string },
  pr: number,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  let page = 1;
  const perPage = 100;

  // Paginate through all changed files.
  while (files.length < 1000) {
    const resp = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pr,
      page,
      per_page: perPage,
    })) as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>;

    if (!Array.isArray(resp) || resp.length === 0) break;

    for (const f of resp) {
      files.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      });
    }

    if (resp.length < perPage) break;
    page++;
  }

  return files;
}

/**
 * Fetch blob content strictly — any failure (404, network, parse) throws.
 * Used for all security-relevant reads (artifacts, CODEOWNERS at base SHA).
 * Callers wrap the entire checkPrHygiene in a try/catch that converts throws
 * to hygiene violations (fail-closed §3.5.7).
 */
async function fetchBlobContentStrict(
  octokit: HygieneOctokit,
  repo: { owner: string; repo: string },
  path: string,
  ref: string,
): Promise<string> {
  const resp = (await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner: repo.owner,
    repo: repo.repo,
    path,
    ref,
    mediaType: { format: 'raw' },
  })) as { content?: string; encoding?: string };

  if (!resp.content) {
    throw new Error(`blob '${path}' at ${ref.slice(0, 8)} is empty or missing`);
  }
  if (resp.encoding === 'base64') {
    return Buffer.from(resp.content.replace(/\n/g, ''), 'base64').toString('utf8');
  }
  return resp.content;
}

/**
 * Verify an upstream approval reference (§3.5.4 / D10).
 *
 * Accepted forms:
 *   - `#<pr-number>` — PR must be merged to base, and carry `gate:<upstream>`
 *   - `<40-hex-sha>` — commit must be reachable from base (merged to main)
 *
 * Anything else is rejected. The check is fail-closed: any API error on the
 * referenced PR/commit surfaces as a violation, NOT a pass.
 */
async function verifyUpstreamReference(
  octokit: HygieneOctokit,
  repo: { owner: string; repo: string },
  upstream: string,
  reference: string,
  baseSha: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const expectedLabel = `gate:${upstream}`;

  if (UPSTREAM_PR_REF_RE.test(reference)) {
    const prNumber = Number.parseInt(reference.slice(1), 10);

    let upstreamPr: {
      state: string;
      merged: boolean;
      merge_commit_sha: string | null;
      labels: Array<{ name: string }>;
      base: { ref: string };
    };
    try {
      upstreamPr = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
      })) as typeof upstreamPr;
    } catch (err) {
      return {
        ok: false,
        reason: `referenced PR #${prNumber} could not be fetched: ${(err as Error).message}`,
      };
    }

    if (upstreamPr.state !== 'closed' || !upstreamPr.merged) {
      return { ok: false, reason: `PR #${prNumber} is not merged (state: ${upstreamPr.state})` };
    }
    if (upstreamPr.base.ref !== 'main') {
      return {
        ok: false,
        reason: `PR #${prNumber} target branch is '${upstreamPr.base.ref}', expected 'main'`,
      };
    }
    if (!upstreamPr.labels.some((l) => l.name === expectedLabel)) {
      return {
        ok: false,
        reason: `PR #${prNumber} does not carry required label '${expectedLabel}'`,
      };
    }

    // Optional extra: if the merge_commit_sha is known, verify it's reachable
    // from the current PR's base. We skip this when the merge_commit_sha is
    // null (squash merges without a recorded merge commit).
    if (upstreamPr.merge_commit_sha) {
      const reachable = await isCommitReachableFromBase(
        octokit,
        repo,
        upstreamPr.merge_commit_sha,
        baseSha,
      );
      if (!reachable) {
        return {
          ok: false,
          reason: `PR #${prNumber} merge commit ${upstreamPr.merge_commit_sha.slice(0, 8)} is not on main`,
        };
      }
    }

    return { ok: true };
  }

  if (UPSTREAM_SHA_REF_RE.test(reference)) {
    const reachable = await isCommitReachableFromBase(octokit, repo, reference, baseSha);
    if (!reachable) {
      return { ok: false, reason: `commit ${reference.slice(0, 8)} is not reachable from main` };
    }
    return { ok: true };
  }

  return {
    ok: false,
    reason: `reference '${reference}' is neither '#<PR>' nor a 40-char SHA`,
  };
}

/**
 * Check whether `commitSha` is an ancestor of `baseSha` via the compare API.
 * Used to verify that an upstream merge SHA is actually on main.
 */
async function isCommitReachableFromBase(
  octokit: HygieneOctokit,
  repo: { owner: string; repo: string },
  commitSha: string,
  baseSha: string,
): Promise<boolean> {
  try {
    const cmp = (await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
      owner: repo.owner,
      repo: repo.repo,
      base: commitSha,
      head: baseSha,
    })) as { status: string };
    // `ahead_by >= 0` and `status` in {ahead, identical} means base is a
    // descendant of (or equal to) the commit. `behind` or `diverged` means
    // the commit is NOT reachable from base.
    return cmp.status === 'identical' || cmp.status === 'ahead';
  } catch {
    // Fail closed: treat compare errors as "not reachable".
    return false;
  }
}

function extractReqIds(content: string): string[] {
  const ids: string[] = [];
  const matches = content.match(/REQ-[A-Z0-9]+-\d+/g);
  if (matches) {
    for (const m of matches) {
      if (REQ_ID_RE.test(m) && !ids.includes(m)) {
        ids.push(m);
      }
    }
  }
  return ids;
}

function extractScrIds(content: string): string[] {
  const ids: string[] = [];
  const matches = content.match(/SCR-[A-Z0-9-]+/g);
  if (matches) {
    for (const m of matches) {
      if (SCR_ID_RE.test(m) && !ids.includes(m)) {
        ids.push(m);
      }
    }
  }
  return ids;
}

/**
 * Extract `operationId` values from a YAML-ish OpenAPI document. This is a
 * line-level extractor (no YAML parser dependency); it matches lines like
 * `operationId: listUsers` and returns the token after the colon.
 */
function extractOperationIds(content: string): string[] {
  const ids: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*operationId:\s*"?([^"#]+)"?\s*(?:#.*)?$/);
    if (m?.[1]) ids.push(m[1].trim());
  }
  return ids;
}

function getRequiredArtifacts(gate: string, version: string): string[] {
  switch (gate) {
    case 'spec':
      return [`specs/${version}/spec.md`];
    case 'architecture':
      return [`specs/${version}/architecture.md`, 'projects.yaml'];
    case 'design':
      return [`specs/${version}/design.md`];
    case 'plan':
      return [`specs/${version}/plan.md`];
    default:
      return [];
  }
}

interface CodeownersRule {
  pattern: string;
  owners: string[];
}

function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      rules.push({
        pattern: parts[0]!,
        owners: parts.slice(1),
      });
    }
  }

  return rules;
}

function findCodeownerForPath(rules: CodeownersRule[], path: string): string[] | null {
  // CODEOWNERS uses last-match-wins semantics.
  // Iterate in reverse to find the last matching rule.
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (codeownersPatternMatches(rule.pattern, path)) {
      return rule.owners;
    }
  }
  return null;
}

function codeownersPatternMatches(pattern: string, path: string): boolean {
  // Simplified CODEOWNERS pattern matching.
  // Handles: *, /path/, /path/file.ext
  if (pattern === '*') return true;
  if (pattern === path) return true;
  if (pattern.endsWith('/') && path.startsWith(pattern)) return true;
  if (pattern.startsWith('/')) {
    const pat = pattern.slice(1);
    if (path === pat || path.startsWith(`${pat}/`) || path.startsWith(`${pat}/`)) {
      return true;
    }
  }
  return false;
}
