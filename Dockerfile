# ==============================================================================
# YourAI — Production Multi-Stage Dockerfile (Next.js 16 Standalone)
# ==============================================================================

# 1. Base image with required system libraries (libc6-compat & openssl for Alpine)
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# 2. Dependencies installation
FROM base AS deps
COPY package.json package-lock.json* ./
# Install exact production + dev dependencies required to build the application
RUN npm ci

# 3. Builder
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Generate Prisma Client to src/generated/prisma
RUN npx prisma generate

# Build Next.js application (emits .next/standalone and .next/static)
RUN npm run build

# 4. Production Runner
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

# Next.js standalone entrypoint
CMD ["node", "server.js"]
