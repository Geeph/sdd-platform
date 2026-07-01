import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubRequestClient } from '../src/github-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createGitHubRequestClient', () => {
  it('builds a versioned GET request without leaking path parameters', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createGitHubRequestClient('secret-token');

    await expect(
      client.request('GET /repos/{owner}/{repo}/labels', {
        owner: 'acme',
        repo: 'demo',
        page: 2,
        per_page: 100,
      }),
    ).resolves.toEqual({ id: 1 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/demo/labels?page=2&per_page=100');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('sends only non-path parameters in mutation JSON', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ commit: { sha: 'seed' } }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createGitHubRequestClient('token');

    await client.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'acme',
      repo: 'demo',
      path: 'template.lock',
      message: 'seed',
      content: 'bG9jaw==',
      branch: 'main',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/demo/contents/template.lock');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'seed',
      content: 'bG9jaw==',
      branch: 'main',
    });
  });

  it('surfaces status and response headers for retry decisions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('busy', {
            status: 503,
            headers: { 'retry-after': '2' },
          }),
      ),
    );
    const client = createGitHubRequestClient('token');

    await expect(
      client.request('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'demo' }),
    ).rejects.toMatchObject({
      status: 503,
      response: { headers: { 'retry-after': '2' } },
    });
  });

  it('marks fetch failures as transient without exposing the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('socket closed');
      }),
    );
    const client = createGitHubRequestClient('do-not-leak');

    const error = (await client
      .request('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'demo' })
      .catch((caught: unknown) => caught)) as Error & { transient?: boolean };
    expect(error).toMatchObject({ transient: true });
    expect(error.message).not.toContain('do-not-leak');
  });
});
