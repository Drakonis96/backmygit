import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { config } from "./config.js";

const headers = () => ({
  Accept: "application/vnd.github+json",
  "User-Agent": `BackMyGit/${config.appVersion}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

type GitHubResponse<T> = { data: T; headers: IncomingHttpHeaders };
const cache = new Map<string, { expires: number; data: unknown }>();

function apiError(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { status, code });
}

function requestOnce<T>(
  apiPath: string,
  family: 4 | 0,
): Promise<GitHubResponse<T>> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: "api.github.com",
        path: apiPath,
        method: "GET",
        family: family || undefined,
        headers: headers(),
        timeout: 15_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let data: unknown;
          try {
            data = body ? JSON.parse(body) : {};
          } catch {
            return reject(
              apiError(
                "GitHub returned an invalid response",
                502,
                "GITHUB_INVALID_RESPONSE",
              ),
            );
          }
          const status = response.statusCode || 502;
          if (status >= 200 && status < 300)
            return resolve({ data: data as T, headers: response.headers });
          if (status === 404)
            return reject(
              apiError("GitHub repository not found", 404, "GITHUB_NOT_FOUND"),
            );
          const remaining = response.headers["x-ratelimit-remaining"];
          if ((status === 403 || status === 429) && remaining === "0") {
            const reset = response.headers["x-ratelimit-reset"];
            const when = reset
              ? new Date(Number(reset) * 1000).toISOString()
              : "later";
            return reject(
              apiError(
                `GitHub API rate limit reached. Resets ${when}.`,
                429,
                "GITHUB_RATE_LIMIT",
              ),
            );
          }
          return reject(
            apiError(
              `GitHub API returned ${status}`,
              status >= 500 ? 502 : status,
              "GITHUB_API_ERROR",
            ),
          );
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(
        apiError("GitHub did not respond in time", 503, "GITHUB_UNAVAILABLE"),
      ),
    );
    request.on("error", (error) =>
      reject(
        Object.assign(error, {
          status: (error as any).status || 503,
          code: "GITHUB_UNAVAILABLE",
        }),
      ),
    );
    request.end();
  });
}

async function githubRequest<T>(
  apiPath: string,
  options: { allowNotFound?: boolean; cacheMs?: number } = {},
): Promise<GitHubResponse<T> | null> {
  const cached = cache.get(apiPath);
  if (cached && cached.expires > Date.now())
    return { data: cached.data as T, headers: {} };
  let lastError: any;
  for (const family of [4, 0] as const) {
    try {
      const response = await requestOnce<T>(apiPath, family);
      if (options.cacheMs)
        cache.set(apiPath, {
          expires: Date.now() + options.cacheMs,
          data: response.data,
        });
      return response;
    } catch (error: any) {
      if (error.status === 404 && options.allowNotFound) return null;
      if (error.status === 429 || (error.status >= 400 && error.status < 500))
        throw error;
      lastError = error;
    }
  }
  throw (
    lastError ||
    apiError("GitHub is temporarily unavailable", 503, "GITHUB_UNAVAILABLE")
  );
}

function repositoryResult(repo: any) {
  return {
    id: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description || "",
    stars: repo.stargazers_count,
    visibility: repo.visibility || (repo.private ? "private" : "public"),
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at,
    url: repo.html_url,
    cloneUrl: repo.clone_url,
    archived: repo.archived,
  };
}

export async function searchRepositories(query: string) {
  const normalized = query.trim().replace(/\s+/g, " ");
  const exact = /^([A-Za-z0-9-]+)[\s/]([A-Za-z0-9_.-]+)$/.exec(normalized);
  if (exact) {
    const direct = await githubRequest<any>(
      `/repos/${encodeURIComponent(exact[1])}/${encodeURIComponent(exact[2])}`,
      { allowNotFound: true, cacheMs: 60_000 },
    );
    if (direct) return [repositoryResult(direct.data)];
  }
  const response = await githubRequest<any>(
    `/search/repositories?q=${encodeURIComponent(normalized)}&sort=updated&order=desc&per_page=20`,
    { cacheMs: 30_000 },
  );
  return (response?.data.items || []).map(repositoryResult);
}

export async function listBranches(
  owner: string,
  repository: string,
): Promise<Array<{ name: string; sha: string; protected: boolean }>> {
  const result: Array<{ name: string; sha: string; protected: boolean }> = [];
  for (let page = 1; page <= 100; page++) {
    const response = await githubRequest<any[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches?per_page=100&page=${page}`,
      { cacheMs: 60_000 },
    );
    const rows = response?.data || [];
    result.push(
      ...rows.map((row) => ({
        name: row.name,
        sha: row.commit.sha,
        protected: row.protected,
      })),
    );
    if (rows.length < 100) break;
  }
  return result;
}
