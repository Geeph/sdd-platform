/**
 * template.test.ts — self-validation of the monorepo-root template.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateProjectsDocument } from '@sdd/schemas';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { TemplateTreeEntry } from '../src/index.js';
import { assembleTree, parseManifest, validateManifest } from '../src/index.js';

const TEMPLATES_ROOT = resolve(__dirname, '../../templates/monorepo-root');
const MANIFEST_PATH = resolve(__dirname, '../../templates/monorepo-root.manifest.json');

async function loadManifest() {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  return parseManifest(JSON.parse(raw));
}

async function loadEntry(manifestPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(TEMPLATES_ROOT, manifestPath)));
}

describe('monorepo-root template', () => {
  it('manifest exists and validates', async () => {
    const manifest = await loadManifest();
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(manifest.files.length).toBeGreaterThan(0);
  });

  it('projects.yaml passes sdd validate (after rendering {{product}})', async () => {
    const manifest = await loadManifest();
    const projectsEntry = manifest.files.find((f) => f.path === 'projects.yaml');
    expect(projectsEntry).toBeDefined();
    expect(projectsEntry?.render).toBe(true);

    const content = new TextDecoder().decode(await loadEntry('projects.yaml'));
    // Substitute the only token for validation.
    const rendered = content.replace(/\{\{product\}\}/g, 'demo');
    const doc = parseYaml(rendered);
    const result = await validateProjectsDocument(doc);
    expect(result.ok).toBe(true);
  });

  it('intake.yml is valid YAML and has required form fields', async () => {
    const content = await readFile(
      resolve(TEMPLATES_ROOT, '.github/ISSUE_TEMPLATE/intake.yml'),
      'utf8',
    );
    const doc = parseYaml(content) as { name: string; body: Array<{ type: string; id?: string }> };
    expect(doc.name).toBeDefined();
    expect(doc.body).toBeInstanceOf(Array);
    expect(doc.body.length).toBeGreaterThan(0);
    // Should include the key fields.
    const ids = doc.body.map((b) => b.id).filter(Boolean);
    expect(ids).toContain('problem');
    expect(ids).toContain('users-scenarios');
    expect(ids).toContain('scope');
  });

  it('config.yml is valid YAML', async () => {
    const content = await readFile(
      resolve(TEMPLATES_ROOT, '.github/ISSUE_TEMPLATE/config.yml'),
      'utf8',
    );
    expect(() => parseYaml(content)).not.toThrow();
  });

  it('gate.md contains the sdd:gate marker block', async () => {
    const content = await readFile(
      resolve(TEMPLATES_ROOT, '.github/PULL_REQUEST_TEMPLATE/gate.md'),
      'utf8',
    );
    expect(content).toMatch(/<!--\s*sdd:gate/);
    expect(content).toMatch(/gate:\s*spec\|architecture\|design\|plan\|contract/);
    expect(content).toMatch(/version:\s*v1/);
    expect(content).toMatch(/upstream_approvals/);
    expect(content).toMatch(/skip_design_gate_reason/);
  });

  it('CODEOWNERS is parseable and has owner for each managed path', async () => {
    const content = await readFile(resolve(TEMPLATES_ROOT, '.github/CODEOWNERS'), 'utf8');
    // Each non-comment line should be `<pattern> <owner>`.
    const lines = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts[1]).toMatch(/^@/);
    }
    // Required managed paths present.
    expect(content).toMatch(/^\*\s+@/m);
    expect(content).toMatch(/^\/specs\//m);
    expect(content).toMatch(/^\/projects\.yaml/m);
    expect(content).toMatch(/^\/AGENTS\.md/m);
    expect(content).toMatch(/^\/\.github\//m);
    expect(content).toMatch(/^\/template\.lock/m);
  });

  it('manifest tree matches on-disk files (no drift)', async () => {
    const manifest = await loadManifest();
    const entries: TemplateTreeEntry[] = [];
    for (const mf of manifest.files) {
      const content = await loadEntry(mf.path);
      entries.push({ path: mf.path, mode: mf.mode, content });
    }
    // assembleTree validates checksums.
    expect(() => assembleTree(manifest, entries)).not.toThrow();
  });

  it('no workflow files in the product template (D7)', async () => {
    const manifest = await loadManifest();
    const workflows = manifest.files.filter((f) => f.path.startsWith('.github/workflows/'));
    expect(workflows).toEqual([]);
  });

  it('no apps/* in the template (M2a)', async () => {
    const manifest = await loadManifest();
    const apps = manifest.files.filter((f) => f.path.startsWith('apps/'));
    expect(apps).toEqual([]);
  });
});
