// Creates the isolated application copy for the browser E2E run.
//   node scripts/e2e/prepare-copy.mjs <repoDir> <targetDir>
// Copies the working tree WITHOUT .git, .next, any .env* file except .env.example, and build
// caches. node_modules is copied locally (no network). Fails if any secret-bearing env file would
// be present in the target afterwards.
import fs from "node:fs";
import path from "node:path";

const [repo, target] = process.argv.slice(2).map((p) => path.resolve(p));
if (!repo || !target) {
  console.error("usage: prepare-copy.mjs <repoDir> <targetDir>");
  process.exit(2);
}
if (target.startsWith(repo + path.sep) || target === repo) {
  console.error("refusing: target must be outside the repository");
  process.exit(2);
}

const SKIP_DIRS = new Set([".git", ".next", "coverage"]);
const isEnvFile = (name) => /^\.env(\..*)?$/i.test(name) && name !== ".env.example";
const SKIP_FILES = new Set(["tsconfig.tsbuildinfo"]);
let copied = 0;
let skippedEnv = 0;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyDir(s, d);
    } else if (entry.isFile()) {
      if (isEnvFile(entry.name)) {
        skippedEnv++;
        continue;
      }
      if (SKIP_FILES.has(entry.name)) continue;
      fs.copyFileSync(s, d);
      copied++;
    } else if (entry.isSymbolicLink()) {
      // node_modules/.bin shims etc.: copy the link target content when it is a file
      try {
        const real = fs.realpathSync(s);
        if (fs.statSync(real).isFile()) fs.copyFileSync(real, d);
      } catch {
        // ignore dangling links
      }
    }
  }
}

if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
copyDir(repo, target);

// Post-condition: no secret-bearing env file anywhere in the copy (node_modules included).
const offenders = [];
(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(p);
    else if (isEnvFile(entry.name) && !p.includes(`${path.sep}node_modules${path.sep}`)) offenders.push(p);
  }
})(target);
if (offenders.length) {
  console.error("ISOLATION FAILURE: env files present in copy:", offenders);
  fs.rmSync(target, { recursive: true, force: true });
  process.exit(1);
}
console.log(`[prepare-copy] copied ${copied} files to ${target}; skipped ${skippedEnv} env file(s); no .env* present`);
