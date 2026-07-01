/**
 * product-init schema tests.
 */

import { describe, expect, it } from 'vitest';
import { validateProductInitDocument } from '../src/index.js';

const VALID = {
  schema_version: 1,
  bootstrap: { approvers: ['platform-admins'] },
  owners: {
    product: 'product-team',
    api: 'api-owners',
    design: 'design-team',
    admins: 'platform-admins',
  },
};

describe('validateProductInitDocument', () => {
  it('accepts a minimal valid config', async () => {
    const result = await validateProductInitDocument(VALID);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a fully-populated valid config', async () => {
    const result = await validateProductInitDocument({
      schema_version: 1,
      repository: {
        description: 'Demo product monorepo',
        visibility: 'private',
      },
      bootstrap: { approvers: ['platform-admins'] },
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
      team_permissions: {
        'platform-admins': 'maintain',
        'product-team': 'push',
      },
      environments: {
        preview: { reviewers: ['product-team'], prevent_self_review: true },
      },
      required_secrets: [],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown top-level key', async () => {
    const result = await validateProductInitDocument({
      ...VALID,
      unknown_key: 'oops',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects missing required owners area', async () => {
    const result = await validateProductInitDocument({
      schema_version: 1,
      bootstrap: { approvers: ['platform-admins'] },
      owners: {
        product: 'product-team',
        api: 'api-owners',
        // missing design, admins
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects invalid permission enum', async () => {
    const result = await validateProductInitDocument({
      ...VALID,
      team_permissions: {
        'some-team': 'superadmin',
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects invalid visibility enum', async () => {
    const result = await validateProductInitDocument({
      ...VALID,
      repository: { visibility: 'secret' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects invalid team slug pattern', async () => {
    const result = await validateProductInitDocument({
      schema_version: 1,
      bootstrap: { approvers: ['Not-A-Valid-Slug'] },
      owners: VALID.owners,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects empty bootstrap.approvers', async () => {
    const result = await validateProductInitDocument({
      schema_version: 1,
      bootstrap: { approvers: [] },
      owners: VALID.owners,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects schema_version != 1', async () => {
    const result = await validateProductInitDocument({
      schema_version: 2,
      bootstrap: { approvers: ['platform-admins'] },
      owners: VALID.owners,
    });
    expect(result.ok).toBe(false);
  });
});
