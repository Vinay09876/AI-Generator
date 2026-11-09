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
| 5 | Generation APIs, job processing, recovery | ✅ Implementation complete — offline API tests 161/161, adapter tests 119/119, DB integration tests 28/28, accounting tests 65/65 (dedicated test DB; all test records cleaned up), TypeScript check passed, `next build` passed. Not yet committed. |
| 6 | `/ai-image` UI | ⏳ Pending |
| 7 | Final testing + release readiness | ⏳ Pending |

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
| API routes | `src/app/api/generations/image/route.ts` (POST), `src/app/api/generations/[jobId]/route.ts` (GET), `src/app/api/assets/[assetId]/route.ts` (GET → 302) |
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
- Test database: dedicated Supabase project (`TEST_DATABASE_URL`, verified separate from production by project ref). Migrations on it require explicit approval.

## 9. Deployment requirements

- **Build command:** run `npx prisma generate` before `next build` (e.g. `npx prisma generate && npm run build`). The generated client (`src/generated/`) is git-ignored and `npm run build` does not generate it.
- **Runtime:** Node.js (required for `sharp` and the Postgres driver; the API routes declare `runtime = "nodejs"`). Install dependencies on the host's own platform so the correct `sharp` binary is used.
- **Request duration:** the host must allow requests of **at least 90 seconds** (`maxDuration = 90` on the generation route; 60 s provider timeout < 90 s < 5 min reconciliation).
- **`APP_ORIGIN`:** set to the deployed public origin (comma-separated if several). If unset in production, every generation POST is rejected with 403.
- **Never configure `TEST_DATABASE_URL` in production.**
- **Required environment variables:** `DATABASE_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST` (or `AUTH_URL`), `APP_ORIGIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`. All server-only; none may be exposed as `NEXT_PUBLIC_*`.
- **Build-time network:** `next/font/google` downloads fonts during `next build`, so the build environment needs internet access. The build itself does not access the database, Cloudflare or Supabase (verified).
- **Region:** host close to the database (Supabase, Tokyo) to avoid ~200 ms per query round trip.
- **Supabase Free tier:** 1 GB storage, limited egress, project pauses after 1 week of inactivity.
