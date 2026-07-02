/**
 * octokit-client.ts — shared MinimalOctokit factory for CLI commands (M4, D16).
 *
 * Extracted from `commands/gate/hygiene.ts` so that `gate/hygiene.ts`,
 * `gate/detect.ts`, and `impact.ts` can all share the same fetch-based
 * GitHub client without each re-implementing it.
 */

/**
 * Create a minimal octokit-like client using `fetch`. This avoids adding the
 * full `@octokit/rest` dependency to the CLI — all callers only need the
 * `request(route, parameters)` pattern.
 */
export function createMinimalOctokit(token: string) {
  return {
    async request(route: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
      const [method, pathTemplate] = route.split(' ');
      if (!method || !pathTemplate) {
        throw new Error(`invalid route: '${route}'`);
      }

      // Substitute path parameters.
      let path = pathTemplate;
      for (const [key, value] of Object.entries(parameters)) {
        path = path.replace(`{${key}}`, String(value));
      }

      // Build query string for GET requests.
      let url = `https://api.github.com${path}`;
      const queryParams: string[] = [];
      if (method === 'GET') {
        for (const [key, value] of Object.entries(parameters)) {
          if (!pathTemplate.includes(`{${key}}`)) {
            queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
          }
        }
      }
      if (queryParams.length > 0) {
        url += `?${queryParams.join('&')}`;
      }

      const headers: Record<string, string> = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      const init: RequestInit = { method, headers };
      if (method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify(parameters);
      }
      const response = await fetch(url, init);

      if (!response.ok) {
        const text = await response.text();
        const err = new Error(
          `GitHub API ${method} ${path}: ${response.status} ${text}`,
        ) as Error & { status: number };
        err.status = response.status;
        throw err;
      }

      // Handle different response types.
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return response.json();
      }
      // Raw content (for blob/file reads).
      return {
        content: await response.text(),
        encoding: 'raw',
      };
    },
  };
}
