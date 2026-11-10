import type { ApiResponse, EntryInput, Race, RaceResult } from "@race/types";

const BASE = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

async function get<T>(
  path: string,
  init?: RequestInit & {
    query?: Record<string, string | number | undefined>;
    next?: { revalidate?: number; tags?: string[] };
  },
): Promise<T> {
  const { query, ...rest } = init ?? {};
  const qs = new URLSearchParams(
    Object.entries(query ?? {}).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  ).toString();
  const res = await fetch(`${BASE}${path}${qs ? "?" + qs : ""}`, rest);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
  return res.json() as Promise<T>;
}

export const api = {
  getRaces: (q?: { limit?: number; page?: number }) =>
    get<ApiResponse<Race[]>>("/races", { query: q }),
  getRace: (id: string) =>
    get<ApiResponse<{ race: Race; results: RaceResult[] }>>(`/races/${id}`, {
      next: { revalidate: 60, tags: ["race-" + id] },
    }),
  postResult: (v: EntryInput) =>
    post<ApiResponse<RaceResult>>(`/results`, v, { cache: "no-store" }),
};
