/**
 * github-read.ts — read-only GitHub port for M2a.
 *
 * M2a delivers only the *type* (`GitHubReadPort`, already exported from
 * `types.ts`) plus a small factory that constructs a *read-only* octokit
 * adapter suitable for dry-run. The writer type is declared in `types.ts`
 * but **not implemented** in M2a; that is M2b/c scope.
 *
 * This module intentionally refuses any mutating method at runtime
 * (defense-in-depth on top of the type-level separation). Tests use a fake
 * `GitHubReadPort` directly, not this adapter.
 */

import { assembleTree, parseManifest } from './resolve.js';
import type {
  GitHubReadPort,
  ObservedState,
  ProductInitInput,
  ReadonlyTree,
  RepoRef,
  ResolvedCommit,
  TemplateManifest,
  TemplateTreeEntry,
} from './types.js';

/**
 * Shape of the octokit-like client we depend on. We only declare the
 * methods we call and only GET/HEAD paths.
 */
export interface OctokitReadOnly {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<unknown>;
}

const WRITE_METHODS_RE = /^(POST|PUT|PATCH|DELETE)\s/i;

/**
 * Build a `GitHubReadPort` backed by an octokit-like client. The adapter
 * refuses any route that is not GET/HEAD (defense-in-depth).
 *
 * For M2a, no real caller constructs this; tests use `FakeReadPort` instead.
 * The factory exists so M2b/c can wire it in without changing the interface.
 */
export function createReadonlyGitHubPort(octokit: OctokitReadOnly): GitHubReadPort {
  async function safeRequest(
    route: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    const method = route.split(' ')[0];
    if (!method) throw new Error(`invalid route: '${route}'`);
    if (WRITE_METHODS_RE.test(route)) {
      throw new Error(`read-only port refuses mutating route: '${route}'`);
    }
    return octokit.request(route, parameters);
  }

  return {
    async resolveCommit(repo: RepoRef, ref: string): Promise<ResolvedCommit> {
      // First try as a commit SHA (fast path).
      if (/^[0-9a-f]{40}$/i.test(ref)) {
        return { commit: ref.toLowerCase(), requestedRef: ref, peeled: false };
      }
      // Otherwise GET the ref and peel annotated tags recursively.
      let currentRef = ref;
      let peeled = false;
      for (let hops = 0; hops < 8; hops++) {
        const res = (await safeRequest('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner: repo.owner,
          repo: repo.repo,
          ref: currentRef,
        })) as { object: { type: string; sha: string } };
        if (res.object.type === 'commit') {
          return {
            commit: res.object.sha.toLowerCase(),
            requestedRef: ref,
            peeled,
          };
        }
        if (res.object.type === 'tag') {
          peeled = true;
          const tag = (await safeRequest('GET /repos/{owner}/{repo}/git/tags/{tag_sha}', {
            owner: repo.owner,
            repo: repo.repo,
            tag_sha: res.object.sha,
          })) as { object: { type: string; sha: string } };
          if (tag.object.type === 'commit') {
            return {
              commit: tag.object.sha.toLowerCase(),
              requestedRef: ref,
              peeled: true,
            };
          }
          // Annotated tag pointing to another tag; keep peeling.
          currentRef = tag.object.sha;
          continue;
        }
        throw new Error(`ref '${ref}' resolved to unsupported object type '${res.object.type}'`);
      }
      throw new Error(`ref '${ref}' exceeded peel depth`);
    },

    async readTemplateTree(repo: RepoRef, commit: string, path: string): Promise<ReadonlyTree> {
      // Load the manifest first (so we know which files to fetch).
      const manifestPath = `templates/${path.split('/').pop() ?? 'monorepo-root'}.manifest.json`;
      const manifestResp = (await safeRequest('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: repo.owner,
        repo: repo.repo,
        path: manifestPath,
        ref: commit,
        mediaType: { format: 'raw' },
      })) as { content?: string; encoding?: string };
      const manifestBytes = decodeContent(manifestResp);
      const manifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));

      // Fetch each listed file at the pinned commit.
      const entries: TemplateTreeEntry[] = [];
      for (const mf of manifest.files) {
        const absPath = `${path}/${mf.path}`;
        const resp = (await safeRequest('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: repo.owner,
          repo: repo.repo,
          path: absPath,
          ref: commit,
          mediaType: { format: 'raw' },
        })) as { content?: string; encoding?: string };
        entries.push({
          path: mf.path,
          mode: mf.mode,
          content: decodeContent(resp),
        });
      }
      return assembleTree(manifest, entries);
    },

    async observe(_input: ProductInitInput): Promise<ObservedState> {
      // M2a: observe() is implemented in M2b/c once write flows exist. In
      // dry-run the caller should inject a fake that returns deterministic
      // observed state; this adapter only exists so callers have a uniform
      // type to hand in.
      throw new Error(
        'observe() is not implemented in M2a; wire a fake for dry-run or wait for M2b/c',
      );
    },
  };
}

function decodeContent(resp: { content?: string; encoding?: string }): Uint8Array {
  if (!resp.content) return new Uint8Array();
  if (resp.encoding === 'base64') {
    const bin = Buffer.from(resp.content.replace(/\n/g, ''), 'base64');
    return new Uint8Array(bin);
  }
  return new TextEncoder().encode(resp.content);
}

// Re-export the TemplateManifest type so consumers can use `parseManifest`.
export type { TemplateManifest };
