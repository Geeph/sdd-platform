/** Minimal GitHub REST transport shared by product-init adapters. */
export interface GitHubRequestClient {
  request(route: string, parameters?: Record<string, unknown>): Promise<unknown>;
}

export function createGitHubRequestClient(token: string): GitHubRequestClient {
  return {
    async request(route: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
      const [method, template] = route.split(' ');
      if (!method || !template) throw new Error(`invalid GitHub route: '${route}'`);

      const pathKeys = new Set<string>();
      const path = template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
        pathKeys.add(key);
        const value = parameters[key];
        if (value === undefined) throw new Error(`missing GitHub path parameter '${key}'`);
        return encodeURIComponent(String(value)).replace(/%2F/gi, '/');
      });

      const remaining = Object.entries(parameters).filter(
        ([key, value]) => !pathKeys.has(key) && key !== 'mediaType' && value !== undefined,
      );
      let url = `https://api.github.com${path}`;
      const init: RequestInit = {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sdd-platform-cli',
        },
      };
      if (method === 'GET' || method === 'HEAD') {
        const query = new URLSearchParams();
        for (const [key, value] of remaining) query.set(key, String(value));
        const suffix = query.toString();
        if (suffix) url += `?${suffix}`;
      } else {
        init.body = JSON.stringify(Object.fromEntries(remaining));
      }

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (cause) {
        const error = new Error(`GitHub API ${method} ${path}: network request failed`, {
          cause,
        }) as Error & { transient: true };
        error.transient = true;
        throw error;
      }
      if (!response.ok) {
        const body = await response.text();
        const error = new Error(
          `GitHub API ${method} ${path}: ${response.status}${body ? ` ${body}` : ''}`,
        ) as Error & {
          status: number;
          response: { headers: Record<string, string> };
        };
        error.status = response.status;
        error.response = { headers: Object.fromEntries(response.headers.entries()) };
        throw error;
      }
      if (response.status === 204 || method === 'HEAD') return {};
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    },
  };
}
