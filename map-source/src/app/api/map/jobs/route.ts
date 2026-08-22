import { NextRequest, NextResponse } from "next/server";

type CachedJobsPayload = {
  jobs: Array<Record<string, unknown>>;
  total: number;
};

const responseCache = new Map<string, { payload: CachedJobsPayload; expiresAt: number }>();
const pendingRequests = new Map<string, Promise<CachedJobsPayload>>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 32;

function remember(cacheKey: string, payload: CachedJobsPayload) {
  responseCache.delete(cacheKey);
  responseCache.set(cacheKey, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value as string | undefined;
    if (!oldest) break;
    responseCache.delete(oldest);
  }
}

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
};

const ALLOWED_PARAMS = new Set([
  "company",
  "exclude_junk",
  "location",
  "order",
  "page",
  "per_page",
  "search",
  "sort",
]);

function publicJobsUpstream() {
  // NEXT_PUBLIC_API_BASE defaults to localhost for browser development and is
  // compiled into the bundle. This server-side proxy needs an explicit
  // upstream or the real public API; otherwise a production preview silently
  // calls a nonexistent localhost service and reports Hiring as unavailable.
  const configured = (process.env.KNOK_PUBLIC_API_UPSTREAM || "").trim();
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, "");
  return "https://hey.knok.work";
}

export async function GET(request: NextRequest) {
  const upstream = new URL("/api/jobs", publicJobsUpstream());
  for (const [key, value] of request.nextUrl.searchParams) {
    if (ALLOWED_PARAMS.has(key)) upstream.searchParams.set(key, value.slice(0, 240));
  }

  const requestedPageSize = Number(upstream.searchParams.get("per_page") || "25");
  upstream.searchParams.set("per_page", String(Math.max(1, Math.min(2000, Number.isFinite(requestedPageSize) ? requestedPageSize : 25))));
  const requestTimeout = upstream.searchParams.has("search") ? 12_000 : 25_000;
  const cacheKey = upstream.toString();
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload, {
      headers: { ...CACHE_HEADERS, "X-Knok-Map-Cache": "hit" },
    });
  }

  try {
    // Coalesce identical cold requests. Without this, a traffic spike on a
    // newly started instance could fan thousands of visitors into thousands
    // of simultaneous full-corpus upstream reads before the first response
    // had a chance to populate the cache.
    let pending = pendingRequests.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(upstream, {
          // The upstream payload can exceed Next's 2MB fetch-cache limit. Keep
          // this fetch uncached and store only the compact, normalized response
          // in the bounded route-level cache above.
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(requestTimeout),
        });
        if (!response.ok) throw new Error(`upstream_${response.status}`);
        const payload = await response.json() as { jobs?: Array<Record<string, unknown>>; total?: unknown };
        const jobs = Array.isArray(payload.jobs) ? payload.jobs.map((job) => ({
          id: String(job.id || ""),
          title: String(job.title || ""),
          company: String(job.company || ""),
          company_canonical_id: job.company_canonical_id == null ? null : String(job.company_canonical_id),
          location: job.location == null ? null : String(job.location),
          posted_at: job.posted_at == null ? null : String(job.posted_at),
          posted_date: job.posted_date == null ? null : String(job.posted_date),
          url: String(job.url || ""),
        })) : [];
        const result = { jobs, total: Number(payload.total || jobs.length) };
        remember(cacheKey, result);
        return result;
      })().finally(() => pendingRequests.delete(cacheKey));
      pendingRequests.set(cacheKey, pending);
    }
    const result = await pending;
    return NextResponse.json(result, {
      headers: {
        ...CACHE_HEADERS,
        "X-Knok-Map-Cache": cached ? "stale-refresh" : "miss",
      },
    });
  } catch {
    if (cached) {
      return NextResponse.json(cached.payload, {
        headers: { ...CACHE_HEADERS, "X-Knok-Map-Cache": "stale" },
      });
    }
    return NextResponse.json({ jobs: [], total: 0, error: "jobs_unavailable" }, { status: 502 });
  }
}
