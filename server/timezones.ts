import https from "node:https";
import { config } from "./config.js";

export interface TimezoneLocation {
  id: number;
  name: string;
  country: string;
  countryCode: string;
  admin1: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

const cache = new Map<
  string,
  { expiresAt: number; items: TimezoneLocation[] }
>();

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function serviceError(message: string) {
  return Object.assign(new Error(message), {
    status: 503,
    code: "LOCATION_SERVICE_UNAVAILABLE",
  });
}

function requestOnce(path: string, family: 4 | 0): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: "geocoding-api.open-meteo.com",
        path,
        method: "GET",
        family: family || undefined,
        timeout: 12_000,
        headers: {
          Accept: "application/json",
          "User-Agent": `BackMyGit/${config.appVersion}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300)
            return reject(serviceError("Location search is temporarily unavailable"));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(serviceError("Location search returned an invalid response"));
          }
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(serviceError("Location search timed out")),
    );
    request.on("error", (error) =>
      reject(
        Object.assign(error, {
          status: 503,
          code: "LOCATION_SERVICE_UNAVAILABLE",
        }),
      ),
    );
    request.end();
  });
}

async function geocodingRequest(path: string): Promise<any> {
  let lastError: unknown;
  for (const family of [4, 0] as const) {
    try {
      return await requestOnce(path, family);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || serviceError("Location search is temporarily unavailable");
}

export async function searchTimezoneLocations(
  query: string,
  language: "en" | "es",
): Promise<TimezoneLocation[]> {
  const normalized = query.trim().replace(/\s+/g, " ");
  const cacheKey = `${language}:${normalized.toLocaleLowerCase(language)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  const path = `/v1/search?name=${encodeURIComponent(normalized)}&count=8&language=${language}&format=json`;
  const response = await geocodingRequest(path);
  const seen = new Set<string>();
  const items = (Array.isArray(response?.results) ? response.results : [])
    .filter(
      (location: any) =>
        typeof location.id === "number" &&
        typeof location.name === "string" &&
        typeof location.timezone === "string" &&
        isValidTimezone(location.timezone),
    )
    .map((location: any) => ({
      id: location.id,
      name: location.name,
      country: location.country || location.country_code || "",
      countryCode: location.country_code || "",
      admin1: location.admin1 || "",
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      timezone: location.timezone,
    }))
    .filter((location: TimezoneLocation) => {
      const key = `${location.id}:${location.timezone}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  cache.set(cacheKey, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, items });
  return items;
}
