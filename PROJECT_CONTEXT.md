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
| 4 | Cloudflare provider adapter + Supabase Storage adapter (119 mocked tests) | ✅ Done |
| 5 | Generation APIs, job processing, recovery | 🔄 Next |
| 6 | `/ai-image` UI | ⏳ Pending |
| 7 | Final testing + release readiness | ⏳ Pending |

## 3. Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Motion · PostgreSQL on Supabase · Prisma 7 (`prisma.config.ts`, client generated to `src/generated/prisma`, `@prisma/adapter-pg`) · Auth.js v5 (Credentials, JWT sessions) · bcryptjs · zod · Cloudflare Workers AI · Supabase Storage (planned).

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

Provider error outcomes drive Stage 5 settlement: `not_run` → `failJobProviderNotRun`; `ran` → `recordProviderSuccess(usage ?? null)` + `failJobAfterProviderSuccess`; `unknown` → `markProviderOutcomeUnknown` (reconcile later). Missing/invalid usage is `null` → charge the reserved amount, never zero.

Lifecycle: `createImageJob` (PENDING) → `markJobStarted` (PROCESSING, commit **before** provider call) → `recordProviderSuccess` → `completeJob`. Failures: `failJobProviderNotRun` (release + refund), `failJobAfterProviderSuccess` (keep usage + refund), `markProviderOutcomeUnknown` (no settlement), `reconcileStaleJobs`.

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

**Storage:** private Supabase bucket `generated-assets` (verified: private, 5,242,880-byte limit, `image/webp` only), keys `users/{userId}/images/{jobId}/{assetId}.webp`, 10-minute signed URLs issued only after an ownership lookup.

## 8. Known risks / open items

- Dev machine → Supabase (Tokyo) is ~200 ms per round trip; host the app in the DB's region for production.
- Supabase Free projects pause after 1 week of inactivity.
- The Neuron budget cannot see other usage on the same Cloudflare account.
- Stage 1 used 499.2 Neurons outside the app budget (covered by the 500 margin).
- User deletion is blocked while a job has an unsettled (`RESERVED`) reservation — an account-deletion feature must settle first.
