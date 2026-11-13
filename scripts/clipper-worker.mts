/**
 * YourAI Video Clipper worker (Stage 9 Batch 5).
 *
 *   Development:  npm run clipper:worker -- [--once] [--idle-ms=5000]          (tsx, dev dependency)
 *   Production:   node --conditions=react-server dist/clipper-worker.mjs [...]  (bundled by
 *                 `npm run build:worker`; this is what the Dockerfile `clipper-worker` target runs)
 *
 * Long-running Node process (NOT a Next.js request handler). Picks up PENDING VIDEO_CLIP jobs one
 * at a time and renders them with real FFmpeg. Requires:
 *   - CLIPPER_WORKER_ENABLED=true  (explicit opt-in so it is never started by accident)
 *   - ffmpeg + ffprobe on PATH
 *   - DATABASE_URL, SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_STORAGE_BUCKET (same as the web app)
 * Optional: CLIPPER_SCRATCH_DIR, CLIPPER_RENDER_TIMEOUT_MS, CLIPPER_FFMPEG_THREADS.
 *
 * Signals: first SIGINT/SIGTERM = finish the current job then exit; second = abort the current
 * render, settle it FAILED (WORKER_SHUTDOWN, refunded) and exit.
 *
 * NOT run against any real database or storage in Batch 5.
 */

import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: clipper-worker [--once] [--idle-ms=5000]\nRequires CLIPPER_WORKER_ENABLED=true and ffmpeg/ffprobe on PATH.");
  process.exit(0);
}

if (process.env.CLIPPER_WORKER_ENABLED !== "true") {
  console.error("[clipper-worker] Refusing to start: set CLIPPER_WORKER_ENABLED=true to opt in.");
  process.exit(2);
}

{
  const { validateClipperWorkerEnv, describeStartupEnvReport } = await import("../src/lib/env-startup");
  const report = validateClipperWorkerEnv();
  if (!report.ok) {
    console.error(`[clipper-worker] Refusing to start. ${describeStartupEnvReport(report)}`);
    process.exit(2);
  }
}

const once = argv.includes("--once");
const idleArg = argv.find((a) => a.startsWith("--idle-ms="));
const idleMs = idleArg ? Math.max(1_000, Number(idleArg.split("=")[1]) || 5_000) : 5_000;

const { SystemProcessRunner } = await import("../src/features/clipper/analysis/runner");
const runner = new SystemProcessRunner();
if (!(await runner.isAvailable("ffmpeg")) || !(await runner.isAvailable("ffprobe"))) {
  console.error("[clipper-worker] Refusing to start: ffmpeg and ffprobe must be installed and on PATH.");
  process.exit(2);
}

const { FfmpegClipperEngine } = await import("../src/features/clipper/engine/ffmpeg-engine");
const { runClipperWorkerLoop } = await import("../src/features/clipper/worker/loop");
const { prismaClipperWorkerLifecycle, getClipperWorkerStorage } = await import("../src/features/clipper/worker/wiring");
const { getClipperStorage } = await import("../src/features/clipper/storage/supabase-clipper");
const { findPendingClipperJobs } = await import("../src/features/clipper/queries");
const { reconcileStaleClipperJobs } = await import("../src/features/clipper/lifecycle");
const { CLIPPER_QUEUE_WAIT_STALE_MS } = await import("../src/features/clipper/config");
const { prisma } = await import("../src/lib/prisma");

const stop = new AbortController();
const abort = new AbortController();
let signals = 0;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    signals++;
    if (signals === 1) {
      console.log(`[clipper-worker] ${sig}: finishing the current job, then exiting (send again to abort).`);
      stop.abort();
    } else {
      console.log(`[clipper-worker] ${sig}: aborting the current job (it will be refunded).`);
      abort.abort();
    }
  });
}

const scratchDir = process.env.CLIPPER_SCRATCH_DIR?.trim() || path.join(os.tmpdir(), "yourai-clipper");
console.log("[clipper-worker] started", { once, idleMs, scratchDir });

try {
  const result = await runClipperWorkerLoop(
    {
      findPendingJobs: (n) => findPendingClipperJobs(n),
      processDeps: {
        engine: new FfmpegClipperEngine({ runner }),
        lifecycle: prismaClipperWorkerLifecycle,
        storage: getClipperWorkerStorage(),
        scratchDir,
      },
      storage: getClipperStorage(),
      housekeeping: () => reconcileStaleClipperJobs({ pendingThresholdMs: CLIPPER_QUEUE_WAIT_STALE_MS }),
    },
    { once, idleMs, stopSignal: stop.signal, abortSignal: abort.signal },
  );
  console.log("[clipper-worker] stopped", { iterations: result.iterations, jobs: result.outcomes.length });
} finally {
  await prisma.$disconnect().catch(() => {});
}
