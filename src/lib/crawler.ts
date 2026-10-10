// Website crawler for the per-user Knowledge Base.
//
// A crawl is a resumable job: each `processCrawl` call works within a wall-clock
// budget (serverless functions are time-limited) and leaves the remaining
// frontier in the job row. The UI polls the job and calls resume until it
// finishes. Same-host only, robots.txt-aware, with include/exclude path globs.

// This module is no longer wired into any route. The KB was simplified to
// free-text only (see routes/knowledge.ts + lib/knowledge.ts), so the website
// crawl feature is retired. Kept here so a future rebuild can revive it.

import type { Client } from "@libsql/client";

// Stubs for the functions that used to live in knowledge.ts.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function addChunks(_db: Client, _kbId: string, _sourceId: string | null, _texts: string[]): Promise<void> {
  return Promise.resolve();
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function chunkText(_text: string, _maxLen?: number, _overlap?: number): string[] {
  return [];
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function deleteSourceChunks(_db: Client, _kbId: string, _sourceId: string): Promise<void> {
  return Promise.resolve();
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function htmlToText(_html: string): string {
  return "";
}

const USER_AGENT = "GradLeadAI-KnowledgeBot/1.0";
const FETCH_TIMEOUT_MS = 8000;
const ROBOTS_TIMEOUT_MS = 4000;
const MAX_PAGE_BYTES = 2_000_000;

export interface CrawlJob {
  id: string;
  kb_id: string;
  source_id: string | null;
  source_url: string;
  host: string | null;
  limit_pages: number;
  max_depth: number;
  include_paths: string | null;
  exclude_paths: string | null;
  status: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
  pages_found: number;
  pages_done: number;
  frontier: string | null;
  visited: string | null;
  error: string | null;
  created_at: string;
  updated_at: string | null;
}

interface FrontierItem {
  url: string;
  depth: number;
}

export interface CrawlOptions {
  sourceUrl: string;
  limit?: number;
  maxDepth?: number;
  includePaths?: string[];
  excludePaths?: string[];
}

function clampLimit(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 100;
  return Math.max(1, Math.min(500, Math.round(v)));
}

function clampDepth(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.max(0, Math.min(5, Math.round(v)));
}

/** Canonicalize a URL for crawling; returns null for anything non-HTTP(S). */
export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]) {
      u.searchParams.delete(p);
    }
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

/** Convert a simple glob ("blog/*", "about") to an anchored RegExp on a path. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/^\//, "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}`);
}

/** True when `pathname` passes the include/exclude globs. */
export function pathAllowed(pathname: string, include: string[], exclude: string[]): boolean {
  const p = pathname.replace(/^\//, "");
  if (exclude.some((pat) => globToRegExp(pat).test(p))) return false;
  if (include.length === 0) return true;
  return include.some((pat) => globToRegExp(pat).test(p));
}

function splitPaths(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,*/*" },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRobots(origin: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`, ROBOTS_TIMEOUT_MS);
    if (!res || !res.ok) return [];
    const text = await res.text();
    const disallow: string[] = [];
    let applies = false;
    for (const line of text.split("\n")) {
      const l = line.replace(/#.*/, "").trim();
      if (!l) continue;
      const [key, ...rest] = l.split(":");
      const k = key.trim().toLowerCase();
      const v = rest.join(":").trim();
      if (k === "user-agent") applies = v === "*" || v.toLowerCase().includes("gradlead");
      else if (k === "disallow" && applies && v) disallow.push(v);
    }
    return disallow;
  } catch {
    return [];
  }
}

function extractLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1] ?? m[2] ?? m[3] ?? "";
    const abs = normalizeUrl(href, base);
    if (abs) out.push(abs);
  }
  return out;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function getCrawlJob(db: Client, jobId: string): Promise<CrawlJob | null> {
  const row = (await db.execute({ sql: "SELECT * FROM kb_crawl_jobs WHERE id = ?", args: [jobId] })).rows[0];
  return (row as unknown as CrawlJob) ?? null;
}

/**
 * Create a crawl job for a site and index its starting page. Any previous crawl
 * source for the same host is replaced so re-syncing never duplicates content.
 */
export async function startCrawl(db: Client, kbId: string, opts: CrawlOptions): Promise<{ jobId: string; sourceId: string }> {
  const startUrl = normalizeUrl(opts.sourceUrl);
  if (!startUrl) throw new Error("Enter a valid http(s) website URL.");
  const host = new URL(startUrl).host;
  const now = new Date().toISOString();

  // Replace an earlier crawl of the same host (chunks + jobs + source).
  const prev = (await db.execute({
    sql: "SELECT id FROM kb_sources WHERE kb_id = ? AND type = 'url' AND name = ?",
    args: [kbId, host],
  })).rows as unknown as { id: string }[];
  for (const p of prev) await deleteSourceChunks(db, kbId, p.id);
  await db.execute({ sql: "DELETE FROM kb_sources WHERE kb_id = ? AND type = 'url' AND name = ?", args: [kbId, host] });
  await db.execute({ sql: "DELETE FROM kb_crawl_jobs WHERE kb_id = ? AND host = ?", args: [kbId, host] });

  const sourceId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO kb_sources (id, kb_id, type, name, status, created_at) VALUES (?, ?, 'url', ?, 'crawling', ?)",
    args: [sourceId, kbId, host, now],
  });

  const frontier: FrontierItem[] = [{ url: startUrl, depth: 0 }];
  await db.execute({
    sql: `INSERT INTO kb_crawl_jobs
      (id, kb_id, source_id, source_url, host, limit_pages, max_depth, include_paths, exclude_paths,
       status, pages_found, pages_done, frontier, visited, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 0, ?, '[]', ?, ?)`,
    args: [
      jobId, kbId, sourceId, startUrl, host, clampLimit(opts.limit), clampDepth(opts.maxDepth),
      (opts.includePaths ?? []).join(","), (opts.excludePaths ?? []).join(","),
      JSON.stringify(frontier), now, now,
    ],
  });
  return { jobId, sourceId };
}

/**
 * Advance a crawl job by up to `budgetMs`. Persists progress after every page
 * so a crash mid-crawl loses at most one page. Returns the updated job.
 */
export async function processCrawl(db: Client, jobId: string, budgetMs = 25000): Promise<CrawlJob> {
  const job = await getCrawlJob(db, jobId);
  if (!job) throw new Error("Crawl job not found");
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job;
  if (!job.source_id) throw new Error("Crawl job has no source");

  const started = Date.now();
  const include = splitPaths(job.include_paths);
  const exclude = splitPaths(job.exclude_paths);
  const visited = new Set<string>(parseJson<string[]>(job.visited, []));
  const frontier: FrontierItem[] = parseJson<FrontierItem[]>(job.frontier, []);
  const origin = new URL(job.source_url).origin;
  const robots = await fetchRobots(origin);
  const disallowed = (u: string): boolean => {
    try {
      const p = new URL(u).pathname;
      return robots.includes("/") || robots.some((d) => d !== "/" && p.startsWith(d));
    } catch {
      return true;
    }
  };

  let done = job.pages_done;
  let status: CrawlJob["status"] = "running";
  let error: string | null = null;

  await db.execute({ sql: "UPDATE kb_crawl_jobs SET status = 'running', updated_at = ? WHERE id = ?", args: [new Date().toISOString(), jobId] });

  try {
    while (frontier.length && done < job.limit_pages && Date.now() - started < budgetMs) {
      const item = frontier.shift()!;
      if (visited.has(item.url)) continue;
      visited.add(item.url);

      const res = await fetchWithTimeout(item.url, FETCH_TIMEOUT_MS);
      if (!res || !res.ok) {
        // Count the attempt so a broken site can't loop forever.
        done++;
        continue;
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (!/text\/html|text\/plain|application\/xhtml/i.test(ctype)) continue;

      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_PAGE_BYTES) continue;
      const body = new TextDecoder().decode(buf);
      const isHtml = /html/i.test(ctype);
      const text = isHtml ? htmlToText(body) : body;

      if (text.length > 40) await addChunks(db, job.kb_id, job.source_id, chunkText(text));
      done++;

      if (isHtml && item.depth < job.max_depth) {
        for (const link of extractLinks(body, item.url)) {
          if (visited.has(link)) continue;
          let lhost: string;
          let lpath: string;
          try {
            const lu = new URL(link);
            lhost = lu.host;
            lpath = lu.pathname;
          } catch {
            continue;
          }
          if (lhost !== job.host) continue;
          if (!pathAllowed(lpath, include, exclude)) continue;
          if (disallowed(link)) continue;
          if (frontier.some((f) => f.url === link)) continue;
          frontier.push({ url: link, depth: item.depth + 1 });
        }
      }

      await db.execute({
        sql: "UPDATE kb_crawl_jobs SET pages_done = ?, pages_found = ?, frontier = ?, visited = ?, updated_at = ? WHERE id = ?",
        args: [done, done + frontier.length, JSON.stringify(frontier), JSON.stringify(Array.from(visited)), new Date().toISOString(), jobId],
      });
    }

    status = frontier.length && done < job.limit_pages ? "paused" : "done";
  } catch (e) {
    status = "failed";
    error = (e as Error).message;
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: "UPDATE kb_crawl_jobs SET status = ?, pages_done = ?, pages_found = ?, frontier = ?, visited = ?, error = ?, updated_at = ? WHERE id = ?",
    args: [status, done, done + frontier.length, JSON.stringify(frontier), JSON.stringify(Array.from(visited)), error, now, jobId],
  });
  await db.execute({
    sql: "UPDATE kb_sources SET status = ?, fetched_at = ? WHERE id = ?",
    args: [status === "done" ? "ready" : status, now, job.source_id],
  });

  return (await getCrawlJob(db, jobId))!;
}

/** Cancel a job in place (keeps the pages already indexed). */
export async function cancelCrawl(db: Client, jobId: string): Promise<CrawlJob | null> {
  const now = new Date().toISOString();
  await db.execute({ sql: "UPDATE kb_crawl_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?", args: [now, jobId] });
  const job = await getCrawlJob(db, jobId);
  if (job?.source_id) {
    await db.execute({ sql: "UPDATE kb_sources SET status = 'ready', fetched_at = ? WHERE id = ?", args: [now, job.source_id] });
  }
  return job;
}
