# YourAI — Project Context

> Source of truth for product direction, approved decisions and current progress.
> Read this before starting any work. Update the **Status** section when a stage completes.
> Contains no secrets — never add real keys, tokens or connection strings here.

## 1. Product

**YourAI** is an AI creative SaaS, starting in India and expanding globally later. Three core tools:

1. **AI Image Generator** — text → image, quality options, history, credits. *(building now)*
2. **AI Video Generator** — future milestone.
3. **AI Video Clipper** — future milestone (upload → process → export short clips).

Then: monetisation (credit purchases, subscriptions, payments). Monetisation comes **after** the core product works reliably.

**Build order is strict:** finish the image generator end to end before starting video, clipper or payments.

## 2. Status (update as stages complete)

AI Image Generator — 7-stage roadmap:

| # | Stage | Status |
|---|---|---|
| 1 | Provider feasibility (Cloudflare FLUX.1 Schnell) | ✅ Done |
| 2 | Prisma schema + safe migrations | ✅ Done — commit `43c68cf` |
| 3 | Credit ledger, Neuron budget, job lifecycle (65 tests) | ✅ Done — commit `6a2bd3b` |
| 4 | Cloudflare provider adapter + Supabase Storage adapter (119 mocked tests) | ✅ Done — commit `218239a` |
| 5 | Generation APIs, job processing, recovery | ✅ Implementation complete — offline API tests 161/161, adapter tests 119/119, DB integration tests 28/28, accounting tests 65/65 (dedicated test DB; all test records cleaned up), TypeScript check passed, `next build` passed. Commit `68d7bc7` (pushed). |
| 6 | `/ai-image` UI | ✅ Implemented (B1–B6) and **real-generation-tested** (one Fast E2E generation on production, 2026-11-09 — see below). Reload-during-processing recovery **unverified** with a real job. Commit `23cad50` (pushed). |
| 7 | Final testing + release readiness | ✅ Done — Batch 1 (Next.js standalone output, Dockerfile, .dockerignore, .env.example audit, /api/health probes) complete. Batch 2 (Hardened Disaster Recovery & Operational Tooling: YOURAI_ENC_V3 chunk-framed streaming authenticated encryption, PBKDF2/HKDF key hierarchy, two-pass streaming DB restore, per-object safe storage reconciliation, coordinated backup sets, 65 DR tests) complete. Batch 3 (Release Hardening, Legal Policies & Final Regression): Sub-Batch 3A (HTTP security headers, strict CSP, centralized lazy Zod env validation, bounded process-local sliding window rate limiting, safe client IP trust boundary, dual liveness/readiness health probes) complete; Sub-Batch 3B (Grounded legal pages /terms, /privacy, /acceptable-use, footer/registration/composer UX discoverability, explicit disclosures of unsupported self-service deletion and India draft status, zero unbuilt moderation tooling invariants, 15 legal tests) complete; Sub-Batch 3C (Complete 760-test regression across all 12 suites, Prisma generate, TypeScript check, Next.js production build, DR documentation, Release Readiness Checklist) complete. |

## 3. Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Motion · PostgreSQL on Supabase · Prisma 7 (`prisma.config.ts`, client generated to `src/generated/prisma`, `@prisma/adapter-pg`) · Auth.js v5 (Credentials, JWT sessions) · bcryptjs · zod · Cloudflare Workers AI (FLUX.1 Schnell, implemented) · Supabase Storage (private bucket, implemented) · sharp (JPEG → WebP).

Next.js 16 uses `src/proxy.ts` (formerly middleware). Repo: `github.com/Vinay09876/AI-Generator`, branch `master`.

## 4. Approved business rules (do not change without discussion)

**Credits (user-facing)**
- New account: **100 credits** (+ `INITIAL_GRANT` ledger row), created atomically with the user.
- Fast image: **1 credit**, 4 steps. Detailed image: **2 credits**, 8 steps.
- Ledger sign: positive = added, negative = deducted. Wallet balance can never be negative (DB `CHECK`).

**Provider capacity (Neurons) — separate from credits**
- Model `@cf/black-forest-labs/flux-1-schnell`, REST `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`, server-side bearer token.
- Free allocation 10,000 Neurons/day, resets **00:00 UTC**. App budget **9,500 Neurons/UTC day** (500 margin).
- Stored as centi-neurons: Fast **17,280**, Detailed **32,640**, daily limit **950,000**.
- Actual usage comes from the `cf-ai-neurons` response header.

**Limits**
- Max **10 counted image generations per user per UTC day**; max **1 active job per user** (DB partial unique index).
- A job counts when its provider reservation is `RESERVED` or `CONSUMED` (provider may have run / did run — even if later refunded). `RELEASED` (provider definitely never ran) does not count.

**Accounting invariants**
- Job creation + credit debit + Neuron reservation happen in **one** DB transaction.
- **Never** call a provider inside a DB transaction.
- Refunds and reservation settlement happen **exactly once**; idempotency keys prevent duplicate jobs/debits/reservations.
- If the provider **may** have run, do not refund until reconciliation (stale `PROCESSING` > 5 min).
- Record actual provider usage separately from reserved usage.

## 5. Stage 1 findings (Cloudflare FLUX.1 Schnell)

| | Fast | Detailed |
|---|---|---|
| Steps | 4 | 8 |
| Neurons (measured) | 172.80 | 326.40 |
| Latency | 2.6 s | 4.7 s |
| Output | JPEG 1024×1024, ~819 KB | JPEG 1024×1024, ~819 KB |

- Accepted inputs: **`prompt` (1–2048 chars) and `steps` (≤ 8) only.** `seed` is rejected (HTTP 400, code 5006); no width/height/aspect.
- Response: JSON `{ result: { image: <base64>, usage: … } }`; the `usage` body field is not yet inspected.
- Cost formula observed: tiles × 4.8 + tiles × steps × 9.6 (1024² = 4 tiles).
- Licence: FLUX.1 [schnell] is Apache-2.0 (commercial use allowed) with an out-of-scope-use list; BFL Usage Policy applies. Publish an acceptable-use policy before public launch.
- Images will be stored as **WebP quality 85** (~165 KB vs ~819 KB JPEG).

## 6. Architecture map

| Area | Location |
|---|---|
| Auth config / instance | `src/lib/auth.config.ts`, `src/lib/auth.ts`, `src/proxy.ts`, `src/features/auth/` |
| Prisma client | `src/lib/prisma.ts` |
| Pricing, quotas, model IDs | `src/features/generations/config.ts` |
| Job lifecycle + accounting orchestration | `src/features/generations/lifecycle.ts` |
| Credit ledger (debit/refund) | `src/features/credits/ledger.ts` |
| Neuron budget (reserve/consume/release) | `src/features/budget/neuron-budget.ts` |
| UTC day helpers | `src/lib/utc.ts` |
| Dashboard queries / UI | `src/features/*/queries.ts`, `src/components/dashboard/`, `src/app/(dashboard)/` |
| Landing page | `src/app/(marketing)/`, `src/components/marketing/` |
| Accounting test suite | `scripts/test-accounting.mts` (`npm run test:accounting`, requires dedicated `TEST_DATABASE_URL`) |
| Image provider (Cloudflare adapter, server-only factory) | `src/features/generations/providers/` |
| JPEG validation → WebP q85 | `src/features/generations/image-processing.ts` |
| Private storage (Supabase adapter, keys, server-only factory) | `src/features/generations/storage/` |
| Asset persistence + ownership-checked signed URLs | `src/features/generations/assets.ts` |
| Adapter test suite (offline, mocked) | `scripts/test-generation-adapters.mts` (`npm run test:adapters`) |
| Generation orchestrator (sync pipeline, DI) | `src/features/generations/generate-image.ts` |
| HTTP handlers (framework-free, DI) + production wiring | `src/features/generations/http.ts`, `src/features/generations/service.ts` |
| Job DTO / user-safe errors / status contract | `src/features/generations/job-view.ts` |
| Pure request validation | `src/features/generations/validation.ts` |
| Trusted origin, capped JSON body, error envelope | `src/lib/api.ts` |
| Centralized environment validation | `src/lib/env.ts` (build-time vs runtime secrets, redaction) |
| Process-local rate limiting | `src/lib/rate-limit.ts` (sliding window, bounded entries, burst throttling) |
| API routes | `src/app/api/generations/image/route.ts` (POST), `src/app/api/generations/[jobId]/route.ts` (GET), `src/app/api/assets/[assetId]/route.ts` (GET → 302), `src/app/api/health/route.ts` (GET, dual liveness & readiness probes) |
| Container & deployment config | `next.config.ts` (`output: "standalone"`, CSP, HSTS, security headers), `Dockerfile` (multi-stage Alpine), `.dockerignore` |
| Disaster recovery: Database | `scripts/backup-db.mts` (`npm run backup:db`), `scripts/restore-db.mts` (`npm run restore:db`) |
| Disaster recovery: Storage | `scripts/backup-storage.mts` (`npm run backup:storage`), `scripts/restore-storage.mts` (`npm run restore:storage`) |
| Disaster recovery: Coordinated Sets | `scripts/backup-set.mts` (`npm run backup:set`), `scripts/restore-set.mts` (`npm run restore:set`) |
| Disaster recovery: Libs & Tests | `scripts/lib/backup-crypto.mts`, `scripts/lib/backup-guard.mts`, `scripts/test-disaster-recovery.mts` (`npm run test:disaster-recovery`, 65 offline tests) |
| Release hardening tests | `scripts/test-release-hardening.mts` (`npm run test:release-hardening`, 14 offline tests) |
| Image generator UI (client) | `src/components/image-generator/` (composer, preview, result actions, gallery, recovery notice, `use-generation.ts`) · `src/app/(dashboard)/ai-image/page.tsx` (server data) |
| Client generation logic (framework-free, DI) | `src/features/generations/client/` — `api.ts` (typed fetch, never throws), `pending-request.ts` (localStorage, key created only on submit), `polling.ts` (pure decisions), `generation-controller.ts` (state machine + recovery), `recovery-scheduler.ts` (Strict-Mode-safe), `gallery.ts`, `download.ts` |
| Stage 6 tests | `npm run test:ui-logic` · `test:ui-flow` · `test:ui-recovery` · `test:ui-gallery` (all offline) · `test:queries` (TEST_DATABASE_URL only) |
| Stage 5 tests | `scripts/test-generation-api.mts` (`npm run test:api`, offline) · `scripts/test-generation-integration.mts` (`npm run test:integration`, TEST_DATABASE_URL only) |

Provider error outcomes drive Stage 5 settlement: `not_run` → `failJobProviderNotRun`; `ran` → `recordProviderSuccess(usage ?? null)` + `failJobAfterProviderSuccess`; `unknown` → `markProviderOutcomeUnknown` (reconcile later). Missing/invalid usage is `null` → charge the reserved amount, never zero.

Lifecycle: `createImageJob` (PENDING) → `markJobStarted` (PROCESSING, commit **before** provider call) → `recordProviderSuccess` → `completeJob` / `completeImageJobWithAsset`. Failures: `failJobProviderNotRun` (release + refund), `failJobAfterProviderSuccess` (keep usage + refund), `markProviderOutcomeUnknown` (no settlement), `reconcileStaleJobs`.

**Implemented components (Stages 4–5)**
- **Cloudflare provider adapter** (`providers/`) — server-only factory, 60 s timeout, `not_run` / `ran` / `unknown` outcome classification, usage from `cf-ai-neurons`.
- **Supabase Storage adapter** (`storage/`) — private bucket, user-scoped keys, no overwrite, 10-minute signed URLs.
- **Synchronous image generation API** — all three routes implemented: `POST /api/generations/image`, `GET /api/generations/[jobId]`, `GET /api/assets/[assetId]`. Route files only delegate to `service.ts` (production wiring) → `http.ts` (framework-free handlers).

**Generation orchestrator** (`generate-image.ts`, `runImageGeneration`) — decides *which* Stage 3 lifecycle function to call; every credit/Neuron change stays inside those functions:
1. Validate input; resolve provider + storage (a configuration error returns 503 before anything is charged).
2. Settle this user's stale jobs (best effort).
3. `createImageJob` — debit + reservation in one transaction. **Replay → return the existing job; never re-runs the provider, debit or reservation.**
4. `markJobStarted` (committed before the provider call; `false` → already settled, provider not called).
5. Provider call — outside any transaction, without the client's abort signal.
6. `recordProviderSuccess(actual ?? reserved)` (`false` → late response; image discarded, nothing uploaded).
7. JPEG → WebP → upload → `completeImageJobWithAsset` (guarded completion + `GeneratedAsset` row in one transaction; on failure or a lost race the upload is deleted).
8. Failures map to exactly one settlement path (`not_run` / `ran` / `unknown` as above). The HTTP layer always re-reads the job, so the client sees the actual persisted state.

**Idempotency** — the client sends one `Idempotency-Key` per submission; replaying it returns the same job (200 if finished, 202 if in progress); a different prompt/quality with the same key → 409 `IDEMPOTENCY_CONFLICT`; concurrent same-key requests serialise on the user-row lock (one job, one debit, one provider call).

**Ownership** — the user ID comes only from the Auth.js session (`/api/*` is not covered by `proxy.ts`, so every handler calls `auth()`). Job and asset lookups are scoped by `{ id, userId }`; "not yours" and "missing" return the same 404. Signed URLs are issued only after an ownership lookup (plus a key-prefix check); storage keys are never returned to the client.

## 7. Constraints & rules

**Budget: ₹0.** No paid services, plan upgrades or paid API calls without explicit approval. Verify free-tier limits from official docs before recommending a service. No real Cloudflare generation calls without approval. A Claude subscription used for development is not API access for the product.

**Security & data**
- Never print or commit `.env`; `.env.example` contains placeholders only.
- Provider tokens and storage service keys are server-only.
- Scope every query by the authenticated user ID; never trust a client-supplied user ID.
- Never reset, drop, recreate or reseed the database. Review migration SQL for destructive operations, then apply with `prisma migrate deploy` (no shadow DB on Supabase; generate SQL with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`).

**Workflow:** inspect → plan → approval → implement agreed scope only → test (report only what actually ran) → report → stop. Never commit or push without explicit approval. Label recommendations as required / strongly recommended / optional / future; don't silently expand scope.

**UI:** premium dark design, responsive, accessible, purposeful Motion animations; don't redesign completed pages without reason.

**Provider error outcomes (approved):** `not_run` only for 400+5006 (Stage 1: 167 ms, no usage header), 401/403, 429 (3036 quota, 3040 capacity) and network errors that prove nothing was sent (ENOTFOUND, EAI_AGAIN, ECONNREFUSED). Everything else — 404 (billing undocumented), other 4xx, all 5xx, timeouts, resets, mid-flight cancellation — is `unknown`. Any response that reports usage is `ran`. Cloudflare does not document whether error responses are billed; verify against the dashboard if one of the `not_run` errors occurs naturally.

**Generation API (Stage 5, approved contract)**
- `POST /api/generations/image` — body `{ prompt, quality: "fast"|"detailed" }`, header `Idempotency-Key` (8–100 `[A-Za-z0-9_-]`), `Content-Type: application/json`, ≤ 16 KB, Origin must match `APP_ORIGIN`/`AUTH_URL` (never Host/X-Forwarded-*). Synchronous.
  201 completed · 202 in progress / outcome unknown (poll GET) · 502 failed + refunded · 200 replay of a finished job · 400 INVALID_INPUT · 401 · 402 INSUFFICIENT_CREDITS · 403 FORBIDDEN_ORIGIN · 409 ACTIVE_JOB_EXISTS / IDEMPOTENCY_CONFLICT · 429 DAILY_LIMIT_REACHED (+resetAt) · 503 CAPACITY_EXHAUSTED (+resetAt) / SERVICE_UNAVAILABLE · 500 INTERNAL_ERROR.
- `GET /api/generations/{jobId}` — owner-scoped status (settles this user's stale jobs first). `GET /api/assets/{assetId}` — ownership check → 302 to a 10-min signed URL (`private, no-store`). Not-owned = missing = 404.
- Refresh recovery: the client keeps the Idempotency-Key per submission; replaying it (or GET by job id) returns the current job and never re-runs provider/debit/reservation.
- Completion: `completeImageJobWithAsset` = the guarded completion of `completeJob` + GeneratedAsset insert in ONE transaction. If reconciliation settled the job first, it throws, the uploaded object is deleted and the settled state is returned. A late provider response (`recordProviderSuccess` false) is discarded without upload.
- The client's abort signal is not passed to the provider (closing the tab must not create an "unknown" outcome).
- Timing invariant (tested): provider timeout 60 s < route `maxDuration` 90 s < PROCESSING reconciliation 5 min.
- **Reconciliation triggers are best effort.** Stale jobs are settled when their owner calls POST/GET, plus a bounded global sweep in Next.js `after()`. `after()` is NOT a durable queue (lost if the process stops); a stuck job of a user who never returns keeps its Neuron reservation until another request triggers the sweep. A durable scheduler (cron) is a future item.
- UsageLog is not written; ProviderBudgetReservation is the source of truth for Neuron usage.

**Image generator UI (Stage 6)**
- Client state machine: idle → submitting → polling → completed / failed, plus error (rejected before a job existed) and stalled. The idempotency key is created only by an explicit submit and reused for every retry / replay / recovery; replays never start a second generation.
- A pending request (key, prompt, quality, startedAt, jobId?) is stored per user in localStorage *before* the POST; it is cleared only for its own job's confirmed terminal state, a definitive rejection, or expiry.
- Page-load recovery (once, Strict-Mode safe): server active job → poll; stored job id → poll; stored request without job id < 10 min → replay with the original key; older → removed with an "expired" notice (prompt restorable). A stored request that is not the server's active job is **held** (kept, explained; Resume / Discard are explicit user actions; new submits are blocked meanwhile).
- Polling: Retry-After (1–30 s), backoff 3/6/12/30 s on failures, paused while the tab is hidden, stops after 7 min → "stalled" with Check again (GET only when a job id is known). "Check now" for uncertain outcomes.
- `completed` requires a confirmed asset. Images are shown only via `/api/assets/{id}`; signed storage URLs and keys never enter client state. Download = blob fetch of `/api/assets/{id}` saved as `yourai-<jobId>.webp`, falling back to opening the image.
- Recent images gallery: the 8 newest completed images (`getRecentImageJobs`, owner-scoped). Selecting one is pure view state (never touches the controller or the stored request).
- Layout: centred single column (max 672 px) below 1280 px; composer + preview side by side from `xl` (1280 px). Gallery 2 / 3 / 4 columns.
- Accessibility: native radio group for quality, labelled prompt with threshold announcements, one polite live region for generation states, `role=alert` for rejections, loading buttons use `aria-disabled` (focus is kept), prompt is read-only (not disabled) while busy, ≥ 44 px targets, reduced-motion respected.

**Stage 6 real E2E test (2026-11-09, one approved Fast generation)**
- Setup: local `next dev` on port 3001 against production DB / Cloudflare / Supabase (`APP_ORIGIN=http://localhost:3001` passed to that process only; `.env` unchanged). User-driven browser test with the dedicated QA account; no automation, no session minting.
- Exactly one `POST /api/generations/image` → 201 (11.5 s end-to-end on the dev server, including Tokyo DB round trips). No polling or replay was needed; no second POST.
- Job `cmw9a961x0000m0j7u24x8qwr`: COMPLETED, FLUX.1 Schnell, Fast (4 steps). Provider latency 1.74 s; job created→started 2.56 s, started→completed 4.48 s.
- Neurons: actual usage from the `cf-ai-neurons` header = 172.80 (17,280 centi), identical to the reservation; reservation CONSUMED and settled once; daily budget consumed 17,280, reserved 0.
- Storage: exactly one object at `users/{userId}/images/{jobId}/{assetId}.webp` in the private bucket — valid WebP, 1024 × 1024, 31,318 bytes (row size matches), `cache-control: max-age=3600`. Asset `6b9df473-6561-4eff-94a6-0247250d815e`.
- Credits: one GENERATION_DEBIT −1 (`job-debit:<job>`), wallet 100 → 99, ledger sum = wallet, no refund. No duplicate job / asset / debit / reservation.
- Image delivery: `/api/assets/{id}` → 302 to a signed URL. Verified in the browser by the user: the image rendered in the preview and appeared in Recent images; Download saved the file with the expected name `yourai-<jobId>.webp` (blob path; the server log shows exactly one further `/api/assets` request and no new-tab fallback); DevTools console had no errors.
- No server errors. Note: Next.js dev warns about `scroll-behavior: smooth` on `<html>` (suggests `data-scroll-behavior="smooth"`); cosmetic, pre-existing.
- **Unverified:** reload during a real in-flight generation (the job completed inside the synchronous request, so no reload window existed).

**Storage:** private Supabase bucket `generated-assets` (verified: private, 5,242,880-byte limit, `image/webp` only), keys `users/{userId}/images/{jobId}/{assetId}.webp`, 10-minute signed URLs issued only after an ownership lookup.

## 8. Known risks / open items

- Dev machine → Supabase (Tokyo) is ~200 ms per round trip; host the app in the DB's region for production.
- Supabase Free projects pause after 1 week of inactivity.
- The Neuron budget cannot see other usage on the same Cloudflare account.
- Stage 1 used 499.2 Neurons outside the app budget (covered by the 500 margin).
- User deletion is blocked while a job has an unsettled (`RESERVED`) reservation — an account-deletion feature must settle first.
- Stage 5: no durable background scheduler — see "Reconciliation triggers are best effort" above.
- Stage 5: Supabase upload has no client-side timeout; a hung upload is safe (guarded completion) but holds the request until the platform's `maxDuration`.
- Stage 5: if the asset DB write fails AND the cleanup delete fails, the object is orphaned (logged with its key for manual removal).
- Stage 5: `APP_ORIGIN` must be set in production (and for tunnels/non-localhost dev), otherwise every POST is rejected with 403.
- Stage 6: verified with one real Fast generation (see "Stage 6 real E2E test"). Still unverified with a real job: a browser reload during an in-flight generation (recovery is covered by offline tests and fixture browser tests only). The real download path (cross-origin blob from the signed URL) works.
- Stage 6: image egress. Every `/api/assets/{id}` hit signs a new URL, so browsers cannot cache images across visits. Each `/ai-image` visit loads up to 8 full-size WebP images (6 on a phone before scrolling). Fixture estimate ~165 KB each (≈ 1.3 MB/visit, ≈ 3,800 visits/month on the 5 GB Supabase Free egress); the first real image was 31 KB, so real sizes vary with image content. Within a page, the preview reuses the thumbnail's already-loaded image (0 extra requests). Small thumbnail renditions or cacheable URLs would need a backend change (future).
- Stage 6: one pending-request slot per user and browser; a held request blocks new submits until resumed or discarded. A stored request without a job id is matched to the server's active job by prompt + quality.
- Stage 6: the 7-minute polling limit restarts on each page load (server reconciliation still settles stuck jobs at 5 minutes).
- Test database: dedicated Supabase project (`TEST_DATABASE_URL`, verified separate from production by project ref). Migrations on it require explicit approval.

## 9. Deployment requirements

- **Build command:** run `npx prisma generate` before `next build` (e.g. `npx prisma generate && npm run build`). The generated client (`src/generated/`) is git-ignored and `npm run build` does not generate it.
- **Standalone output:** `next.config.ts` sets `output: "standalone"`. Production builds emit `.next/standalone` containing `server.js` and traced dependencies. In containers, copy `public/` to `./public` and `.next/static` to `./.next/static`. Run via `node server.js` with `PORT=3000` and `HOSTNAME="0.0.0.0"`.
- **Health check:** `GET /api/health` returns HTTP 200 `{ status: "ok", timestamp: ... }` with `Cache-Control: no-store` (process-level liveness; never touches the database or external APIs). Readiness probe `GET /api/health?probe=readiness` executes an active database check (`SELECT 1` with 3000ms timeout) via dynamic Prisma import, returning HTTP 200 `{ status: "ok", checks: { process: "alive", database: "healthy" } }` or HTTP 503 `{ status: "degraded", checks: { process: "alive", database: "unhealthy" } }`.
- **Runtime:** Node.js (required for `sharp` and the Postgres driver; the API routes declare `runtime = "nodejs"`). Install dependencies on the host's own platform so the correct `sharp` binary is used. Multi-stage `Dockerfile` uses `node:20-alpine` with `libc6-compat` and `openssl`.
- **Request duration:** the host must allow requests of **at least 90 seconds** (`maxDuration = 90` on the generation route; 60 s provider timeout < 90 s < 5 min reconciliation).
- **`APP_ORIGIN`:** set to the deployed public origin (comma-separated if several). If unset in production, every generation POST is rejected with 403.
- **Never configure `TEST_DATABASE_URL` in production.**
- **Required environment variables:** `DATABASE_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST` (or `AUTH_URL`), `APP_ORIGIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`. All server-only; none may be exposed as `NEXT_PUBLIC_*`.
- **Build-time network:** `next/font/google` downloads fonts during `next build`, so the build environment needs internet access. The build itself does not access the database, Cloudflare or Supabase (verified).
- **Region:** host close to the database (Supabase, Tokyo) to avoid ~200 ms per query round trip.
- **Supabase Free tier:** 1 GB storage, limited egress, project pauses after 1 week of inactivity.

## 10. Disaster Recovery & Operational Runbooks

Offline administrative disaster recovery tooling designed for SaaS durability, data sovereignty, and migration readiness.

### Cryptographic Specification
- **Algorithm:** Authenticated AES-256-GCM (`aes-256-gcm`).
- **Two-Tier Key Hierarchy:**
  - **Master Key (Tier 1):** PBKDF2-HMAC-SHA256 (`pbkdf2Sync` / `deriveMasterKeyAsync`), 600,000 iterations (OWASP standard), 16-byte random salt, 32-byte key. Derived once per backup set.
  - **Sub-Keys (Tier 2):** Fast HKDF-SHA256 (`hkdfSync`), derived per object context (`storage:${storageKey}`) in < 1 microsecond without event-loop blocking.
- **Envelope Formats:**
  - **Version 3 (`YOURAI_ENC_V3`, current chunk-framed streaming):**
    - Header (50 bytes): Magic ASCII Header (`YOURAI_ENC_V3`, 13B), Cipher suite ID (`0x01` = AES-256-GCM, 1B), KDF iterations (uint32BE, 4B), Cryptographic salt (16B), Base IV / Nonce (12B), Chunk size (uint32BE, 4B, default 65536 = 64 KB).
    - Chunk Frames: `[Chunk Index (uint32BE, 4B)][Payload Type (0x01 mid, 0x02 final, 1B)][Ciphertext Len (uint32BE, 4B)][Ciphertext][GCM Tag (16B)]`.
    - Per-chunk unique nonce derived deterministically from Base IV + chunk index.
    - Authenticated Additional Data (AAD) binds magic, salt, iterations, chunk index, and payload type.
    - **Zero unauthenticated plaintext:** Decipher verifies the GCM tag **before** releasing each chunk's plaintext.
  - **Version 2 (`YOURAI_ENC_V2`, backward-compatible single-tag envelope):**
    - Bytes 0–12: Magic ASCII Header (`YOURAI_ENC_V2`, 13 bytes)
    - Byte 13: Cipher suite ID (`0x01` = AES-256-GCM)
    - Bytes 14–17: KDF iterations (32-bit big-endian uint32, e.g. 600,000)
    - Bytes 18–33: Cryptographic salt (16 bytes)
    - Bytes 34–45: AES-GCM IV / Nonce (12 bytes)
    - Bytes 46 to (EOF - 16): Ciphertext
    - Final 16 bytes: GCM Authentication Tag
  - **Version 1 (`YOURAI_ENC_V1`, legacy backward-compatible):**
    - Bytes 0–12: Magic ASCII Header (`YOURAI_ENC_V1`)
    - Bytes 13–28: Salt (16 bytes)
    - Bytes 29–40: IV (12 bytes)
    - Bytes 41 to (EOF - 16): Ciphertext
    - Final 16 bytes: GCM Authentication Tag (100,000 fixed iterations)
- **Manifest Authentication:** Manifest files (`manifest.json`, `backup-set.json`) are cryptographically authenticated via companion HMAC-SHA256 signatures (`.sig`).
- **Passphrase Policy:** Minimum 16 characters enforced for `BACKUP_ENCRYPTION_KEY`.
- **Security Invariant:** Plaintext database dumps and sensitive assets never touch unencrypted disk. `backups/`, `*.dump`, `*.dump.enc`, `*.sql`, `*.enc`, `*.meta.json`, `*.manifest.json`, and `.backup.lock` are git-ignored.

### Coordinated Backup Sets (`npm run backup:set` / `npm run restore:set`)
Provides atomic synchronization between the PostgreSQL database and private Supabase Storage:
1. **Database-First Capture ($T_1$):** Captures the database dump using `pg_dump -Fc` through streaming AES-256-GCM.
2. **Exact Reference Extraction ($T_2$):** Queries the snapshot to extract all active `GeneratedAsset.storageKey` references.
3. **Targeted Storage Backup ($T_3$):** Downloads and encrypts only those exact referenced objects using two-tier HKDF sub-keys and atomic temporary writes (`.tmp` -> `.enc`).
4. **Cross-Validation Verification ($T_4$):** Cross-references every database asset against disk checksums and encryption headers. If any referenced object is missing, the set is marked `FAILED_INCONSISTENT` and rejected.
5. **Finalization:** Emits an immutable, signed manifest `backup-set.json` with status `VERIFIED`.
- **Coordinated Runbook Commands:**
  ```bash
  # Create a coordinated verified backup set:
  BACKUP_ENCRYPTION_KEY="your-strong-passphrase" npm run backup:set

  # Pre-flight verify complete backup set (zero modifications):
  BACKUP_ENCRYPTION_KEY="your-strong-passphrase" npm run restore:set -- --set backups/sets/<backupSetId> --verify-only

  # Restore coordinated set (restores Storage first, then Database second):
  BACKUP_ENCRYPTION_KEY="your-strong-passphrase" npm run restore:set -- --set backups/sets/<backupSetId> --target-db="postgres://..." --target-bucket="restored-assets"
  ```

### Database Backup & Two-Pass Streaming Restore Runbook (`pg_dump` / `pg_restore`)
- **Requirements:** PostgreSQL client tools (`pg_dump`, `pg_restore`) available in local PATH.
- **Backup command:**
  ```bash
  BACKUP_ENCRYPTION_KEY="your-strong-passphrase" npm run backup:db
  # Or targeting a specific database:
  DATABASE_URL="postgres://..." BACKUP_ENCRYPTION_KEY="..." npm run backup:db
  ```
  - **Zero-disk plaintext:** Streams `pg_dump -Fc` directly to stdout, pipes through Node.js crypto transform `createEncryptionTransform()`, and writes only the encrypted payload `.dump.enc` to `backups/db/`.
  - **Credentials:** Uses secure temporary `PGPASSFILE` (mode 0600 on POSIX) with memory/disk shredding and cleanup.
- **Restore command (Two-Pass Streaming with Protected Input Snapshot & V3 Chunk Verification):**
  ```bash
  BACKUP_ENCRYPTION_KEY="your-strong-passphrase" npm run restore:db -- --file backups/db/backup-YYYY-MM-DDTHH-mm-ss.dump.enc --target-url="postgres://..."
  ```
  - **Version 3 Chunk-Framed Authenticated Encryption (DR-01):** Archives use the `YOURAI_ENC_V3` format where each chunk (default 64 KB, bounds 1 KB to 16 MB) carries an independent AES-256-GCM authentication tag, deterministic nonce derived from Base IV and chunk index, and AAD binding magic, salt, iterations, chunk size, chunk index, and payload type. Frame lengths and payload types are validated immediately before buffering to fail closed against oversized frames without excessive memory allocation. PBKDF2 iterations are bounded between 100,000 and 5,000,000. Plaintext is released to downstream consumers **only after** each chunk's tag passes verification, guaranteeing zero unauthenticated plaintext can reach `pg_restore`.
  - **Protected Input Snapshot (DR-01A):** Restores from a private, exclusively created temporary copy (`constants.COPYFILE_EXCL`) in an isolated directory. Prevents both path re-resolution races and in-place source mutation. Opens a single pinned descriptor across both passes.
  - **Signal & Child Lifecycle Cleanup:** On `SIGINT`/`SIGTERM` or exceptions, closes file descriptors, terminates active `pg_restore` processes (`SIGTERM`), unlinks private snapshot directories, and re-emits exit codes (130/143).
  - **Pass 1 (Pre-Flight Verification):** Streams the encrypted snapshot through `createDecryptionTransform` into a dry sink. Validates 100% of the archive and GCM auth tag in constant RAM ($O(1)$) **before** `pg_restore` is spawned. Corrupted or truncated archives fail immediately without touching the target database.
  - **Pass 2 (Authenticated Streaming Restore):** Only after Pass 1 confirms authenticity, streams verified plaintext directly into `pg_restore.stdin` with `--single-transaction` for atomic rollback on connection drops.
  - **Exit Code 1 Analysis (DR-01B):** Fails closed by default on exit code 1. Treats nonzero exit as fatal unless stderr consists exclusively of harmless drop notices (`pg_restore: notice: table "..." does not exist, skipping drop`).
  - **Safety Guard:** Fails closed if the target matches production `DATABASE_URL` (canonical URL normalization equates loopback aliases, default 5432, and stripped query parameters) unless `--confirm-production-overwrite` is passed.

### Supabase Storage Backup & Restore Runbook
- **Backup command:**
  ```bash
  BACKUP_ENCRYPTION_KEY="your-strong-passphrase" npm run backup:storage
  ```
  - Process mutex lockfile (`.backup.lock`) prevents concurrent runs.
  - Downloads objects to `.tmp` files and executes atomic verified renames.
  - **Full Streaming Verification (DR-03A):** Incremental skip cryptographically validates the entire AES-GCM tag, plaintext SHA-256, and byte size in constant $O(1)$ RAM using the object subkey before skipping. Corrupted or tampered files are automatically re-downloaded.
  - **Deletion Reconciliation (DR-03B):** Live deletions are tombstoned (`isDeleted = true`) in the current snapshot manifest without mutating historical recovery sets.
  - **Domain-Separated HMAC Signatures (DR-04A):** Signs `manifest.json` using a dedicated HKDF subkey (`yourai:manifest:signature:v1`) into `manifest.json.sig`.
- **Restore command (Per-Object Safe Reconciliation):**
  ```bash
  BACKUP_ENCRYPTION_KEY="your-strong-passphrase" npm run restore:storage -- --target-bucket="restored-assets"
  ```
  - **Fail-Closed Authentication (DR-04B):** Fails closed if `.sig` signature is missing or tampered, unless `--allow-unsigned-manifest` is explicitly provided.
  - **Per-Object Safe Reconciliation (DR-03):** Checks each object in target bucket:
    1. If missing: uploads with `{ upsert: false }`.
    2. If present and plaintext SHA-256 matches: skips upload (`skippedCount++`), enabling safe retries after partial failure without destructive writes.
    3. If present and content differs: fails closed with explicit conflict error unless `--force-destructive-overwrite` is provided.
  - Pre-flight verifies all encrypted objects before network upload. Skips tombstoned `isDeleted` entries.
  - Requires `--confirm-production-overwrite` if targeting the production bucket.

### Coordinated Backup-Set & Restore Runbook
- **Dump-Derived Asset Extraction (DR-02):** In `scripts/backup-set.mts`, `extractReferencedStorageKeysFromDump()` streams `pg_restore --data-only --table=GeneratedAsset` line-by-line using `node:readline` (preventing multi-gigabyte dump stdout buffering), while the extracted key inventory consumes memory proportional to the number and length of storage keys ($O(N)$ in key count).
- **Character-by-Character COPY Decoder:** `decodePostgresCopyField()` properly decodes PostgreSQL COPY text format, distinguishing literal `\\t` (a backslash and letter 't') from `\t` (tab character), handling `\N` (NULL), newlines, carriage returns, hex (`\xhh`), and octal (`\ooo`) escapes. Fails closed if a COPY block begins but ends before the `\.` end-of-data marker.
- **Coordinated Restore Failure Modes & Safe Recovery:**
  - *Storage fails during Step 1:* Database remains untouched; existing database is unaffected. Safe retry via `npm run restore:set` resumes without re-uploading already reconciled objects.
  - *Storage succeeds (Step 1), Database fails (Step 2):* Database rolls back atomically (`--single-transaction`). Storage objects are dormant (protected by database ownership lookups). Fix database issue and rerun `restore:set` or `restore:db`. Identical storage objects are skipped automatically during rerun.

### Consistency, Skew & Concurrency
- **Foreign Reference Structure:** The database table `GeneratedAsset` holds `storageKey` strings pointing to private objects in Supabase Storage.
- **Safe Recovery Order:** Always restore **Storage objects first**, then restore **Database second**.
- **Point-in-Time Skew Scenarios:**
  - *Storage newer than DB:* Storage contains unreferenced image files. Completely harmless; assets cannot be queried or leaked because database ownership lookup gates all access.
  - *DB newer than Storage:* Database contains asset rows referencing storage keys that do not exist (causes 404 on viewing/downloading). Coordinated backup sets eliminate this skew by capturing DB first and extracting exact keys.
- **Concurrent Generation & Deletion:**
  - In YourAI, images are generated immutably.
  - Soft deletion in database ensures storage objects remain available during active backup windows.
  - True snapshot isolation across two independent systems (PostgreSQL and Supabase Storage) requires freezing uploads or a retention period before hard deletion.

### Operational Drill Status & Isolated Restore Disclosure
- **Tooling Verification:** The DR tooling, chunk-framed cryptographic engine (`YOURAI_ENC_V3`), streaming transforms, line-by-line COPY parser, and safety guards are exhaustively verified across 65 unit and integration tests (`scripts/test-disaster-recovery.mts`).
- **Live Restore Drill Pending:** An end-to-end restore into an actual isolated live database project has not yet been executed in production. A full-scale isolated environment restore drill is scheduled as a pre-launch operational verification task before public launch.

## 11. Security Hardening, Rate Limiting & Environment Validation (Stage 7 Batch 3A)

### Security Headers & Content Security Policy (CSP)
- **Configuration:** `next.config.ts` exports `getSecurityHeaders(isDev)` and applies them to all routes (`source: "/(.*)"`).
- **CSP Directives:**
  - `default-src 'self'`
  - `script-src 'self' 'unsafe-inline'` in production (explicitly excludes `'unsafe-eval'`; `'unsafe-eval'` is permitted exclusively in development for Fast Refresh / DevTools).
  - **Inline Script Trade-Off:** Next.js 16 App Router requires inline hydration scripts for React 19. Standalone static builds make dynamic per-request nonce injection impractical without forcing all pages dynamic. Trade-off: `'unsafe-inline'` is retained for scripts and styles; XSS protection relies on React JSX automatic escaping, strict Zod request schema validation, and complete absence of `dangerouslySetInnerHTML`.
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
  - `font-src 'self' https://fonts.gstatic.com data:`
  - `img-src 'self' data: blob: https://*.supabase.co https://*.cloudflare.com`
  - `connect-src 'self' https://*.supabase.co https://api.cloudflare.com`
  - `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`
- **HSTS Policy:** `Strict-Transport-Security: max-age=31536000` is applied **only** in production (`NODE_ENV === "production"`), strictly **without** `includeSubDomains` to prevent impacting sibling domains or local/tunnel environments.
- **Additional Standard Headers:**
  - `X-Frame-Options: DENY` (clickjacking defense)
  - `X-Content-Type-Options: nosniff` (MIME sniffing defense)
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()`

### Centralized Environment Validation (`src/lib/env.ts`)
- **Build vs Runtime Separation:** Centralized Zod schemas cleanly separate static build-time requirements (`buildEnvSchema`: `NODE_ENV`, `PORT`, `HOSTNAME`) from server-only runtime secrets (`serverRuntimeEnvSchema`: `DATABASE_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST`, `APP_ORIGIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`).
- **Static Build Compatibility:** `next build` static page generation completes successfully without live production secrets or database access.
- **Lazy Runtime Boundary:** Protected services validate environment variables lazily via `validateRuntimeEnv()` and `assertRuntimeEnv()`.
- **Zero Secret Leakage:** Validation error messages and sanitized diagnostic status (`getSanitizedEnvStatus()`) strictly redact all secret values and connection strings.

### Process-Local Best-Effort Rate Limiting & Client IP Trust Model (`src/lib/rate-limit.ts`)
- **Algorithm:** In-memory sliding window counter (`InMemoryRateLimiter`).
- **Memory Bounds & Cleanup:** Maximum 10,000 tracked keys with automatic periodic cleanup of expired windows (15 min interval).
- **Client IP Trust Boundaries & Anti-Spoofing:**
  - `trustModel === "none"` (default): Without an established, network-level trusted reverse proxy boundary, all client-supplied forwarding headers (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `CF-Ray`) are strictly untrusted and ignored. The derived client identity falls back safely to `"127.0.0.1"`. Attackers cannot rotate or forge headers to evade IP-based rate limiting.
  - `trustModel === "cloudflare"`: May **only** be enabled (`TRUST_PROXY=cloudflare`) when the deployment network infrastructure guarantees that the origin server cannot be reached directly by untrusted clients (e.g. via Cloudflare Tunnel / `cloudflared`, Authenticated Origin Pulls / mTLS, or strict firewall ingress allowing only Cloudflare IP ranges).
  - **CF-Ray Threat Model Correction:** `CF-Ray` is a non-cryptographic diagnostic request identifier, NOT a cryptographic signature or proof of origin authenticity. Any direct HTTP client connecting to an unprotected origin can fabricate both `CF-Connecting-IP` and `CF-Ray`. Header presence alone is never sufficient proof of a trusted proxy.
  - **Deployment Prerequisite & Limitation:** Because no production hosting or network ingress boundary has been established yet, `TRUST_PROXY=cloudflare` **must remain disabled**. The safe fallback (`"127.0.0.1"`) is used.
  - **Documented Deployment Limitation:** In direct/untrusted deployments, all clients sharing the fallback IP share the IP-level burst limits (5 registrations/15m, 10 logins/15m, 10 generation requests/min).
  - **Authoritative Compensating Protections:**
    - Login enforces independent, unshared account-level throttling (`login:account:${normalizedEmail}`, 5 attempts / 15m), which is immune to IP sharing.
    - PostgreSQL ACID transactions remain the sole authoritative enforcement boundary for generation daily limits (10/day), concurrency (1 active job), and credit wallet balances. Process-local rate limiting is strictly best-effort burst abuse mitigation. Zero Redis or paid infrastructure is introduced.
- **Configured Burst Limits:**
  - Registration: 5 requests / 15 minutes per IP (`REGISTER_IP`).
  - Login: 10 requests / 15 minutes per IP (`LOGIN_IP`), plus 5 requests / 15 minutes per normalized email address (`LOGIN_ACCOUNT`).
  - Generation API: 10 requests / 1 minute per IP (`GENERATION_BURST`), returning HTTP 429 `RATE_LIMITED` with `Retry-After` header.

### Dual Health Check Probes (`src/app/api/health/route.ts`)
- **Liveness Probe (`GET /api/health`):** Instant process-level check returning HTTP 200 `{ status: "ok", timestamp: ... }` with `Cache-Control: no-store`. Never touches the database or external APIs.
- **Readiness Probe (`GET /api/health?probe=readiness`):** Active database health probe using dynamic lazy Prisma import, executing `SELECT 1` with a 3000ms timeout. Returns HTTP 200 `{ status: "ok", checks: { process: "alive", database: "healthy" } }` or HTTP 503 `{ status: "degraded", checks: { process: "alive", database: "unhealthy" } }`.

## Stage 7, Batch 3, Sub-Batch 3B: Grounded User-Facing Legal Policies & UX Discoverability (ACCEPTED & VERIFIED)

### 1. Grounded Legal Policy Pages
All policies strictly reflect actual architecture, verified pricing, actual data models, and truthful enforcement capabilities:
- **Terms of Service (`/terms`):**
  - Explains current text-to-image service based on FLUX.1 Schnell on Cloudflare Workers AI.
  - Initial registration grant: 100 promotional credits (`INITIAL_CREDITS`).
  - Pricing: Fast = 1 credit, Detailed = 2 credits (`IMAGE_QUALITIES`).
  - Authoritative daily quota: 10 counted generation jobs per UTC day (`DAILY_USER_IMAGE_LIMIT`).
  - Concurrency limit: Maximum 1 active generation job per account.
  - **Credit Accounting & Failure Restoration:** Clearly distinguishes non-redeemable/non-cash promotional units from automatic wallet credit restoration. Documents the exact implemented failure conditions that restore credits: (1) upstream provider rejection / pre-flight failure, (2) downstream pipeline processing failure (decode, WebP, upload, asset DB insert), and (3) stale-job timeout reconciliation. Discloses that completed generations are final and non-refundable for aesthetic dissatisfaction.
  - Disclaims output uniqueness, accuracy, safety, and commercial fitness.
  - **Governing Law & Dispute Resolution (Draft Provisions):** Designates India as the target legal system in draft terms; explicitly flags territorial venue, judicial forum, and dispute resolution mechanisms as provisional placeholders subject to formal qualified legal counsel review once the operating corporate entity and registered seat are established.
  - Discloses pre-release status; operator contact reserved for official publication prior to launch.
- **Privacy Policy (`/privacy`):**
  - Documents actual account data: email, display name, bcryptjs password hashes (never stored or logged in plaintext).
  - Documents authentication: Auth.js v5 JWT session cookies (`authjs.session-token`) with `HttpOnly`, `SameSite=Lax`, and `Secure` flags.
  - Documents generation records: prompts, quality parameters, credit ledger transactions, and generated assets.
  - Subprocessors: Supabase (PostgreSQL & object storage in Tokyo, Japan / AWS ap-northeast-1) and Cloudflare Workers AI (neural model inference).
  - Private asset storage: Direct unauthenticated bucket access disabled; assets accessible only via time-limited 10-minute (600s) HMAC-signed URLs issued after session ownership verification.
  - Client storage: `localStorage` used solely for client-side crash/refresh recovery of pending generation requests. Zero third-party tracking cookies or marketing beacons.
  - Data Retention & Deletion: Explicitly discloses that automated self-service account deletion is currently unsupported in software.
- **Acceptable Use Policy (`/acceptable-use`):**
  - Zero tolerance for Child Sexual Abuse Material (CSAM/CSAE) with immediate permanent account termination. Carefully qualified language reserving the right to refer violations to competent authorities where legally required or appropriate, subject to legal review. Discloses that no automated direct reporting API integration is currently operational.
  - Unconditional prohibition of Non-Consensual Intimate Imagery (NCII), unauthorized deepfakes of real individuals, hate speech, harassment, violence, terrorism, fraud, phishing, and malware.
  - Prohibits system abuse: bypassing rate limits, exploiting concurrency or daily quotas, payload abuse beyond the 2048-character prompt maximum (`PROMPT_MAX_LENGTH`).
  - **Truthful Enforcement Transparency (Zero False Claims):** Truthfully discloses that the current inference pipeline does NOT incorporate automated pre-inference safety filters or computer-vision moderation classifiers, and that the software does NOT currently contain internal administrative moderation dashboards, abuse queues, or automated suspension tooling. Technical controls implemented in software are strictly: (1) server-side schema validation (character limits, UTF-8, malformed JSON rejection), (2) process-local burst rate limiters, and (3) PostgreSQL transactional quotas. The policy contractually reserves YourAI's legal right to restrict, suspend, or terminate accounts, while explicitly noting that operational abuse-intake and administrative review workflows are pre-launch operational items.

### 2. UX Discoverability & Navigation Touchpoints
- **Legal Navigation Routes (`src/lib/constants.ts`):** Defined `LEGAL_ROUTES` (`terms`, `privacy`, `acceptableUse`) and linked into `ROUTES`.
- **Site Footer (`src/components/layout/footer.tsx`):** Added a dedicated "Legal" column with links to all 3 policies and responsive grid adjustment (`md:grid-cols-[1.3fr_repeat(4,1fr)]`), plus bottom-bar quick links.
- **Registration Form (`src/features/auth/components/register-form.tsx`):** Added explicit agreement disclaimer notice with direct links to Terms of Service, Privacy Policy, and Acceptable Use Policy above the submit button.
- **Image Generator Composer (`src/components/image-generator/prompt-editor.tsx` & `image-generator.tsx`):** Added clear compliance reminders linking to `/acceptable-use` below the prompt editor and below the Generate button.
- **Settings Dashboard (`src/app/(dashboard)/settings/page.tsx`):** Added "Data, Privacy & Legal" panel with policy links, private asset storage details (Tokyo region, 10-minute signed URLs), and explicit disclosure regarding unsupported self-service account deletion.

### 3. Explicit Disclosures & Pre-Launch Blockers Recorded
- **Pre-Public-Launch Blocker — Missing Verified Operator Contact:** The application currently has no verified support, legal, or grievance officer email address. Fictitious email addresses were strictly forbidden and omitted. Formal publication of official operator support and legal notice channels is recorded as an **explicit blocking requirement prior to public commercial launch**.
- **Software Limitation — Unsupported Self-Service Account Deletion:** Due to active budget reservations and relational ledger foreign keys, automated cascading deletion is currently unsupported in software. All legal pages and user settings accurately disclose this constraint without false self-service claims. Manual deletion workflows must be designed and implemented before public launch.
- **Outstanding Legal Review — Governing Law & Dispute Resolution Clauses:** Terms currently contain preliminary draft clauses designating the laws of India. Forum, jurisdiction, and dispute resolution procedures are explicitly provisional and flagged for qualified legal counsel review once the operating legal entity is incorporated.
- **Operational Status — Policy Rights vs Implemented Capabilities:** Policies strictly separate contractual rights from software capabilities. No automated law enforcement reporting API (e.g. NCMEC API), automated pre-inference prompt moderation filter, administrative moderation dashboard, abuse-intake queue, or account suspension controls are implemented in software (the `User` schema has no status or suspension flags). Enforcement at runtime is limited to server input validation, process-local rate limits, and PostgreSQL quotas; abuse-intake workflows and administrative review tooling are pre-launch operational items.

### 4. Verification Matrix (760 total tests across 12 suites)
- `test:disaster-recovery` (65/65 passed)
- `test:adapters` (119/119 passed)
- `test:api` (161/161 passed)
- `test:ui-logic` (97/97 passed)
- `test:ui-flow` (67/67 passed)
- `test:ui-recovery` (59/59 passed)
- `test:ui-gallery` (39/39 passed)
- `test:release-hardening` (16/16 passed)
- `test:legal` (15/15 passed)
- `test:accounting` (65/65 passed, dedicated test DB)
- `test:integration` (28/28 passed, dedicated test DB)
- `test:queries` (29/29 passed, dedicated test DB)
- **Total Tests: 760 passed, 0 failed across all 12 suites**
- `npx prisma generate` (Prisma Client 7.10.1 generated successfully)
- `npx tsc --noEmit` (0 errors)
- `next build` (16/16 pages statically prerendered and optimized successfully)

## 12. Release Readiness Checklist & Final Review (Stage 7 Closure)

### Category A: Implemented & Verified
- [x] **Production Standalone Build:** `next.config.ts` configured with `output: "standalone"`, generating `.next/standalone` and `.next/static`.
- [x] **Container Deployment Assets:** Multi-stage Alpine `Dockerfile` and comprehensive `.dockerignore` excluding `.env`, `.git`, `backups`, and dumps.
- [x] **Environment Validation:** Centralized Zod validation (`src/lib/env.ts`) separating build-time configuration from runtime secrets; zero secrets logged or leaked in error messages.
- [x] **Security Headers & CSP:** Production CSP with strict directives, Google Fonts & Supabase whitelisting, script execution without `'unsafe-eval'`, and 1-year HSTS without `includeSubDomains`.
- [x] **Process-Local Rate Limiting:** Bounded in-memory sliding window limiter (`src/lib/rate-limit.ts`) protecting registration, login, and generation endpoints against casual burst abuse; maximum 10,000 tracked keys with automatic expiration cleanup.
- [x] **Safe Client IP Strategy:** Strict fallback to `"127.0.0.1"` under default `trustModel: "none"`; client-supplied forwarding headers (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `CF-Ray`) rejected without an established network ingress boundary. CF-Ray documented as non-cryptographic.
- [x] **Authoritative Accounting & Quotas:** PostgreSQL ACID transactions enforce generation allowances (10/day), concurrency (1 active job), and credit balances. Process-local rate limiting is strictly secondary burst protection.
- [x] **Dual Health Check Probes:** `/api/health` process liveness probe (never touches external services) and `/api/health?probe=readiness` active database probe (`SELECT 1` with 3-second timeout).
- [x] **Hardened Disaster Recovery Tooling:** Version 3 chunk-framed authenticated encryption (`YOURAI_ENC_V3`), PBKDF2 (600k iterations) / HKDF key hierarchy, two-pass streaming DB restore with pre-flight verification, per-object storage reconciliation, dump-derived storage key extraction ($O(N)$ memory), signed HMAC manifests, and accidental overwrite guards.
- [x] **Grounded Legal Policies:** `/terms`, `/privacy`, and `/acceptable-use` accurately reflect actual image generation pricing (1 credit Fast / 2 credits Detailed), 100 promotional credits, 10 daily jobs, Tokyo Supabase Storage, 10-minute signed URLs, and 3 failure credit restoration conditions.
- [x] **Legal UX Touchpoints:** Responsive Footer navigation, Registration agreement disclaimer, Composer/PromptEditor compliance notices, and Settings "Data, Privacy & Legal" panel.
- [x] **Negative Invariants Verified:** No fabricated emails, no false automated moderation claims, no false self-service account deletion claims, and no unbuilt operational moderation queues.
- [x] **Exhaustive Test Suite:** 760 passing tests across 12 suites, clean TypeScript check, and successful Next.js production build.

### Category B: Implemented but Not Fully Runtime-Verified
- [ ] **Docker Container Live Runtime:** Dockerfile and `.dockerignore` are syntactically and architecturally complete. Live container execution and networking could not be runtime-verified because Docker daemon is not available in the current development environment.
- [ ] **End-to-End Isolated Database Restore Exercise:** Disaster recovery scripts, cryptographic streaming transforms, and restore safety guards are fully verified via unit and integration tests (65/65 passing). However, an end-to-end restore into an actual isolated live PostgreSQL instance has not yet been executed.

### Category C: Pre-Launch Operational & Legal Blockers (Must resolve before public launch)
1. **Missing Verified Operator Contact Channels:** The application currently contains no verified support, legal, or grievance officer email address. Fictitious email addresses were strictly forbidden and omitted. Formal publication of official operator support and legal notice channels is mandatory before public commercial launch.
2. **Unsupported Self-Service Account Deletion:** Due to active budget reservations and relational ledger foreign keys, automated cascading account deletion is currently unsupported in software. A safe manual operator runbook or software deletion workflow must be implemented before opening registration to the general public.
3. **Unbuilt Abuse-Intake & Administrative Moderation Tooling:** Zero administrative review tools, abuse intake endpoints, or account suspension flags exist in the current schema/codebase (User schema has no status or suspension flags). Administrative moderation dashboards and abuse queues must be developed before launch.
4. **India Governing Law & Dispute Resolution Draft Status:** Preliminary draft terms designate India as the governing jurisdiction. Territorial venue, judicial forum, and dispute resolution mechanisms are provisional and require review and formalization by qualified legal counsel once the operating corporate entity and registered seat are finalized.
5. **Production Deployment & Network Ingress Boundary:** The application has not yet been hosted or deployed to production infrastructure. The trusted proxy boundary (`TRUST_PROXY=cloudflare`) cannot be enabled until network ingress (e.g. Cloudflare Tunnel or Authenticated Origin Pulls) is configured to block direct client access to the origin server.
6. **Multi-Instance Abuse Prevention:** Process-local rate limiting does not synchronize across horizontal server replicas or serverless instances. Multi-instance rate limiting (e.g., Redis or Cloudflare WAF rate limiting) must be evaluated if scaling horizontally.
