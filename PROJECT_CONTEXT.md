# YourAI — Project Context

> Source of truth for product direction, approved decisions and current progress.
> Read this before starting any work. Update the **Status** section when a stage completes.
> Contains no secrets — never add real keys, tokens or connection strings here.

## 1. Product

**YourAI** is an AI creative SaaS, starting in India and expanding globally later. Three core tools:

1. **AI Image Generator** — text → image, quality options, history, credits. *(completed in Stage 7)*
2. **AI Video Generator** — text → video, 720p 5s, aspect ratios (16:9, 9:16, 1:1), Wan 2.1 via Fal.ai / Mock adapter, credits, history. *(building now — Stage 8)*
3. **AI Video Clipper** — future milestone (upload → process → export short clips).

Then: monetisation (credit purchases, subscriptions, payments). Monetisation comes **after** the core product works reliably.

**Build order is strict:** finish the image generator end to end before starting video, clipper or payments.

## 2. Status (update as stages complete)

AI Image & Video Generator roadmap:

| # | Stage | Status |
|---|---|---|
| 1 | Provider feasibility (Cloudflare FLUX.1 Schnell) | ✅ Done |
| 2 | Prisma schema + safe migrations | ✅ Done — commit `43c68cf` |
| 3 | Credit ledger, Neuron budget, job lifecycle (65 tests) | ✅ Done — commit `6a2bd3b` |
| 4 | Cloudflare provider adapter + Supabase Storage adapter (119 mocked tests) | ✅ Done — commit `218239a` |
| 5 | Generation APIs, job processing, recovery | ✅ Implementation complete — offline API tests 161/161, adapter tests 119/119, DB integration tests 28/28, accounting tests 65/65 (dedicated test DB; all test records cleaned up), TypeScript check passed, `next build` passed. Commit `68d7bc7` (pushed). |
| 6 | `/ai-image` UI | ✅ Implemented (B1–B6) and **real-generation-tested** (one Fast E2E generation on production, 2026-11-09 — see below). Reload-during-processing recovery **unverified** with a real job. Commit `23cad50` (pushed). |
| 7 | Final testing + release readiness | ✅ Done — Batch 1 (Next.js standalone output, Dockerfile, .dockerignore, .env.example audit, /api/health probes) complete. Batch 2 (Hardened Disaster Recovery & Operational Tooling: YOURAI_ENC_V3 chunk-framed streaming authenticated encryption, PBKDF2/HKDF key hierarchy, two-pass streaming DB restore, per-object safe storage reconciliation, coordinated backup sets, 65 DR tests) complete. Batch 3 (Release Hardening, Legal Policies & Final Regression): Sub-Batch 3A (HTTP security headers, strict CSP, centralized lazy Zod env validation, bounded process-local sliding window rate limiting, safe client IP trust boundary, dual liveness/readiness health probes) complete; Sub-Batch 3B (Grounded legal pages /terms, /privacy, /acceptable-use, footer/registration/composer UX discoverability, explicit disclosures of unsupported self-service deletion and India draft status, zero unbuilt moderation tooling invariants, 15 legal tests) complete; Sub-Batch 3C (Complete 760-test regression across all 12 suites, Prisma generate, TypeScript check, Next.js production build, DR documentation, Release Readiness Checklist) complete. Commit `d681411` (pushed). |
| 8 | AI Video Generator | ✅ Complete — Batch 0 (Feasibility & Architecture) complete; Batch 1 (Domain config, pricing, types, MockVideoProvider, MP4 fixture & Ed25519 webhook boundary; 83 tests) complete; Batch 2A (DB schema, migrations & lifecycle state machine; 70 tests) complete; Batch 2B (Streaming storage ingestion, SSRF IP pinning, thumbnail boundary & signed URLs; 116 tests) complete; Batch 3 (Fal.ai provider adapter, Ed25519 webhook verification, durable persistence, concurrency-safe leases, cron reconciliation & 15m timeout sweep; 161 tests) complete; Batch 4 (Generation APIs & client synchronization layer, including cryptographically bound delayed webhook correlation token verification; 103 tests) complete; Batch 5 (Premium AI Video Generator UI at `/ai-video`, cinematic player, gallery & component tests; 74 tests) complete; Batch 6 (Legal Policy Reconciliation, UI Review, Full Regression & Release Readiness; 20 legal tests, 1,027 total offline regression tests passing) complete. Live Fal.ai E2E trial deferred pending explicit authorization. |
| 8.1 | Staging Readiness Assessment | ✅ Complete — Comprehensive staging readiness audit across secrets, migrations, Supabase storage, Fal.ai ingress, cron scheduling, operator tooling, diagnostics, offline/live test boundaries, and 7-phase staging setup checklist. |
| 8.2 | Zero-Cost Operational Preparation | ✅ Complete — Production Operator CLI (`scripts/resolve-ambiguous-job.mts`) with physical storage verification, Account Deletion SOP (`docs/runbooks/account-deletion-sop.md`), Staging Runbook (`docs/runbooks/staging-setup-runbook.md`), 74 CLI safety tests, 1,196 passing offline tests across 15 suites. Commit `c6b73f3` (pushed). |
| 9 | AI Video Clipper | 🔄 In Progress — Batch 0 approved; Batch 1 (Domain Config, VideoSource Abstraction, Types, Validation, Storage Keys & Mock Engine; 43 tests) complete; Batch 2 (Database Schema Reusability, Job Lifecycle State Machine, Dynamic Multi-Clip Credit Accounting, Ingestion Leases, Terminal Guards, Idempotent Refunds, Decoupled Cleanup & Lease Fencing; 25 tests) complete; Batch 3 (Subprocess Runner & Security Boundary, FFprobe Metadata Extraction, Audio Demuxing & Silence Detection, Scene Cut Detection, Multi-Format Whisper Parser with Interpolation Safeguard, Deterministic Highlight Scoring, High-Contrast ASS/SRT Karaoke Generator; 34 tests) complete; Batch 4 (FFmpeg filter graphs & argument builder, output validation, WebP poster frames, FfmpegClipperEngine, lease-fenced worker orchestration, streaming output ingestion, orphan/source cleanup & retry sweep; 69 tests + 6 lifecycle tests, 3 real-FFmpeg tests SKIPPED — no FFmpeg on dev machine, real encode NOT verified) complete; Batch 5 (direct-to-storage upload workflow with fail-closed, lock-serialised quota; clip job API & job view; worker process with job pickup and graceful/hard shutdown; scene & pacing planner — speech analysis/captions explicitly unavailable; maintenance cron for stale jobs, cleanup retries and abandoned uploads; browser client controller; 73 tests + 4 lifecycle tests) complete. Batches 1–5 + Stage 8 cron fix committed and pushed as `4ed067f`. Batch 6 (`/video-clipper` UI, operator submission switch, queued-job cancel + refund, download redirect, upload-reservation recovery; 35 backend + 40 UI + 7 lifecycle tests) implemented 2026-11-11, uncommitted, awaiting review — see §16.13. |

## 3. Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Motion · PostgreSQL on Supabase · Prisma 7 (`prisma.config.ts`, client generated to `src/generated/prisma`, `@prisma/adapter-pg`) · Auth.js v5 (Credentials, JWT sessions) · bcryptjs · zod · Cloudflare Workers AI (FLUX.1 Schnell, implemented) · Supabase Storage (private bucket, implemented) · sharp (JPEG → WebP) · Fal.ai (Wan 2.1 720p/5s text-to-video target), Mock Video Provider adapter, asynchronous webhook-first lifecycle with atomic ingestion lease & polling fallback, streamed MP4 ingestion to private Supabase Storage.

Next.js 16 uses `src/proxy.ts` (formerly middleware). Repo: `github.com/Vinay09876/AI-Generator`, branch `master`.

## 4. Approved business rules (do not change without discussion)

**Credits (user-facing)**
- New account: **100 credits** (+ `INITIAL_GRANT` ledger row), created atomically with the user.
- Fast image: **1 credit**, 4 steps. Detailed image: **2 credits**, 8 steps.
- Video: Configurable via `VIDEO_CREDIT_COST` (proposed **10 credits** per 5-second 720p video, 24 fps).
- Ledger sign: positive = added, negative = deducted. Wallet balance can never be negative (DB `CHECK`).

**Limits**
- Max **10 counted image generations per user per UTC day**.
- Max **1 counted video generation per user per UTC day** for promotional accounts (`DEFAULT_DAILY_USER_VIDEO_LIMIT = 1`). In production during Stage 8, video generation is restricted to authorized QA accounts (`STAGE_8_QA_USER_EMAILS`). Quotas and pricing remain configurable via `getDailyUserVideoLimit()` and `getVideoCreditCost()`.
- Shared platform concurrency limit: max **1 active generation job per user across all types** (enforced by PostgreSQL partial unique index `GenerationJob_one_active_per_user`).
- A job counts when its provider reservation is `RESERVED` or `CONSUMED` (provider may have run / did run — even if later refunded). `RELEASED` (provider definitely never ran) does not count.

**AI Video Generator rules (Stage 8)**
- Provider: **Fal.ai hosting Wan 2.1** (720p, Apache 2.0 open-weights, commercial use permitted). Local development and test suite backed by offline `MockVideoProvider`.
- Asynchronous lifecycle: `POST /api/generations/video` returns HTTP 202 `PROCESSING` immediately; provider calls `POST /api/webhooks/video/fal` with Fast ACK (HTTP 200) after durable result recording; streaming ingestion acquired via atomic database lease (`ingestionToken` + 5-min expiration); client read-only polling `GET /api/generations/video/{jobId}` (4s interval) serves as status sync and lease-recovery fallback.
- Timing: Provider timeout 120s; stale `PROCESSING` reconciliation window **15 minutes**.
- Storage: Private Supabase Storage bucket `generated-assets`, keys `users/{userId}/videos/{jobId}/{assetId}.mp4`, max 35MB, 10-minute signed URLs. Poster frame WebP stored at `thumbnailKey`.
- Invariants: Pre-allocation debit (-credits) on submit; automatic refund (+credits) on upstream rejection, provider failure, or timeout reconciliation; single-transaction guarded completion `WHERE id = :id AND ingestionToken = :token`.

**Provider capacity (Neurons) — separate from credits (Image Generator)**
- Model `@cf/black-forest-labs/flux-1-schnell`, REST `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`, server-side bearer token.
- Free allocation 10,000 Neurons/day, resets **00:00 UTC**. App budget **9,500 Neurons/UTC day** (500 margin).
- Stored as centi-neurons: Fast **17,280**, Detailed **32,640**, daily limit **950,000**.
- Actual usage comes from the `cf-ai-neurons` response header.

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
| Video config & pricing | `src/features/video/config.ts` (pricing, aspect ratios, durations) |
| Video types & interfaces | `src/features/video/types.ts` (VideoProviderAdapter, webhook types, job payloads) |
| Video provider adapters | `src/features/video/providers/` (`adapter.ts`, `mock-provider.ts`, `fal-provider.ts`) |
| Video lifecycle & lease | `src/features/video/lifecycle.ts` (atomic ingestion token lease, guarded completion, timeouts) |
| Video HTTP handlers & DI | `src/features/video/http.ts`, `src/features/video/service.ts` |
| Video API routes | `src/app/api/generations/video/route.ts` (POST async submit), `src/app/api/generations/video/[jobId]/route.ts` (GET status sync), `src/app/api/webhooks/video/fal/route.ts` (POST Fast-ACK webhook) |
| Video UI (client) | `src/components/video-generator/` · `src/app/(dashboard)/ai-video/page.tsx` |
| Video adapter test suite | `scripts/test-video-adapters.mts` (`npm run test:video-adapters`, offline) |

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

## 13. Stage 8 — AI Video Generator: Architecture & Batch Plan

### 1. Architectural Blueprint & Technical Invariants
- **Provider Choice:** Fal.ai hosting Alibaba Wan 2.1 (`fal-ai/wan/v2.1/t2v-720p`, Apache 2.0 open-weights, commercial rights permitted).
- **Zero-Budget Strategy:** 100% of domain logic, state machines, webhook handlers, ingestion leases, storage streams, and UI flows are implemented and tested offline using a deterministic `MockVideoProvider` with an embedded fixture MP4. Exactly one real E2E generation is performed using developer trial credits during Batch 5.
- **Asynchronous Webhook-First Lifecycle & Fast-ACK (<200ms):**
  - Webhook endpoint (`POST /api/webhooks/video/fal`) verifies provider ED25519 signature via public JWKS.
  - Webhook performs **Fast ACK (<200ms)**: writes provider result payload into `GenerationJob.settings.providerResult` and immediately returns HTTP 200 to prevent provider retry storms.
  - Large MP4 asset streaming ingestion (5–25MB) is decoupled from the webhook response.
- **Atomic Ingestion Claim & Crash Recovery:**
  - Prevents race conditions between webhook handlers and client polling.
  - Ingestion lease acquired via atomic conditional update:
    ```sql
    UPDATE "GenerationJob"
    SET "ingestionToken" = :token,
        "ingestionLeaseExpiresAt" = now() + interval '5 minutes'
    WHERE id = :id
      AND status = 'PROCESSING'
      AND ("ingestionToken" IS NULL OR "ingestionLeaseExpiresAt" < now())
    RETURNING id;
    ```
  - Exactly one execution path streams the video from the provider CDN directly to private Supabase Storage (`users/{userId}/videos/{jobId}/{assetId}.mp4`).
  - Terminal settlement (`completeVideoJobWithAsset`) is guarded: `WHERE id = :id AND "ingestionToken" = :token`.
  - If a worker crashes mid-ingestion, the 5-minute lease expires, allowing client polling or a sweep trigger to reclaim and complete ingestion.
- **Client Polling Fallback:**
  - Client polls `GET /api/generations/video/{jobId}` every 4 seconds.
  - If the job is marked complete, returns asset metadata and signed URL immediately.
  - If provider results exist but ingestion hasn't occurred (e.g. lost worker or webhook delivery failure), polling triggers the ingestion lease acquisition.
  - Best-effort stale job sweep (15-minute reconciliation window) auto-refunds dead jobs.
- **Credit Accounting & Financial Exposure Model:**
  - Configurable `VIDEO_CREDIT_COST = 10` credits per 5-second 720p video (provider cost ~$0.30 at $0.06/sec).
  - Pre-allocation debit (-10 credits) on job creation.
  - Automatic refund (+10 credits) on upstream failure or timeout reconciliation.
  - Concurrency protected by the existing global partial unique index `GenerationJob_one_active_per_user` across all generation types.
  - Daily limit: 1 video generation per user per UTC day for promotional accounts (`DEFAULT_DAILY_USER_VIDEO_LIMIT = 1`). Restricted to authorized QA accounts via server-side environment configuration (`STAGE_8_QA_ALLOWLIST`) in production during Stage 8. Quotas remain configurable via `getDailyUserVideoLimit()`.
  - Authoritative Entitlement & Server-Side Security Model (`src/features/video/auth.ts`):
    - Server-side authorization check exclusively (`isServerAuthorizedQaUser`).
    - Prefers stable user IDs (`user.id`) from authenticated session.
    - If email is matched, requires normalized lowercase matching AND confirmed email identity (`emailVerified` is truthy); unverified emails fail closed.
    - Production strictly fails closed: if `STAGE_8_QA_ALLOWLIST` is missing, empty, or whitespace, video generation access is denied to all accounts.
    - Server exclusively resolves entitlements (`resolveUserVideoEntitlement`); untrusted client payloads (e.g. `{ tier: "paid", isQa: true }`) are strictly ignored.
    - Paid tier quota (provisional 50/day) is granted strictly when trusted active subscription records exist; absent payment infrastructure, fails closed.
    - Unknown or unrecognized tiers fail closed to promotional (1 video/day).
    - QA allowlist values are never bundled to client-side code or exposed in API responses.
- **Storage & Bandwidth Controls:**
  - Private Supabase Storage bucket `generated-assets`.
  - Streamed direct upload with a 35MB size limit.
  - Thumbnail poster frame (`thumbnailKey`) generated and stored as WebP (~40KB) to protect Supabase 5GB/month egress bandwidth in gallery views.

### 2. Stage 8 Implementation Batch Sequence
- **Batch 0: Provider Feasibility & Architecture** (✅ Approved & Documented)
- **Batch 1: Video Domain Config, Pricing, Types, Mock Adapter & Entitlement Security** (✅ Complete — 116 tests passing)
  - `src/features/video/config.ts`: Aspect ratios (`16:9`, `9:16`, `1:1`), duration (`5s`), resolution (`720p`), fps (`24fps`), default credit pricing (`DEFAULT_VIDEO_CREDIT_COST = 10` via configurable `getVideoCreditCost()`), promotional daily quota (`DEFAULT_DAILY_USER_VIDEO_LIMIT = 1`), configurable tier limits via `getDailyUserVideoLimit()` (provisional QA: 10, paid: 50, unknown/unrecognized: fails closed to 1), limits (35MB MP4, 1MB WebP thumbnail), timing invariants (120s provider timeout < 300s lease < 900s reconciliation).
  - `src/features/video/auth.ts`: Server-side QA authorization and entitlement resolution (`isServerAuthorizedQaUser`, `resolveUserVideoEntitlement`, `canGenerateVideoInStage8`, `parseQaAllowlist`):
    - Server environment variable `STAGE_8_QA_ALLOWLIST` (deliberately not hardcoded in source).
    - Prefers stable user IDs (`user.id`); checks normalized lowercase emails strictly when `emailVerified` is truthy.
    - Production fail-closed protection: if allowlist is absent or empty, denies video generation access.
    - Disregards untrusted client payloads (`clientPayload`) to prevent privilege elevation.
    - Requires trusted active subscription data for paid tier; unknown tiers fail closed to promotional (1).
    - Zero exposure of allowlist values in client bundles or responses.
  - `src/features/video/types.ts`: Provider contract `VideoProviderAdapter`, `VideoGenerationRequest`, `VideoSubmitResult`, `CompletedVideoMetadata`, `VideoJobStatusResult`, `VideoCancelResult`, `VideoProviderError` (with `toLog()` secret redaction).
  - `src/features/video/providers/fixture.ts`: Dual-fixture architecture:
    - **Structural Container Fixture** (`MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER` / `MOCK_MP4_FIXTURE_BUFFER`, 631 bytes): Syntactically valid ISOBMFF container conforming to ISO/IEC 14496-12/14 (`ftyp`, `moov`, `mdat`). Defines track metadata (1280x720, 5s), but lacks H.264 `avcC` parameter sets and encoded macroblocks (not decodable by video decoders). Retained for fast, ultra-compact unit tests and container parser validation.
    - **Playable H.264 Video Fixture** (`MOCK_MP4_PLAYABLE_FIXTURE_BUFFER`, 19,190 bytes): Genuinely decodable and playable H.264 video container (Baseline Profile Level 1.0, SQCIF 128x96, 1.0s at 1000 timescale). Contains authentic `avcC` box with SPS/PPS parameter sets, chunk offsets, and uncompressed `I_PCM` IDR slice in `mdat`. Fully decodable and playable in HTML5 `<video>`, Chromium, and Windows Media Foundation.
    - `inspectMp4Buffer` parser inspecting atom boxes, validating container structure and verifying `isPlayableH264` via `avcC` detection.
  - `src/features/video/providers/mock-provider.ts`: Offline deterministic `MockVideoProvider` implementing `VideoProviderAdapter` with state progression (PENDING → PROCESSING → COMPLETED), idempotent checks, `[mock:slow]`, `[mock:fail:*]` triggers, cancellation, and dual fixture support (`[mock:playable]` / `fixtureMode: "playable"` delivering genuine H.264 video).
  - `src/features/video/webhooks/verify.ts`: Provider-independent ED25519 webhook signature verifier (`verifyEd25519WebhookSignature`) with replay attack prevention, 5-minute timestamp tolerance, clock skew protection, and local test keypair generation.
  - `scripts/test-video-adapters.mts`: Offline test suite (`npm run test:video-adapters`) with 116/116 tests passing across 7 categories.
- **Batch 2A: Database Schema, Lifecycle State Machine & Credit Accounting** (✅ Complete — 70 tests passing)
  - Additive Schema Migrations (`prisma/migrations/20261111083000_add_video_generation_fields/migration.sql`):
    - `GenerationJob.ingestionToken` (Text?, nullable): Unique token claimed by an ingestion worker to stream video output.
    - `GenerationJob.ingestionLeaseExpiresAt` (DateTime?, nullable): Expiration timestamp for the active ingestion lease; enables worker crash recovery.
    - `GeneratedAsset.durationSeconds` (Float?, nullable): Duration of video or audio asset in seconds.
    - `GeneratedAsset.thumbnailKey` (String?, nullable): Private storage key for the video poster frame thumbnail (WebP).
    - `GenerationJob_status_ingestionLeaseExpiresAt_idx` composite index for $O(1)$ query performance during reconciliation sweeps.
    - Data integrity check constraints:
      - `GenerationJob_ingestion_lease_consistency`: `CHECK (("ingestionToken" IS NULL AND "ingestionLeaseExpiresAt" IS NULL) OR ("ingestionToken" IS NOT NULL AND "ingestionLeaseExpiresAt" IS NOT NULL))` strictly enforces the two valid states, preventing unreclaimable leases (token without expiry) or orphaned expiries.
      - `GeneratedAsset_duration_positive`: `CHECK ("durationSeconds" IS NULL OR "durationSeconds" > 0)`
    - Concurrency preservation: Verified that the existing partial unique index `GenerationJob_one_active_per_user` on `("userId") WHERE status IN ('PENDING', 'PROCESSING')` is unpartitioned by `type`, enforcing a strict platform-wide maximum of 1 active generation per user across both image and video requests.
  - Video Generation Lifecycle State Machine (`src/features/video/lifecycle.ts`):
    - `validateVideoRequestInput`: Enforces prompt limits (1..2048 chars), supported aspect ratios (`16:9`, `9:16`, `1:1`), durations (5s), resolutions (720p), fps (24fps), and non-empty idempotency keys.
    - `createVideoJob`: Serializes user requests (`FOR UPDATE`), checks idempotency replays (returns existing job or raises `IDEMPOTENCY_CONFLICT`), checks daily quota (1 for promotional, 10 for QA, 50 for paid), enforces 1 active generation concurrency, creates `PENDING` job, and debits user wallet in ONE transaction. Supports dynamic, non-hardcoded credit pricing.
    - `markVideoJobStarted`: Guarded `PENDING -> PROCESSING` transition upon upstream submission; records provider job ID and `startedAt`.
    - `recordVideoProviderResult`: Atomically records provider output payload in `settings.providerResult`, enabling Fast-ACK (<200ms) for webhooks without blocking on heavy video streaming.
    - `claimVideoIngestionLease`: Atomic conditional `UPDATE ... SET ingestionToken = :token, ingestionLeaseExpiresAt = now() + 5m WHERE id = :id AND status = 'PROCESSING' AND (ingestionToken IS NULL OR ingestionLeaseExpiresAt < now())`. Exactly one winner acquires the lease; concurrent workers are rejected; crashed workers can be reclaimed once expired.
    - `completeVideoJobWithAsset`: Guarded `PROCESSING -> COMPLETED` transition requiring valid `ingestionToken`. Finalizes `chargedCredits = estimatedCredits` (dynamic amount), atomically clears `ingestionToken = NULL` and `ingestionLeaseExpiresAt = NULL`, and inserts `GeneratedAsset` with duration and thumbnailKey. Completed jobs are never refunded.
    - `failVideoJob` & `cancelVideoJob`: Guarded terminal transitions from `PENDING` or `PROCESSING` only; atomically clears `ingestionToken = NULL` and `ingestionLeaseExpiresAt = NULL`, and derives exact refund dynamically from the original debit transaction record via `refundJobDebit` (verified with arbitrary 17 credits). Completed jobs match 0 rows and cannot be refunded.
    - `reconcileStaleVideoJobs`: Sweeps stuck PENDING (> 5m) and PROCESSING (> 15m) jobs, safely transitioning them to FAILED, clearing leases, and refunding credits.
  - Mutual Exclusivity & Post-Terminal Invariants:
    - Completed jobs can never be refunded: calling `failVideoJob` or `cancelVideoJob` on a `COMPLETED` job matches 0 rows and issues 0 refunds.
    - Refunded/Failed jobs can never produce assets: `completeVideoJobWithAsset` checks `status = 'PROCESSING'` and matching `ingestionToken`; if already failed or refunded, matches 0 rows and throws `JobNotCompletableError`, creating 0 assets.
  - Test Suite (`npm run test:video-lifecycle`):
    - 70 passing tests across schema inspection, input validation, state transitions, atomic lease cleanup, dynamic credit accounting (17 credits), daily quotas, stale reconciliation, and concurrency simulations (idempotency races, insufficient balance, lease claims).
  - Documented Database Testing Limitations:
    - Real PostgreSQL live verification: The current development sandbox runs offline without network access to remote databases (`aws-0-ap-northeast-1.pooler.supabase.com`) or a local PostgreSQL daemon. To guarantee zero disruption to production, no migrations or writes were executed against production. All concurrency guarantees (row locking, unique constraint violations, atomic conditional updates) were verified offline using a high-fidelity transactional simulator. Live execution against an isolated PostgreSQL instance remains a pre-release verification item.
- **Batch 2B: Video Storage, Streaming Ingestion & Thumbnail Poster Frame Extraction** (✅ Complete — 116 tests passing)
  - Modular Video Storage Pipeline (`src/features/video/storage/`):
    - `keys.ts`: Deterministic, user-scoped object keys (`users/{userId}/videos/{jobId}/{assetId}.mp4` and `users/{userId}/videos/{jobId}/{assetId}-thumb.webp`). Strict segment assertions (`^[A-Za-z0-9_-]{8,64}$`) preventing path traversal (`..`), directory separators, or prefix injection. Ownership verification helpers (`isVideoKeyOwnedBy`, `isVideoThumbnailKeyOwnedBy`, `isVideoAssetKeyOwnedBy`).
    - `ssrf.ts`: Defense-in-depth SSRF protection & Connection Pinning (`resolveAndPinAddress`, `safePinnedHttpsDownload`, `validateVideoDownloadUrl`, `safeFetchWithSsrfGuard`):
      - Protocol validation: Enforces HTTPS only (`https:`), strictly disallowing `http:`, `file:`, `ftp:`, `gopher:`.
      - Port validation: Enforces default HTTPS port 443; rejects custom ports.
      - Host allowlist: Enforces approved provider hosts (`fal.media`, `*.fal.media`, `fal.ai`, `*.fal.ai`, `storage.googleapis.com`, `*.storage.googleapis.com`).
      - IP & loopback blocking: Rejects `localhost`, `127.0.0.1`, RFC1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), AWS/cloud metadata link-local (`169.254.169.254`), carrier-grade NAT (`100.64.0.0/10`), and IPv6 private/loopback/link-local ranges (`::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`).
      - DNS connection pinning: `safePinnedHttpsDownload` performs DNS resolution prior to connecting, validates all returned IPs, and pins the verified IP via a custom `lookup` callback in `https.request`. The actual TCP/TLS socket connects strictly to the pinned address while setting `servername: hostname` for authentic TLS SNI and server certificate validation. This completely closes the DNS rebinding / TOCTOU gap between validation and connection.
      - Safe redirect interceptor: Intercepts HTTP 301/302/307/308 redirects with `redirect: "manual"`, independently re-resolves and re-pins each destination hop against SSRF rules, and enforces a hard ceiling of 3 hops.
    - `stream.ts`: Streamed retrieval without buffering 35MB files in RAM (`createVideoStreamMeter`, `downloadVideoStream`):
      - Chunk-safe MP4 container header validation: Accumulates incoming bytes across arbitrary chunk boundaries until the first 8 bytes arrive, then validates the `ftyp` box at offset 4..8. Streams ending prematurely before 8 bytes are rejected in `flush()`.
      - Limitation documentation: The `ftyp` box check verifies ISO Base Media File Format container signature conformity, not codec decodability. Full H.264 decodability requires parsing SPS/PPS in `moov.trak.mdia.minf.stbl.stsd.avcC`.
      - Byte-meter Transform stream: Enforces `MAX_PROVIDER_VIDEO_BYTES` (35MB) on the fly, destroying stream if limit is exceeded.
      - Content-Length pre-check: Aborts upstream fetch immediately if `Content-Length > 35MB`.
      - Content-Type enforcement: Verifies `video/mp4` or `video/*`; rejects HTML error pages.
    - `thumbnail.ts`: Video thumbnail extraction boundary (`VideoThumbnailExtractor`):
      - Tooling check: `isFfmpegAvailable` detects presence of FFmpeg CLI in PATH via `execFile` with 2s timeout and caching.
      - `FfmpegThumbnailExtractor`: Cleanly throws `ThumbnailExtractionError("MISSING_DEPENDENCY")` when FFmpeg is not installed on the host.
      - `ProviderPosterThumbnailExtractor`: Converts provider-supplied poster images (buffer, data URI, or URL) into WebP quality 85 via Sharp, enforcing the 1MB thumbnail cap (`MAX_STORED_THUMBNAIL_BYTES`).
      - `MockThumbnailExtractor`: Offline deterministic extractor for testing with custom dimensions and configurable failure simulation modes.
      - `CompositeVideoThumbnailExtractor`: Orchestrates extraction by prioritizing provider poster frames, falling back to FFmpeg if available, or reporting clean missing dependency without corrupting asset metadata.
    - `supabase.ts`: Supabase Storage adapter (`SupabaseVideoObjectStorage` implementing `VideoObjectStorage`):
      - Streaming compatibility: Passes Node.js `Readable` stream directly to `@supabase/storage-js` with `duplex: "half"` without buffering the 35 MB payload in a full in-memory Buffer. Includes `content-length` header when known to avoid chunked transfer issues on backend storage.
      - Supports buffered uploads (`put`) for WebP thumbnails.
      - Enforces private bucket access, signed URL generation, and idempotent deletion.
    - `ingestion.ts`: Full ingestion pipeline orchestrator (`ingestVideoOutput`, `getSignedVideoAssetUrl`):
      - Downloads video stream with SSRF connection pinning and chunk-safe signature checks.
      - Uploads video directly to private Supabase Storage.
      - Extracts and uploads WebP poster frame if extractor succeeds.
      - Graceful dependency fallback: If FFmpeg is missing and no poster was supplied, logs structured warning and sets `thumbnailKey: null` without failing ingestion or corrupting metadata (unless `requireThumbnail: true` is requested).
      - Atomic guarded completion: Calls Batch 2A `completeVideoJobWithAsset` with matching `ingestionToken`.
      - Orphan cleanup on failure: If database completion or any step throws, atomically deletes all uploaded storage objects (`storage.delete`). If deletion also fails, reports orphaned keys in `VideoAssetPersistenceError`.
      - Authenticated signed URLs: `getSignedVideoAssetUrl` derives `userId` strictly from the server session (never from client input), scopes lookups by `{ id: assetId, userId }`, validates key prefix matching against `isVideoKeyOwnedBy` / `isVideoThumbnailKeyOwnedBy`, and returns safe 404 NOT_FOUND on any mismatch to prevent ID probing.
  - Test Suite (`npm run test:video-storage`):
    - 116 passing tests across user-scoped keys, path traversal, SSRF IP/host filtering, DNS connection pinning, DNS rebinding prevention, IPv4/IPv6 address pinning, redirect loop protection, chunk-safe header validation (single chunk, 2 chunks, small chunks, truncated streams), streaming meter, FFmpeg detection, WebP conversion, storage adapter, full ingestion lifecycle, graceful thumbnail fallback, strict mode orphan cleanup, stale lease rejection, database failure cleanup, and authenticated signed URL ownership security.
  - Tooling & Environment Status:
    - FFmpeg CLI: Verified absent on current Windows environment. The adapter boundary cleanly identifies this (`isFfmpegAvailable() === false`), correctly documents the missing dependency, and gracefully falls back to provider posters or `thumbnailKey: null` rather than pretending local extraction works.
    - PostgreSQL isolation limitation: Database lifecycle guarantees remain verified via high-fidelity transactional simulation. Real isolated PostgreSQL verification remains a pre-release operational item.
    - Supabase live integration limitation: Offline sandbox mode prevents live HTTP uploads to remote Supabase Storage. Verified through SDK source inspection and simulated streaming upload tests; isolated live integration testing remains a pre-release operational item.
- **Batch 3: Fal.ai Provider Adapter, Webhook Fast-ACK & Asynchronous Orchestration** (✅ Complete & Verified — 119 tests passing)
  - Official Provider Research & Specification Verification (Nov 11, 2026):
    - Selected Model: `fal-ai/wan/v2.1/t2v-720p` (Alibaba Tongyi Wan 2.1 text-to-video, Apache 2.0 open weights, commercial use permitted under Fal.ai platform terms, verified official pricing $0.10/second for 720p -> $0.50 per 5-second video; YourAI charges 10 platform credits via configurable `getVideoCreditCost()`).
    - Queue Submission API: `POST https://queue.fal.run/fal-ai/wan/v2.1/t2v-720p?fal_webhook={encodedWebhookUrl}`.
    - Verified Request Schema: `prompt` (string, required), `aspect_ratio` ("16:9", "9:16", "1:1"), `num_frames: 81`, `frames_per_second: 16`, `resolution: "720p"`, `enable_safety_checker: true`.
    - Verified Duration Mapping: 81 frames at 16 fps = ~5.06s (~5s).
    - Verified Output Schema: `{ video: { url: string, content_type: string, file_size: number } }`.
    - Webhook Cryptography: Ed25519 asymmetric signature using JWKS (`https://rest.fal.ai/.well-known/jwks.json`).
    - Required Headers: `X-Fal-Webhook-Request-Id`, `X-Fal-Webhook-User-Id`, `X-Fal-Webhook-Timestamp`, `X-Fal-Webhook-Signature` (hex-encoded Ed25519 signature).
    - Signed Message Format: Strict concatenation of `${requestId}\n${userId}\n${timestamp}\n${bodyHash}` where `bodyHash` is the lowercase hex SHA-256 digest of raw unparsed request bytes.
  - Official Fal.ai Webhook Verifier (`src/features/video/webhooks/fal-verify.ts`):
    - `verifyFalWebhookSignature`: Validates Ed25519 signatures on raw bytes using Node.js `crypto.verify(null, messageBuffer, key, sigBuffer)`.
    - Strict Replay Protection: Rejects timestamps older than 300 seconds (`WEBHOOK_TIMESTAMP_TOLERANCE_MS`) or more than 60 seconds in the future.
    - Public Key Management: Fetches and caches JWKS from `https://rest.fal.ai/.well-known/jwks.json` with 24-hour TTL; parses `OKP` Ed25519 JWKs using SPKI DER encoding.
    - Test Utilities: `generateFalTestKeypair` and `signFalWebhookPayload` for 100% offline cryptographic tests.
  - Webhook Identity Separation & Mismatch Defense:
    - Delivery Identity: `X-Fal-Webhook-Request-Id` (unique per delivery, verified by Ed25519 signature, used for `ProviderWebhookEvent.eventId` deduplication).
    - Provider Generation Identity: `body.request_id` (used for `GenerationJob.providerJobId` correlation).
    - Mismatch Defense: If `X-Fal-Webhook-Request-Id !== body.request_id`, the webhook route strictly rejects with HTTP 400 (`Identity mismatch`) to prevent forged payload correlations.
    - Unverified payloads rejected before parsing with HTTP 401.
    - Duplicate deliveries of identical or different event IDs for the same provider job do not create duplicate assets or settlements (guarded by terminal job status check and unique asset constraints).
  - Ambiguous Provider Submission Handling (`src/features/video/lifecycle.ts` & `src/features/video/providers/fal-provider.ts`):
    - Explicit classification: Pre-transmission rejections (`ENOTFOUND`, invalid schema, pre-aborted signal) classified as `not_run` (safe to refund immediately). In-flight network drops, timeouts, 5xx, or malformed 200 classified as `unknown`.
    - Non-premature refund: `recordVideoJobSubmissionAmbiguous` transitions job `PENDING -> PROCESSING`, records `submission = { state: "ambiguous", error, attemptedAt }` in settings, and preserves debited credits.
    - Webhook-Driven Recovery: Submission embeds `?jobId={jobId}` into `fal_webhook` query parameter (`https://yourai.com/api/webhooks/video/fal?jobId=...`). When the webhook arrives, it recovers the job via `event.jobId`, backfills `providerJobId`, and completes asset ingestion.
    - 15-Minute Timeout Sweep: If no webhook arrives after 15 minutes, `reconcileStaleVideoJobs()` settles the job to `FAILED` and refunds credits.
    - Residual Ambiguity: Fal.ai does not support idempotency keys on queue submissions; automated re-submissions are avoided to prevent duplicate provider charges.
  - Durable Worker Execution & Recovery Architecture (`src/features/video/webhooks/durable-events.ts`, `process-event.ts`, `src/app/api/cron/video-webhooks/route.ts`):
    - Fast-ACK Guarantee: `POST /api/webhooks/video/fal/route.ts` durably persists verified events to PostgreSQL and acknowledges within <200ms with HTTP 200 `{ received: true, requestId }`.
    - Failure Retry Semantics: If database persistence fails, returns HTTP 500 to invoke provider retry.
    - Concurrency-safe Leases: `claimWebhookEvent` atomically claims events using conditional SQL with 5-minute lease and `attempts < 5`.
    - Bounded Exponential Backoff: `getWebhookRetryBackoffMs(attempts)` calculates 15s, 30s, 60s, 120s, 240s, capped at 300s (5m). On `FAILED` event settlement, `leaseExpiresAt` is set into the future to enforce backoff.
    - Exhausted Event Observability: After 5 failed attempts, events remain in `FAILED` status and are excluded from automatic claims. Operator function `resetExhaustedWebhookEvent(eventId)` enables manual replay.
    - Production Execution Mechanisms (Zero Paid Infrastructure):
      1. Immediate dispatch on webhook receipt via Next.js `after()` or asynchronous non-blocking task.
      2. Client polling fallback: `GET /api/generations/video/[jobId]` checks for pending/unclaimed events for the job and claims/processes them.
      3. Periodic Reconciliation Endpoint: `GET /api/cron/video-webhooks` (protected by `CRON_SECRET`; fails closed in production when unset — §16.12), invoking `sweepStaleWebhookEvents()`, `processPendingWebhookBatch()`, and `reconcileStaleVideoJobs()`. Compatible with free external cron triggers (cron-job.org, GitHub Actions, Vercel Cron free tier) without requiring paid Redis/BullMQ/SQS infrastructure.
  - Test Suite (`scripts/test-fal-webhooks-orchestration.mts` / `npm run test:video-webhooks`):
    - 119 passing tests across Ed25519 signature verification, replay protection, adapter submission, queue polling, error normalization, secret redaction, durable persistence, Fast-ACK route handler, identity mismatch rejection, leased event claims, out-of-order deliveries, crash recovery, ambiguous submission handling, webhook recovery, stale sweeps, exponential backoff, batch worker processing, and cron reconciliation endpoint.
- **Batch 4: Generation APIs & Client Synchronization Layer** (✅ Complete & Verified — 75 tests passing)
  - `POST /api/generations/video` (Asynchronous Video Generation Submission):
    - Node.js runtime, `maxDuration = 60`.
    - Server-side Auth.js session authentication (strictly derives `userId` from verified session; never trusts client-supplied user ID).
    - Origin verification against `APP_URL` and trusted local hostnames (`FORBIDDEN_ORIGIN` 403).
    - Rate limiting via `checkRateLimit` (IP and authenticated-user burst throttles return 429 with `Retry-After`).
    - Input validation via `validateVideoRequestInput` (prompt length 1-2048, aspect ratio 16:9/9:16/1:1, duration 5s, resolution 720p, fps 16 strictly aligned with Wan 2.1 81-frame model; unapproved frame rates rejected with 400).
    - Server-side Stage 8 QA authorization (`canGenerateVideoInStage8`): Strictly enforces allowlist in production; denies access with 403 FORBIDDEN if allowlist is missing or unverified. Never trusts client QA claims.
    - Dynamic credit debit & quota resolution: Resolves tier and daily UTC limit (`getDailyUserVideoLimit`) and charges dynamic debit amount (`getVideoCreditCost()` = 10 credits) via `createVideoJob`.
    - Atomic job creation: Inserts `GenerationJob` with status `PENDING`, `jobType: VIDEO`, and durable submission intent (`settings.submission = { state: "intent", createdAt }`).
    - Reliable idempotency: User-scoped idempotency key prevents duplicate job creation; replays existing job state safely if retried.
    - Concurrency constraint: Gracefully maps `P2002` on `active_generation_per_user` to HTTP 409 `ACTIVE_JOB_EXISTS`.
    - Asynchronous dispatch: Invokes provider (`getFalVideoProvider().submit`). On success, returns HTTP 202 Accepted with `Location: /api/generations/video/{jobId}`, `Retry-After: 4`, and `VideoJobView` reporting model native 16 fps and 5s duration.
    - Definite rejection handling: Cleanly maps `not_run` provider rejections to HTTP 502 `UPSTREAM_REJECTED` and refunds debited credits atomically.
    - Ambiguous outcome handling: Maps network drops or in-flight 5xx to HTTP 202 Accepted, updates submission state to `ambiguous`, and preserves debited credits. ReconcileStaleVideoJobs does NOT automatically refund ambiguous submissions after 15 minutes; instead, transitions them to an explicit operationally reviewable unresolved state (`settings.submission.unresolved = true`, `reviewStatus: "pending_operator_review"`) while preserving `PROCESSING` status and debits. Late valid webhooks safely complete unresolved jobs, while operator resolution paths (`resolveAmbiguousJobAsFailed`, `resolveAmbiguousJobAsCompleted`) provide manual resolution with full audit trail and enforce post-refund late completion rejection.
  - Durable Submission Recovery (`src/features/video/durable-submission.ts`):
    - Eliminates blind duplicate requests: Because Fal.ai's `queue.fal.run` API lacks native idempotency key support, YourAI prevents double submissions on server restart by distinguishing unattempted intent (`state: "intent"`) from in-flight submissions.
    - Atomic Lease Claiming: `claimVideoSubmissionLease` uses atomic PostgreSQL conditional updates to claim a 60s submission lease (`state: "dispatching"`).
    - Stale Intent Recovery: `reconcileStaleSubmissionIntent` re-dispatches unattempted jobs whose leases expired, while safely transitioning in-flight unconfirmed dispatches to `state: "ambiguous"` to await webhook correlation via `?jobId={jobId}` or operational review (never auto-refunded).
  - `GET /api/generations/video/[jobId]` (Lightweight Owner-Scoped Polling Endpoint):
    - Node.js runtime.
    - Strictly owner-scoped lookup: Scoped by `{ id: jobId, userId }`. Returns HTTP 404 NOT_FOUND on any missing or cross-user query to prevent ID probing.
    - Lightweight Invariant: Never streams 35 MB videos, never runs FFmpeg, and never uploads to Supabase Storage synchronously inside GET.
    - Asynchronous Ingestion Signaling: Detects pending provider output on `PROCESSING` jobs without completed assets, and schedules the durable processing worker in the background via Next.js `after()` (`triggerPendingIngestion`).
    - Polling Response: Returns HTTP 200 with `Retry-After: 4`, current status, estimated duration, and credit cost.
    - Authenticated Signed URLs: Upon `COMPLETED` status, generates 10-minute signed URLs for private video and thumbnail objects, strictly validating owner key prefixes (`isVideoKeyOwnedBy`).
    - Passive Stale Sweep: Invokes non-blocking `reconcileStaleVideoJobs()` opportunistically for the user.
  - Independent Durable Ingestion Recovery (`src/features/video/storage/ingestion.ts` & cron endpoint):
    - Scheduled Recovery Worker: `processPendingIngestionJobs` independently discovers and ingests ready provider results from `GenerationJob` rows where `status = 'PROCESSING'` and `settings.providerResult` is present.
    - Decoupled from Client Polling: Jobs progress to `COMPLETED` even if the browser closes and no client ever polls `GET /api/generations/video/[jobId]`.
    - Lease Recovery: Re-claims expired ingestion leases if an immediate trigger (`after()`) crashed or failed mid-stream.
    - Concurrency Safety: Atomic `claimVideoIngestionLease` excludes duplicate workers from processing the same job concurrently.
  - Client Synchronization Layer (`src/features/video/client/`):
    - Framework-Free Controller (`VideoGenerationController`):
      - State progression: `idle` -> `submitting` -> `polling` -> `completed` / `failed`.
      - Polling cadence: Initial 4s delay, honoring upstream `Retry-After` header when provided.
      - Exponential backoff with ±15% randomized jitter (4s, 8s, 16s, capped at 30s) to prevent thundering herd.
      - Maximum polling duration: Bounded at 15 minutes (`MAX_POLL_DURATION_MS = 900,000`), settling to timeout failure if exceeded.
      - Tab Visibility Handling: Automatically pauses polling timers when tab is hidden (`document.visibilityState === "hidden"`) and immediately resumes polling on tab focus.
      - Network Offline Handling: Automatically pauses polling when browser loses connectivity (`navigator.onLine === false`) and resumes immediately upon `online` event.
      - Session Expiry Detection: Stops polling on HTTP 401 and invokes `onUnauthenticated` callback to prompt user re-login.
      - Client Stopping vs Server Cancellation: Controller `stop()` strictly aborts client-side polling and network fetches; does NOT issue a server-side cancellation mutation or disrupt credit accounting.
    - React Hook (`useVideoGeneration`):
      - Subscribes to `VideoGenerationController` events with automatic lifecycle cleanup on component unmount.
  - Test Suite (`scripts/test-video-api-client.mts` / `npm run test:video-api`):
    - 103 passing tests covering authentication, CSRF, burst rate limits, prompt validation, aspect ratio validation, unapproved 24fps rejection, QA authorization, quota enforcement, credit balance check, active generation concurrency conflict, asynchronous dispatch, fast HTTP 202 responses, provider error normalization, ambiguous outcome persistence, durable submission recovery, unresolved state preservation (no auto-refund), operator resolution paths (failed & completed), prevention of late completion post-refund, cross-user 404 security, lightweight polling invariant, background ingestion signaling, independent durable ingestion without GET, authenticated signed asset URLs, backoff jitter, visibility/offline pause/resume, and controller abort handling.
  - Cryptographically Bound Webhook Correlation Security (`src/features/video/webhooks/correlation.ts`):
    - Delayed Correlation Defense: Fal.ai Ed25519 webhook signatures only cover `${requestId}\n${userId}\n${timestamp}\n${bodyHash}`; query parameters such as `?jobId=` are NOT signed by the provider. Without cryptographic correlation binding, an attacker holding any valid signed Fal webhook payload could append arbitrary `jobId` parameters to associate webhooks with unowned or ambiguous jobs.
    - Token Structure: Bound to `jobId`, `provider` ("fal-ai"), and unique `submissionAttempt` UUID. Format: `${base64url(submissionAttempt)}.${hex(nonce16)}.${hex(hmacSha256)}` signed with `WEBHOOK_CORRELATION_SECRET` or `AUTH_SECRET`. 16-byte random nonce guarantees unpredictability.
    - URL Construction: `fal-provider.ts` constructs `https://yourai.com/api/webhooks/video/fal?jobId={jobId}&token={correlationToken}`.
    - HTTP Boundary Enforcement (`route.ts`): If `jobId` query param is present, `token` query param is MANDATORY. Missing, malformed, cross-job substituted, or tampered tokens are rejected with HTTP 400 `Invalid correlation`. A valid Fal Ed25519 signature ALONE cannot authorize an attacker-controlled or modified `jobId`.
    - Asynchronous Worker Enforcement (`process-event.ts`): Priority B correlation verifies that payload `_correlationToken` matches `candidateJob.settings.submission.correlationToken`, `candidateJob.settings.submission.token` (submission attempt), and `candidateJob.id` using constant-time comparison. Rejected correlations leave the job completely untouched.
    - Replay Defense: Redeliveries on terminal jobs (`status !== 'PROCESSING'`) immediately settle to `PROCESSED` with `JOB_ALREADY_TERMINAL` without duplicate credit debits, refunds, or asset creation.
  - Overall Stage 8 Test Coverage: **640 passing video tests** across 6 suites (116 domain + 70 lifecycle + 116 storage + 161 webhook + 103 API/client + 74 UI) + **119 image tests** = **759 total passing tests** with 0 regressions.
- **Batch 5: Premium AI Video Generator UI (`/ai-video`) & Component Architecture** (✅ Complete & Verified — 74 tests passing)
  - Primary Route (`src/app/(dashboard)/ai-video/page.tsx`):
    - Server-side Auth.js session authentication; redirects unauthenticated requests cleanly to `/login`.
    - Server-side entitlement resolution (`resolveUserVideoEntitlement`): Derives tier, daily quota, and daily usage count strictly on the server; never trusts client-supplied tier or QA claims.
    - Owner-scoped parallel data fetching: Simultaneously retrieves any existing active video generation job (`getActiveVideoJobForUser`), recent completed videos with secure signed URLs (`getRecentVideoJobsWithUrls`), and current wallet balance (`getCreditBalance`).
    - Cinematic layout: Header with breadcrumb, live daily usage counter pill (`VideoDailyUsage`), and `RevealGroup` Motion animations with reduced-motion support.
  - Component Architecture (`src/components/video-generator/`):
    - `VideoSpecsBadge` (`video-specs-badge.tsx`): Displays Wan 2.1 model telemetry badge: 720p HD resolution, native 16 FPS frame rate, 5.0s duration (81 frames), AI safety checker indicator. Accessible labels and screen reader text.
    - `AspectRatioSelector` (`aspect-ratio-selector.tsx`): Interactive selector for 16:9 (Landscape, 1280x720), 9:16 (Portrait, 720x1280), and 1:1 (Square, 960x960) with visual frame wireframes, active Motion layout pill, and accessible radiogroup semantics (`role="radiogroup"`, `aria-checked`).
    - `VideoPromptEditor` (`video-prompt-editor.tsx`): Textarea with live character counter (0/2048), warning threshold (>1900 chars), clear button, quick-start cinematic inspiration chips (Drone Flight, Cyberpunk, Macro, Deep Space, Vintage Drift), and validation error alert.
    - `VideoCostSummary` (`video-cost-summary.tsx`): Clear 10-credit generation cost badge, user credit balance breakdown, insufficient credits alert (`role="alert"`) with CTA to Settings, and daily limit reached warning.
    - `VideoDailyUsage` (`video-daily-usage.tsx`): Header pill displaying daily video generation count against tier quota with visual progress bar.
    - `VideoPlayer` (`video-player.tsx`): Custom cinematic HTML5 video player with play/pause, scrub bar, timecode (0:02 / 0:05), loop toggle (default active), volume/mute, fullscreen, and direct authorized download.
    - `VideoPreviewStage` (`video-preview-stage.tsx`): Viewfinder stage supporting idle viewfinder, in-progress pulse with elapsed timer and realistic stage progression (queueing -> synthesizing @ 16 FPS -> encoding H.264 -> private storage), completed player with action bar (copy prompt, reuse in composer, download), failed state with auto-refund notification, and history review view with "Back to Generator" navigation.
    - `RecentVideosGallery` (`recent-videos.tsx`): Responsive gallery of up to 8 recent completed videos with aspect ratio badge, duration badge, thumbnail, hover play overlay, and empty state.
    - `VideoGenerator` (`video-generator.tsx`): Primary coordinator wiring `useVideoGeneration`, server-provided `activeJob` resumption on page load/refresh, validation, blocked checks, and screen reader announcements.
  - Secure Gallery Queries (`src/features/video/queries.ts`):
    - `getRecentVideoJobsWithUrls`: Queries up to 8 completed video jobs for the authenticated user, verifies user-scoped storage key prefixes (`isVideoKeyOwnedBy`), and generates temporary 10-minute signed URLs without leaking raw storage keys.
  - Test Suite (`scripts/test-video-ui.mts` / `npm run test:video-ui`):
    - 74 automated unit/component/integration tests covering:
      - Section 1: Video specs & aspect ratio configuration.
      - Section 2: Prompt validation, sanitization & length limits.
      - Section 3: Timecode formatting, aspect ratio classes & player utilities.
      - Section 4: Video job record to sanitized client view mapping.
      - Section 5: Gallery signed URL resolution with owner namespace verification.
      - Section 6: Client controller state machine progression (idle -> submitting -> polling -> completed).
      - Section 7: Component render & accessibility markup validation using `renderToStaticMarkup`.
  - Boundaries & Spend Invariants:
    - ₹0 spend: zero real Fal.ai calls made.
    - Zero paid cloud infrastructure provisioned.
    - No unapproved migrations or database writes.
    - Production build (`next build`) and TypeScript typecheck (`tsc --noEmit`) verified 100% clean.
    - Live E2E trial deferred until explicit authorization.
- **Batch 6: Legal Policy Reconciliation, UI Review, Full Regression & Release Readiness** (✅ Complete & Verified — 20 legal tests, 1,027 total offline regression tests passing)
  - Legal Policy Reconciliation:
    - `/terms` (Terms of Service): Updated to disclose Alibaba Tongyi Wan 2.1 video generation via Fal.ai (720p HD, 5s @ native 16 FPS); dynamic credit accounting (10 platform credits per generation); ambiguous provider submission handling (debit held in `pending_operator_review` without automatic refund merely due to 15-minute timeout; webhook recovery with correlation token; manual operator review with audit trail; terminal refunds block late completion); daily video limit (1/day for promotional tier; Stage 8 QA authorization in production); shared 1 active job concurrency lock across image and video; Apache 2.0 open weights terms; private Supabase storage with 10-minute signed URLs; truthful retention disclosure (no automated background deletion schedule); and reminder that automated self-service account deletion is currently unsupported in software.
    - `/privacy` (Privacy Policy): Added Features Analytics Inc. (Fal.ai) as an authorized third-party subprocessor for AI video model inference and webhook delivery; documented collection of video prompts, aspect ratios, and generated video MP4 / WebP poster assets; disclosed Ed25519 webhook signatures and HMAC-SHA256 correlation tokens; detailed 10-minute temporary signed URLs strictly verified by session owner prefix; and truthfully reiterated that self-service account deletion remains unsupported in software.
    - `/acceptable-use` (Acceptable Use Policy): Clarified that prohibited content standards apply equally to video and image generation; documented prompt length limit (2,048 chars) and aspect ratios; disclosed that video requests submitted to Fal.ai enforce the provider-level AI safety checker (`enable_safety_checker: true`); disclosed that image prompts dispatch to FLUX.1 Schnell without pre-inference NLP keyword filters; prohibited tampering with webhook signatures, correlation tokens, or signed URLs; and truthfully noted the absence of internal admin moderation dashboards.
    - Test Suite (`scripts/test-legal-policies.mts` / `npm run test:legal`): 20 passing tests verifying all legal routes, grounded terms, subprocessor disclosures, negative invariants (no fabricated operator emails, no fictitious automated AI scanners, no automated self-service account deletion, no fake moderation queues), and Stage 8 video reconciliation.
  - Video UI Browser & Accessibility Review (`/ai-video`):
    - Desktop and mobile layouts verified: single column mobile stack with smooth scroll-to-view helper on submit/history select; two-column desktop grid with sticky composer and preview stage.
    - Viewfinder lifecycle verified across idle viewfinder, in-progress pulse with elapsed timer and 16 FPS stage progression (no fake percentages), completed HTML5 player with seekbar/loop/fullscreen, failed state with auto-refund notification, and history review navigation.
    - Gallery and empty states verified: up to 8 recent videos with aspect ratio badges, duration chips, thumbnails, hover play overlays, and accessible empty state.
    - Accessibility and reduced-motion enhancements: integrated `useReducedMotion()` into `RevealGroup`, `RevealItem`, and `AspectRatioSelector`; added `motion-reduce:animate-none` to laser scanner, pulse icons, and loading spinners.
  - Full Regression Matrix (100% Green, 0 Regressions):
    - Video test suites: `test:video-adapters` (116), `test:video-lifecycle` (70), `test:video-storage` (116), `test:video-webhooks` (161), `test:video-api` (103), `test:video-ui` (74) = **640 video tests**.
    - Platform, image & legal test suites: `test:adapters` (119), `test:ui-logic` (97), `test:ui-flow` (67), `test:ui-recovery` (59), `test:ui-gallery` (39), `test:disaster-recovery` (65), `test:release-hardening` (16), `test:legal` (20) = **482 platform/image tests**.
    - Total offline regression suite: **1,122 tests passed, 0 failed**.
    - Static analysis & build: `npx tsc --noEmit` passed with 0 errors; `next build` passed with 0 errors across all 17 static and dynamic routes; `git diff --check` clean.
  - Production Readiness Assessment:
    - **Ready Items**: Complete asynchronous video generation pipeline, atomic credit debit/refund accounting, SSRF connection pinning, chunk-safe ISOBMFF MP4 validation, Ed25519 webhook signature validation, cryptographically bound delayed correlation tokens, durable event persistence with Fast-ACK, exponential backoff, cron reconciliation endpoint, lightweight polling, client synchronization controller, premium cinematic UI at `/ai-video`, reconciled legal policies, and zero-regression test coverage.
    - **Launch Blockers**:
      1. Single Live E2E Provider Run: Exactly one live verification generation on Fal.ai using developer trial credits to confirm live queue behavior, real network latency, and remote MP4 asset retrieval before public enablement (requires explicit user authorization).
      2. Production Database Migrations: Applying migrations `20261111083000_add_video_generation_fields` and `20261111120000_add_provider_webhook_events` to the production PostgreSQL cluster.
      3. Environment Variables: Setting production `FAL_KEY`, `WEBHOOK_CORRELATION_SECRET`, `CRON_SECRET`, and `STAGE_8_QA_USER_EMAILS` on the hosting provider.
    - **Infrastructure Requirements**:
      1. External Heartbeat / Scheduled Trigger: Configuring a recurring 1-minute or 5-minute HTTP GET to `/api/cron/video-webhooks` with `Authorization: Bearer $CRON_SECRET` (via cron-job.org, GitHub Actions scheduled workflow, or Vercel Cron free tier) to reliably sweep expired leases and reconcile stuck jobs without paid message brokers.
      2. Supabase Storage Bucket Policy: Verifying private bucket configuration for `generated-assets` with service-role write access and signed-URL read access only.
    - **Operational Gaps**:
      1. Operator Resolution Tooling: In the absence of an administrative web UI, operator functions (`resolveAmbiguousJobAsFailed`, `resolveAmbiguousJobAsCompleted`) currently run via backend scripts/REPL. An operational CLI script or admin dashboard should be established for non-developer operators.
      2. Administrative Account Closure: Manual workflow for user account closure and transactional data scrubbing is documented in legal policies but lacks automated back-office tooling.
    - **Legal & Provider-Term Questions**:
      1. Formal Legal Review: Governing law provisions designate India as a draft placeholder; formal legal review by qualified counsel is required to specify registered corporate entities, dispute arbitration venues, and statutory grievance officer appointments.
      2. Enterprise Provider Agreement: Formal review of Fal.ai platform data processing addendum (DPA) and commercial SLA for production scale.
    - **Tests Not Performed / Impossible Offline**:
      1. Live provider inference under real network jitter, cloud edge latency, and provider queue backpressure.
      2. Live Supabase Storage streaming upload to remote AWS Tokyo region.
      3. Live FFmpeg thumbnail extraction in environments where FFmpeg is installed (offline tests gracefully fall back to provider posters / `null` thumbnails).

## 14. Stage 8.1 — Staging Readiness Assessment Findings

Detailed verification audit across 10 staging operational dimensions (Budget Constraint: ₹0, zero live calls executed):

### 1. Environment & Secret Configuration
- `DATABASE_URL`: Staging PostgreSQL pooled/direct string (`NEEDS CONFIGURATION`).
- `AUTH_SECRET`: Staging session signing key (`NEEDS CONFIGURATION`).
- `APP_ORIGIN`: Canonical staging public URL for CSRF validation (`NEEDS CONFIGURATION`).
- `FAL_KEY`: Fal.ai queue submission key (`BLOCKER` — live requests impossible without key).
- `FAL_WEBHOOK_URL`: Webhook ingress URL; defaults to `${APP_ORIGIN}/api/webhooks/video/fal` (`READY`).
- `WEBHOOK_CORRELATION_SECRET`: HMAC-SHA256 correlation secret; falls back to `AUTH_SECRET` (`READY`).
- `CRON_SECRET`: Bearer token for `/api/cron/video-webhooks` (`NEEDS CONFIGURATION`).
- `STAGE_8_QA_USER_EMAILS`: Authorized QA allowlist (`NEEDS CONFIGURATION` — required in staging production mode).
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`: Admin storage access (`NEEDS CONFIGURATION`).

### 2. Database Migrations, Backup & Rollback
- Status: Two safe, non-locking migrations pending in `prisma/migrations/`:
  - `20261111083000_add_video_generation_fields` (Lease columns, check constraints, duration check).
  - `20261111120000_add_provider_webhook_events` (Webhook outbox table, enum, indexes).
- Rollback: Reverse SQL scripts documented and tested (`READY`).
- Pre-Migration Snapshot: `npm run backup:db` prior to running `prisma migrate deploy` (`NEEDS CONFIGURATION`).
- Classification: `NEEDS CONFIGURATION`.

### 3. Supabase Private Storage Configuration
- Bucket: `generated-assets` must be strictly PRIVATE with zero public read access (`NEEDS CONFIGURATION`).
- Access Pattern: Service role write; client reads strictly via 10-minute temporary signed HMAC URLs (`READY`).
- Live Verification: In-memory/mock storage verified; remote live upload to AWS Tokyo is `NOT VERIFIED`.

### 4. Cron Scheduling & Background Worker Recovery
- Route: `GET /api/cron/video-webhooks` with bearer token auth (`READY`).
- Workers: Sweeps expired webhook worker leases, reclaims crashed ingestion triggers, processes pending webhook outbox with exponential backoff, and cleans up ordinary stale jobs older than 15 minutes (`READY`).
- External Scheduler: Needs 1-minute or 5-minute external HTTP heartbeat trigger (`NEEDS CONFIGURATION`).

### 5. Fal.ai Configuration & Webhook Ingress
- Model: `fal-ai/wan/v2.1/t2v-720p` (Wan 2.1 720p, 5s @ native 16 FPS, `enable_safety_checker: true`) (`READY`).
- Cryptographic Verification: Ed25519 JWKS verification and HMAC correlation token binding (`READY`).
- Ingress: Publicly reachable HTTPS endpoint required for Fal delivery (`BLOCKER` for live test).

### 6. Authentication, Authorization & Security
- Session cookies (Auth.js v5 JWT), server QA gating, CSRF check, 10 req/min rate limit, SSRF DNS connection pinning, CSP `media-src` verified clean (`READY`).

### 7. Operator Tooling, Account Deletion & Disaster Recovery
- Operator Functions: `resolveAmbiguousJobAsFailed` and `resolveAmbiguousJobAsCompleted` implemented in `lifecycle.ts` (`READY`); CLI wrapper script for operational staff (`NEEDS CONFIGURATION`).
- Account Deletion: Disabled in software; manual deletion SOP required (`NEEDS CONFIGURATION`).
- DR Tooling: V3 chunk-framed backup and safe reconciliation restore verified (`READY`).

### 8. Monitoring & Diagnostics
- Liveness Probe: `GET /api/health` (`READY`).
- Structured Logs: `[fal-webhook]` and `[video-ingestion]` logs with redacted secrets (`READY`).
- Cloud APM: Centralized Sentry/Datadog logging (`NEEDS CONFIGURATION`).

### 9. Offline vs Live Test Boundaries
- Offline Regression: 1,122 tests passed across 14 suites (`READY`).
- Live Tests: Live migration application, remote Supabase upload, single Fal.ai trial credit E2E run (`NOT VERIFIED`).

### 10. Step-by-Step Staging Setup Checklist
- Phase 1: Environment & Secrets Provisioning.
- Phase 2: Database Backup & Migration Deployment.
- Phase 3: Supabase Storage Bucket Security Audit.
- Phase 4: Public Ingress & Webhook Endpoint Routing.
- Phase 5: External Heartbeat Scheduler Setup.
- Phase 6: Single Live E2E Video Generation Test Run.
- Phase 7: Post-Run Operational & Financial Ledger Verification.

---

## 15. Stage 8.2 — Zero-Cost Operational Preparation Completed

All Stage 8.2 deliverables and three focused reliability corrections have been executed and verified strictly within ₹0 expenditure boundaries (no live API requests, zero trial credit consumption, no cloud database or storage mutations):

### 1. Operator CLI (`scripts/resolve-ambiguous-job.mts`) — Completed Asset Physical Verification
- **Operational Purpose**: Enables operational engineers to safely inspect and settle generation jobs trapped in an ambiguous or unresolved processing state (e.g. provider queue timeout, dropped connection, network partition).
- **Supported Terminal Actions**:
  1. `--action=failed`: Settles job as `FAILED` and dynamically refunds the exact debited credit amount via the double-entry credit ledger (`CreditTransaction` + `CreditWallet`).
  2. `--action=completed`: Settles job as `COMPLETED`, finalizes credit charges, and registers the output asset with validated dimensions, duration, and file size in `GeneratedAsset`.
- **Physical Asset Verification & Safety Invariants (Focused Correction 1)**:
  - **Storage Object Existence Verification**: Before settling as `COMPLETED`, the CLI queries private storage (`storageVerifier`) to confirm the physical object exists in the private bucket. **Storage-key namespace validation alone is explicitly rejected as proof of existence**.
  - **MIME Type & Integrity Checks**: Verifies that the storage object MIME type is supported (`video/mp4` or `video/quicktime`); rejects non-video files (e.g. `text/plain`, `application/octet-stream`).
  - **Size Bounds & Mismatch Protection**: Verifies object size is strictly positive (> 0) and does not exceed `MAX_STORED_VIDEO_BYTES` (35 MB). Rejects any mismatch between specified `--size-bytes` and actual storage size.
  - **Video Metadata Validation**: Enforces supported dimensions (`1280x720` for 16:9, `720x1280` for 9:16, `960x960` for 1:1) and supported duration (`5.0s`).
  - **Thumbnail Verification**: If `--thumbnail-key` is supplied, verifies user namespace ownership, physical object existence in storage, image MIME type (`image/webp`, `image/jpeg`, `image/png`), and size limit (<= 1 MB).
  - **Dry-Run by Default**: Default mode queries and prints masked user details, proposed state transitions, and confirmed storage object verification details without applying any database mutations. Mutation requires explicit `--confirm` flag.
  - **Terminal State Lock**: Strictly blocks modifying already terminal jobs (`COMPLETED`, `FAILED`, `CANCELLED`) or `PENDING` jobs.
- **Verification**: Tested via dedicated offline test suite `scripts/test-operator-cli.mts` (**74/74 tests passing**).

### 2. Administrative Account Deletion SOP (`docs/runbooks/account-deletion-sop.md`) (Focused Correction 2)
- **Document ID**: `SOP-OPS-004` (Classification: Internal Operational Runbook).
- **Documentation Only**: **Zero deletion scripts implemented, provided, or executed**.
- **Regulatory Disclaimer**: Explicitly states that the document **does NOT claim or certify compliance with GDPR, CCPA, the Indian Digital Personal Data Protection Act (DPDP), or any specific regulation**.
- **Legal Verification Requirement**: Marks the proposed **7–10 year retention duration** for financial records and statutory applicability across tax/commercial jurisdictions as **strictly requiring qualified legal verification** before production adoption.
- **Double-Entry Ledger Reconciliation**:
  - Details the fundamental invariant: `CreditWallet.balance == SUM(CreditTransaction.amount)`.
  - Documents **Pattern A (Balancing Forfeiture Transaction)** and **Pattern B (Frozen Balance Preservation)** as proposed engineering patterns strictly requiring qualified legal and product approval before operational enforcement.
  - Prohibits silent balance overwrites or ledger deletions: never executes un-audited `UPDATE "CreditWallet" SET balance = 0` or deletes `CreditTransaction` rows.
- **5-Stage Administrative Protocol**: Request & hold check, job draining & session revocation, PII tombstoning & ledger reconciliation, Supabase storage purge, and ticket audit closure.

### 3. Staging Configuration, Migration & Verification Runbook (`docs/runbooks/staging-setup-runbook.md`) (Focused Correction 3)
- **Document ID**: `RUNBOOK-STAGING-001`.
- **Migration Rollback Data Loss Warning**:
  - Explicitly documents that rolling back migrations after active usage **causes permanent, irreversible data loss**:
    - `DROP TABLE "ProviderWebhookEvent"` destroys all stored webhook payloads, retry counters, and correlation audit logs.
    - `DROP COLUMN "durationSeconds"` and `DROP COLUMN "thumbnailKey"` permanently destroys video playback duration and poster thumbnail references for all video `GeneratedAsset` records.
    - `DROP COLUMN "ingestionToken"` and `DROP COLUMN "ingestionLeaseExpiresAt"` wipes all active ingestion leases from `GenerationJob`.
  - **Mandatory Pre-Rollback Requirements**: Mandates a verified pre-rollback database backup (`npm run backup:db`), a reviewed recovery plan signed off by Lead Engineer / SRE, and traffic freezing on video ingress routes.
- **Prisma Migration-History Reconciliation & Operational Hierarchy**:
  - Clarifies that **forward-fix migrations** or **verified database snapshot restoration** (`npm run restore:db`) are strongly preferred over manual Prisma migration-history deletion.
  - Manual modification or deletion of `_prisma_migrations` is an exceptional emergency fallback that **strictly requires explicit database-owner approval** and a reviewed recovery plan; it is never treated as routine rollback.
  - Explains the emergency protocol for reconciling `_prisma_migrations` and `schema.prisma` if manual DDL is authorized.
- **Non-Execution Notice**:
  - Explicitly states that **no live database rollback drill has been performed on staging or production infrastructure** (strict ₹0 expenditure and zero-mutation boundary).
- **Comprehensive Staging Blueprint**:
  - Complete environment variable dictionary with types, sensitivities, and defaults.
  - External cron heartbeat configuration (1-to-5 minute interval GET to `/api/cron/video-webhooks` with bearer token auth).
  - Private Supabase bucket security requirements (`generated-assets` strictly private, RLS enabled, 10-minute temporary signed URLs).
  - Public Fal.ai webhook ingress setup (HTTPS endpoint, tunnel setup, Ed25519 JWKS verification, HMAC correlation token binding).
  - Clear separation between Configuration Tasks and Verification Tasks with sign-off checklists.

### 4. Total Verification & Regression Metrics
- **Test Suites (15 Suites, 1,196 Passing Tests, 0 Failures)**:
  - `test:operator-cli`: 74 passed (+7 focused storage verification tests)
  - `test:video-adapters`: 116 passed
  - `test:video-lifecycle`: 70 passed
  - `test:video-storage`: 116 passed
  - `test:video-webhooks`: 161 passed
  - `test:video-api`: 103 passed
  - `test:video-ui`: 74 passed
  - `test:legal`: 20 passed
  - `test:release-hardening`: 16 passed
  - `test:disaster-recovery`: 65 passed
  - Image suites (`test:accounting`, `test:adapters`, `test:api`, `test:integration`, `test:ui-logic`, etc.): 381 passed
- **TypeScript Type Check**: `npx tsc --noEmit` clean (0 errors).
- **Next.js Production Build**: `npm run build` compiled and optimized all 23 app routes successfully.
- **Git Diff & Formatting**: `git diff --check` clean (0 whitespace/formatting issues).
- **Budget Constraint**: ₹0 expenditure maintained (no live Fal.ai calls, zero cloud mutations).

## 16. Stage 9 — AI Video Clipper: Architecture, Feasibility & Operational Invariants

### 1. Processing Infrastructure & Runtime Separation
- **Runtime Decoupling**:
  - **Local Development**: Runs in Node.js environment backed by `MockClipperEngine` (zero external dependencies, fast offline test execution) or optional local FFmpeg if present.
  - **Production Runtime**: Requires a dedicated containerized worker process (e.g. Next.js standalone container runner or background task queue).
  - **Serverless Limitation**: Next.js serverless request handlers (e.g. Lambda/Vercel with 10s–60s timeouts, no FFmpeg/Whisper binary runtimes, and constrained memory) **cannot execute long-running video clipping**. The HTTP layer acts solely as an ingestion ingress ticket issuer and status polling boundary.
- **Engine Abstraction (`VideoClipperEngine`)**:
  - `MockClipperEngine`: Deterministic, offline, fixture-driven engine for CI/CD and developer testing without system dependencies.
  - `FfmpegClipperEngine`: Production worker engine utilizing external FFmpeg subprocess for metadata extraction, audio separation, scene detection, dynamic `.ass` subtitle rendering, and single-pass canvas transcoding.
- **Operational Reality & Budget Discipline**:
  - **Commercial video clipping cannot currently be reliably guaranteed at ₹0**. Sustained multi-minute 1080p video transcoding and local Whisper transcription require non-trivial CPU/RAM resources that exceed typical free-tier limits.
  - All paid infrastructure, cloud GPUs, and paid transcription APIs remain strictly disabled.

### 2. Source Video Retention & Cleanup Lifecycle
- **Retention Invariant**: Raw source footage **must never be deleted after audio extraction**. Transcoding and framing candidate clips requires random frame access to the source video throughout rendering.
- **Retention Span**: The source video is retained in ephemeral staging storage (`ephemeral/users/{userId}/uploads/{uploadId}.mp4`) until all requested clips have been rendered, validated, and permanently committed to `generated-assets`.
- **Deletion Triggers**:
  1. *On Success*: Immediately upon saving all rendered clips and thumbnails to permanent storage and committing database records, the ephemeral source object is deleted.
  2. *On Terminal Failure*: The ephemeral source object is deleted (or scheduled for deletion) to prevent quota leakage.
  3. *TTL Orphan Sweep*: An unreferenced or abandoned upload is automatically purged after a configurable TTL (e.g. 2 hours) via reconciliation cron.
- **Observability & Failure Retries**: Deletion attempts are recorded in the job's settings audit trail. If a storage deletion fails due to a network glitch, it does not fail the generation; instead, the key is logged in `pending_cleanups` for retry during periodic reconciliation.

### 3. Metadata Extraction (Non-Contiguous MP4 `moov` Parsing)
- **Faststart & Non-Faststart Support**: The `moov` atom in MP4 files may reside at the beginning (faststart) or the end (standard recording).
- **Two-Phase HTTP Range Strategy**:
  1. *Head Range*: Inspect bytes 0–262,143 (first 256 KB). If `moov` is present, parse container dimensions, duration, and tracks directly.
  2. *Tail Range*: If `moov` is not found in the head, issue a range request for the last 524,288 bytes (trailing 512 KB) where recording devices place the index.
  3. *Bounded Download Fallback*: If `moov` is still unlocated, sequential streaming is capped at a strict safety ceiling (10 MB). Non-compliant files are deferred to local worker file inspection.
- **Malformed & Atom-Bomb Protection**: Strict validation of box headers: reject box lengths exceeding remaining bytes, zero-length non-final boxes, circular offsets, and atoms exceeding 10 MB.

### 4. Empirical Resource Benchmarks & Measurement Protocol
- **Estimation Label**: All CPU, RAM, processing time, and output size numbers are theoretical estimates until empirically measured.
- **Benchmark Protocol**:
  - Test Fixtures: Standard 1080p H.264 @ 30 fps (5 Mbps bitrate, stereo AAC audio) at 60s and 180s durations.
  - Metrics Recorded: Peak RSS memory (MB), CPU core utilization (%), Total end-to-end wall-clock time (s), Audio extraction latency (s), Whisper transcription latency (s), FFmpeg scene detection speed (x realtime), and Single-pass transcode time (s).

### 5. Input Validation & Audio-Optional / Visual-Only Path
- **Visual-Only Clipping Mode**: Videos lacking an audio track (timelapses, screen recordings, silent footage) are officially supported:
  - Visual scene detection and frame motion heuristics operate without audio.
  - Speech transcription and subtitle burning are cleanly bypassed (transcript `[]`, `burnSubtitles: false`).
  - Audio normalization filters are omitted; output video contains no audio stream or a synthesized null track.
  - UI and job status explicitly flag `visual_only: true`.
- **Configurability**: All operational thresholds (`MAX_UPLOAD_SIZE_BYTES`, `MIN_SOURCE_DURATION_SECONDS`, `MAX_SOURCE_DURATION_SECONDS`, `MAX_CLIPS_PER_JOB`, `DEFAULT_CLIP_DURATION_SECONDS`) are resolved via domain configuration functions, preventing hardcoded limits.

### 6. Storage Accounting, Quotas & Orphan Detection
- **Storage Protection Invariant**: The 1 GB Supabase free storage quota is insufficient for uncontrolled commercial clipping.
- **Upload Quotas**: Enforce strict per-user in-flight upload limits (maximum 1 concurrent upload / active job per user; maximum 200 MB temporary staging quota per user).
- **Storage Accounting**: Monitor aggregate ephemeral storage bytes and permanent clip assets.
- **Orphan Sweep**: Ephemeral uploads unlinked to a completed or active `GenerationJob` within 2 hours are flagged as orphans and deleted.
- **Retryable Cleanup Queue**: Any transient failure to delete an ephemeral storage object is recorded in `pending_cleanups` and retried by the background worker.

### 7. Stage 9 — Batch 1 Implementation Completed
- **Domain Configuration (`src/features/clipper/config.ts`)**:
  - Dynamic getters for file size, duration bounds, clip targets, credit pricing (`DEFAULT_CREDIT_COST_PER_CLIP = 5`), and daily quotas (`DEFAULT_DAILY_USER_CLIP_LIMIT = 2`).
  - Supported aspect ratios: 9:16 (vertical), 1:1 (square), 16:9 (landscape).
  - Framing modes: `pillarbox_blur` (default), `center_crop`, `fit`.
  - Allowed MIME types: `video/mp4`, `video/quicktime`, `video/webm`.
  - Storage TTLs: Ephemeral upload TTL = 7,200s (2h), Signed URL TTL = 600s (10m), Ephemeral staging quota = 200 MB per user.
- **Memory-Safe VideoSource Abstraction (`src/features/clipper/source.ts`)**:
  - Replaces raw memory buffering with `VideoSource` contract.
  - `LocalFileVideoSource`: Direct access to worker disk paths with optional automatic cleanup on disposal.
  - `StorageReferenceVideoSource`: Bounded streaming download into isolated scratch temp files, with strict `maxBytes` enforcement and explicit cleanup callbacks.
- **Domain Types & Engine Contracts (`src/features/clipper/types.ts`)**:
  - `VideoClipperEngine` interface operating over `VideoSource`: `extractMetadata()`, `detectScenes()`, `transcribeAudio()`, and `renderClip()`.
  - Structured domain types: `VideoMetadata`, `SceneCut`, `TranscriptWord`, `TranscriptSegment`, `TranscriptResult`, `CandidateHighlight`, `ClipRenderRequest`, `ClipRenderResult`, `ClipperJobSettings`.
- **Pure Input & Container Validation (`src/features/clipper/validation.ts`)**:
  - `inspectContainerMagicBytes`: Binary header inspection for MP4 `ftyp` box and WebM EBML header.
  - `validateUploadMimeType`, `validateUploadSizeBytes`.
  - `validateSourceMetadata`: Enforces 15s–300s duration, 1080p resolution ceiling, and resolves visual-only mode when audio is absent.
  - `validateClipWindow`: Validates 5s–60s clip duration, monotonicity, and total duration boundaries.
  - `validateAspectRatio`, `validateFramingMode`, `validateIdentifier`.
- **User-Isolated Storage Keys (`src/features/clipper/storage/keys.ts`)**:
  - Path traversal defense via `SEGMENT_REGEX` (`/^[A-Za-z0-9_-]{8,64}$/`).
  - Ephemeral uploads: `ephemeral/users/{userId}/uploads/{uploadId}.mp4`.
  - Permanent clips: `users/{userId}/clips/{jobId}/{clipId}.mp4`.
  - Poster thumbnails: `users/{userId}/clips/{jobId}/{clipId}-thumb.webp`.
  - Strict ownership checkers (`isEphemeralUploadKeyOwnedBy`, `isClipKeyOwnedBy`, `isClipThumbnailKeyOwnedBy`, `isClipperKeyOwnedBy`).
- **Deterministic Offline Mock Engine (`src/features/clipper/engine/mock-engine.ts`)**:
  - Implements `VideoClipperEngine`.
  - Returns deterministic 1080p metadata, 5 monotonic scene cuts, and word-level transcript segments.
  - Explicitly handles visual-only / silent videos (`isVisualOnly: true`, empty transcript).
  - Emits structural mock MP4 containers with explicit disclaimer: `isMockOutput: true` (not claimed as genuine re-encoded output).
  - Enforces `VideoSource.materialize().cleanup()` in every operation.
- **Batch 1 Test Suite (`scripts/test-clipper-batch1.mts` / `npm run test:clipper`)**:
  - 43/43 tests passing offline with 0 network calls and 0 database access.

### 8. Stage 9 — Batch 2 Implementation Completed
- **Database Schema & Model Reusability**:
  - Reuses existing Prisma `GenerationJob` model and `GenerationType.VIDEO_CLIP` enum value without schema mutations or DDL migrations.
  - Reuses existing `GeneratedAsset` model with `AssetType.VIDEO` for multi-clip outputs.
  - Reuses existing `CreditWallet` and `CreditTransaction` models for double-entry financial ledger accounting.
  - Leverages existing PostgreSQL partial unique index `GenerationJob_one_active_per_user` on `("userId") WHERE "status" IN ('PENDING', 'PROCESSING')` across all types (`IMAGE`, `VIDEO`, `VIDEO_CLIP`) to enforce single active generation per user globally.
- **Lifecycle State Machine (`src/features/clipper/lifecycle.ts`)**:
  - `validateClipperRequestInput`: Validates untrusted client payloads, verifies storage key ownership, clamps clip counts to [1, 3], and disables subtitles in visual-only mode.
  - `createClipperJob`: Atomically creates `PENDING` job and debits dynamic credit cost in a single ACID transaction with row-level locking (`SELECT FOR UPDATE`).
  - `Dynamic Credit Accounting`: Derives credit cost dynamically from clip count (`DEFAULT_CREDIT_COST_PER_CLIP = 5` credits per clip: 1 clip = 5, 2 clips = 10, 3 clips = 15).
  - `Idempotency Replay & Conflict Guard`: Idempotent replays return existing job record with matching parameters; mismatched payloads with identical idempotency key throw `IDEMPOTENCY_CONFLICT`.
  - `Daily Quota Protection`: Enforces UTC-day quota (`DEFAULT_DAILY_USER_CLIP_LIMIT = 2`) via `countDailyClipJobs`.
  - `Worker Lease Management`: Atomic lease acquisition (`claimClipperLease`) via `ingestionToken` with 5-minute lease expiry, and lease extension (`renewClipperLease`).
  - `Guarded Multi-Clip Completion`: `completeClipperJobWithAssets` verifies lease token, finalizes credits (`chargedCredits = estimatedCredits`), inserts multiple `GeneratedAsset` records, and updates settings.
  - `Atomic Ledger-Backed Refunds`: `failClipperJob` and `cancelClipperJob` refund debited credits atomically via `refundJobDebit()` using idempotent `job-refund:<jobId>` key.
  - `Terminal State Guards`: Completed jobs cannot be refunded; failed or cancelled jobs cannot create assets.
  - `Stale Job Reconciliation Sweep`: `reconcileStaleClipperJobs` detects stuck `PENDING` (> 5m) and expired `PROCESSING` leases (> 15m), transitioning them to `FAILED` with automatic refunds.
  - `Decoupled Ephemeral Source Cleanup`: `recordClipperSourceCleanup` manages retryable pending cleanup records in `settings.pendingCleanups` and `settings.cleanupAudit` without financial side-effects.
  - `Lease-Expiry Fencing Safeguard`: `completeClipperJobWithAssets` and `renewClipperLease` explicitly check `AND ("ingestionLeaseExpiresAt" IS NULL OR "ingestionLeaseExpiresAt" > now())` to block stale workers whose lease expired.
- **Batch 2 Offline Test Suite (`scripts/test-clipper-lifecycle.mts` / `npm run test:clipper-lifecycle`)**:
  - 25/25 tests passing offline across 12 requirement categories with 0 live database or network calls.

### 9. Stage 9 — Batch 3 Implementation Completed
- **Subprocess Runner & Security Boundaries (`src/features/clipper/analysis/runner.ts`)**:
  - Direct `execFile` argument array execution strictly avoiding shell interpolation (command injection defense).
  - Explicit protocol blocking (`assertSafeSubprocessArgs`): rejects `http://`, `https://`, `ftp://`, `smb://`, `rtmp://`, etc., preventing SSRF and arbitrary remote media resolution.
  - Hard timeouts (15s probe, 60s processing) and bounded buffer caps (5 MB stdout/stderr) to defend against memory exhaustion DoS.
  - Pluggable `MockProcessRunner` recording invocation history and supporting custom command overrides for offline testing.
- **Video Metadata Extraction (`src/features/clipper/analysis/metadata.ts`)**:
  - Executes `ffprobe -v quiet -print_format json -show_format -show_streams` via `ProcessRunner`.
  - Invariant: Never assumes container metadata or `moov` atom is located in the first 256 KB.
  - Fractional frame-rate calculation (`parseFpsFraction` for `24/1`, `30000/1001` -> 29.97, etc.).
  - Visual-only detection: sets `hasAudio: false` and `audioCodec: null` when audio streams are absent.
  - Validates output against domain boundaries (`validateSourceMetadata`).
- **Audio Stream Extraction & Silence Detection (`src/features/clipper/analysis/audio.ts`)**:
  - `extractAudioTrack`: Inspects metadata and cleanly bypasses visual-only videos (`{ hasAudio: false, audioPath: null }`) without running FFmpeg or throwing.
  - Demuxes audio to 16kHz mono PCM WAV (`-vn -acodec pcm_s16le -ar 16000 -ac 1`).
  - `detectAudioSilence`: Runs `silencedetect=noise=-30dB:d=0.5` and parses stderr for start/end/duration intervals.
- **Visual Scene Cut Detection (`src/features/clipper/analysis/scene.ts`)**:
  - Runs FFmpeg `select='gt(scene,0.3)',metadata=print:file=-` to detect visual transitions.
  - Monotonic timestamp ordering, minimum duration de-bouncing (1.0s), and origin fallback (0.0s).
- **Whisper Transcription Parser (`src/features/clipper/analysis/transcription.ts`)**:
  - Multi-format ingestion: Whisper native JSON, WebVTT (`.vtt`), and SubRip (`.srt`).
  - **Accuracy Safeguard**: Flags `hasWordLevelAlignment: false` on segments and `isInterpolated: true` on words when acoustic timestamps are absent. Does not falsely claim word-level precision for linearly estimated words.
  - Visual-only handling: returns `{ segments: [], fullText: "", isVisualOnly: true }` without failing.
- **Deterministic Highlight Scoring Engine (`src/features/clipper/analysis/highlight.ts`)**:
  - Multi-factor heuristic: speech density curve (optimal 2.2–3.8 words/sec), hook detection in first 4s (questions, trigger keywords), dead-air penalties, and scene cut snapping.
  - Visual-only video mode: scores based on visual scene pacing and transition density without requiring speech.
  - Greedy non-overlapping selection: returns top requested clips with $\le 20\%$ temporal overlap.
  - Re-indexes word timestamps relative to clip start (`startTime = 0s`).
- **ASS & SRT Subtitle Generator (`src/features/clipper/subtitles/ass-generator.ts`)**:
  - Generates ASS v4.00+ subtitles formatted for canvas resolution (`9:16`, `1:1`, `16:9`).
  - Mobile-friendly chunking (3–5 words per subtitle dialogue).
  - Karaoke word-timing tags (`{\k<centiseconds>}`) for short-form video engagement.
  - **Security Safeguard**: Sanitizes text to strip curly braces `{}` and backslashes `\` to prevent ASS command injection.
  - Generates standard SRT captions as fallback.
- **Batch 3 Offline Test Suite (`scripts/test-clipper-batch3.mts` / `npm run test:clipper-analysis`)**:
  - 34/34 tests passing offline across 7 categories with 0 live network calls and 0 database access.

### 10. Stage 9 — Batch 4 Implementation Completed (Rendering Pipeline, Framing & Output Ingestion)

**Verification honesty:** all rendering tests use a mocked `ProcessRunner`. FFmpeg/FFprobe are **not installed** on the development machine, so the 3 real-encode tests were **SKIPPED**. No real video has been rendered, no output quality has been inspected, and no performance figures exist.

- **Filter graphs (`render/filter-graph.ts`, pure)** — one `-filter_complex` pass per clip, input `#0` only:
  - `center_crop`: `scale=W:H:force_original_aspect_ratio=increase,crop=W:H`.
  - `fit`: `scale=…:decrease:force_divisible_by=2,pad=W:H:(ow-iw)/2:(oh-ih)/2:black`.
  - `pillarbox_blur`: `split` → background cover-scaled at 1/6 resolution (even dims), `boxblur`, upscaled → foreground fit-scaled → `overlay` centred.
  - Then `fps=min(source,30)` → optional `subtitles=filename=subs.ass` → `format=yuv420p` → `[vout]`.
  - Audio (only when present): `loudnorm=I=-14:TP=-1.5:LRA=11` (single-pass), 48 kHz stereo → `[aout]`. Visual-only sources get `-an` and never subtitles.
  - Subtitle filename must match `^[A-Za-z0-9_-]{1,64}\.ass$`; no user text ever enters the graph.
- **Argument builder (`render/args.ts`)** — execFile arrays only: `-nostdin -n` (never overwrite) `-hide_banner -loglevel error`, `-threads N` + `-filter_complex_threads N` (default 2, `CLIPPER_FFMPEG_THREADS`), `-protocol_whitelist file`, input seek `-ss`/`-t`, `libx264 veryfast crf 23 high yuv420p`, `-maxrate` derived so a 60 s clip fits `MAX_STORED_CLIP_BYTES` (30 MB), `-fs` hard output cap, `-map_metadata -1 -map_chapters -1 -sn -dn` (strips e.g. phone GPS metadata), `-movflags +faststart -f mp4`. Paths must be absolute, have no URL scheme and not start with `-`. The runner additionally blocks FFmpeg pseudo-protocols (`concat:`, `subfile:`, `data:`, `crypto:`, `cache:`, `async:`, `tee:`, `fd:`).
- **Output validation (`render/validate-output.ts`)** — `fs.stat` size 1..limit, 12-byte `ftyp` signature read (extension not trusted), FFprobe: container includes `mp4`, exactly one H.264 stream, exact W×H, duration within ±0.5 s of requested, audio presence matches expectation (AAC).
- **Poster frames (`render/thumbnail.ts`)** — FFmpeg extracts one PNG frame from the *rendered* clip (at 25% / ≤3 s) to the scratch dir; sharp converts file-to-file to WebP (q82, 540 px wide, ≤1 MB). The PNG is always removed.
- **`FfmpegClipperEngine` (`engine/ffmpeg-engine.ts`)** — requires an injected runner and **refuses `MockProcessRunner`** unless `allowMockRunner` (tests). Reuses Batch 3 metadata/scene/audio modules. Transcription is never faked: without an injected `SpeechTranscriber` an audio source throws `TRANSCRIPTION_UNAVAILABLE`; visual-only returns an empty transcript. `renderClip` uses a private `mkdtemp` scratch dir, runs FFmpeg with `cwd` = scratch dir (bare subtitle filename, so no Windows filter-path escaping), render timeout default 10 min (`CLIPPER_RENDER_TIMEOUT_MS`, an unbenchmarked safety ceiling), returns **file paths + idempotent `cleanup()`, never buffers**, and removes the scratch dir on any failure. FFmpeg stderr/paths never reach user-visible messages.
- **Runner** — `RunnerOptions.signal` (abort kills the subprocess → `PROCESS_ABORTED`), `windowsHide`, explicit `PROCESS_OUTPUT_LIMIT`. The global default runner is still the mock (Batch 3 behaviour); production code must inject `SystemProcessRunner` explicitly.
- **Lease keeper (`worker/lease.ts`)** — heartbeat renewal every `leaseMs/3`; a rejected renewal, or failing renewals that outlive the last grant minus a 10% margin, marks the lease lost and **aborts the AbortSignal** (killing FFmpeg). `renewNow()` is a database-round-trip fencing checkpoint; in-memory ownership alone is never trusted.
- **Worker (`worker/process-job.ts`, dependency-injected)** — `markStarted` → `claimLease` → materialize source **once** (storage sources downloaded once; analysis and every render use the local copy) → probe → highlights (pre-selected or `planClips` hook) → per clip: fence → render → validate → thumbnail → fence → **stream upload from disk with real `contentLength`** (key tracked before upload, since partial uploads may create objects) → final fence → `completeClipperJobWithAssets` → source cleanup → record cleanup outcomes.
  - Mock/buffer engine output is refused (`ENGINE_OUTPUT_NOT_FILE`, `MOCK_OUTPUT_REFUSED`).
  - Exactly `requestedClipsCount` clips are required (credits were debited for that count); fewer → `INSUFFICIENT_HIGHLIGHTS` failure + refund. Partial delivery/partial refunds are not supported.
  - Failure before completion: delete this worker's uploads → `failClipperJobFenced` (refund) → source deleted only if **this** worker settled.
  - Lease lost (heartbeat, fence or fenced-out completion): no settlement, no refund, **source preserved**; own uploaded objects deleted (their keys are unique and never registered).
  - Ambiguous completion error: job state re-read; if COMPLETED with our keys → completed (nothing deleted); if rolled back → delete uploads, fenced fail; if unreadable → **delete nothing**, report `settlement_unknown`.
  - User-visible failure reason is `Video clipping failed (<CODE>).` only.
- **Lifecycle additions (`lifecycle.ts`)** — `failClipperJobFenced` (PROCESSING + matching token + unexpired lease; idempotent refund), `recordClipperCleanupResults` (row-locked `SELECT … FOR UPDATE` read-modify-write; failed keys added to `pendingCleanups`, successes removed, audit trail capped at 50; never touches status/credits), `getClipperJobCleanupState`. **Fix:** `createClipperJob` no longer schedules a `platform_asset` source (the user's own Stage 8 video) for deletion.
- **Retry sweep (`retryClipperPendingCleanups`)** — terminal jobs only; deletes only the job's own ephemeral source upload or unregistered clip/thumbnail keys under `users/{userId}/clips/{jobId}/`; registered assets, other jobs' keys, foreign users' keys and platform assets are skipped. Not yet scheduled (Batch 5).
- **Wiring (`worker/wiring.ts`, `server-only`)** — Prisma lifecycle + Supabase `putStream`/`delete`. Not re-exported from the index and not invoked anywhere yet.
- **Tests** — `scripts/test-clipper-batch4.mts` (`npm run test:clipper-render`): 69 passed, 0 failed, **3 skipped (real FFmpeg)**. `test:clipper-lifecycle`: 31/31 (6 new Batch 4 tests for fenced failure, cleanup recording and platform-asset retention).
- **Regression (2026-11-11)** — clipper batch1 43/43, lifecycle 31/31, analysis 34/34, video adapters 116/116, video lifecycle 70/70, operator CLI 74/74, `npx tsc --noEmit` clean, `npm run build` successful (worker code is not imported by any route yet, so the build does not exercise it).
- **Known limitations / not verified**
  - Real FFmpeg encode, libass subtitle rendering (font `Inter` may be absent → fontconfig fallback), `loudnorm` output and `libx264` availability in the target FFmpeg build — unverified.
  - Supabase `putStream` with a Node `fs.ReadStream` has not been exercised against a live bucket.
  - No job pickup/scheduling, worker process, cron for `retryClipperPendingCleanups`, or ephemeral-upload TTL sweep yet (Batch 5).
  - Batch 3 analysis timeouts (30 s scene/audio) may be too short for 300 s sources on slow CPUs; untested.
  - Process resource limits are thread caps + timeouts + `-fs` only; CPU/memory cgroup limits must come from the worker container.
  - Lifecycle tests remain in-memory mocks; real PostgreSQL concurrency is unproven.

### 11. Stage 9 — Batch 5 Implementation Completed (Upload Workflow, Job API, Worker Execution, Maintenance, Client Controller)

**Owner decisions (2026-11-11):**
- **A — scene & pacing clipping for all videos.** Clips are chosen from visual scene cuts plus acoustic silence detection only; original audio is preserved. Speech-based scoring and captions are **unavailable** until a real transcription engine is integrated. Nothing is transcribed or faked. The limitation is persisted on each job (`settings.analysis`) and returned by the API (`job.analysis = { highlightMode: "scene_pacing", speechAnalysis: "unavailable", captions: "unavailable", originalAudio: "preserved" }`). Requests asking for captions are rejected with `CAPTIONS_UNAVAILABLE`.
- **Upload cap 50 MB by default** (`DEFAULT_MAX_UPLOAD_SIZE_BYTES`, override `CLIPPER_MAX_UPLOAD_BYTES`). Supabase Free officially caps individual files at 50 MB. **Staging must verify the project's actual bucket/global limit.**

**Upload workflow (`uploads/uploads.ts`, `storage/adapter.ts`, `storage/supabase-clipper.ts`)** — the browser uploads directly to private storage; no video passes through Next.js.
1. `POST /api/clipper/uploads` validates the declared MIME type and size, then under the per-user lock:
   - lists `ephemeral/users/{userId}/uploads` and evaluates the quota (max 1 pending upload, 200 MB staging);
   - writes an **empty placeholder** at the new random upload key;
   - then issues a signed upload URL (upsert over the placeholder).
2. The browser PUTs the file.
3. `POST /api/clipper/uploads/complete` re-checks ownership, real size (1..cap), age (TTL 2 h minus 15 min margin) and the container signature (reads only the first 64 bytes via a Range request; the extension must match the container).
4. `POST /api/clipper/uploads/discard` releases a pending upload (refused while an active job uses it).

**Quota safety (mandatory safeguards):**
- **Fail closed:** listing errors, timeouts (5 s per op), malformed pages, missing object sizes, unexpected sub-folders, or reaching the 20-object ceiling (completeness unprovable) all return `503 QUOTA_UNVERIFIABLE`. An incomplete or failed listing is never treated as zero usage.
- **Concurrency:** check-and-reserve runs inside `withUserLock` (the same `SELECT … FROM "User" … FOR UPDATE` row lock as job creation). Because the placeholder is written inside the lock, any concurrent or later intent sees the reservation in its own listing. A placeholder counts as one pending upload reserving the full upload cap. Tests show 6 concurrent intents → exactly 1 succeeds, and a no-lock control shows the bypass the lock prevents.
- Trade-off: the DB transaction is held across bounded storage calls (list + placeholder, each ≤5 s; tx timeout 20 s).

**Clip job API (`jobs.ts`, `http.ts`, `job-view.ts`, `queries.ts`, `service.ts`)**
- `POST /api/generations/clip` (requires `Idempotency-Key`): body `{ source: {type:"upload", uploadKey} | {type:"platform_asset", assetId}, aspectRatio, framing, clipCount, hints? }`. Validation is strict (unknown aspect or framing values and out-of-range clip counts are rejected, not defaulted).
  - Upload sources are re-verified and must not have been used by any earlier job (`UPLOAD_ALREADY_USED`).
  - Platform-asset sources must be the user's own COMPLETED Stage 8 VIDEO asset under `users/{userId}/videos/`. Note: Stage 8 videos are 5 s long, so they are currently always rejected by the 15 s minimum (`SOURCE_DURATION_OUT_OF_RANGE`).
  - Client duration and dimensions are **hints only** (`settings.sourceMetadataOrigin = "client_hint"`); the worker's FFprobe result is authoritative and violations fail and refund.
  - `burnSubtitles` is always false and `isVisualOnly` is decided by the worker.
  - Idempotent replays are detected **before** source verification, because a finished job's upload is legitimately deleted.
- `GET /api/generations/clip/[jobId]` returns status, credits, analysis limitations, public failure code and message, and the clips with 10-minute signed URLs. It never returns storage keys, cleanup data or internal errors. Signing failures degrade to `null` URLs.
- All state-changing routes use the trusted Origin check, session auth, the process-local rate limit and the 16 KB JSON cap.

**Worker execution (`worker/loop.ts`, `worker/plan-clips.ts`, `scripts/clipper-worker.mts`, `npm run clipper:worker`)**
- Long-running Node process, not a request handler. It refuses to start unless `CLIPPER_WORKER_ENABLED=true` **and** ffmpeg and ffprobe are on PATH; both guards were smoke-tested.
- Picks up PENDING VIDEO_CLIP jobs (oldest first), one at a time. Exclusivity comes from the atomic `markStarted` + lease claim; the two-worker race test confirms exactly one completes and the other reports `not_claimed`. Expired PROCESSING jobs are not resumed; reconciliation fails and refunds them.
- The source is streamed once from a signed URL into bounded scratch storage (storage-js `download()` is avoided because it buffers a Blob).
- Planner: `engine.detectScenes` plus acoustic `detectSilence` (audio sources only) feed `scoreCandidateHighlights` with an explicit `SPEECH_ANALYSIS_UNAVAILABLE` marker (empty transcript). Output words and transcript text are forced empty.
- Shutdown: the first SIGINT/SIGTERM finishes the current job and exits. A second signal aborts FFmpeg via `LeaseKeeper.externalSignal`; the job is then settled `FAILED (WORKER_SHUTDOWN)` with a refund **under the still-valid lease**, and the source is cleaned up.
- Unprocessable settings are skipped and left for reconciliation.

**Maintenance (`maintenance.ts`, `GET /api/cron/clipper`)** — bounded, isolated phases:
1. Stale jobs: `reconcileStaleClipperJobs` with a **30-minute queue-wait** threshold for unclaimed PENDING jobs, so a single busy worker does not cause mass failures.
2. Cleanup retries for terminal jobs with `cleanupStatus` pending or failed (20 per run):
   - an empty stale list is finalized to `cleaned`;
   - ineligible keys, and keys that failed 10 times, are removed from retry and the job is marked `needs_review` (audited), so the sweep can never get stuck.
3. Abandoned-upload sweep (≤50 user folders and ≤100 deletes per run): deletes only well-formed keys older than the 2 h TTL that no ACTIVE clip job references. Missing timestamps, listing or DB errors, and foreign or malformed keys are skipped, never deleted.
- Cron auth uses `Authorization: Bearer $CRON_SECRET` with a timing-safe comparison and **fails closed in production when `CRON_SECRET` is unset**.
- ~~Risk (Stage 8): `/api/cron/video-webhooks` failed *open* when `CRON_SECRET` was unset in production.~~ **Fixed 2026-11-11** — see §16.12.

**Lifecycle changes:**
- `completeClipperJobWithAssets` sets `cleanupStatus` to `cleaned` when nothing is scheduled (platform-asset source).
- `recordClipperCleanupResults` gains `abandonKeys` (→ `needs_review`) and `finalize`.
- `createClipperJob` accepts `extraSettings` (`sourceMetadataOrigin`, `sourceSizeBytes`, `analysis`).

**Client controller (`src/features/clipper/client/`, browser-safe, no UI yet)**
- `api.ts` (never throws), `upload.ts` (XHR PUT with progress and abort), `pending.ts` (localStorage key `yourai:clipper:pending:<userId>`, 10-minute replay window, 24-hour recovery window), and `controller.ts`, a state machine: idle → uploading → verifying → submitting → processing → completed | failed | expired.
- The idempotency key is created once and persisted **before** the POST; ambiguous outcomes (network/5xx) retry with the same key.
- `recover()` never creates a key. Definitive rejections and failed uploads release the upload reservation.

**Tests (2026-11-11)**
- `npm run test:clipper-api`: **73/73**.
- `test:clipper-lifecycle`: 35/35 (+4).
- Mutation checks confirmed the suite fails if the listing fails open (4 failures), the lock is bypassed (1), or the key is not persisted before the POST (1).
- Regression: render 69/69 (3 real-FFmpeg skipped), batch1 43/43 (upload-cap assertion updated to 50 MB), analysis 34/34, video adapters 116/116, video lifecycle 70/70, operator CLI 74/74.
- `npx tsc --noEmit` clean; `npm run build` passes with 29 routes (6 new); `git diff --check` clean.

**Carried-forward validation items (not verified):**
1. Real FFmpeg encoding and subtitle rendering (FFmpeg is absent locally).
2. Supabase against a real bucket:
   - signed upload URLs with upsert over a 0-byte placeholder (and whether 0-byte objects are accepted);
   - `info()` sizes and timestamps, Range reads and streamed downloads;
   - `list()` folder semantics;
   - the browser PUT format for signed uploads;
   - the project's per-object size limit.
3. PostgreSQL concurrency (row lock + JSON-path queries) and a real worker run against a database.
4. Transcription: none — audio-based (speech) clipping and captions remain unavailable.
- **Hosting:** there is no free, reliable host for the long-running worker. At ₹0 it can only run on the owner's own machine.
- The abandoned-upload sweep processes the first 50 user folders per run in name order (possible starvation at scale; acceptable for now).
- The UI is Batch 6; `/video-clipper` is still the placeholder.

### 16.12 Stage 8 security fix — video cron fails closed (2026-11-11, uncommitted, awaiting review)

Batch 5 was accepted on 2026-11-11. Before the commit, the owner asked for this one Stage 8 security fix.

- **Before:** `GET /api/cron/video-webhooks` checked the bearer only when `NODE_ENV=production` **and** `CRON_SECRET` was set, so a missing secret in production left it open.
- **Now:** `src/features/video/cron-auth.ts` → `isVideoCronRequestAuthorized(request, env)`:
  - **Production:** the secret must be configured (blank or whitespace counts as missing) and the request must send `Authorization: Bearer <secret>`, compared timing-safe. Otherwise the response is 401 before any database or storage work.
  - **Outside production:** the endpoint stays open, as before, including when a secret is set.
- The route now calls the helper; no other Stage 8 logic changed (video generation, accounting, migrations and storage are untouched).
- **Tests:** `npm run test:video-cron-auth` (`scripts/test-video-cron-auth.mts`) passes **29/29**.
  - It covers production with a missing or blank secret, a wrong, truncated or schemeless token, and the correct token, which reaches reconciliation (shown by a sentinel database stub). It also checks that development, `test` and an unset `NODE_ENV` stay open.
  - Mutation check: restoring fail-open causes 9 failures.
- **Regression:** video-webhooks 161, video-adapters 116, video-lifecycle 70, video-storage 116, video-api 103 and video-ui 74, all passing.
- **Static checks:** `npx tsc --noEmit` is clean; `npm run build` passes; `git diff --check` is clean.

### 16.13 Stage 9 Batch 6 — Video Clipper UI & editor integration (2026-11-11, uncommitted, awaiting review)

Owner decisions (all approved): (1) `CLIPPER_SUBMISSIONS_ENABLED` operator switch; (2) user cancel + refund for QUEUED jobs only; (3) secure download redirect; (4) clip length shown as fixed information; (5) Fix A for upload reservations.

**UI (`/video-clipper`, replaces the placeholder)**
- Server page loads, owner-scoped and read-only: switch state, limits, analysis capabilities, balance, today's usage, the active clip job, and the last 6 completed jobs with signed links (`loadClipperPageData` in `service.ts`).
- Client: `src/components/video-clipper/`:
  - `video-clipper.tsx` lays out a main column (status, results, source) and a sticky settings column on desktop; it becomes a single column on mobile.
  - Upload: dropzone, and a local preview from an object URL (nothing is uploaded until Generate).
  - Local checks (format, 50 MB, 15–300 s, resolution) run before any reservation.
  - Settings: aspect ratio, framing and clip count use native radio groups.
  - Clip length is fixed text: about 30 s, between 5 and 60 s, with no control.
  - Cost and daily-usage summary.
  - The analysis notice is always shown: scene and pacing only; speech and captions unavailable; original audio kept.
  - Status panel with an aria-live region:
    - the only percentage is real upload progress;
    - "Queued, waiting for a worker" escalates to "Not picked up yet" after 2 minutes;
    - "Processing" appears only once the server reports PROCESSING.
  - Results and recent clips use native `<video>`. Expired signed links are refetched (throttled to once per 20 s per job).
  - Downloads go through the same-origin route.
- The Stage 8 `VideoPlayer` was **not** reused: its download anchor uses the cross-origin signed URL, where browsers ignore `download`. Stage 8 code is unchanged.

**Operator switch `CLIPPER_SUBMISSIONS_ENABLED`** (`resolveClipperSubmissionsSwitch`)
- **Production:** ON only for exactly `true` (trimmed, case-insensitive). Missing, blank or any other value is OFF.
- **Development:** missing is ON; `false` is OFF; anything else is OFF.
- When OFF:
  - new upload reservations and new jobs get 503 `CLIPPER_UNAVAILABLE` before any storage access, lock or debit;
  - an existing Idempotency-Key replay still returns its job;
  - status, verify, discard, cancel and download keep working.
- The client treats this 503 as definitive (no retries) and releases the upload.
- UI wording: "Submissions are open" means only that new jobs are accepted. The page states it cannot tell whether a worker is running, and never claims the worker is online.

**Queued-job cancellation** (`POST /api/generations/clip/[jobId]/cancel`)
- `cancelQueuedClipperJobForUser` (`lifecycle.ts`) runs one transaction:
  `UPDATE … SET status='CANCELLED' WHERE id AND userId AND type='VIDEO_CLIP' AND status='PENDING' AND startedAt IS NULL AND ingestionToken IS NULL`, followed by `refundJobDebit` (idempotent ledger).
- The worker's `markClipperJobStarted` is a conditional UPDATE on the same row, so exactly one wins.
  - If cancel wins, the worker's markStarted and lease claim both fail, and it never reads, renders, settles or deletes anything.
  - If the worker wins, the response is 409 `JOB_ALREADY_STARTED` and polling continues.
- Only the winning cancel deletes the user's own ephemeral upload (`cancel.ts`) and records the result. A failed or unrecorded delete stays in `pendingCleanups` (set at job creation) for the existing cron retry.
- Existing `cancelClipperJob`, the 30-minute queue timeout and refunds are unchanged.

**Download route** (`GET /api/generations/clip/[jobId]/clips/[assetId]/download`)
- Requires a session and a rate-limit check, and validates both ids.
- `getClipAssetForDownload`: the asset must belong to the user and to this job, and the job must be a COMPLETED VIDEO_CLIP job; the key-ownership check is applied again.
- Answers 302 to a **60 s** signed link with `download=yourai-clip-<id>.mp4` (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`).
- `ClipperStorage.createSignedUrl` gained an optional `{ download }`, with the origin pinning kept.

**Fix A (client controller)**
- The reservation key is persisted (`yourai:clipper:reservation:<userId>`) as soon as it is granted.
- It is released on cancel during reservation, upload or verification, on upload or verification failure, on definitive rejection, and on expiry.
- It is cleared when a job takes ownership of the upload.
- On page load, `recover()` releases an orphaned reservation unless another tab holds the Web Locks upload lock (`client/tab-lock.ts`).
- `resume(jobId)` follows the server's active job (another device) without POSTing or creating a key.
- `cancelQueued()` was added. `cancel()` now returns to idle from any active phase, keeping the pending record for recovery.

**Tests (2026-11-11)**
- `npm run test:clipper-b6`: 35/35.
- `npm run test:clipper-ui`: 40/40.
- `test:clipper-lifecycle`: 42/42, of which 7 are new (cancel, duplicate cancel, foreign user, both race orders, stray lease or startedAt, failed job).
- Mutation checks: removing the verification-abort release causes 1 failure; removing the gate causes 1 failure.
- Regression:
  - clipper-api 73, clipper 43, clipper-analysis 34, clipper-render 69 (3 real-FFmpeg tests skipped);
  - video-cron-auth 29, video-webhooks 161, video-adapters 116, video-lifecycle 70, video-storage 116, video-api 103, video-ui 74, operator-cli 74.
- `npx tsc --noEmit` is clean; `npm run build` passes (new routes: cancel, download); `git diff --check` is clean.

### 16.14 Stage 9 Batch 7 — Orientation-Neutral Limits, Phone Rotation Normalization, Upload Recovery, Real FFmpeg & PostgreSQL Integration (2026-11-12, uncommitted, awaiting review)

**1. Orientation-Neutral Limits & Phone Rotation Normalization (`analysis/metadata.ts`, `validation.ts`)**
- Source video validation updated to orientation-neutral bounds: `Math.max(w, h) <= 1920 && Math.min(w, h) <= 1080` and `Math.min(w, h) >= 360`, accepting portrait (1080×1920), landscape (1920×1080), and square (1080×1080) at up to 1080p, while rejecting 4K resolutions.
- Implemented `parseRotationDegrees` parsing `side_data_list` (Display Matrix) and `tags.rotate`, normalizing to `0`, `90`, `180`, `270`.
- Display dimensions normalized in `parseFfprobeJson`: coded landscape with 90° or 270° rotation tag is normalized to portrait display dimensions so smartphone videos render upright without distortion.
- Fixed highlight candidate duration calculation in `analysis/highlight.ts`: dynamically scales `targetDur` down when `clipCount * targetDur > sourceDurationSeconds` with filler fallback, preventing false `INSUFFICIENT_HIGHLIGHTS` failures on short source files.

**2. Upload Reservation Recovery & Safe Release (`uploads/uploads.ts`, `client/`, `POST /api/clipper/uploads/release-pending`)**
- Client generates `uploadId` upfront and persists reservation intent to local storage before the request.
- Dropped response / network failure handling: retries with identical `uploadId`, preventing duplicate reservation quota leaks.
- Added `POST /api/clipper/uploads/release-pending` endpoint releasing unused upload reservations under user lock without touching in-use job assets.
- Discard by ID releases orphaned reservation keys safely under user row lock.

**3. Real FFmpeg Encoding & Suite (`scripts/test-clipper-ffmpeg-real.mts`)**
- 7/7 passed using verified local FFmpeg binary:
  - Synthetic multi-scene fixtures (portrait 1080×1920, landscape 1920×1080, square 1080×1080) with silence gaps.
  - Phone rotation metadata validation (coded landscape + rotation → display portrait, rendered upright).
  - 4K rejection by real metadata validation.
  - Framing modes on portrait source keeping requested canvas.

**4. Real PostgreSQL Integration Suite (`scripts/test-clipper-pg-integration.mts`)**
- 15/15 passed against throwaway loopback cluster (`yourai_it` on port 55432):
  - Partial unique index across generation types (`GenerationJob_one_active_per_user`).
  - Race ×30: user cancel vs worker pickup — exactly one winner, refund iff cancel won, ledger balanced.
  - 10 concurrent cancels of one job → exactly one settles, one refund.
  - Cross-stage one-active-job: clip vs video vs image in parallel → exactly one created.
  - Real user row lock: 8 parallel upload intents → exactly 1 reservation.
  - JSON-path queries against real jsonb: active keys, referenced, pending cleanups, download lookup.
  - Stale queue sweep: 31-minute-old PENDING job fails + refunds once.
  - Global ledger balance invariant preserved across all tests.

**5. Verification Matrix (Stage 9)**
- `npm run test:clipper` (Batch 1 domain): **43/43 PASS**
- `npm run test:clipper-lifecycle` (Batch 2 state machine): **42/42 PASS**
- `npm run test:clipper-analysis` (Batch 3 analysis & subtitles): **34/34 PASS**
- `npm run test:clipper-render` (Batch 4 offline render): **69/69 PASS** (3 real-FFmpeg skipped in offline runner)
- `npm run test:clipper-api` (Batch 5 API & worker loop): **73/73 PASS**
- `npm run test:clipper-b6` (Batch 6 cancel & download): **35/35 PASS**
- `npm run test:clipper-b7` (Batch 7 orientation & recovery): **38/38 PASS**
- `npm run test:clipper-ui` (UI components & flow): **41/41 PASS**
- `npm run test:clipper-ffmpeg` (Real FFmpeg encode): **7/7 PASS** (0 failed, 0 skipped)
- `test:clipper-pg` (Real PostgreSQL integration): **15/15 PASS** (20/20 isolation guard checks passed)
- **Total Stage 9 Tests Passed: 397 tests across 10 suites**
- Stage 8 regression tests: 289 passed (`video-cron-auth` 29, `video-adapters` 116, `video-lifecycle` 70, `operator-cli` 74).
- `tsc --noEmit`: 0 errors.
- `next build --webpack`: 22/22 routes successfully prerendered and optimized.
- `git diff --check`: clean (0 whitespace errors).
