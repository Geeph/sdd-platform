import type { SDDProjects } from '@sdd/schemas';
import { describe, expect, it } from 'vitest';
import { semanticValidateProjects } from '../src/semantics.js';

// Helper to build a minimal valid SDDProjects document around a components array.
function docWith(components: SDDProjects['components']): SDDProjects {
  return {
    schema_version: 1,
    product: 'demo',
    repository_mode: 'monorepo',
    components,
  };
}

describe('semanticValidateProjects', () => {
  it('returns no errors for a valid document', () => {
    const doc = docWith([
      {
        id: 'backend',
        path: 'apps/backend',
        template: 'spring-boot',
        template_ref: 'v1.0.0',
        owner: 'backend-team',
        ci: 'java',
      },
      {
        id: 'web',
        path: 'apps/web',
        template: 'web',
        template_ref: 'v1.0.0',
        owner: 'web-team',
        ci: 'web',
      },
    ]);
    expect(semanticValidateProjects(doc)).toEqual([]);
  });

  it('detects duplicate component IDs', () => {
    const doc = docWith([
      {
        id: 'backend',
        path: 'apps/backend',
        template: 'spring-boot',
        template_ref: 'v1',
        owner: 't',
        ci: 'java',
      },
      {
        id: 'backend',
        path: 'apps/backend-v2',
        template: 'spring-boot',
        template_ref: 'v1',
        owner: 't',
        ci: 'java',
      },
    ]);
    const errors = semanticValidateProjects(doc);
    expect(errors.some((e) => /id 'backend' is duplicated/.test(e))).toBe(true);
  });

  it('detects duplicate component paths', () => {
    const doc = docWith([
      {
        id: 'backend-a',
        path: 'apps/backend',
        template: 'spring-boot',
        template_ref: 'v1',
        owner: 't',
        ci: 'java',
      },
      {
        id: 'backend-b',
        path: 'apps/backend',
        template: 'spring-boot',
        template_ref: 'v1',
        owner: 't',
        ci: 'java',
      },
    ]);
    const errors = semanticValidateProjects(doc);
    expect(errors.some((e) => /path.*is duplicated/.test(e))).toBe(true);
  });

  it('detects nested paths (prefix relationship)', () => {
    const doc = docWith([
      {
        id: 'backend',
        path: 'apps/backend',
        template: 'spring-boot',
        template_ref: 'v1',
        owner: 't',
        ci: 'java',
      },
      {
        id: 'backend-inner',
        path: 'apps/backend/inner',
        template: 'spring-boot',
        template_ref: 'v1',
        owner: 't',
        ci: 'java',
      },
    ]);
    const errors = semanticValidateProjects(doc);
    expect(errors.some((e) => /must not be nested/.test(e))).toBe(true);
  });

  it('detects template/ci mismatches', () => {
    const doc = docWith([
      {
        id: 'backend',
        path: 'apps/backend',
        template: 'spring-boot',
        template_ref: 'v1',
        owner: 't',
        ci: 'web', // mismatch: spring-boot should pair with java
      },
    ]);
    const errors = semanticValidateProjects(doc);
    expect(errors.some((e) => /must pair with ci='java'/.test(e))).toBe(true);
  });

  it('validates all known template/ci pairs', () => {
    const pairs: Array<{
      template: SDDProjects['components'][number]['template'];
      ci: SDDProjects['components'][number]['ci'];
    }> = [
      { template: 'spring-boot', ci: 'java' },
      { template: 'web', ci: 'web' },
      { template: 'ios-tuist', ci: 'ios' },
      { template: 'android', ci: 'android' },
    ];
    for (const { template, ci } of pairs) {
      const doc = docWith([
        {
          id: 'c',
          path: 'apps/c',
          template,
          template_ref: 'v1',
          owner: 't',
          ci,
        },
      ]);
      expect(semanticValidateProjects(doc)).toEqual([]);
    }
  });

  it('accepts empty components', () => {
    const doc = docWith([]);
    expect(semanticValidateProjects(doc)).toEqual([]);
  });
});
