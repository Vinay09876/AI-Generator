// Stage 4 adapter tests: Cloudflare provider, image processing, storage keys, Supabase
// storage adapter, asset persistence/cleanup and ownership-checked signed URLs.
//
// Fully offline: NO network and NO database. Global fetch is replaced with a function
// that throws, credentials are removed from the environment, and every external
// dependency is injected (fake fetch, fake Supabase client, in-memory storage, fake
// ownership lookup). Image processing uses the real sharp library.
//
// Run: npm run test:adapters   (uses --conditions=react-server so server-only modules load)
import sharp from "sharp";

for (const k of ["DATABASE_URL", "TEST_DATABASE_URL", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_STORAGE_BUCKET"]) {
  delete process.env[k];
}
let realNetworkAttempts = 0;
globalThis.fetch = (async () => {
  realNetworkAttempts++;
  throw new Error("Network access is forbidden in adapter tests");
}) as typeof fetch;

const { createCloudflareImageProvider, parseNeuronsHeader, decodeStrictBase64 } = await import("@/features/generations/providers/cloudflare");
const { ProviderError } = await import("@/features/generations/providers/types");
const { getImageProvider } = await import("@/features/generations/providers/index");
const { convertProviderImageToWebp, ImageValidationError } = await import("@/features/generations/image-processing");
const { buildImageObjectKey, isImageKeyOwnedBy } = await import("@/features/generations/storage/keys");
const { SupabaseObjectStorage } = await import("@/features/generations/storage/supabase");
const { getObjectStorage } = await import("@/features/generations/storage/index");
const { StorageError } = await import("@/features/generations/storage/types");
const { persistImageAsset, getSignedAssetUrl, AssetPersistenceError, AssetAccessError } = await import("@/features/generations/assets");
const { IMAGE_MODEL, MAX_STORED_IMAGE_BYTES } = await import("@/features/generations/config");
type ObjectStorage = import("@/features/generations/storage/types").ObjectStorage;

// AbortSignal.timeout() uses an unref'd timer; in a long-running server the event loop is
// always busy, but in this script nothing else would keep Node alive while a fake request
// hangs. Keep the loop alive for the duration of the suite.
const keepAlive = setInterval(() => {}, 1_000);

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const section = (s: string) => console.log(`\n# ${s}`);

const TOKEN = "test-token-SECRET-value-123";
const ACCOUNT = "acct0123456789abcdef";
const PROMPT = "A private prompt about a lighthouse at dawn";
const USER = "cuserAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "cuserBBBBBBBBBBBBBBBBBBBBB";
const JOB = "cjobCCCCCCCCCCCCCCCCCCCCCC";

// Real images generated locally.
const jpeg1024 = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 30, g: 60, b: 120 } } })
  .composite([{ input: Buffer.from(`<svg width="1024" height="1024"><circle cx="512" cy="512" r="300" fill="#f0abfc"/></svg>`) }])
  .jpeg({ quality: 90 }).toBuffer();
const png1024 = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#123456" } }).png().toBuffer();
const jpegHuge = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: "#222" } }).jpeg().toBuffer();
const jpegTiny = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#222" } }).jpeg().toBuffer();
const B64 = jpeg1024.toString("base64");

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => { const call = { url, init }; calls.push(call); return respond(call); };
  return { impl, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const provider = (impl: (u: string, i: RequestInit) => Promise<Response>, timeoutMs = 2_000) =>
  createCloudflareImageProvider({ accountId: ACCOUNT, apiToken: TOKEN, model: IMAGE_MODEL, fetchImpl: impl, timeoutMs });

async function expectProviderError(p: Promise<unknown>) {
  try { await p; return null; } catch (e) { return e as InstanceType<typeof ProviderError>; }
}
const leaksSecrets = (e: unknown) => {
  const text = JSON.stringify(e) + String((e as Error)?.message) + JSON.stringify((e as { toLog?: () => unknown })?.toLog?.() ?? {});
  return text.includes(TOKEN) || text.includes(PROMPT) || text.includes(B64.slice(0, 40));
};

try {
  // ------------------------------------------------------------------ provider: success
  section("Cloudflare provider — success");
  {
    const f = fakeFetch(() => json({ success: true, result: { image: B64, usage: {} }, errors: [] }, 200, { "cf-ai-neurons": "172.80", "cf-ai-req-id": "req-1" }));
    const r = await provider(f.impl).generate({ prompt: PROMPT, steps: 4 });
    const call = f.calls[0];
    const headers = new Headers(call.init.headers);
    ok(f.calls.length === 1 && call.url === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${IMAGE_MODEL}` && call.init.method === "POST",
      "POSTs to the account/model endpoint");
    ok(headers.get("authorization") === `Bearer ${TOKEN}` && headers.get("content-type") === "application/json", "sends bearer token + JSON content type (server-side only)");
    ok(call.init.body === JSON.stringify({ prompt: PROMPT, steps: 4 }), "request body is exactly { prompt, steps } — no seed/width/height");
    ok(r.bytes.equals(jpeg1024), "decodes base64 image bytes exactly");
    ok(r.usage.centiNeurons === 17280 && r.usage.source === "header", "cf-ai-neurons 172.80 → 17,280 centi-neurons");
    ok(r.providerRequestId === "req-1" && r.provider === "cloudflare-workers-ai" && r.model === IMAGE_MODEL && r.latencyMs >= 0, "returns provider metadata (request id, model, latency)");
    ok(!("result" in r) && !("success" in r), "internal result does not leak Cloudflare's response envelope");
    const d = fakeFetch(() => json({ success: true, result: { image: B64 } }, 200, { "cf-ai-neurons": "326.40" }));
    const r8 = await provider(d.impl).generate({ prompt: PROMPT, steps: 8 });
    ok(d.calls[0].init.body === JSON.stringify({ prompt: PROMPT, steps: 8 }) && r8.usage.centiNeurons === 32640, "detailed (8 steps): 326.40 → 32,640");
  }

  // ------------------------------------------------------------------ provider: usage header
  section("Neuron usage header");
  {
    for (const [v, want] of [["172.80", 17280], ["326.4", 32640], ["1", 100], ["0.01", 1]] as const) {
      ok(parseNeuronsHeader(v).centiNeurons === want, `parse "${v}" → ${want}`);
    }
    for (const v of ["abc", "-1", "0", "0.00", "1.234", "1e3", " ", "NaN", "172,80"]) {
      const u = parseNeuronsHeader(v);
      ok(u.centiNeurons === null && (u.source === "invalid" || u.source === "missing"), `invalid header "${v}" → null (charge reservation, never zero)`);
    }
    const missing = fakeFetch(() => json({ success: true, result: { image: B64 } }, 200, {}));
    const r = await provider(missing.impl).generate({ prompt: PROMPT, steps: 4 });
    ok(r.usage.centiNeurons === null && r.usage.source === "missing", "HTTP 200 without cf-ai-neurons → usage null/missing (never 0)");
    const bad = fakeFetch(() => json({ success: true, result: { image: B64 } }, 200, { "cf-ai-neurons": "0" }));
    const rb = await provider(bad.impl).generate({ prompt: PROMPT, steps: 4 });
    ok(rb.usage.centiNeurons === null && rb.usage.source === "invalid", "HTTP 200 with cf-ai-neurons \"0\" → usage null/invalid (never 0)");
  }

  // ------------------------------------------------------------------ provider: malformed 200s
  section("Malformed HTTP 200 responses (provider ran)");
  {
    const cases: [string, () => Response][] = [
      ["invalid JSON", () => new Response("{not json", { status: 200, headers: { "cf-ai-neurons": "172.80" } })],
      ["missing image field", () => json({ success: true, result: {} }, 200, { "cf-ai-neurons": "172.80" })],
      ["non-base64 image", () => json({ success: true, result: { image: "%%%not-base64%%%" } }, 200)],
      ["base64 with whitespace", () => json({ success: true, result: { image: B64.slice(0, 40) + "\n" + B64.slice(40) } }, 200)],
      ["base64 bad padding", () => json({ success: true, result: { image: B64.slice(0, B64.length - 1) } }, 200)],
      ["URL-safe base64 alphabet", () => json({ success: true, result: { image: "ab-_" } }, 200)],
      ["empty image string", () => json({ success: true, result: { image: "" } }, 200)],
    ];
    for (const [label, res] of cases) {
      const e = await expectProviderError(provider(fakeFetch(res).impl).generate({ prompt: PROMPT, steps: 4 }));
      ok(e?.code === "MALFORMED_RESPONSE" && e.outcome === "ran", `${label} → MALFORMED_RESPONSE, outcome ran`);
    }
    const withUsage = await expectProviderError(provider(fakeFetch(cases[0][1]).impl).generate({ prompt: PROMPT, steps: 4 }));
    ok(withUsage?.usage?.centiNeurons === 17280, "malformed 200 still carries reported usage for settlement");
    const big = await expectProviderError(provider(fakeFetch(() => new Response("x", { status: 200, headers: { "content-length": String(16 * 1024 * 1024) } })).impl).generate({ prompt: PROMPT, steps: 4 }));
    ok(big?.code === "MALFORMED_RESPONSE" && big.outcome === "ran", "oversized response body (content-length) → rejected without reading, outcome ran");
    const s0 = await expectProviderError(provider(fakeFetch(() => json({ success: false, errors: [{ code: 1000, message: "x" }] }, 200)).impl).generate({ prompt: PROMPT, steps: 4 }));
    ok(s0?.code === "UPSTREAM" && s0.outcome === "unknown", "HTTP 200 with success:false and no usage → unknown");
    const s1 = await expectProviderError(provider(fakeFetch(() => json({ success: false, errors: [] }, 200, { "cf-ai-neurons": "50.00" })).impl).generate({ prompt: PROMPT, steps: 4 }));
    ok(s1?.outcome === "ran", "HTTP 200 with success:false but usage reported → ran");
  }

  // ------------------------------------------------------------------ provider: HTTP errors
  section("Provider HTTP errors — not_run only when non-execution is established");
  {
    const cfErr = (status: number, code: number | null, headers: Record<string, string> = {}) =>
      () => json({ success: false, errors: code === null ? [] : [{ code, message: `error ${code}` }], result: null }, status, headers);
    const expectations: [string, () => Response, string, string][] = [
      ["400 + 5006 (schema validation)", cfErr(400, 5006), "INVALID_REQUEST", "not_run"],
      ["401 unauthorised", cfErr(401, 10000), "AUTH", "not_run"],
      ["403 forbidden", cfErr(403, 10000), "AUTH", "not_run"],
      ["404 invalid model ID (3042) — billing undocumented", cfErr(404, 3042), "MODEL_NOT_FOUND", "unknown"],
      ["404 without a provider code", cfErr(404, null), "MODEL_NOT_FOUND", "unknown"],
      ["404 with usage reported", cfErr(404, 3042, { "cf-ai-neurons": "5.00" }), "MODEL_NOT_FOUND", "ran"],
      ["429 + 3036 (daily allocation exhausted)", cfErr(429, 3036), "QUOTA_EXHAUSTED", "not_run"],
      ["429 rate limited", cfErr(429, 3040), "RATE_LIMITED", "not_run"],
      ["400 without validation code", cfErr(400, null), "UPSTREAM", "unknown"],
      ["400 with unrecognised code", cfErr(400, 3001), "UPSTREAM", "unknown"],
      ["408 request timeout", cfErr(408, null), "UPSTREAM", "unknown"],
      ["409 conflict", cfErr(409, null), "UPSTREAM", "unknown"],
      ["413 payload too large", cfErr(413, null), "UPSTREAM", "unknown"],
      ["500 internal error", cfErr(500, 3043), "UPSTREAM", "unknown"],
      ["502 bad gateway (HTML body)", () => new Response("<html>bad gateway</html>", { status: 502 }), "UPSTREAM", "unknown"],
      ["503 unavailable", cfErr(503, null), "UPSTREAM", "unknown"],
      ["504 gateway timeout", cfErr(504, null), "UPSTREAM", "unknown"],
      ["400 + 5006 but usage reported", cfErr(400, 5006, { "cf-ai-neurons": "10.00" }), "INVALID_REQUEST", "ran"],
    ];
    for (const [label, res, code, outcome] of expectations) {
      const e = await expectProviderError(provider(fakeFetch(res).impl).generate({ prompt: PROMPT, steps: 4 }));
      ok(e instanceof ProviderError && e.code === code && e.outcome === outcome, `${label} → ${code}/${outcome}${e ? ` (got ${e.code}/${e.outcome})` : ""}`);
    }
    const e401 = await expectProviderError(provider(fakeFetch(cfErr(401, 10000)).impl).generate({ prompt: PROMPT, steps: 4 }));
    ok(e401?.httpStatus === 401 && e401.providerCode === 10000, "error carries httpStatus + provider code for logs");
  }

  // ------------------------------------------------------------------ provider: network + timeout
  section("Network failures and timeouts");
  {
    const netErr = (code: string) => fakeFetch(() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }); });
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]) {
      const e = await expectProviderError(provider(netErr(code).impl).generate({ prompt: PROMPT, steps: 4 }));
      ok(e?.code === "NETWORK" && e.outcome === "not_run", `${code} (request never sent) → NETWORK/not_run`);
    }
    for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ETIMEDOUT"]) {
      const e = await expectProviderError(provider(netErr(code).impl).generate({ prompt: PROMPT, steps: 4 }));
      ok(e?.code === "NETWORK" && e.outcome === "unknown", `${code} (may have been sent) → NETWORK/unknown`);
    }
    const noCode = await expectProviderError(provider(fakeFetch(() => { throw new TypeError("fetch failed"); }).impl).generate({ prompt: PROMPT, steps: 4 }));
    ok(noCode?.code === "NETWORK" && noCode.outcome === "unknown", "network error without a code → unknown");

    const hang = fakeFetch(({ init }) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    const t0 = performance.now();
    const te = await expectProviderError(provider(hang.impl, 80).generate({ prompt: PROMPT, steps: 4 }));
    const elapsed = performance.now() - t0;
    ok(te?.code === "TIMEOUT" && te.outcome === "unknown", "no response within timeout → TIMEOUT/unknown (never refunded immediately)");
    ok(elapsed >= 70 && elapsed < 1_500, `timeout fires promptly (${Math.round(elapsed)} ms for an 80 ms limit)`);

    const ctrl = new AbortController();
    const cancel = fakeFetch(({ init }) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    setTimeout(() => ctrl.abort(), 20);
    const ce = await expectProviderError(provider(cancel.impl).generate({ prompt: PROMPT, steps: 4, signal: ctrl.signal }));
    ok(ce?.code === "CANCELLED" && ce.outcome === "unknown", "caller cancels in flight → CANCELLED/unknown");
    const pre = new AbortController(); pre.abort();
    const preF = fakeFetch(() => json({}));
    const pe = await expectProviderError(provider(preF.impl).generate({ prompt: PROMPT, steps: 4, signal: pre.signal }));
    ok(pe?.code === "CANCELLED" && pe.outcome === "not_run" && preF.calls.length === 0, "already-cancelled before sending → not_run, nothing sent");
  }

  // ------------------------------------------------------------------ provider: input validation
  section("Provider input validation (nothing sent)");
  {
    for (const [label, req] of [["empty prompt", { prompt: "", steps: 4 }], ["2049-char prompt", { prompt: "x".repeat(2049), steps: 4 }], ["unsupported steps 5", { prompt: "x", steps: 5 }], ["steps 0", { prompt: "x", steps: 0 }]] as const) {
      const f = fakeFetch(() => json({}));
      const e = await expectProviderError(provider(f.impl).generate(req));
      ok(e?.code === "INVALID_REQUEST" && e.outcome === "not_run" && f.calls.length === 0, `${label} → INVALID_REQUEST/not_run, fetch not called`);
    }
  }

  // ------------------------------------------------------------------ provider: secrets
  section("No secrets, prompts or image data in errors");
  {
    const errs = await Promise.all([
      expectProviderError(provider(fakeFetch(() => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401)).impl).generate({ prompt: PROMPT, steps: 4 })),
      expectProviderError(provider(fakeFetch(() => new Response("{bad", { status: 200 })).impl).generate({ prompt: PROMPT, steps: 4 })),
      expectProviderError(provider(fakeFetch(() => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); }).impl).generate({ prompt: PROMPT, steps: 4 })),
      expectProviderError(provider(fakeFetch(() => json({ success: true, result: { image: B64.slice(1) } }, 200)).impl).generate({ prompt: PROMPT, steps: 4 })),
    ]);
    ok(errs.every((e) => e instanceof ProviderError) && errs.every((e) => !leaksSecrets(e)), "error messages/toLog() never include the API token, prompt or base64 data");
  }

  // ------------------------------------------------------------------ provider factory (server-only)
  section("Server-only provider factory");
  {
    let msg = "";
    try { getImageProvider(); } catch (e) { msg = (e as Error).message; }
    ok(/CLOUDFLARE_ACCOUNT_ID/.test(msg) && /CLOUDFLARE_AI_API_TOKEN/.test(msg), "missing credentials → config error naming the variables (names only)");
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT; process.env.CLOUDFLARE_AI_API_TOKEN = TOKEN;
    const p = getImageProvider();
    ok(p.id === "cloudflare-workers-ai" && p.model === IMAGE_MODEL && !JSON.stringify(p).includes(TOKEN), "factory builds the Cloudflare provider without exposing the token on the object");
    delete process.env.CLOUDFLARE_ACCOUNT_ID; delete process.env.CLOUDFLARE_AI_API_TOKEN;
  }

  // ------------------------------------------------------------------ image processing
  section("Image validation + WebP conversion (real sharp)");
  {
    const out = await convertProviderImageToWebp(jpeg1024);
    const meta = await sharp(out.buffer).metadata();
    ok(out.mimeType === "image/webp" && meta.format === "webp" && out.buffer.subarray(0, 4).toString() === "RIFF" && out.buffer.subarray(8, 12).toString() === "WEBP",
      "JPEG → WebP (signature + decoder agree)");
    ok(out.width === 1024 && out.height === 1024 && meta.width === 1024 && meta.height === 1024, "dimensions preserved and recorded (1024×1024)");
    ok(out.sizeBytes === out.buffer.length && out.sizeBytes > 0 && out.sizeBytes <= MAX_STORED_IMAGE_BYTES, `actual size recorded (${out.sizeBytes} bytes ≤ 5 MB)`);
    const q85 = await sharp(jpeg1024).webp({ quality: 85 }).toBuffer();
    ok(out.buffer.equals(q85), "output is byte-identical to sharp WebP quality 85");

    const reject = async (label: string, input: Buffer, code: string, opts?: { maxOutputBytes?: number }) => {
      try { await convertProviderImageToWebp(input, opts); ok(false, `${label} → should be rejected`); }
      catch (e) { ok(e instanceof ImageValidationError && e.code === code, `${label} → ${code}${e instanceof ImageValidationError ? "" : ` (got ${(e as Error).message})`}`); }
    };
    await reject("PNG instead of JPEG (incorrect MIME type)", png1024, "UNSUPPORTED_FORMAT");
    await reject("WebP instead of JPEG", out.buffer, "UNSUPPORTED_FORMAT");
    await reject("empty buffer", Buffer.alloc(0), "EMPTY");
    await reject("random bytes", Buffer.from("definitely not an image at all"), "UNSUPPORTED_FORMAT");
    await reject("JPEG signature + garbage", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]), "INVALID_IMAGE");
    await reject("truncated JPEG", jpeg1024.subarray(0, Math.floor(jpeg1024.length / 3)), "INVALID_IMAGE");
    await reject("3000×3000 JPEG (over 2048 limit)", jpegHuge, "INVALID_DIMENSIONS");
    await reject("16×16 JPEG (implausibly small)", jpegTiny, "INVALID_DIMENSIONS");
    await reject("output over the stored-size limit", jpeg1024, "TOO_LARGE", { maxOutputBytes: 100 });
  }

  // ------------------------------------------------------------------ keys
  section("User-scoped object keys");
  {
    ok(buildImageObjectKey({ userId: USER, jobId: JOB, assetId: "asset_1234567" }) === `users/${USER}/images/${JOB}/asset_1234567.webp`, "key = users/{userId}/images/{jobId}/{assetId}.webp");
    for (const [label, p] of [
      ["path traversal userId", { userId: "../admin1", jobId: JOB, assetId: "asset_1234567" }],
      ["slash in jobId", { userId: USER, jobId: "a/b/c/d/e/f", assetId: "asset_1234567" }],
      ["empty assetId", { userId: USER, jobId: JOB, assetId: "" }],
      ["dot segment", { userId: USER, jobId: JOB, assetId: "........" }],
    ] as const) {
      let code = ""; try { buildImageObjectKey(p); } catch (e) { code = (e as InstanceType<typeof StorageError>).code; }
      ok(code === "INVALID_KEY", `rejects ${label}`);
    }
    const k = buildImageObjectKey({ userId: USER, jobId: JOB, assetId: "asset_1234567" });
    ok(isImageKeyOwnedBy(k, USER) && !isImageKeyOwnedBy(k, OTHER), "ownership check: owner true, other user false");
    ok(!isImageKeyOwnedBy(`users/${USER}0/images/${JOB}/asset_1234567.webp`, USER), "prefix trick (userId + extra char) is not owned");
    ok(!isImageKeyOwnedBy(`users/${USER}/images/../${OTHER}/x.webp`, USER) && !isImageKeyOwnedBy(`users/${USER}/other/${JOB}/asset_1234567.webp`, USER), "malformed/traversal keys are not owned");
  }

  // ------------------------------------------------------------------ Supabase adapter (fake client)
  section("Supabase storage adapter (fake client, no network)");
  {
    type Rec = { op: string; bucket: string; args: unknown[] };
    const makeClient = (behaviour: { upload?: unknown; sign?: unknown; remove?: unknown } = {}) => {
      const calls: Rec[] = [];
      const client = {
        storage: {
          from: (bucket: string) => ({
            upload: async (...args: unknown[]) => { calls.push({ op: "upload", bucket, args }); return { data: behaviour.upload ? null : { path: args[0] }, error: behaviour.upload ?? null }; },
            createSignedUrl: async (...args: unknown[]) => { calls.push({ op: "sign", bucket, args }); return behaviour.sign ? { data: null, error: behaviour.sign } : { data: { signedUrl: `https://example.supabase.co/storage/v1/object/sign/${bucket}/${args[0]}?token=t&exp=${args[1]}` }, error: null }; },
            remove: async (...args: unknown[]) => { calls.push({ op: "remove", bucket, args }); return { data: behaviour.remove ? null : [], error: behaviour.remove ?? null }; },
          }),
        },
      };
      return { client: client as never, calls };
    };
    const key = buildImageObjectKey({ userId: USER, jobId: JOB, assetId: "asset_1234567" });
    const webp = (await convertProviderImageToWebp(jpeg1024)).buffer;

    const a = makeClient(); const s = new SupabaseObjectStorage(a.client, "generated-assets");
    await s.put(key, webp, { contentType: "image/webp", maxBytes: MAX_STORED_IMAGE_BYTES });
    const opts = a.calls[0]?.args[2] as { contentType: string; upsert: boolean };
    ok(a.calls[0]?.op === "upload" && a.calls[0].bucket === "generated-assets" && a.calls[0].args[0] === key && opts.contentType === "image/webp" && opts.upsert === false,
      "upload: configured bucket, user-scoped key, image/webp, upsert:false (never overwrite)");

    const b = makeClient(); const sb = new SupabaseObjectStorage(b.client, "generated-assets");
    let tooLarge = ""; try { await sb.put(key, Buffer.alloc(MAX_STORED_IMAGE_BYTES + 1), { contentType: "image/webp", maxBytes: MAX_STORED_IMAGE_BYTES }); } catch (e) { tooLarge = (e as InstanceType<typeof StorageError>).code; }
    ok(tooLarge === "TOO_LARGE" && b.calls.length === 0, "5 MB limit enforced in application code: oversized upload rejected before calling Supabase");
    let empty = ""; try { await sb.put(key, Buffer.alloc(0), { contentType: "image/webp", maxBytes: MAX_STORED_IMAGE_BYTES }); } catch (e) { empty = (e as InstanceType<typeof StorageError>).code; }
    ok(empty === "TOO_LARGE" && b.calls.length === 0, "empty upload rejected before calling Supabase");

    const dup = new SupabaseObjectStorage(makeClient({ upload: { message: "The resource already exists", statusCode: "409" } }).client, "generated-assets");
    let dupCode = ""; try { await dup.put(key, webp, { contentType: "image/webp", maxBytes: MAX_STORED_IMAGE_BYTES }); } catch (e) { dupCode = (e as InstanceType<typeof StorageError>).code; }
    ok(dupCode === "ALREADY_EXISTS", "existing object → ALREADY_EXISTS (no overwrite)");
    const failing = new SupabaseObjectStorage(makeClient({ upload: { message: "internal error", statusCode: "500" } }).client, "generated-assets");
    let upCode = ""; let upStatus: number | null = null;
    try { await failing.put(key, webp, { contentType: "image/webp", maxBytes: MAX_STORED_IMAGE_BYTES }); } catch (e) { upCode = (e as InstanceType<typeof StorageError>).code; upStatus = (e as InstanceType<typeof StorageError>).httpStatus; }
    ok(upCode === "UPLOAD_FAILED" && upStatus === 500, "storage upload failure → UPLOAD_FAILED with status");

    const c = makeClient(); const sc = new SupabaseObjectStorage(c.client, "generated-assets");
    const url = await sc.createSignedUrl(key, 600);
    ok(c.calls[0]?.op === "sign" && c.calls[0].args[0] === key && c.calls[0].args[1] === 600 && url.includes(key), "createSignedUrl: passes key + 600 s expiry, returns URL");
    let signCode = ""; try { await new SupabaseObjectStorage(makeClient({ sign: { message: "not found", statusCode: "404" } }).client, "b").createSignedUrl(key, 600); } catch (e) { signCode = (e as InstanceType<typeof StorageError>).code; }
    ok(signCode === "SIGN_FAILED", "signing failure → SIGN_FAILED");
    await sc.delete(key);
    ok(c.calls[1]?.op === "remove" && JSON.stringify(c.calls[1].args[0]) === JSON.stringify([key]), "delete removes exactly [key]");

    let cfgMsg = ""; try { getObjectStorage(); } catch (e) { cfgMsg = (e as Error).message; }
    ok(/SUPABASE_URL/.test(cfgMsg) && /SUPABASE_SECRET_KEY/.test(cfgMsg) && /SUPABASE_STORAGE_BUCKET/.test(cfgMsg), "server-only storage factory: missing config names variables only");
    process.env.SUPABASE_URL = "https://example.supabase.co"; process.env.SUPABASE_SECRET_KEY = "sb_secret_TEST_ONLY_value"; process.env.SUPABASE_STORAGE_BUCKET = "generated-assets";
    const real = getObjectStorage();
    ok(real instanceof SupabaseObjectStorage && realNetworkAttempts === 0, "factory creates the Supabase adapter without any network call");
  }

  // ------------------------------------------------------------------ assets: persistence + cleanup
  section("Asset persistence and cleanup (in-memory storage)");
  {
    const memory = (opts: { failPut?: boolean; failDelete?: boolean } = {}) => {
      const objects = new Map<string, Buffer>();
      const log: string[] = [];
      const storage: ObjectStorage = {
        async put(key, body, o) { log.push(`put:${key}`); if (opts.failPut) throw new StorageError("UPLOAD_FAILED", "Upload failed.", 500); if (body.length > o.maxBytes) throw new StorageError("TOO_LARGE", "x"); objects.set(key, body); },
        async createSignedUrl(key, exp) { log.push(`sign:${key}`); return `signed://${key}?exp=${exp}`; },
        async delete(key) { log.push(`delete:${key}`); if (opts.failDelete) throw new StorageError("DELETE_FAILED", "Delete failed."); objects.delete(key); },
      };
      return { storage, objects, log };
    };
    const image = await convertProviderImageToWebp(jpeg1024);

    const m1 = memory();
    let saved: unknown = null;
    const result = await persistImageAsset({ storage: m1.storage, userId: USER, jobId: JOB, image, assetId: "asset_1234567", save: async (rec) => { saved = rec; return { id: rec.assetId }; } });
    const key = `users/${USER}/images/${JOB}/asset_1234567.webp`;
    ok(m1.objects.has(key) && (result as { id: string }).id === "asset_1234567", "success: object stored under user-scoped key, save() result returned");
    ok(JSON.stringify(saved) === JSON.stringify({ assetId: "asset_1234567", storageKey: key, mimeType: "image/webp", width: 1024, height: 1024, sizeBytes: image.sizeBytes }),
      "save() receives storage key + actual size, MIME type and dimensions (no image data)");
    ok([...m1.objects.values()].every((b) => b.subarray(8, 12).toString() === "WEBP"), "only the WebP is stored (no JPEG original)");

    const m2 = memory({ failPut: true });
    let saveCalled = false; let putErr = "";
    try { await persistImageAsset({ storage: m2.storage, userId: USER, jobId: JOB, image, save: async () => { saveCalled = true; } }); } catch (e) { putErr = (e as InstanceType<typeof StorageError>).code; }
    ok(putErr === "UPLOAD_FAILED" && !saveCalled && m2.objects.size === 0, "upload failure: error propagates, save() not called, nothing stored");

    const m3 = memory();
    let pe: InstanceType<typeof AssetPersistenceError> | null = null;
    try { await persistImageAsset({ storage: m3.storage, userId: USER, jobId: JOB, image, save: async () => { throw new Error("db down"); } }); } catch (e) { pe = e as InstanceType<typeof AssetPersistenceError>; }
    ok(pe instanceof AssetPersistenceError && pe.orphanedKey === null && m3.objects.size === 0 && m3.log.some((l) => l.startsWith("delete:")),
      "DB save failure: uploaded object deleted (cleanup), AssetPersistenceError, no orphan");
    ok((pe?.cause as Error)?.message === "db down", "original DB error preserved as cause");

    const m4 = memory({ failDelete: true });
    const origErr = console.error; console.error = () => {};
    let pe2: InstanceType<typeof AssetPersistenceError> | null = null;
    try { await persistImageAsset({ storage: m4.storage, userId: USER, jobId: JOB, image, assetId: "asset_7654321", save: async () => { throw new Error("db down"); } }); } catch (e) { pe2 = e as InstanceType<typeof AssetPersistenceError>; }
    console.error = origErr;
    ok(pe2 instanceof AssetPersistenceError && pe2.orphanedKey === `users/${USER}/images/${JOB}/asset_7654321.webp`, "DB save failure + cleanup failure: orphaned key reported for later sweep");

    let keyErr = "";
    try { await persistImageAsset({ storage: memory().storage, userId: "../evil", jobId: JOB, image, save: async () => {} }); } catch (e) { keyErr = (e as InstanceType<typeof StorageError>).code; }
    ok(keyErr === "INVALID_KEY", "invalid userId rejected before upload");
  }

  // ------------------------------------------------------------------ assets: ownership-checked signing
  section("Ownership-checked signed URLs");
  {
    const signed: string[] = [];
    const storage: ObjectStorage = {
      async put() {}, async delete() {},
      async createSignedUrl(key, exp) { signed.push(key); return `signed://${key}?exp=${exp}`; },
    };
    const ownKey = `users/${USER}/images/${JOB}/asset_1234567.webp`;
    const lookups: unknown[] = [];
    const db = new Map([["asset_1234567", { userId: USER, storageKey: ownKey }], ["asset_foreign1", { userId: OTHER, storageKey: `users/${OTHER}/images/${JOB}/asset_foreign1.webp` }], ["asset_tamper1", { userId: USER, storageKey: `users/${OTHER}/images/${JOB}/asset_tamper1.webp` }]]);
    // Mirrors the real query: scoped by BOTH asset id and user id.
    const findAsset = async (w: { assetId: string; userId: string }) => { lookups.push(w); const a = db.get(w.assetId); return a && a.userId === w.userId ? { storageKey: a.storageKey } : null; };

    const url = await getSignedAssetUrl({ userId: USER, assetId: "asset_1234567", storage, findAsset });
    ok(url === `signed://${ownKey}?exp=600` && signed.length === 1, "owner gets a signed URL (600 s) for the key stored in the DB");
    ok(JSON.stringify(lookups[0]) === JSON.stringify({ assetId: "asset_1234567", userId: USER }), "lookup is scoped by assetId AND session userId");

    const denied = async (label: string, userId: string, assetId: string) => {
      const before = signed.length;
      let err: unknown = null; try { await getSignedAssetUrl({ userId, assetId, storage, findAsset }); } catch (e) { err = e; }
      ok(err instanceof AssetAccessError && signed.length === before, `${label} → NOT_FOUND and storage never asked to sign`);
    };
    await denied("another user's asset", USER, "asset_foreign1");
    await denied("non-existent asset", USER, "asset_missing1");
    await denied("record whose key points outside the owner's prefix", USER, "asset_tamper1");
    await denied("empty asset id", USER, "");
    const e1 = await getSignedAssetUrl({ userId: USER, assetId: "asset_foreign1", storage, findAsset }).catch((e) => e);
    const e2 = await getSignedAssetUrl({ userId: USER, assetId: "asset_missing1", storage, findAsset }).catch((e) => e);
    ok(e1.message === e2.message, "'not yours' and 'missing' are indistinguishable (no id probing)");
  }

  section("Isolation");
  ok(realNetworkAttempts === 0, "no real network access was attempted during the whole suite");
} catch (e) {
  fail++;
  console.error("TEST ERROR", (e as Error)?.stack?.split("\n").slice(0, 4).join("\n"));
} finally {
  clearInterval(keepAlive);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}
