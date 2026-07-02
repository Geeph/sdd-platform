/**
 * platform-templates.test.ts — self-validation of the four M3 platform
 * templates (spring-boot, web, ios-tuist, android) and D2 factory
 * relaxations (TEMPLATE_NAMES closed set).
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TemplateTreeEntry } from '../src/index.js';
import {
  assembleTree,
  parseManifest,
  renderTree,
  TEMPLATE_NAMES,
  validateManifest,
} from '../src/index.js';
import type { ComponentRenderContext, RenderContext } from '../src/types.js';

const TEMPLATES = ['spring-boot', 'web', 'ios-tuist', 'android'] as const;
const REPO_ROOT = resolve(__dirname, '../..');

async function loadManifest(name: string) {
  const raw = await readFile(resolve(REPO_ROOT, `templates/${name}.manifest.json`), 'utf8');
  return parseManifest(JSON.parse(raw));
}

async function loadEntry(templateName: string, path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(REPO_ROOT, `templates/${templateName}`, path)));
}

describe('D2: TEMPLATE_NAMES closed set', () => {
  it('exposes the five expected template names', () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual([
      'android',
      'ios-tuist',
      'monorepo-root',
      'spring-boot',
      'web',
    ]);
  });

  it('validateManifest accepts each name in the closed set', async () => {
    for (const name of TEMPLATES) {
      const manifest = await loadManifest(name);
      expect(manifest.template).toBe(name);
      expect(() => validateManifest(manifest)).not.toThrow();
    }
  });

  it('validateManifest rejects names outside the closed set', () => {
    expect(() =>
      validateManifest({
        template: 'unknown-template' as never,
        path: 'templates/unknown',
        tree_sha256: 'sha256:' + 'a'.repeat(64),
        files: [],
      }),
    ).toThrow(/must be one of/);
  });

  it('parseManifest rejects unknown template names', () => {
    expect(() =>
      parseManifest({
        template: 'unknown',
        path: 'templates/unknown',
        tree_sha256: 'sha256:' + 'a'.repeat(64),
        files: [],
      }),
    ).toThrow(/must be one of/);
  });
});

for (const name of TEMPLATES) {
  describe(`${name} template`, () => {
    it('manifest exists and validates', async () => {
      const manifest = await loadManifest(name);
      expect(() => validateManifest(manifest)).not.toThrow();
      expect(manifest.files.length).toBeGreaterThan(0);
      expect(manifest.path).toBe(`templates/${name}`);
    });

    it('manifest matches on-disk files (no drift)', async () => {
      const manifest = await loadManifest(name);
      const entries: TemplateTreeEntry[] = [];
      for (const mf of manifest.files) {
        const content = await loadEntry(name, mf.path);
        entries.push({ path: mf.path, mode: mf.mode, content });
      }
      expect(() => assembleTree(manifest, entries)).not.toThrow();
    });

    it('contains no CI workflow files (D10)', async () => {
      const manifest = await loadManifest(name);
      const workflows = manifest.files.filter((f) => f.path.includes('.github/workflows/'));
      expect(workflows).toEqual([]);
    });

    it('contains no nested apps/ paths', async () => {
      const manifest = await loadManifest(name);
      const apps = manifest.files.filter((f) => f.path.startsWith('apps/'));
      expect(apps).toEqual([]);
    });

    it('renderTree produces template.lock with correct template.name/path', async () => {
      const manifest = await loadManifest(name);
      const entries: TemplateTreeEntry[] = [];
      for (const mf of manifest.files) {
        const content = await loadEntry(name, mf.path);
        entries.push({ path: mf.path, mode: mf.mode, content });
      }
      const tree = assembleTree(manifest, entries);
      const context: ComponentRenderContext = {
        product: 'demo',
        repo: 'acme',
        owners: {
          product: 'product-team',
          api: 'api-team',
          design: 'design-team',
          admins: 'admins',
        },
        component: {
          id: 'sample',
          path: 'apps/sample',
          owner: 'sample-team',
        },
      };
      const rendered = renderTree({
        tree,
        context,
        source: {
          repository: 'acme/sdd-platform',
          requestedRef: 'a'.repeat(40),
          resolvedCommit: 'a'.repeat(40),
        },
        generator: { package: '@sdd/factory', version: '0.1.0' },
      });
      // Lock file should mention this template name/path, not monorepo-root.
      expect(rendered.lockYaml).toContain(`name: ${name}`);
      expect(rendered.lockYaml).toContain(`path: templates/${name}`);
      // Must NOT contain monorepo-root.
      expect(rendered.lockYaml).not.toContain('monorepo-root');
    });
  });
}

describe('ComponentRenderContext tokens', () => {
  it('substitutes {{component_id}} and {{component_owner}}', async () => {
    // Use the web template (which uses these tokens in package.json / README).
    const manifest = await loadManifest('web');
    const entries: TemplateTreeEntry[] = [];
    for (const mf of manifest.files) {
      const content = await loadEntry('web', mf.path);
      entries.push({ path: mf.path, mode: mf.mode, content });
    }
    const tree = assembleTree(manifest, entries);
    const context: ComponentRenderContext = {
      product: 'demo',
      repo: 'acme',
      owners: {
        product: 'product-team',
        api: 'api-team',
        design: 'design-team',
        admins: 'admins',
      },
      component: {
        id: 'mycomp',
        path: 'apps/mycomp',
        owner: 'myteam',
      },
    };
    const rendered = renderTree({
      tree,
      context,
      source: {
        repository: 'acme/sdd-platform',
        requestedRef: 'a'.repeat(40),
        resolvedCommit: 'a'.repeat(40),
      },
      generator: { package: '@sdd/factory', version: '0.1.0' },
    });
    // package.json should have been rendered with the component id.
    const pkg = rendered.entries.find((e) => e.path === 'package.json');
    expect(pkg).toBeDefined();
    const text = new TextDecoder().decode(pkg!.content);
    expect(text).toContain('"name": "mycomp"');
    expect(text).not.toContain('{{component_id}}');
    // README should reference the owner.
    const readme = rendered.entries.find((e) => e.path === 'README.md');
    expect(readme).toBeDefined();
    const readmeText = new TextDecoder().decode(readme!.content);
    expect(readmeText).toContain('myteam');
    expect(readmeText).not.toContain('{{component_owner}}');
  });

  it('still substitutes {{product}} for backwards compatibility (monorepo-root)', async () => {
    // monorepo-root uses {{product}} (but not {{component_id}}), so it can
    // render with a plain RenderContext (no component).
    const raw = await readFile(resolve(REPO_ROOT, 'templates/monorepo-root.manifest.json'), 'utf8');
    const manifest = parseManifest(JSON.parse(raw));
    const entries: TemplateTreeEntry[] = [];
    for (const mf of manifest.files) {
      const content = new Uint8Array(
        await readFile(resolve(REPO_ROOT, 'templates/monorepo-root', mf.path)),
      );
      entries.push({ path: mf.path, mode: mf.mode, content });
    }
    const tree = assembleTree(manifest, entries);
    const context: RenderContext = {
      product: 'acmeproduct',
      repo: 'acme',
      owners: {
        product: 'product-team',
        api: 'api-team',
        design: 'design-team',
        admins: 'admins',
      },
    };
    const rendered = renderTree({
      tree,
      context,
      source: {
        repository: 'acme/sdd-platform',
        requestedRef: 'a'.repeat(40),
        resolvedCommit: 'a'.repeat(40),
      },
      generator: { package: '@sdd/factory', version: '0.1.0' },
    });
    const projects = rendered.entries.find((e) => e.path === 'projects.yaml');
    expect(projects).toBeDefined();
    const text = new TextDecoder().decode(projects!.content);
    expect(text).toContain('acmeproduct');
  });
});

describe('Template toolchain smoke test', () => {
  const testContext: ComponentRenderContext = {
    product: 'demo',
    repo: 'acme',
    owners: {
      product: 'product-team',
      api: 'api-team',
      design: 'design-team',
      admins: 'admins',
    },
    component: {
      id: 'web',
      path: 'apps/web',
      owner: 'web-team',
    },
  };

  it('web: rendered template passes typecheck, lint, and tests', async () => {
    const manifest = await loadManifest('web');
    const entries: TemplateTreeEntry[] = [];
    for (const mf of manifest.files) {
      const content = await loadEntry('web', mf.path);
      entries.push({ path: mf.path, mode: mf.mode, content });
    }
    const tree = assembleTree(manifest, entries);
    const rendered = renderTree({
      tree,
      context: testContext,
      source: {
        repository: 'acme/sdd-platform',
        requestedRef: 'a'.repeat(40),
        resolvedCommit: 'a'.repeat(40),
      },
      generator: { package: '@sdd/factory', version: '0.1.0' },
    });

    // Write rendered files to a temp directory. Use POSIX temp path to avoid
    // parent workspace interference with pnpm install.
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmpDir = mkdtempSync(`${tmpdir()}/sdd-web-`);
    try {
      // mkdtempSync already created the dir; write files directly.
      for (const entry of rendered.entries) {
        const filePath = resolve(tmpDir, entry.path);
        const dir = resolve(filePath, '..');
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, entry.content);
      }

      // Run pnpm install.
      execFileSync('pnpm', ['install', '--frozen-lockfile'], {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });

      // Run tsc --noEmit (typecheck).
      execFileSync('pnpm', ['tsc', '--noEmit'], {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      execFileSync('pnpm', ['lint'], {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      execFileSync('pnpm', ['test'], {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string; message?: string };
      const msg = [failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n');
      throw new Error(`web template toolchain check failed: ${msg}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
    // Success proves the template is structurally sound.
  }, 180_000);

  it('spring-boot template: toolchain not run (requires JDK 21 + Gradle)', () => {
    // The spring-boot template requires a JDK and Gradle wrapper JAR.
    // This test documents the gap; full validation requires a CI runner
    // with JDK 21 (e.g. actions/setup-java).
    expect(true).toBe(true); // Documented skip — not a failure.
  });

  it('android template: toolchain not run (requires JDK + Android SDK)', () => {
    // The android template requires JDK, Android SDK cmdline-tools,
    // and a gradle-wrapper.jar. Full validation requires a CI runner
    // with both JDK and Android SDK.
    expect(true).toBe(true); // Documented skip.
  });

  it('ios-tuist template: toolchain not run (requires macOS + Xcode + Tuist)', () => {
    // The ios-tuist template requires macOS, Xcode 16+, and Tuist CLI.
    // Full validation requires a GitHub Actions macOS runner.
    expect(true).toBe(true); // Documented skip.
  });
});
