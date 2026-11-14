# ==============================================================================
# Pixora — Production Multi-Stage Dockerfile (Next.js 16 Standalone + Clipper worker)
#
#   Web app (default target):   docker build -t pixora-web .
#   Clipper worker:             docker build --target clipper-worker -t pixora-clipper-worker .
#
# No secrets are needed or allowed at build time: .dockerignore keeps .env*, certificates and
# keys out of the build context (sole exception: the public, fingerprint-pinned Supabase root CA
# in config/tls/, shipped at /app/certs/ for verified database TLS), and the builder stage fails if any .env file reaches the
# standalone output. All runtime configuration is injected as environment variables.
# Database migrations are NOT run by these images (operator step: `npx prisma migrate deploy`
# from a reviewed checkout — see docs/runbooks/staging-setup-runbook.md).
# ==============================================================================

# 1. Base image with required system libraries (libc6-compat & openssl for Alpine)
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# 2. All dependencies (build tooling included)
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# 3. Production-only dependencies (runtime node_modules for the clipper worker)
FROM base AS prod-deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# 4. Builder
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# The repository has no public/ directory; create it so the runner COPY below always succeeds.
RUN mkdir -p public

# Generate Prisma Client to src/generated/prisma (needs no DATABASE_URL — prisma/cli-database-url.ts)
RUN npx prisma generate

# Build Next.js (emits .next/standalone and .next/static) and bundle the clipper worker
# (emits dist/clipper-worker.mjs; plain Node, no tsx/TypeScript at runtime)
RUN npm run build && npm run build:worker

# Fail the build if any env file made it into the standalone output
RUN if find .next/standalone -name '.env*' ! -name '.env.example' | grep -q .; then \
      echo "ERROR: .env file found in .next/standalone" >&2; exit 1; \
    fi

# 5. Clipper worker (long-running FFmpeg render process; never serves HTTP)
FROM node:20-alpine AS clipper-worker
RUN apk add --no-cache libc6-compat openssl ffmpeg
WORKDIR /app

ENV NODE_ENV=production
ENV CLIPPER_SCRATCH_DIR=/tmp/pixora-clipper

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 worker

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist/clipper-worker.mjs ./dist/clipper-worker.mjs

# Build-time sanity check: the worker refuses to start without these binaries.
RUN ffmpeg -version > /dev/null && ffprobe -version > /dev/null

# Public Supabase root CA for verified database TLS (DATABASE_URL ...&sslmode=verify-full&sslrootcert=/app/certs/supabase-root-2021.crt).
# Root-owned and read-only for the runtime user; the build fails unless it is exactly the pinned certificate.
COPY --from=builder /app/config/tls/supabase-root-2021.crt /app/certs/supabase-root-2021.crt
RUN openssl x509 -in /app/certs/supabase-root-2021.crt -noout -fingerprint -sha256 \
      | grep -qx 'sha256 Fingerprint=80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA' \
    && chmod 0444 /app/certs/supabase-root-2021.crt

USER worker

# Still requires CLIPPER_WORKER_ENABLED=true plus DATABASE_URL, SUPABASE_URL, SUPABASE_SECRET_KEY and
# SUPABASE_STORAGE_BUCKET at runtime; it exits with a clear error otherwise.
CMD ["node", "--conditions=react-server", "dist/clipper-worker.mjs"]

# 6. Web runner (default target: keep this stage last)
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Run as non-root user for container security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy public assets and static build output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Public Supabase root CA for verified database TLS (see the clipper-worker stage). Root-owned, read-only,
# fingerprint-pinned; src/lib/env-startup.ts refuses to start in production unless DATABASE_URL uses it.
COPY --from=builder /app/config/tls/supabase-root-2021.crt /app/certs/supabase-root-2021.crt
RUN openssl x509 -in /app/certs/supabase-root-2021.crt -noout -fingerprint -sha256 \
      | grep -qx 'sha256 Fingerprint=80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA' \
    && chmod 0444 /app/certs/supabase-root-2021.crt

USER nextjs

EXPOSE 3000

# Next.js standalone entrypoint (src/instrumentation.ts validates the environment at startup)
CMD ["node", "server.js"]
