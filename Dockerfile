# ==============================================================================
# Pixora — Production Multi-Stage Dockerfile (Next.js 16 Standalone + Clipper worker)
#
#   Web app (default target):   docker build -t pixora-web .
#   Clipper worker:             docker build --target clipper-worker -t pixora-clipper-worker .
#
# No secrets are needed or allowed at build time: .dockerignore keeps .env*, certificates and
# keys out of the build context, and the builder stage fails if any .env file reaches the
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

USER nextjs

EXPOSE 3000

# Next.js standalone entrypoint (src/instrumentation.ts validates the environment at startup)
CMD ["node", "server.js"]
