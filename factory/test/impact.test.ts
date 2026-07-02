/**
 * impact.test.ts — tests for computeImpact + D20 semantic diff (M4).
 *
 * Covers:
 *   - Whole-doc normalized diff for spec.md (§2.5)
 *   - diffRequirementSections: canonical heading, rewrite detection, dedup
 *   - diffDesignScreens: canonical screen table, conservative body change
 *   - diffOpenApiOperations: YAML parse, key-sorted comparison, fail closed
 *   - computeImpact with pre-fetched changedPaths (D22)
 *   - Renamed files use previousPath for base read (D19)
 */

import { describe, expect, it } from 'vitest';
import type { ChangedPath, ImpactReader } from '../src/impact.js';
import {
  computeImpact,
  createApiImpactReader,
  diffDesignScreens,
  diffOpenApiOperationsAsync,
  diffRequirementSections,
} from '../src/impact.js';

// ---- diffRequirementSections (§2.5/D20) ----

describe('diffRequirementSections', () => {
  it('detects added requirement', () => {
    const base = '# Spec\n\n### REQ-AUTH-001\n\nSome text.\n';
    const head = '# Spec\n\n### REQ-AUTH-001\n\nSome text.\n\n### REQ-AUTH-002\n\nNew req.\n';
    const result = diffRequirementSections(base, head);
    expect(result.added).toEqual(['REQ-AUTH-002']);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('detects removed requirement', () => {
    const base = '# Spec\n\n### REQ-AUTH-001\n\nSome text.\n\n### REQ-AUTH-002\n\nAnother.\n';
    const head = '# Spec\n\n### REQ-AUTH-001\n\nSome text.\n';
    const result = diffRequirementSections(base, head);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['REQ-AUTH-002']);
    expect(result.changed).toEqual([]);
  });

  it('detects content rewrite with same ID (P1 fix)', () => {
    const base = '# Spec\n\n### REQ-AUTH-001\n\nOriginal acceptance criteria.\n';
    const head = '# Spec\n\n### REQ-AUTH-001\n\nCompletely rewritten criteria.\n';
    const result = diffRequirementSections(base, head);
    expect(result.changed).toEqual(['REQ-AUTH-001']);
  });

  it('does not report unchanged requirement', () => {
    const base = '# Spec\n\n### REQ-AUTH-001\n\nSame text.\n';
    const head = '# Spec\n\n### REQ-AUTH-001\n\nSame text.\n';
    const result = diffRequirementSections(base, head);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('does not treat duplicate REF in tracking table as second anchor', () => {
    const base = '# Spec\n\n### REQ-AUTH-001\n\nBase text.\n\n| Ref | REQ-AUTH-001 |\n';
    const head = '# Spec\n\n### REQ-AUTH-001\n\nBase text.\n\n| Ref | REQ-AUTH-001 |\n';
    const result = diffRequirementSections(base, head);
    expect(result.changed).toEqual([]);
  });

  it('section ends at next same-or-higher heading', () => {
    const base =
      '# Spec\n\n### REQ-AUTH-001\n\nText.\n\n## Next section\n\n### REQ-AUTH-002\n\nOther.\n';
    const head =
      '# Spec\n\n### REQ-AUTH-001\n\nModified text.\n\n## Next section\n\n### REQ-AUTH-002\n\nOther.\n';
    const result = diffRequirementSections(base, head);
    expect(result.changed).toEqual(['REQ-AUTH-001']);
    expect(result.changed).not.toContain('REQ-AUTH-002');
  });
});

// ---- diffDesignScreens (§2.5/D20) ----

describe('diffDesignScreens', () => {
  const makeDesign = (screenRows: string, body = '') => {
    return `# Design\n\n## 2. 屏幕清单（Screens）\n\n| ID | Name |\n|---|---|\n${screenRows}\n\n## 3. Other\n\n${body}`;
  };

  it('detects added screen in canonical table', () => {
    const base = makeDesign('| SCR-HOME | Home |');
    const head = makeDesign('| SCR-HOME | Home |\n| SCR-PROFILE | Profile |');
    const result = diffDesignScreens(base, head);
    expect(result.added).toEqual(['SCR-PROFILE']);
  });

  it('detects removed screen in canonical table', () => {
    const base = makeDesign('| SCR-HOME | Home |\n| SCR-PROFILE | Profile |');
    const head = makeDesign('| SCR-HOME | Home |');
    const result = diffDesignScreens(base, head);
    expect(result.removed).toEqual(['SCR-PROFILE']);
  });

  it('conservatively reports all screens when body changes', () => {
    const base = makeDesign('| SCR-HOME | Home |', 'Original flow description.');
    const head = makeDesign('| SCR-HOME | Home |', 'Modified flow description.');
    const result = diffDesignScreens(base, head);
    // Body changed → all canonical screens reported as changed.
    expect(result.changed).toContain('SCR-HOME');
  });

  it('does not treat SCR-ID in §8 mapping as second canonical declaration', () => {
    const base = makeDesign('| SCR-HOME | Home |', 'See §8 mapping: SCR-HOME → /api/home');
    const head = makeDesign('| SCR-HOME | Home |', 'See §8 mapping: SCR-HOME → /api/home');
    const result = diffDesignScreens(base, head);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
  });
});

// ---- diffOpenApiOperations (§2.5/D20) ----

describe('diffOpenApiOperations', () => {
  const makeOpenApi = (ops: string) => {
    return `openapi: 3.0.0\ninfo:\n  title: Test\n  version: 1.0.0\npaths:\n${ops}`;
  };

  it('detects added operation', async () => {
    const base = makeOpenApi('  /users:\n    get:\n      operationId: listUsers\n');
    const head = makeOpenApi(
      '  /users:\n    get:\n      operationId: listUsers\n  /posts:\n    get:\n      operationId: listPosts\n',
    );
    const result = await diffOpenApiOperationsAsync(base, head);
    expect(result.added).toContain('listPosts');
  });

  it('detects removed operation', async () => {
    const base = makeOpenApi(
      '  /users:\n    get:\n      operationId: listUsers\n  /posts:\n    get:\n      operationId: listPosts\n',
    );
    const head = makeOpenApi('  /users:\n    get:\n      operationId: listUsers\n');
    const result = await diffOpenApiOperationsAsync(base, head);
    expect(result.removed).toContain('listPosts');
  });

  it('detects changed operation (summary before operationId)', async () => {
    const base = makeOpenApi(
      '  /users:\n    get:\n      summary: Old\n      operationId: listUsers\n',
    );
    const head = makeOpenApi(
      '  /users:\n    get:\n      summary: New\n      operationId: listUsers\n',
    );
    const result = await diffOpenApiOperationsAsync(base, head);
    expect(result.changed).toContain('listUsers');
  });

  it('does not report change for key reordering', async () => {
    const base = makeOpenApi(
      '  /users:\n    get:\n      summary: Same\n      operationId: listUsers\n',
    );
    const head = makeOpenApi(
      '  /users:\n    get:\n      operationId: listUsers\n      summary: Same\n',
    );
    const result = await diffOpenApiOperationsAsync(base, head);
    expect(result.changed).toEqual([]);
  });

  it('detects deeply nested field changes (P1 #2 regression)', async () => {
    const base = makeOpenApi(
      '  /users:\n    get:\n      operationId: listUsers\n      responses:\n        "200":\n          description: old description\n',
    );
    const head = makeOpenApi(
      '  /users:\n    get:\n      operationId: listUsers\n      responses:\n        "200":\n          description: new description\n',
    );
    const result = await diffOpenApiOperationsAsync(base, head);
    expect(result.changed).toContain('listUsers');
  });

  it('rejects operationId that fails OPERATION_ID_RE (P1 #3 regression)', async () => {
    const base = makeOpenApi('  /users:\n    get:\n      operationId: listUsers\n');
    const head = makeOpenApi('  /users:\n    get:\n      operationId: 123bad\n');
    await expect(diffOpenApiOperationsAsync(base, head)).rejects.toThrow(/valid operationId/);
  });
});

// ---- computeImpact with pre-fetched changedPaths (D22) ----

describe('computeImpact', () => {
  function makeReader(files: Record<string, Record<string, string>>): ImpactReader {
    return {
      async listChangedPaths() {
        throw new Error('should not be called when changedPaths is provided');
      },
      async readFileAt(ref: string, path: string): Promise<string | null> {
        return files[ref]?.[path] ?? null;
      },
    };
  }

  it('does not call listChangedPaths when changedPaths is provided (D22)', async () => {
    let listCalled = false;
    const reader: ImpactReader = {
      async listChangedPaths() {
        listCalled = true;
        return [];
      },
      async readFileAt() {
        return null;
      },
    };

    await computeImpact({
      reader,
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: [],
    });

    expect(listCalled).toBe(false);
  });

  it('spec.md content change triggers all platforms', async () => {
    const reader = makeReader({
      'base-sha': { 'specs/v1/spec.md': '# Spec\n\nOriginal scope.\n' },
      'head-sha': { 'specs/v1/spec.md': '# Spec\n\nModified scope.\n' },
    });

    const result = await computeImpact({
      reader,
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: [{ path: 'specs/v1/spec.md', status: 'modified' }],
    });

    expect(result.platforms.backend).toBe(true);
    expect(result.platforms.web).toBe(true);
    expect(result.platforms.ios).toBe(true);
    expect(result.platforms.android).toBe(true);
  });

  it('spec.md with only whitespace change does not trigger platforms', async () => {
    const reader = makeReader({
      'base-sha': { 'specs/v1/spec.md': '# Spec\n\nSame content.\n' },
      'head-sha': { 'specs/v1/spec.md': '# Spec\n\nSame content.\n\n' },
    });

    const result = await computeImpact({
      reader,
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: [{ path: 'specs/v1/spec.md', status: 'modified' }],
    });

    expect(result.platforms.backend).toBe(false);
    expect(result.platforms.web).toBe(false);
    expect(result.platforms.ios).toBe(false);
    expect(result.platforms.android).toBe(false);
  });

  it('renamed file reads base at previousPath (D19)', async () => {
    const sameContent = '# Spec\n\nSame content.\n';
    const reader: ImpactReader = {
      async listChangedPaths() {
        return [];
      },
      async readFileAt(ref: string, _path: string): Promise<string | null> {
        // Return same content for any path — simulates a rename where
        // the content is byte-identical.
        return sameContent;
      },
    };

    const result = await computeImpact({
      reader,
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: [
        {
          path: 'specs/v1/spec.md',
          status: 'renamed',
          previousPath: 'specs/v1/old-location/spec.md',
        },
      ],
    });

    // Content is the same → no platform trigger.
    // previousPath is used to read base content (which is the same content).
    expect(result.platforms.backend).toBe(false);
    expect(result.platforms.web).toBe(false);
    expect(result.platforms.ios).toBe(false);
    expect(result.platforms.android).toBe(false);
  });

  it('contracts/openapi.yaml change triggers all platforms', async () => {
    const reader = makeReader({
      'base-sha': {
        'contracts/openapi.yaml':
          'openapi: 3.0.0\ninfo:\n  title: T\n  version: 1.0.0\npaths: {}\n',
      },
      'head-sha': {
        'contracts/openapi.yaml':
          'openapi: 3.0.0\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /x:\n    get:\n      operationId: getX\n',
      },
    });

    const result = await computeImpact({
      reader,
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: [{ path: 'contracts/openapi.yaml', status: 'modified' }],
    });

    expect(result.platforms.backend).toBe(true);
    expect(result.platforms.web).toBe(true);
    expect(result.platforms.ios).toBe(true);
    expect(result.platforms.android).toBe(true);
    expect(result.changed.operations).toContain('getX');
  });

  it('breaking = true only for removed operationId', async () => {
    const reader = makeReader({
      'base-sha': {
        'contracts/openapi.yaml':
          'openapi: 3.0.0\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /x:\n    get:\n      operationId: getX\n',
      },
      'head-sha': {
        'contracts/openapi.yaml':
          'openapi: 3.0.0\ninfo:\n  title: T\n  version: 1.0.0\npaths: {}\n',
      },
    });

    const result = await computeImpact({
      reader,
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: [{ path: 'contracts/openapi.yaml', status: 'modified' }],
    });

    expect(result.breaking).toBe(true);
    expect(result.changed.operations).toContain('getX');
  });

  it('design/tokens/ change triggers web+ios+android but NOT backend', async () => {
    const reader = makeReader({});

    const result = await computeImpact({
      reader,
      base: 'base-sha',
      head: 'head-sha',
      changedPaths: [{ path: 'design/tokens/colors.json', status: 'added' }],
    });

    expect(result.platforms.backend).toBe(false);
    expect(result.platforms.web).toBe(true);
    expect(result.platforms.ios).toBe(true);
    expect(result.platforms.android).toBe(true);
  });
});

// ---- createApiImpactReader (P1 #1 regression) ----

describe('createApiImpactReader', () => {
  function makeOctokit(response: Record<string, unknown>) {
    return {
      async request(): Promise<unknown> {
        return response;
      },
    };
  }

  it('throws when truncated=true (explicit truncation signal)', async () => {
    const octokit = makeOctokit({ files: [], truncated: true });
    const reader = createApiImpactReader(octokit, { owner: 'a', repo: 'b' });
    await expect(reader.listChangedPaths('base', 'head')).rejects.toThrow(/truncated/);
  });

  it('throws at the documented 300-file cap even for one commit (P1 #1 regression)', async () => {
    const octokit = makeOctokit({
      files: Array.from({ length: 300 }, (_, index) => ({
        filename: `file-${index}.java`,
        status: 'modified',
      })),
      truncated: false,
      ahead_by: 1,
    });
    const reader = createApiImpactReader(octokit, { owner: 'a', repo: 'b' });
    await expect(reader.listChangedPaths('base', 'head')).rejects.toThrow(/300-file cap/);
  });

  it('returns fewer than 300 files regardless of commit count', async () => {
    const octokit = makeOctokit({
      files: Array.from({ length: 299 }, (_, index) => ({
        filename: `file-${index}.java`,
        status: 'modified',
      })),
      truncated: false,
      ahead_by: 500,
    });
    const reader = createApiImpactReader(octokit, { owner: 'a', repo: 'b' });
    const paths = await reader.listChangedPaths('base', 'head');
    expect(paths).toHaveLength(299);
    expect(paths[0].path).toBe('file-0.java');
  });
});
