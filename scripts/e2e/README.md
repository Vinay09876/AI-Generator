# Isolated browser E2E (Stage 9 Batch 7)

Runs the real app, the real clipper worker and real Chrome **without touching any real database,
storage or provider**. Everything lives in a scratch folder (`E2E_ROOT`); nothing here is used by
the production app.

| Piece | What it is |
|---|---|
| `prepare-copy.mjs` | Copies the repo to `E2E_ROOT/app` **without** `.git`, `.next` or any `.env*` file except `.env.example` (fails if one appears). `node_modules` is copied locally, so no network is needed. |
| `launch.mjs` | Runs a command in the copy with a **minimal allow-listed environment** (the user's shell variables are not inherited), loopback-only configuration, and the egress guard preloaded. It runs `isolation-guard.mjs` first and **aborts if any check fails**. `--sync` refreshes `src/`, `scripts/`, `prisma/` and config. |
| `deny-egress.mjs` | `--import` preload for every Node process (app, its workers, the clipper worker, Prisma CLI). It blocks every non-loopback TCP/TLS connection and DNS lookup and logs each attempt to `logs/egress-blocked.log`. |
| `isolation-guard.mjs` | 20 checks: working directory, no `.env`/`.git`, database = throwaway cluster on port 55432 (data directory inside `E2E_ROOT`), storage = local stand-in, provider keys = blocked sentinels, egress actually blocked (fetch and raw TCP probes), loopback reachable. |
| `pg-cluster.mjs` | `initdb`/`pg_ctl` for a throwaway cluster (`127.0.0.1:55432`, loopback-only `pg_hba`). Databases `yourai_e2e` and `yourai_it`. |
| `storage-standin.mjs` | **Local stand-in** for the Supabase Storage endpoints the app uses. It does **not** verify real Supabase behaviour. |
| `font-mock.cjs` | Answers `next/font/google` through Next's `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` test hook, so the build needs no network (fallback fonts are rendered). |
| `make-fixtures.mjs` | FFmpeg-generated portrait, landscape and square fixtures, plus oversize and unsupported files. |
| `browser-e2e.mjs` | Playwright-core scenarios against installed Chrome. The browser can resolve only `127.0.0.1` (`--host-resolver-rules`). CSP is bypassed because the stand-in is `http://127.0.0.1`, while the production CSP allows only `https://*.supabase.co`. |

## Order

1. `node pg-cluster.mjs init|start <E2E_ROOT>/pgdata`
2. `node prepare-copy.mjs <repo> <E2E_ROOT>/app`
3. Start the stand-in (`STANDIN_DIR`, `STANDIN_SECRET_KEY=e2e-local-standin-key`).
4. `node launch.mjs --root <E2E_ROOT> --repo <repo>` with no command, to run the guard only.
5. Apply migrations, for each test database:
   `node launch.mjs … --db yourai_it -- npx prisma migrate deploy` (and again with `--db yourai_e2e`).
6. Run the PostgreSQL integration suite:
   `node launch.mjs … --db yourai_it -- npm run test:clipper-pg`
7. In the copy only, `next.config.ts` gets `typescript.ignoreBuildErrors` (see `PROJECT_CONTEXT.md`); then build:
   `node launch.mjs … --set NODE_ENV=production -- npx next build --webpack`
8. Start the app:
   `node launch.mjs … --set NODE_ENV=production --set CLIPPER_SUBMISSIONS_ENABLED=true --set STAGE_8_QA_USER_EMAILS=e2e-a@e2e.local -- npx next start -p 3100 -H 127.0.0.1`
9. Run the browser scenarios:
   `node --import <deny-egress> browser-e2e.mjs --root … --repo … --ffmpeg <bin>`

The only external downloads are the FFmpeg build (checksum-verified) and `playwright-core`, which
is installed into `E2E_ROOT/tools` only, never into this repository.
