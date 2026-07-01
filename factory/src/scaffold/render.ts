/**
 * scaffold/render.ts — per-component rendering (M3).
 *
 * Wraps the factory `renderTree` with component-specific context and
 * produces the per-component `template.lock` YAML content.
 */

import { stringify as yamlStringify } from 'yaml';
import { renderTree } from '../render.js';
import { sha256Hex } from '../resolve.js';
import type { ComponentRenderContext, RenderInput } from '../types.js';
import type { ExpectedFile } from './subtree.js';
import type {
  ComponentLock,
  ResolvedTemplate,
  ScaffoldApproval,
  ScaffoldComponent,
} from './types.js';

export interface RenderedComponent {
  /** Rendered file entries (relative paths under the component's path). */
  files: ReadonlyArray<{
    path: string;
    mode: '100644' | '100755';
    content: Uint8Array;
    source_sha256: string;
    output_sha256: string;
  }>;
  /** Overall tree hash (sha256 of all rendered files). */
  outputTreeSha256: string;
  /** Per-component template.lock YAML content. */
  lockYaml: string;
  /** Parsed lock file (for structured inspection). */
  lock: ComponentLock;
}

export interface RenderComponentInput {
  /** Product slug. */
  product: string;
  /** Target GitHub org. */
  repo: string;
  /** Platform repo string (e.g. "acme/sdd-platform"). */
  platformRepo: string;
  /** The component being rendered. */
  component: ScaffoldComponent;
  /** Resolved template tree. */
  resolvedTemplate: ResolvedTemplate;
  /** Architecture Gate approval info (for lock file `approved_by`). */
  approval?: ScaffoldApproval;
  /** Architecture version (e.g. "v1"). */
  version?: string;
  /** Provenance block (from verifyGateApproval result). */
  provenance?: {
    pr: number;
    approved_head_sha: string;
    merge_commit_sha: string;
    approved_at: string;
    authorization_policy: string;
  };
  /** Generator identity (package + version + resolved_commit). */
  generator: {
    package: string;
    version: string;
    resolved_commit?: string;
  };
}

/**
 * Render a single component's files + lock file from its resolved template.
 * Does not write anything; purely a transform.
 */
export function renderComponent(input: RenderComponentInput): RenderedComponent {
  const {
    component,
    resolvedTemplate,
    product,
    repo,
    platformRepo,
    approval,
    version,
    provenance,
    generator,
  } = input;

  // Build the ComponentRenderContext.
  const context: ComponentRenderContext = {
    product,
    repo,
    owners: {
      product: 'product',
      api: 'api',
      design: 'design',
      admins: 'admins',
    },
    component: {
      id: component.id,
      path: component.path,
      owner: component.owner,
    },
  };

  // Build the render input (reusing factory renderTree).
  const renderInput: RenderInput = {
    tree: {
      manifest: resolvedTemplate.manifest,
      entries: resolvedTemplate.tree,
      sourceTreeSha256: resolvedTemplate.sourceTreeSha256,
    },
    context,
    source: {
      repository: platformRepo,
      requestedRef: component.template_ref,
      resolvedCommit: resolvedTemplate.commit,
    },
    generator: {
      package: generator.package,
      version: generator.version,
    },
  };

  const rendered = renderTree(renderInput);

  // Build per-component lock.
  const manifestSha = sha256Hex(
    new TextEncoder().encode(
      `${JSON.stringify(
        {
          template: resolvedTemplate.manifest.template,
          path: resolvedTemplate.manifest.path,
          tree_sha256: resolvedTemplate.manifest.tree_sha256,
          files: resolvedTemplate.manifest.files.map((f) => ({
            path: f.path,
            mode: f.mode,
            render: f.render,
            sha256: f.sha256,
          })),
        },
        null,
        2,
      )}\n`,
    ),
  );

  const lock: ComponentLock = {
    schema_version: 1,
    generator: {
      package: generator.package,
      version: generator.version,
      ...(generator.resolved_commit ? { resolved_commit: generator.resolved_commit } : {}),
    },
    source: {
      repository: platformRepo,
      resolved_commit: resolvedTemplate.commit,
    },
    template: {
      name: resolvedTemplate.manifest.template,
      path: resolvedTemplate.manifest.path,
      manifest_sha256: manifestSha,
      source_tree_sha256: resolvedTemplate.sourceTreeSha256,
      output_tree_sha256: rendered.outputTreeSha256,
    },
    component: {
      id: component.id,
      path: component.path,
      owner: component.owner,
    },
    approved_by: {
      gate: 'architecture',
      version: version ?? '',
      pr: provenance?.pr ?? approval?.pr ?? 0,
      approved_head_sha: provenance?.approved_head_sha ?? '',
      merge_commit_sha: provenance?.merge_commit_sha ?? approval?.mergeCommitSha ?? '',
      approved_at: provenance?.approved_at ?? '',
      authorization_policy: provenance?.authorization_policy ?? 'current-codeowners',
      required_checks: [],
    },
    files: rendered.fileDigests.map((d) => ({
      path: d.path,
      mode: d.mode,
      source_sha256: d.source_sha256,
      output_sha256: d.output_sha256,
    })),
  };

  const lockYaml = yamlStringify(lock, {
    lineWidth: 0,
    singleQuote: false,
    strict: true,
  });

  return {
    files: rendered.entries.map((e, i) => ({
      path: e.path,
      mode: e.mode,
      content: e.content,
      source_sha256: rendered.fileDigests[i]!.source_sha256,
      output_sha256: rendered.fileDigests[i]!.output_sha256,
    })),
    outputTreeSha256: rendered.outputTreeSha256,
    lockYaml,
    lock,
  };
}

/**
 * Build the expected file set for a rendered component, including the
 * per-component template.lock. Used by D25 subtree verification.
 *
 * The lock file is placed at `<component.path>/template.lock` and is NOT
 * included in the output_tree_sha256 (to avoid the recursive dependency).
 */
export function expectedFilesForComponent(
  componentPath: string,
  rendered: RenderedComponent,
  lockContent: string,
): ExpectedFile[] {
  const out: ExpectedFile[] = rendered.files.map((f) => ({
    path: f.path,
    mode: f.mode,
    output_sha256: f.output_sha256,
  }));
  // Add the template.lock file itself.
  out.push({
    path: 'template.lock',
    mode: '100644',
    output_sha256: sha256Hex(new TextEncoder().encode(lockContent)),
  });
  return out;
}
