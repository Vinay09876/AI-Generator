import assert from "node:assert/strict";
import { validateRuntimeEnv, assertRuntimeEnv, getSanitizedEnvStatus } from "../src/lib/env";
import { InMemoryRateLimiter, extractClientIp, RATE_LIMITS } from "../src/lib/rate-limit";
import { createGenerationHandlers, type GenerationHttpDeps } from "../src/features/generations/http";
import nextConfig, { getSecurityHeaders } from "../next.config";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res
        .then(() => {
          passed++;
          console.log(`PASS  ${name}`);
        })
        .catch((err) => {
          failed++;
          console.error(`FAIL  ${name}:`, err);
        });
    }
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}:`, err);
  }
}

async function run() {
  console.log("\n# Sub-Batch 3A — HTTP Security Headers & Content Security Policy");

  await test("nextConfig defines headers() returning security headers array", async () => {
    const cfg = (nextConfig as any).default ?? nextConfig;
    assert.equal(typeof cfg.headers, "function", "headers must be a function");
    const headerRules = await cfg.headers();
    assert.ok(Array.isArray(headerRules), "headers() must return an array");
    const wildcardRule = headerRules.find((r: any) => r.source === "/:path*");
    assert.ok(wildcardRule, "Must have /:path* wildcard rule");

    const headersMap = new Map<string, string>(wildcardRule.headers.map((h: any) => [h.key, String(h.value)]));

    assert.ok(headersMap.has("Content-Security-Policy"), "Missing CSP");
    assert.equal(headersMap.get("X-Frame-Options"), "DENY", "X-Frame-Options must be DENY");
    assert.equal(headersMap.get("X-Content-Type-Options"), "nosniff", "X-Content-Type-Options must be nosniff");
    assert.equal(headersMap.get("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.ok(headersMap.get("Permissions-Policy")?.includes("camera=()"), "Permissions-Policy must restrict camera");
  });

  await test("CSP contains required origins and directives", () => {
    const headers = getSecurityHeaders(false);
    const csp = headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";

    assert.ok(csp.includes("default-src 'self'"), "CSP must include default-src 'self'");
    assert.ok(csp.includes("frame-ancestors 'none'"), "CSP must include frame-ancestors 'none'");
    assert.ok(csp.includes("object-src 'none'"), "CSP must include object-src 'none'");
    assert.ok(csp.includes("base-uri 'self'"), "CSP must include base-uri 'self'");
    assert.ok(csp.includes("form-action 'self'"), "CSP must include form-action 'self'");
    assert.ok(csp.includes("https://*.supabase.co"), "CSP must include Supabase in img-src / connect-src");
    assert.ok(csp.includes("media-src 'self' blob: data: https://*.supabase.co"), "CSP must include Supabase in media-src for video playback");
    assert.ok(csp.includes("https://fonts.googleapis.com"), "CSP must include Google Fonts in style-src");
    assert.ok(csp.includes("https://fonts.gstatic.com"), "CSP must include Google Fonts in font-src");
  });

  await test("CSP excludes unsafe-eval and HSTS excludes includeSubDomains in production", () => {
    const prodHeaders = getSecurityHeaders(false);
    const headersMap = new Map(prodHeaders.map((h) => [h.key, h.value]));

    const csp = headersMap.get("Content-Security-Policy") ?? "";
    assert.ok(!csp.includes("'unsafe-eval'"), "Production CSP must NOT contain 'unsafe-eval'");
    assert.ok(csp.includes("'unsafe-inline'"), "Production CSP keeps 'unsafe-inline' for Next.js hydration");

    const hsts = headersMap.get("Strict-Transport-Security");
    assert.ok(hsts, "Production must include Strict-Transport-Security");
    assert.equal(hsts, "max-age=31536000", "HSTS must have max-age=31536000 without includeSubDomains");
    assert.ok(!hsts.includes("includeSubDomains"), "HSTS must NOT include includeSubDomains without domain audit");

    // In development: HSTS is omitted to avoid breaking localhost HTTP
    const devHeaders = getSecurityHeaders(true);
    const devHeadersMap = new Map(devHeaders.map((h) => [h.key, h.value]));
    assert.equal(devHeadersMap.get("Strict-Transport-Security"), undefined);
    assert.ok(devHeadersMap.get("Content-Security-Policy")?.includes("'unsafe-eval'"));
  });

  console.log("\n# Sub-Batch 3A — Centralized Runtime Environment Validation");

  const validMockEnv = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://postgres:secretpassword@db.project.supabase.co:5432/postgres?schema=public",
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    AUTH_URL: "http://localhost:3000",
    APP_ORIGIN: "http://localhost:3000",
    CLOUDFLARE_ACCOUNT_ID: "cf-test-acc",
    CLOUDFLARE_AI_API_TOKEN: "cf-test-token-xyz",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SECRET_KEY: "sb-secret-key-123",
    SUPABASE_STORAGE_BUCKET: "generated-assets",
  };

  await test("validateRuntimeEnv succeeds with complete valid configuration", () => {
    const res = validateRuntimeEnv(validMockEnv);
    assert.equal(res.ok, true, "Valid environment should pass");
    if (res.ok) {
      assert.equal(res.data.DATABASE_URL, validMockEnv.DATABASE_URL);
      assert.equal(res.data.CLOUDFLARE_ACCOUNT_ID, "cf-test-acc");
    }
  });

  await test("validateRuntimeEnv detects missing required variables", () => {
    const res = validateRuntimeEnv({
      ...validMockEnv,
      DATABASE_URL: undefined,
      CLOUDFLARE_AI_API_TOKEN: "",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.missing.includes("DATABASE_URL"), "Should list DATABASE_URL in missing");
      assert.ok(res.missing.includes("CLOUDFLARE_AI_API_TOKEN"), "Should list CLOUDFLARE_AI_API_TOKEN in missing");
    }
  });

  await test("validateRuntimeEnv detects invalid connection strings and short secrets", () => {
    const res = validateRuntimeEnv({
      ...validMockEnv,
      DATABASE_URL: "mysql://localhost:3306/db",
      AUTH_SECRET: "tooshort",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.invalid.includes("DATABASE_URL"), "Should mark non-postgres URL as invalid");
      assert.ok(res.invalid.includes("AUTH_SECRET"), "Should mark <16 char secret as invalid");
    }
  });

  await test("assertRuntimeEnv throws sanitized error naming keys only (never values)", () => {
    const sensitiveDb = "postgresql://user:SENSITIVE_DB_PASSWORD@host:5432/db";
    assert.throws(
      () => {
        assertRuntimeEnv({
          ...validMockEnv,
          DATABASE_URL: sensitiveDb,
          AUTH_SECRET: "short",
          SUPABASE_SECRET_KEY: undefined,
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("missing: [SUPABASE_SECRET_KEY]"));
        assert.ok(err.message.includes("invalid: [AUTH_SECRET]"));
        assert.ok(!err.message.includes("SENSITIVE_DB_PASSWORD"), "Must not leak password");
        assert.ok(!err.message.includes("cf-test-token-xyz"), "Must not leak Cloudflare token");
        assert.ok(!err.message.includes("short"), "Must not echo short secret");
        return true;
      },
    );
  });

  await test("getSanitizedEnvStatus returns non-sensitive boolean diagnostics", () => {
    const status = getSanitizedEnvStatus(validMockEnv);
    assert.equal(status.valid, true);
    assert.equal(status.configured.hasDatabaseUrl, true);
    assert.equal(status.configured.hasCloudflareCredentials, true);
    assert.equal(status.configured.hasSupabaseStorage, true);
  });

  console.log("\n# Sub-Batch 3A — In-Memory Process-Local Rate Limiting");

  await test("RATE_LIMITS configuration matches approved specifications", () => {
    assert.deepEqual(RATE_LIMITS.REGISTER_IP, { max: 5, windowMs: 15 * 60 * 1000 });
    assert.deepEqual(RATE_LIMITS.LOGIN_IP, { max: 10, windowMs: 15 * 60 * 1000 });
    assert.deepEqual(RATE_LIMITS.LOGIN_ACCOUNT, { max: 5, windowMs: 15 * 60 * 1000 });
    assert.deepEqual(RATE_LIMITS.GENERATION_BURST, { max: 10, windowMs: 60 * 1000 });
  });

  await test("InMemoryRateLimiter sliding window allows hits within limit", () => {
    const limiter = new InMemoryRateLimiter();
    const config = { max: 3, windowMs: 1000 };
    const now = 10000;

    const r1 = limiter.check("user1", config, now);
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 2);

    const r2 = limiter.check("user1", config, now + 100);
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 1);

    const r3 = limiter.check("user1", config, now + 200);
    assert.equal(r3.allowed, true);
    assert.equal(r3.remaining, 0);

    const r4 = limiter.check("user1", config, now + 300);
    assert.equal(r4.allowed, false);
    assert.equal(r4.remaining, 0);
    assert.equal(r4.retryAfterSeconds, 1);
  });

  await test("InMemoryRateLimiter sliding window prunes expired entries", () => {
    const limiter = new InMemoryRateLimiter();
    const config = { max: 2, windowMs: 1000 };
    const t0 = 10000;

    limiter.check("ip:1", config, t0);
    limiter.check("ip:1", config, t0 + 200);
    assert.equal(limiter.check("ip:1", config, t0 + 400).allowed, false);

    // After window expires (> 1000ms after t0)
    const tFuture = t0 + 1050;
    const r = limiter.check("ip:1", config, tFuture);
    assert.equal(r.allowed, true, "Should allow after window slides past first hit");
  });

  await test("InMemoryRateLimiter bounds maximum entries", () => {
    const limiter = new InMemoryRateLimiter({ maxEntries: 3 });
    const config = { max: 5, windowMs: 10000 };

    limiter.check("key1", config, 1000);
    limiter.check("key2", config, 1000);
    limiter.check("key3", config, 1000);
    assert.equal(limiter.size, 3);

    // Adding 4th key should evict oldest
    limiter.check("key4", config, 1000);
    assert.equal(limiter.size, 3, "Size must be capped at maxEntries");
  });

  await test("extractClientIp enforces trust boundary: spoofed headers cannot change client identity under default model", () => {
    // Under default trustModel "none": ALL forwarding headers are untrusted
    const spoofed1 = extractClientIp({ "x-forwarded-for": "198.51.100.1" });
    const spoofed2 = extractClientIp({ "x-forwarded-for": "203.0.113.2" });
    const spoofedRealIp = extractClientIp({ "x-real-ip": "192.0.2.5" });
    const spoofedCf = extractClientIp({ "cf-connecting-ip": "198.51.100.99" });
    const spoofedAll = extractClientIp({
      "cf-connecting-ip": "198.51.100.99",
      "cf-ray": "8f1234567890abcd-NRT",
      "x-real-ip": "192.0.2.5",
      "x-forwarded-for": "10.0.0.1, 192.0.2.1",
    });

    // In direct/untrusted deployments, client identity is invariant
    assert.equal(spoofed1, "127.0.0.1");
    assert.equal(spoofed2, "127.0.0.1");
    assert.equal(spoofedRealIp, "127.0.0.1");
    assert.equal(spoofedCf, "127.0.0.1");
    assert.equal(spoofedAll, "127.0.0.1");

    // Anti-spoofing test: rotating X-Forwarded-For cannot bypass rate limiting
    const limiter = new InMemoryRateLimiter();
    const config = { max: 3, windowMs: 60_000 };
    const now = Date.now();

    for (let i = 0; i < 3; i++) {
      const ip = extractClientIp({ "x-forwarded-for": `198.51.100.${i + 1}` });
      const res = limiter.check(`register:ip:${ip}`, config, now + i * 10);
      assert.equal(res.allowed, true, `Hit ${i + 1} should be allowed`);
    }

    // 4th hit with a different spoofed IP must be BLOCKED because identity is invariant
    const ip4 = extractClientIp({ "x-forwarded-for": "198.51.100.99" });
    const res4 = limiter.check(`register:ip:${ip4}`, config, now + 40);
    assert.equal(res4.allowed, false, "4th hit with spoofed header must be blocked by rate limiter");
  });

  await test("extractClientIp: CF-Ray alone does not authenticate a request; Cloudflare mode honored only under explicit trust configuration", () => {
    // 1. CF-Ray alone is NOT authentication: In default mode ("none"), a request with forged CF-Connecting-IP
    // and forged CF-Ray MUST still be rejected and return fallback IP (127.0.0.1).
    assert.equal(
      extractClientIp(
        {
          "cf-connecting-ip": "203.0.113.50",
          "cf-ray": "8f1234567890abcd-NRT",
        },
        { trustModel: "none" },
      ),
      "127.0.0.1",
      "CF-Ray must not be treated as proof of trusted proxy under default model",
    );

    // 2. Default invocation without options must also fail closed to 127.0.0.1
    const originalEnv = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      assert.equal(
        extractClientIp({
          "cf-connecting-ip": "203.0.113.50",
          "cf-ray": "8f1234567890abcd-NRT",
        }),
        "127.0.0.1",
        "Default environment without TRUST_PROXY must ignore CF headers",
      );

      // 3. When operator explicitly enables TRUST_PROXY=cloudflare (asserting network-level isolation):
      process.env.TRUST_PROXY = "cloudflare";
      assert.equal(
        extractClientIp({
          "cf-connecting-ip": "203.0.113.50",
          "cf-ray": "8f1234567890abcd-NRT",
          "x-forwarded-for": "198.51.100.1",
          "x-real-ip": "192.0.2.1",
        }),
        "203.0.113.50",
        "Cloudflare mode extracts CF-Connecting-IP when explicitly configured",
      );

      // 4. Under Cloudflare mode, missing CF-Ray fails closed
      assert.equal(
        extractClientIp({ "cf-connecting-ip": "203.0.113.50" }),
        "127.0.0.1",
        "Cloudflare mode without CF-Ray fails closed",
      );

      // 5. X-Forwarded-For and X-Real-IP are never trusted even under Cloudflare trust model
      assert.equal(
        extractClientIp({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "192.0.2.1" }),
        "127.0.0.1",
        "X-Forwarded-For and X-Real-IP must never be trusted",
      );

      // 6. Malformed or injected CF-Connecting-IP fails closed to fallback
      assert.equal(
        extractClientIp({ "cf-connecting-ip": "invalid-ip-string", "cf-ray": "8f1234-NRT" }),
        "127.0.0.1",
      );
      assert.equal(
        extractClientIp({ "cf-connecting-ip": "1.1.1.1, 2.2.2.2", "cf-ray": "8f1234-NRT" }),
        "127.0.0.1",
      );
    } finally {
      if (originalEnv !== undefined) process.env.TRUST_PROXY = originalEnv;
      else delete process.env.TRUST_PROXY;
    }
  });

  console.log("\n# Sub-Batch 3A — Generation Endpoint Burst Rate Limiting Integration");

  await test("postImage enforces checkRateLimit when provided", async () => {
    const burstLimiter = new InMemoryRateLimiter();
    const deps: GenerationHttpDeps = {
      getUserId: async () => "user-123",
      trustedOrigins: () => ["http://localhost:3000"],
      generate: async () => ({ jobId: "job-123", replayed: false, outcome: "completed" as const }),
      loadJob: async () => ({
        id: "job-123",
        userId: "user-123",
        status: "COMPLETED",
        prompt: "test",
        quality: "fast",
        model: "m",
        errorMessage: null,
        settings: { quality: "fast" },
        chargedCredits: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
        assets: [
          {
            id: "a1",
            userId: "user-123",
            jobId: "job-123",
            type: "IMAGE",
            storageKey: "users/user-123/images/job-123/a1.webp",
            fileUrl: null,
            width: 1024,
            height: 1024,
            mimeType: "image/webp",
            fileSize: BigInt(1000),
            createdAt: new Date(),
          },
        ],
      }),
      loadBalance: async () => 100,
      reconcileForUser: async () => {},
      scheduleBackground: () => {},
      reconcileGlobal: async () => {},
      signAssetUrl: async () => "https://signed.url",
      checkRateLimit: (key) => burstLimiter.check(key, { max: 2, windowMs: 60000 }),
    };

    const handlers = createGenerationHandlers(deps);
    const makeReq = () =>
      new Request("http://localhost:3000/api/generations/image", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "idempotency-key": "idempotency-key-12345",
          "content-type": "application/json",
          "x-real-ip": "192.168.1.50",
        },
        body: JSON.stringify({ prompt: "A golden sunset", quality: "fast" }),
      });

    // 1st request: OK (allowed by rate limiter)
    const res1 = await handlers.postImage(makeReq());
    assert.ok(res1.status === 200 || res1.status === 201, "1st request should succeed");

    // 2nd request: OK (allowed by rate limiter)
    const res2 = await handlers.postImage(makeReq());
    assert.ok(res2.status === 200 || res2.status === 201, "2nd request should succeed");

    // 3rd request: RATE_LIMITED (429) (burst limit of 2 exceeded)
    const res3 = await handlers.postImage(makeReq());
    assert.equal(res3.status, 429);
    const body3 = (await res3.json()) as { error?: { code?: string } };
    assert.equal(body3.error?.code, "RATE_LIMITED");
    assert.ok(res3.headers.get("Retry-After"), "Must include Retry-After header");
  });

  console.log("\n# Sub-Batch 3A — Dual Health Check Route Probes");

  await test("GET /api/health (liveness) returns 200 without touching database", async () => {
    const { GET } = await import("../src/app/api/health/route");
    const req = new Request("http://localhost:3000/api/health");
    const res = await GET(req);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
    const data = await res.json();
    assert.equal(data.status, "ok");
    assert.equal(data.checks?.process, "alive");
    assert.equal(data.checks?.database, undefined, "Liveness must NOT execute database check");
  });

  console.log("\n========================================");
  console.log(`Sub-Batch 3A Tests: ${passed} passed, ${failed} failed`);
  console.log("========================================\n");

  if (failed > 0) process.exit(1);
}

run();
