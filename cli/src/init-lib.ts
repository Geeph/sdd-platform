/**
 * init-lib.ts — thin facade between CLI and @sdd/factory.
 *
 * Provides:
 *   - `compileInitPlan`: delegates to @sdd/factory.
 *   - `serializeInitPlan`: delegates to @sdd/factory.
 *   - `validateProductInitConfig`: semantic validation on top of the JSON
 *     schema (owners area coverage, team_permissions dedup, etc.).
 */

import type { GitHubReadPort, InitPlan, ProductInitConfig, ProductInitInput } from '@sdd/factory';

export { compileInitPlan, serializeInitPlan } from '@sdd/factory';
export type { GitHubReadPort, InitPlan, ProductInitConfig, ProductInitInput };

const REQUIRED_OWNER_AREAS = ['product', 'api', 'design', 'admins'] as const;

/**
 * Semantic validation for product-init.yaml. JSON schema enforces shape;
 * this enforces cross-field rules the spec lists in §2.8.
 */
export function validateProductInitConfig(raw: ProductInitConfig): ProductInitConfig {
  if (raw.schema_version !== 1) {
    throw new Error(`schema_version must be 1, got ${raw.schema_version}`);
  }

  // owners: four required areas must be present and non-empty.
  for (const area of REQUIRED_OWNER_AREAS) {
    const v = raw.owners?.[area];
    if (!v || typeof v !== 'string' || v.length === 0) {
      throw new Error(`owners.${area} is required`);
    }
  }

  // bootstrap.approvers must be ≥1 team slug.
  if (!raw.bootstrap?.approvers || raw.bootstrap.approvers.length === 0) {
    throw new Error('bootstrap.approvers must contain at least one team slug');
  }

  // team_permissions: dedup keys and validate enum.
  const perms = raw.team_permissions ?? {};
  const validPerms = new Set(['pull', 'triage', 'push', 'maintain', 'admin']);
  const seen = new Set<string>();
  for (const [team, perm] of Object.entries(perms)) {
    if (!validPerms.has(perm)) {
      throw new Error(`team_permissions['${team}']: invalid permission '${perm}'`);
    }
    if (seen.has(team)) {
      throw new Error(`team_permissions['${team}']: duplicated`);
    }
    seen.add(team);
  }

  // visibility consistency: config.repository.visibility must be in enum.
  if (raw.repository?.visibility) {
    const validVis = new Set(['private', 'internal', 'public']);
    if (!validVis.has(raw.repository.visibility)) {
      throw new Error(`repository.visibility must be private|internal|public`);
    }
  }

  return raw;
}
