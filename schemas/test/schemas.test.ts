import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  validateImpactDocument,
  validateProjectsDocument,
  validateTaskDocument,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, 'fixtures');

async function loadFixture(name: string): Promise<unknown> {
  const content = await readFile(join(fixtures, name), 'utf8');
  return parseYaml(content);
}

describe('projects.schema.json', () => {
  it('accepts a fully populated valid document', async () => {
    const data = await loadFixture('projects-valid.yaml');
    const result = await validateProjectsDocument(data);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts empty components array (init state)', async () => {
    const data = await loadFixture('projects-empty-components.yaml');
    const result = await validateProjectsDocument(data);
    expect(result.ok).toBe(true);
  });

  it('rejects wrong schema_version', async () => {
    const data = await loadFixture('projects-bad-version.yaml');
    const result = await validateProjectsDocument(data);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects absolute path in component', async () => {
    const data = await loadFixture('projects-absolute-path.yaml');
    const result = await validateProjectsDocument(data);
    expect(result.ok).toBe(false);
    const paths = result.errors.map((e) => e.path);
    expect(paths.some((p) => p.includes('path'))).toBe(true);
  });

  it('rejects path containing .. traversal', async () => {
    const data = await loadFixture('projects-dotdot-path.yaml');
    const result = await validateProjectsDocument(data);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown template value', async () => {
    const data = await loadFixture('projects-bad-template.yaml');
    const result = await validateProjectsDocument(data);
    expect(result.ok).toBe(false);
  });

  it('rejects missing required ci field', async () => {
    const data = await loadFixture('projects-missing-ci.yaml');
    const result = await validateProjectsDocument(data);
    expect(result.ok).toBe(false);
  });

  it('rejects extra properties', async () => {
    const data = {
      schema_version: 1,
      product: 'demo',
      repository_mode: 'monorepo',
      components: [],
      rogue: true,
    };
    const result = await validateProjectsDocument(data);
    expect(result.ok).toBe(false);
  });
});

describe('task.schema.json', () => {
  it('accepts a valid task', async () => {
    const data = await loadFixture('task-valid.yaml');
    const result = await validateTaskDocument(data);
    expect(result.ok).toBe(true);
  });

  it('rejects missing id', async () => {
    const data = await loadFixture('task-missing-id.yaml');
    const result = await validateTaskDocument(data);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown platform', async () => {
    const data = await loadFixture('task-bad-platform.yaml');
    const result = await validateTaskDocument(data);
    expect(result.ok).toBe(false);
  });

  it('rejects bad id format (no dot)', async () => {
    const data = await loadFixture('task-bad-id.yaml');
    const result = await validateTaskDocument(data);
    expect(result.ok).toBe(false);
  });
});

describe('impact.schema.json', () => {
  it('accepts a valid impact document', async () => {
    const data = await loadFixture('impact-valid.yaml');
    const result = await validateImpactDocument(data);
    expect(result.ok).toBe(true);
  });

  it('accepts impact with populated issue arrays', async () => {
    const data = await loadFixture('impact-with-issues.yaml');
    const result = await validateImpactDocument(data);
    expect(result.ok).toBe(true);
  });

  it('rejects missing base', async () => {
    const data = await loadFixture('impact-missing-base.yaml');
    const result = await validateImpactDocument(data);
    expect(result.ok).toBe(false);
  });

  it('rejects missing breaking', async () => {
    const data = await loadFixture('impact-missing-breaking.yaml');
    const result = await validateImpactDocument(data);
    expect(result.ok).toBe(false);
  });

  it('rejects platforms missing required android', async () => {
    const data = await loadFixture('impact-bad-platforms.yaml');
    const result = await validateImpactDocument(data);
    expect(result.ok).toBe(false);
  });
});
