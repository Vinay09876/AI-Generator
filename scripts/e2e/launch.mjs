// Isolated launcher: runs a command inside the isolated copy with a MINIMAL, allow-listed
// environment (no inherited DATABASE_URL / keys from the user's shell), the egress guard preloaded,
// and the isolation guard executed first. Aborts if the guard fails.
//   node launch.mjs --root <E2E_ROOT> --repo <repoDir> [--db yourai_e2e|yourai_it] [--ffmpeg <binDir>]
//                   [--set KEY=VALUE ...] -- <command...>
//   node launch.mjs ... --sync      (re-copy src/, scripts/, prisma/, package.json into the copy)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep >= 0 ? argv.slice(0, sep) : argv;
const command = sep >= 0 ? argv.slice(sep + 1) : [];
const opt = (name, def) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : def;
};
const ROOT = path.resolve(opt("--root") ?? "");
const REPO = path.resolve(opt("--repo") ?? "");
const APP = path.join(ROOT, "app");
const DB = opt("--db", "yourai_e2e");
const FFMPEG = opt("--ffmpeg");
const sets = opts.flatMap((o, i) => (o === "--set" ? [opts[i + 1]] : []));
if (!fs.existsSync(APP)) {
  console.error(`isolated copy not found: ${APP}`);
  process.exit(2);
}

if (opts.includes("--sync")) {
  const isEnv = (n) => /^\.env/i.test(n) && n !== ".env.example";
  const copy = (src, dst) => {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const n of fs.readdirSync(src)) if (!isEnv(n)) copy(path.join(src, n), path.join(dst, n));
    } else fs.copyFileSync(src, dst);
  };
  for (const rel of ["src", "scripts", "prisma", "package.json", "tsconfig.json", "prisma.config.ts"]) {
    const s = path.join(REPO, rel);
    if (!fs.existsSync(s)) continue;
    if (fs.statSync(s).isDirectory()) fs.rmSync(path.join(APP, rel), { recursive: true, force: true });
    copy(s, path.join(APP, rel));
  }
  console.log("[launch] synced src/, scripts/, prisma/ and config into the isolated copy");
  if (!command.length) process.exit(0);
}

const ALLOW = ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "SystemDrive"];
const env = {};
for (const k of ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
const basePath = [path.dirname(process.execPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"];
env.PATH = [FFMPEG, path.join(APP, "node_modules", ".bin"), ...basePath].filter(Boolean).join(path.delimiter);
const guardFile = path.join(REPO, "scripts", "e2e", "deny-egress.mjs");
Object.assign(env, {
  E2E_ROOT: ROOT,
  E2E_REPO_DIR: REPO,
  E2E_EGRESS_LOG: path.join(ROOT, "logs", "egress-blocked.log"),
  NODE_OPTIONS: `--import ${pathToFileURL(guardFile).href}`,
  DATABASE_URL: `postgresql://postgres@127.0.0.1:55432/${DB}`,
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SECRET_KEY: "e2e-local-standin-key",
  SUPABASE_STORAGE_BUCKET: "generated-assets",
  CLOUDFLARE_ACCOUNT_ID: "e2e-blocked-account",
  CLOUDFLARE_AI_API_TOKEN: "e2e-blocked-not-a-real-key",
  FAL_KEY: "e2e-blocked-not-a-real-key",
  AUTH_SECRET: "e2e-isolated-auth-secret-0123456789abcdef",
  AUTH_URL: "http://127.0.0.1:3100",
  AUTH_TRUST_HOST: "true",
  APP_ORIGIN: "http://127.0.0.1:3100",
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(REPO, "scripts", "e2e", "font-mock.cjs"),
  CLIPPER_SCRATCH_DIR: path.join(ROOT, "worker-scratch"),
  STAGE_8_QA_ALLOWLIST: "e2e-a@e2e.local,e2e-b@e2e.local,e2e-c@e2e.local",
});
for (const s of sets) {
  const i = s.indexOf("=");
  env[s.slice(0, i)] = s.slice(i + 1);
}
fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
fs.mkdirSync(env.CLIPPER_SCRATCH_DIR, { recursive: true });

const guard = spawnSync(process.execPath, [path.join(REPO, "scripts", "e2e", "isolation-guard.mjs")], { cwd: APP, env, stdio: "inherit" });
if (guard.status !== 0) {
  console.error("[launch] isolation guard FAILED — not starting anything.");
  process.exit(1);
}
if (!command.length) process.exit(0);

const child = spawn(command.join(" "), { cwd: APP, env, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
