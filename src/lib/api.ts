/**
 * Small, dependency-free helpers for JSON route handlers: trusted-origin checks,
 * size-capped JSON body parsing and a consistent error envelope.
 */

// ---------------------------------------------------------------------------
// Trusted origins (CSRF defence for state-changing requests)
// ---------------------------------------------------------------------------

const DEV_FALLBACK_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

/**
 * The application's own origin(s), from configuration only — never from the request's
 * Host or X-Forwarded-* headers, which a client or misconfigured proxy can set.
 *  - APP_ORIGIN: comma-separated list, e.g. "https://yourai.example,https://www.yourai.example"
 *  - AUTH_URL (if set) is also trusted, since Auth.js already treats it as canonical.
 * Outside production, localhost:3000 is allowed when nothing is configured.
 * In production with nothing configured the list is empty, so every check fails closed.
 */
export function resolveTrustedOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const origins = new Set<string>();
  for (const raw of [...(env.APP_ORIGIN ?? "").split(","), env.AUTH_URL ?? ""]) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
    } catch {
      // Invalid entries are ignored (fail closed for that entry); never echo the value.
    }
  }
  if (origins.size === 0 && env.NODE_ENV !== "production") DEV_FALLBACK_ORIGINS.forEach((o) => origins.add(o));
  return [...origins];
}

/**
 * True only if the browser-supplied Origin exactly matches a trusted origin. Browsers always
 * send Origin on cross-origin and same-origin POST fetches and scripts cannot forge it.
 * Requests without an Origin (or with "null") are rejected. Fetch metadata, when present,
 * must not say the request came from another site.
 */
export function isTrustedOrigin(request: Request, trusted: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return false;
  return trusted.includes(origin);
}

// ---------------------------------------------------------------------------
// JSON body parsing with a hard size cap
// ---------------------------------------------------------------------------

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: "CONTENT_TYPE" | "TOO_LARGE" | "INVALID_JSON" };

/** Reads at most `maxBytes` (streamed, so an oversized body is never fully buffered). */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) return { ok: false, reason: "CONTENT_TYPE" };

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "TOO_LARGE" };
  if (!request.body) return { ok: false, reason: "INVALID_JSON" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "TOO_LARGE" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "INVALID_JSON" };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "INVALID_JSON" };
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const BASE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...headers },
  });
}

/** Error envelope: { error: { code, message, ...extra } }. `message` must be user-safe. */
export function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return jsonResponse({ error: { code, message, ...extra } }, status, headers);
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
