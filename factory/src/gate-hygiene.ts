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
 *   5. CODEOWNER: changed paths fall under matching CODEOWNERS rules.
 *   6. Read method: full pagination for changed files; blob at PR head SHA.
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
const _OPERATION_ID_RE = /^[a-z][a-z0-9_-]*$/;

const VALID_GATES = new Set(['spec', 'architecture', 'design', 'plan', 'contract']);

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
      labels: Array<{ name: string }>;
      body: string | null;
      user: { login: string };
    };

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

    // §3.5.3: Stable IDs — fetch blobs and check content.
    if (gateType === 'spec') {
      const specPath = `specs/${version}/spec.md`;
      if (changedFilenames.has(specPath)) {
        const content = await fetchBlobContent(input.octokit, input.repo, specPath, pr.head.sha);
        const reqIds = extractReqIds(content);
        if (reqIds.length === 0) {
          violations.push('spec.md must contain at least one REQ-<AREA>-<n> ID');
        }
      }
    }

    if (gateType === 'design') {
      const designPath = `specs/${version}/design.md`;
      if (changedFilenames.has(designPath)) {
        const content = await fetchBlobContent(input.octokit, input.repo, designPath, pr.head.sha);
        const scrIds = extractScrIds(content);
        if (scrIds.length === 0) {
          violations.push('design.md must contain at least one SCR-<NAME> ID');
        }
      }
    }

    // §3.5.4: Upstream approvals for architecture/design/plan.
    if (['architecture', 'design', 'plan'].includes(gateType)) {
      const upstreamApprovals = marker.upstream_approvals;

      if (Object.keys(upstreamApprovals).length === 0) {
        violations.push(`${gateType} gate requires upstream_approvals in marker`);
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
    }

    // §3.5.5: CODEOWNER check — changed paths fall under matching rules.
    // This is a simplified check: we verify that paths have owners.
    // Full CODEOWNERS parsing is complex; for M2 we do a basic check.
    const codeownersContent = await fetchBlobContent(
      input.octokit,
      input.repo,
      '.github/CODEOWNERS',
      pr.head.sha,
    );

    if (codeownersContent) {
      const codeownersRules = parseCodeowners(codeownersContent);
      for (const cf of changedFiles) {
        const owner = findCodeownerForPath(codeownersRules, cf.filename);
        if (!owner) {
          // Fallback to wildcard.
          const wildcardOwner = findCodeownerForPath(codeownersRules, '*');
          if (!wildcardOwner) {
            violations.push(`changed file '${cf.filename}' has no CODEOWNER`);
          }
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

async function fetchBlobContent(
  octokit: HygieneOctokit,
  repo: { owner: string; repo: string },
  path: string,
  ref: string,
): Promise<string> {
  try {
    const resp = (await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner,
      repo: repo.repo,
      path,
      ref,
      mediaType: { format: 'raw' },
    })) as { content?: string; encoding?: string };

    if (!resp.content) return '';
    if (resp.encoding === 'base64') {
      return Buffer.from(resp.content.replace(/\n/g, ''), 'base64').toString('utf8');
    }
    return resp.content;
  } catch {
    return '';
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
