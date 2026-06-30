import { isAbsolute, normalize } from 'node:path';

export interface ProjectsComponent {
  id: string;
  path: string;
  template: string;
  ci: string;
}

export interface ProjectsDocument {
  components: ProjectsComponent[];
}

const TEMPLATE_CI_PAIRS: Record<string, string> = {
  'spring-boot': 'java',
  web: 'web',
  'ios-tuist': 'ios',
  android: 'android',
};

/**
 * Perform semantic validation on a projects.yaml document that the JSON
 * schema cannot express (unique ids, non-overlapping paths, template/ci
 * pairings).
 */
export function semanticValidateProjects(doc: ProjectsDocument): string[] {
  const errors: string[] = [];
  const components = doc.components ?? [];

  // 1. Component IDs must be unique
  const ids = new Set<string>();
  for (const c of components) {
    if (ids.has(c.id)) {
      errors.push(`components[].id '${c.id}' is duplicated`);
    }
    ids.add(c.id);
  }

  // 2. Component paths must be unique and not be prefixes of each other
  const paths: string[] = [];
  for (const c of components) {
    if (isAbsolute(c.path) || c.path.includes('..')) {
      errors.push(`components[].path '${c.path}' must be a relative path under apps/ without '..'`);
      continue;
    }
    const normalized = normalize(c.path);
    if (normalized !== c.path) {
      errors.push(`components[].path '${c.path}' is not normalized (expected '${normalized}')`);
      continue;
    }
    if (!normalized.startsWith('apps/')) {
      errors.push(`components[].path '${c.path}' must be under apps/`);
      continue;
    }
    if (paths.includes(normalized)) {
      errors.push(`components[].path '${c.path}' is duplicated`);
    }
    paths.push(normalized);
  }
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i];
      const b = paths[j];
      if (a === undefined || b === undefined) continue;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        errors.push(`components[].path '${a}' and '${b}' must not be nested (prefix relationship)`);
      }
    }
  }

  // 3. Template and CI must be a legal pair
  for (const c of components) {
    const expected = TEMPLATE_CI_PAIRS[c.template];
    if (!expected) {
      errors.push(`components[].template '${c.template}' is not recognized`);
    } else if (expected !== c.ci) {
      errors.push(
        `components[].template '${c.template}' must pair with ci='${expected}', got '${c.ci}'`,
      );
    }
  }

  return errors;
}
