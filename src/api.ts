export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | undefined;
export function setCsrfToken(value?: string) { csrfToken = value; }

export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${url}`, {
      ...options,
      headers: {
        ...(!['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase())
          ? { "Content-Type": "application/json" }
          : {}),
        ...(!['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase()) && csrfToken
          ? { 'X-CSRF-Token': csrfToken }
          : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      "The BackMyGit server is unavailable",
      0,
      "SERVER_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const body = await response.json();
      message = body.error || message;
      code = body.code;
    } catch {
      /* non-JSON response */
    }
    if (response.status === 401 && !url.startsWith('/auth/'))
      window.dispatchEvent(new Event('backmygit:unauthorized'));
    throw new ApiError(message, response.status, code);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const mutate = <T>(url: string, method: string, body?: unknown) =>
  api<T>(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const formatBytes = (bytes?: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

export const shortSha = (sha?: string) => (sha ? sha.slice(0, 8) : "—");
