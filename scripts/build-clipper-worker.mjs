// Bundles the clipper worker (scripts/clipper-worker.mts + the src/ modules it imports, including the
// generated Prisma client) into one plain-Node ESM file, so production never needs tsx or TypeScript.
//
//   npm run build:worker   ->  dist/clipper-worker.mjs
//   run:  node --conditions=react-server dist/clipper-worker.mjs [--once] [--idle-ms=5000]
//
// npm packages stay external and are resolved from the production node_modules at runtime
// (`npm ci --omit=dev`). `--conditions=react-server` is required at runtime as well, because the
// shared server modules import "server-only", which only resolves to a no-op under that condition.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: root,
  entryPoints: ["scripts/clipper-worker.mts"],
  outfile: "dist/clipper-worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  conditions: ["react-server"],
  tsconfig: "tsconfig.json",
  // Some server modules load packages lazily with require() (e.g. @supabase/supabase-js); give the
  // ESM bundle a real CommonJS require so those calls resolve from node_modules at runtime.
  banner: { js: 'import { createRequire as __youraiCreateRequire } from "node:module";\nconst require = __youraiCreateRequire(import.meta.url);' },
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
