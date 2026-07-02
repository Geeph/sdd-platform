/**
 * Verify that the running generator is the exact platform commit pinned by
 * the target repository's managed required-workflow ruleset (D26).
 */

export interface WorkflowPinOctokit {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

export interface VerifyRequiredWorkflowPinInput {
  octokit: WorkflowPinOctokit;
  target: { owner: string; repo: string };
  platform: { owner: string; repo: string };
  generatorCommit: string;
  workflowPath?: string;
}

export interface VerifiedWorkflowPin {
  platformRepositoryId: number;
  commit: string;
  workflowPath: string;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export async function verifyRequiredWorkflowPin(
  input: VerifyRequiredWorkflowPinInput,
): Promise<VerifiedWorkflowPin> {
  const workflowPath = input.workflowPath ?? '.github/workflows/pr-hygiene.yml';
  if (!FULL_SHA_RE.test(input.generatorCommit)) {
    throw new Error('generator commit is missing or is not a full 40-hex SHA');
  }

  const [targetRepo, platformRepo] = (await Promise.all([
    input.octokit.request('GET /repos/{owner}/{repo}', {
      owner: input.target.owner,
      repo: input.target.repo,
    }),
    input.octokit.request('GET /repos/{owner}/{repo}', {
      owner: input.platform.owner,
      repo: input.platform.repo,
    }),
  ])) as Array<{ id?: number }>;
  if (!targetRepo?.id || !platformRepo?.id) {
    throw new Error('repository identity response is missing an id');
  }

  const rulesetName = `sdd-workflows-${targetRepo.id}`;
  const summaries: Array<{ id?: number; name?: string }> = [];
  for (let page = 1; ; page++) {
    const batch = (await input.octokit.request('GET /orgs/{org}/rulesets', {
      org: input.target.owner,
      per_page: 100,
      page,
    })) as Array<{ id?: number; name?: string }>;
    summaries.push(...batch);
    if (batch.length < 100) break;
  }

  const matches = summaries.filter((ruleset) => ruleset.name === rulesetName);
  if (matches.length !== 1 || !matches[0]?.id) {
    throw new Error(`expected exactly one managed workflow ruleset '${rulesetName}'`);
  }

  const detail = (await input.octokit.request('GET /orgs/{org}/rulesets/{ruleset_id}', {
    org: input.target.owner,
    ruleset_id: matches[0].id,
  })) as {
    enforcement?: string;
    conditions?: Record<string, unknown>;
    rules?: Array<{ type?: string; parameters?: unknown }>;
  };
  if (detail.enforcement !== 'active') {
    throw new Error(`managed workflow ruleset '${rulesetName}' is not active`);
  }

  const repositoryCondition = detail.conditions?.repository_id as
    | { repository_ids?: number[] }
    | undefined;
  const refCondition = detail.conditions?.ref_name as
    | { include?: string[]; exclude?: string[] }
    | undefined;
  if (
    repositoryCondition?.repository_ids?.length !== 1 ||
    repositoryCondition.repository_ids[0] !== targetRepo.id ||
    refCondition?.include?.length !== 1 ||
    refCondition.include[0] !== 'refs/heads/main' ||
    (refCondition.exclude?.length ?? 0) !== 0
  ) {
    throw new Error(
      `managed workflow ruleset '${rulesetName}' targets unexpected repositories or refs`,
    );
  }

  const workflowRules = (detail.rules ?? []).filter((rule) => rule.type === 'workflows');
  if (workflowRules.length !== 1) {
    throw new Error(`managed workflow ruleset '${rulesetName}' has an invalid workflows rule`);
  }
  const parameters = workflowRules[0]?.parameters as
    | { workflows?: Array<{ repository_id?: number; path?: string; sha?: string }> }
    | undefined;
  const candidates = (parameters?.workflows ?? []).filter(
    (workflow) => workflow.path === workflowPath,
  );
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  if (!candidate) {
    throw new Error(`required workflow '${workflowPath}' does not have a unique pin`);
  }
  if (candidate.repository_id !== platformRepo.id) {
    throw new Error(`required workflow '${workflowPath}' is pinned to an unexpected repository`);
  }
  if (!candidate.sha || candidate.sha.toLowerCase() !== input.generatorCommit.toLowerCase()) {
    throw new Error(`generator commit does not match required workflow '${workflowPath}' pin`);
  }

  return {
    platformRepositoryId: platformRepo.id,
    commit: input.generatorCommit.toLowerCase(),
    workflowPath,
  };
}
