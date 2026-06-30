import { describe, expect, it } from 'vitest';
import type { ProjectsDocument } from '../src/semantics.js';
import { semanticValidateProjects } from '../src/semantics.js';

describe('semanticValidateProjects', () => {
  it('returns no errors for a valid document', () => {
    const doc: ProjectsDocument = {
      components: [
        {
          id: 'backend',
          path: 'apps/backend',
          template: 'spring-boot',
          ci: 'java',
        },
        {
          id: 'web',
          path: 'apps/web',
          template: 'web',
          ci: 'web',
        },
      ],
    };
    expect(semanticValidateProjects(doc)).toEqual([]);
  });

  it('detects duplicate component IDs', () => {
    const doc: ProjectsDocument = {
      components: [
        {
          id: 'backend',
          path: 'apps/backend',
          template: 'spring-boot',
          ci: 'java',
        },
        {
          id: 'backend',
          path: 'apps/backend-v2',
          template: 'spring-boot',
          ci: 'java',
        },
      ],
    };
    const errors = semanticValidateProjects(doc);
    expect(errors.some((e) => /id 'backend' is duplicated/.test(e))).toBe(true);
  });

  it('detects duplicate component paths', () => {
    const doc: ProjectsDocument = {
      components: [
        {
          id: 'backend-a',
          path: 'apps/backend',
          template: 'spring-boot',
          ci: 'java',
        },
        {
          id: 'backend-b',
          path: 'apps/backend',
          template: 'spring-boot',
          ci: 'java',
        },
      ],
    };
    const errors = semanticValidateProjects(doc);
    expect(errors.some((e) => /path.*is duplicated/.test(e))).toBe(true);
  });

  it('detects nested paths (prefix relationship)', () => {
    const doc: ProjectsDocument = {
      components: [
        {
          id: 'backend',
          path: 'apps/backend',
          template: 'spring-boot',
          ci: 'java',
        },
        {
          id: 'backend-inner',
          path: 'apps/backend/inner',
          template: 'spring-boot',
          ci: 'java',
        },
      ],
    };
    const errors = semanticValidateProjects(doc);
    expect(errors.some((e) => /must not be nested/.test(e))).toBe(true);
  });

  it('detects template/ci mismatches', () => {
    const doc: ProjectsDocument = {
      components: [
        {
          id: 'backend',
          path: 'apps/backend',
          template: 'spring-boot',
          ci: 'web', // mismatch: spring-boot should pair with java
        },
      ],
    };
    const errors = semanticValidateProjects(doc);
    expect(errors.some((e) => /must pair with ci='java'/.test(e))).toBe(true);
  });

  it('validates all known template/ci pairs', () => {
    const pairs: Array<{ template: string; ci: string }> = [
      { template: 'spring-boot', ci: 'java' },
      { template: 'web', ci: 'web' },
      { template: 'ios-tuist', ci: 'ios' },
      { template: 'android', ci: 'android' },
    ];
    for (const { template, ci } of pairs) {
      const doc: ProjectsDocument = {
        components: [{ id: 'c', path: 'apps/c', template, ci }],
      };
      expect(semanticValidateProjects(doc)).toEqual([]);
    }
  });

  it('accepts empty components', () => {
    const doc: ProjectsDocument = { components: [] };
    expect(semanticValidateProjects(doc)).toEqual([]);
  });
});
