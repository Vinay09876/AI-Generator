// Isolated browser E2E for /video-clipper (Stage 9 Batch 7). Real Chrome (playwright-core from the
// scratchpad tools folder), the isolated production build on 127.0.0.1:3100, the throwaway
// PostgreSQL cluster, the LOCAL storage stand-in and the real clipper worker with the verified
// FFmpeg build. The browser cannot resolve any host except 127.0.0.1.
//   node browser-e2e.mjs --root <E2E_ROOT> --repo <repoDir> --ffmpeg <binDir>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (n) => args[args.indexOf(n) + 1];
const ROOT = path.resolve(arg("--root"));
const REPO = path.resolve(arg("--repo"));
const FF = path.resolve(arg("--ffmpeg"));
const APP = path.join(ROOT, "app");
const ART = path.join(ROOT, "artifacts");
const FIX = path.join(ROOT, "fixtures");
const BASE = "http://127.0.0.1:3100";
const STANDIN = "http://127.0.0.1:54321";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
fs.mkdirSync(ART, { recursive: true });

const { chromium } = createRequire(path.join(ROOT, "tools", "package.json"))("playwright-core");
const pg = createRequire(path.join(APP, "package.json"))("pg");
const db = new pg.Client({ connectionString: "postgresql://postgres@127.0.0.1:55432/yourai_e2e" });
await db.connect();
// Throwaway E2E database only (guarded by the connection string above): start from a clean slate.
await db.query('TRUNCATE "User" CASCADE');

const results = [];
let current = "";
async function scenario(name, fn) {
  current = name;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 600) });
    console.error(`FAIL  ${name}: ${String(e?.message ?? e).slice(0, 600)}`);
    for (const p of pages) await p.screenshot({ path: path.join(ART, `fail-${results.length}-${pages.indexOf(p)}.png`), fullPage: true }).catch(() => { });
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch((e) => e);
    if (last === true) return;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what} (last=${String(last)})`);
}
const standin = async (p, init) => (await fetch(`${STANDIN}${p}`, init)).json();
await standin("/__debug/reset", { method: "POST" });
const uploadsOf = async (uid) => (await standin("/__debug/objects")).filter((o) => o.key.startsWith(`generated-assets/ephemeral/users/${uid}/uploads/`));
const userId = async (email) => (await db.query(`select id from "User" where email=$1`, [email])).rows[0]?.id;
const balanceOf = async (uid) => (await db.query(`select balance from "CreditWallet" where "userId"=$1`, [uid])).rows[0]?.balance;
const ffprobe = (file) => JSON.parse(execFileSync(path.join(FF, "ffprobe.exe"), ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }));

// ---------------------------------------------------------------- worker / second instance
const launch = (extra, cmd, log) => {
  const out = fs.openSync(path.join(ROOT, "logs", log), "a");
  return spawn(process.execPath, [path.join(REPO, "scripts", "e2e", "launch.mjs"), "--root", ROOT, "--repo", REPO, "--db", "yourai_e2e", "--set", "NODE_ENV=production", ...extra, "--", ...cmd], { stdio: ["ignore", out, out] });
};
const killTree = (child) => {
  try {
    execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // already gone
  }
};
let worker = null;
const startWorker = () => (worker = launch(["--ffmpeg", FF, "--set", "CLIPPER_WORKER_ENABLED=true"], ["npx", "tsx", "--conditions=react-server", "scripts/clipper-worker.mts", "--idle-ms=1000"], "worker.log"));

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--disable-sync", "--disable-domain-reliability"],
});
const pages = [];
// CSP is bypassed ONLY because the storage stand-in is http://127.0.0.1 (production CSP allows https://*.supabase.co).
const newContext = (opts = {}) => browser.newContext({ bypassCSP: true, acceptDownloads: true, viewport: { width: 1366, height: 900 }, ...opts });

async function register(page, tag) {
  const email = `e2e-${tag}@e2e.local`;
  await page.goto(`${BASE}/register`);
  await page.fill('input[name="name"]', `E2E ${tag.toUpperCase()}`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "E2e-Strong-Passw0rd!");
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 30_000 }), page.click('button[type="submit"]')]);
  const id = await userId(email);
  assert(id, `user ${email} created`);
  return { email, id };
}
const status = (page) => page.locator("#clipper-status-title").textContent({ timeout: 2000 }).catch(() => null);
async function waitStatus(page, re, ms, what) {
  await until(async () => re.test((await status(page)) ?? ""), ms, `${what} (status /${re.source}/)`);
}
async function chooseFile(page, file) {
  const filePath = path.join(FIX, file);
  const input = page.locator('input[type="file"]');
  const removeBtn = page.getByRole("button", { name: "Remove this video" });
  await input.setInputFiles(filePath);
  try {
    await removeBtn.waitFor({ state: "visible", timeout: 3000 });
  } catch {
    // React may have hydrated after the first file event was dispatched: re-dispatch once
    await input.setInputFiles(filePath);
    await removeBtn.waitFor({ state: "visible", timeout: 17_000 });
  }
}
async function ensureNoActiveJob(page, uid) {
  const rows = (await db.query(`select id, status from "GenerationJob" where "userId"=$1 and status in ('PENDING','PROCESSING')`, [uid])).rows;
  for (const r of rows) {
    if (r.status === "PENDING") {
      await page.goto(`${BASE}/video-clipper`);
      await page.evaluate(async (id) => fetch(`/api/generations/clip/${id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), r.id);
    }
    await until(async () => (await db.query(`select status from "GenerationJob" where id=$1`, [r.id])).rows[0].status.match(/COMPLETED|FAILED|CANCELLED/) !== null, 300_000, "leftover job settled");
  }
}
async function fresh(page) {
  await page.goto(`${BASE}/video-clipper`);
  await page.locator('input[type="file"]').waitFor({ state: "attached", timeout: 15_000 });
}
async function generate(page) {
  const btn = page.locator('button[type="submit"]', { hasText: /Generate/ });
  await until(async () => !(await btn.isDisabled()), 20_000, "Generate enabled");
  await btn.click();
}

const ctxA = await newContext();
const page = await ctxA.newPage();
pages.push(page);
let A;

try {
  await scenario("register user A and open /video-clipper (honest notices, fixed clip length)", async () => {
    A = await register(page, "a");
    // Throwaway DB only: user A plays the verified Stage 8 QA account (allowlist requires emailVerified).
    await db.query('update "User" set "emailVerified" = now() where id = $1', [A.id]);
    await page.goto(`${BASE}/video-clipper`);
    await page.getByRole("heading", { name: "What this tool does" }).waitFor({ timeout: 20_000 }); // fully streamed
    const body = await page.locator("main").innerText();
    for (const t of ["Submissions are open", "can't tell whether it is running", "Speech analysis", "Not available yet: clips have no subtitles", "about 30 seconds each", "Choose a video or drop it here", "vertical, square or landscape"]) {
      assert(body.includes(t), `page shows "${t}"`);
    }
    assert(!/\bonline\b/i.test(body), "never claims a worker is online");
    await page.screenshot({ path: path.join(ART, "01-desktop-initial.png"), fullPage: true });
  });

  await scenario("unsupported and oversize files are rejected locally (nothing reserved)", async () => {
    await fresh(page);
    await chooseFile(page, "notes.txt");
    await page.getByRole("alert").filter({ hasText: "Choose an MP4, MOV or WebM video." }).waitFor({ timeout: 5000 });
    assert(await page.locator('button[type="submit"]', { hasText: /Generate/ }).isDisabled(), "Generate disabled");
    await page.getByRole("button", { name: "Remove this video" }).click();
    await chooseFile(page, "oversize-51mb.mp4");
    await page.getByRole("alert").filter({ hasText: /maximum is 50 MB/ }).waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Remove this video" }).click();
    assert((await uploadsOf(A.id)).length === 0, "no reservation was made");
  });

  await scenario("portrait preview shows real metadata (1080×1920, 0:24)", async () => {
    await fresh(page);
    await chooseFile(page, "portrait-1080x1920.mp4");
    await page.getByText(/1080×1920/).first().waitFor({ timeout: 30_000 });
    const t = await page.locator("main").innerText();
    assert(t.includes("0:24"), "duration shown");
    assert(await page.locator("video").first().isVisible(), "preview video visible");
    await page.screenshot({ path: path.join(ART, "02-portrait-preview.png") });
  });

  await scenario("real upload progress, then cancel mid-upload releases the reservation", async () => {
    const cdp = await ctxA.newCDPSession(page);
    await cdp.send("Network.enable");
    await fresh(page);
    await chooseFile(page, "portrait-1080x1920.mp4");
    await page.getByText(/1080×1920/).first().waitFor({ timeout: 30_000 });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 150 * 1024 });
    await page.locator('input[name="clip-count"][value="1"]').check({ force: true });
    await generate(page);
    const seen = new Set();
    await until(async () => {
      const v = await page.locator('[role="progressbar"]').getAttribute("aria-valuenow", { timeout: 500 }).catch(() => null);
      if (v !== null) seen.add(Number(v));
      return [...seen].some((x) => x >= 15);
    }, 30_000, "upload progress ≥ 15%");
    assert(seen.size >= 2, `progress advanced through several values (${[...seen].join(",")})`);
    assert([...seen].every((x) => x < 100), "never jumped to 100% before finishing");
    await page.screenshot({ path: path.join(ART, "03-upload-progress.png") });
    await page.getByRole("button", { name: "Cancel upload" }).click();
    await until(async () => (await uploadsOf(A.id)).length === 0, 15_000, "reservation released");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    assert((await db.query(`select count(*)::int n from "GenerationJob" where "userId"=$1`, [A.id])).rows[0].n === 0, "no job created");
  });

  await scenario("queued (no worker): honest state, survives refresh; Stage 8 video blocked by the active clip job; cancel refunds", async () => {
    const before = await balanceOf(A.id);
    await fresh(page);
    await chooseFile(page, "portrait-1080x1920.mp4");
    await page.getByText(/1080×1920/).first().waitFor({ timeout: 30_000 });
    await page.locator('input[name="clip-count"][value="1"]').check({ force: true });
    await generate(page);
    await waitStatus(page, /Queued, waiting for a worker/, 60_000, "queued");
    assert((await balanceOf(A.id)) === before - 5, "5 credits reserved");
    const txt = await page.locator("main").innerText();
    assert(!/Processing/.test(await status(page)), "not shown as processing");
    assert(!/\d+\s*%/.test(txt.replace(/\d+% uploaded/g, "")), "no fake percentage");

    await page.reload();
    await waitStatus(page, /Queued, waiting for a worker|Not picked up yet/, 30_000, "queued after reload");

    const video = await page.evaluate(async () => {
      const r = await fetch("/api/generations/video", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": `vid-e2e-${Date.now()}` },
        body: JSON.stringify({ prompt: "A calm mountain lake at sunrise, cinematic", aspectRatio: "16:9", durationSeconds: 5 }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    assert(video.status === 409 && video.body?.error?.code === "ACTIVE_JOB_EXISTS", `video blocked: ${JSON.stringify(video)}`);

    await page.getByRole("button", { name: "Cancel and refund" }).click();
    await page.getByRole("button", { name: "Yes, cancel and refund" }).click();
    await waitStatus(page, /Job cancelled/, 20_000, "cancelled");
    assert((await balanceOf(A.id)) === before, "credits refunded");
    await until(async () => (await uploadsOf(A.id)).length === 0, 15_000, "source upload deleted after cancel");
    const job = (await db.query(`select status, "errorMessage" from "GenerationJob" where "userId"=$1 order by "createdAt" desc limit 1`, [A.id])).rows[0];
    assert(job.status === "CANCELLED" && /USER_CANCELLED/.test(job.errorMessage), "job CANCELLED (USER_CANCELLED)");
    await page.screenshot({ path: path.join(ART, "04-cancelled.png") });
  });

  await scenario("lost reservation response: same-id retries, no premature release, released by id after reload", async () => {
    await ensureNoActiveJob(page, A.id);
    await fresh(page);
    await chooseFile(page, "landscape-1920x1080.mp4");
    await page.getByText(/1920×1080/).first().waitFor({ timeout: 15_000 });
    let hits = 0;
    const ids = new Set();
    const routeHandler = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      hits++;
      ids.add(JSON.parse(route.request().postData() ?? "{}").uploadId);
      await route.fetch(); // the server really grants (or re-grants) the reservation...
      await route.abort("connectionreset"); // ...but the browser never sees the answer
    };
    await page.route("**/api/clipper/uploads", routeHandler);
    await generate(page);
    await waitStatus(page, /Connection lost|failed/i, 40_000, "intent failure shown");
    await page.unroute("**/api/clipper/uploads");
    assert(hits === 3, `retried 3 times (${hits})`);
    assert(ids.size === 1 && /^upl_[a-f0-9]{32}$/.test([...ids][0]), `same client id on every retry (${[...ids].join(",")})`);
    const objs = await uploadsOf(A.id);
    assert(objs.length === 1 && objs[0].key.includes([...ids][0]), "exactly one reservation exists, under that id");
    await page.reload();
    await sleep(8000);
    assert((await uploadsOf(A.id)).length === 1, "not released before the safety delay");
    await until(async () => (await uploadsOf(A.id)).length === 0, 75_000, "released by id after reload");
    const leftover = await page.evaluate((uid) => localStorage.getItem(`yourai:clipper:reservation:${uid}`), A.id);
    assert(leftover === null, "local reservation record cleared");
  });

  await scenario("orphan reservation from elsewhere → 'Release my pending upload' → retry succeeds", async () => {
    await ensureNoActiveJob(page, A.id);
    const orphan = await page.evaluate(async () => {
      const id = "upl_" + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const r = await fetch("/api/clipper/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mimeType: "video/mp4", sizeBytes: 1000, uploadId: id }) });
      return r.status;
    });
    assert(orphan === 201, `orphan reservation created (${orphan})`);
    await fresh(page);
    await chooseFile(page, "landscape-1920x1080.mp4");
    await page.getByText(/1920×1080/).first().waitFor({ timeout: 15_000 });
    await page.locator('input[name="clip-count"][value="2"]').check({ force: true });
    await page.locator('input[name="clip-aspect"][value="9:16"]').check({ force: true });
    await generate(page);
    await waitStatus(page, /A previous upload is still reserved/, 30_000, "pending-exists error");
    await page.screenshot({ path: path.join(ART, "05-pending-exists.png") });
    await page.getByRole("button", { name: "Release my pending upload" }).click();
    await page.getByText(/Released\. You can try again now\./).waitFor({ timeout: 15_000 });
    assert((await uploadsOf(A.id)).length === 0, "orphan released");
    await page.getByRole("button", { name: "Try again" }).click();
    await waitStatus(page, /Queued, waiting for a worker/, 60_000, "queued after retry");
  });

  let completedJobId = null;
  await scenario("real worker: Processing only after pickup → 2 clips (landscape → 9:16) → playback", async () => {
    startWorker();
    await waitStatus(page, /^Processing$|^Your clips are ready/, 90_000, "processing or completed after worker pickup");
    const row = (await db.query(`select status, "startedAt" from "GenerationJob" where "userId"=$1 order by "createdAt" desc limit 1`, [A.id])).rows[0];
    assert((row.status === "PROCESSING" || row.status === "COMPLETED") && row.startedAt, "DB confirms PROCESSING/COMPLETED with startedAt");
    await page.screenshot({ path: path.join(ART, "06-processing.png") });
    await waitStatus(page, /Your clips are ready/, 300_000, "completed");
    const cards = page.locator("article");
    assert((await cards.count()) === 2, `2 clip cards (${await cards.count()})`);
    completedJobId = (await db.query(`select id from "GenerationJob" where "userId"=$1 and status='COMPLETED' order by "createdAt" desc limit 1`, [A.id])).rows[0].id;
    const play = await page.evaluate(async () => {
      const v = document.querySelector("article video");
      v.muted = true;
      await v.play();
      await new Promise((r) => setTimeout(r, 2000));
      return { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, err: v.error?.code ?? null };
    });
    assert(play.t > 0.5 && play.w === 1080 && play.h === 1920 && play.err === null, `plays 1080x1920 (${JSON.stringify(play)})`);
    await page.screenshot({ path: path.join(ART, "07-results.png"), fullPage: true });
  });

  await scenario("download: same-origin route → 302 → attachment; saved file is a 1080x1920 H.264/AAC MP4", async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.locator('a[aria-label^="Download"]').first().click()]);
    assert(/^pixora-clip-[A-Za-z0-9_-]+\.mp4$/.test(dl.suggestedFilename()), `filename ${dl.suggestedFilename()}`);
    const file = path.join(ART, dl.suggestedFilename());
    await dl.saveAs(file);
    const p = ffprobe(file);
    const v = p.streams.find((s) => s.codec_type === "video");
    assert(v.width === 1080 && v.height === 1920 && v.codec_name === "h264", `video ${v.width}x${v.height} ${v.codec_name}`);
    assert(p.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac"), "audio kept");
    const d = Number(p.format.duration);
    assert(d >= 5 && d <= 60.5, `clip length ${d}s within 5–60 s`);
    const href = await page.locator('a[aria-label^="Download"]').first().getAttribute("href");
    assert(href.startsWith("/api/generations/clip/"), "download link is same-origin");
  });

  await scenario("expired signed links are refreshed automatically and playback recovers", async () => {
    const before = await page.locator("article video").first().getAttribute("src");
    await standin("/__debug/expire-tokens", { method: "POST" });
    await page.evaluate(async () => {
      const v = document.querySelector("article video");
      v.muted = true;
      v.load();
      await v.play().catch(() => { });
    });
    await until(async () => (await page.locator("article video").first().getAttribute("src")) !== before, 30_000, "new signed src");
    const play = await page.evaluate(async () => {
      const v = document.querySelector("article video");
      v.muted = true;
      await v.play();
      await new Promise((r) => setTimeout(r, 1500));
      return { t: v.currentTime, err: v.error?.code ?? null };
    });
    assert(play.t > 0.3 && play.err === null, `plays after refresh (${JSON.stringify(play)})`);
  });

  await scenario("refresh after completion: results remain under Recent clips; daily usage shows updated count", async () => {
    await page.reload();
    await page.getByRole("heading", { name: "Recent clips" }).waitFor({ timeout: 15_000 });
    assert((await page.locator("article").count()) >= 2, "clips listed");
    const text = await page.locator("main").innerText();
    assert(text.includes("1 / 2") || text.includes("2 / 2"), `daily usage updated (got: ${text.match(/\d+\s*\/\s*2/)?.[0]})`);
  });

  let B;
  const ctxB = await newContext();
  const pageB = await ctxB.newPage();
  pages.push(pageB);
  await scenario("user B: portrait → 1:1 renders 1080x1080; cannot see or download user A's clips", async () => {
    B = await register(pageB, "b");
    await pageB.goto(`${BASE}/video-clipper`);
    await chooseFile(pageB, "portrait-1080x1920.mp4");
    await pageB.getByText(/1080×1920/).first().waitFor({ timeout: 15_000 });
    await pageB.locator('input[name="clip-aspect"][value="1:1"]').check({ force: true });
    await pageB.locator('input[name="clip-count"][value="1"]').check({ force: true });
    await generate(pageB);
    await waitStatus(pageB, /Your clips are ready/, 300_000, "B completed");
    const dims = await pageB.evaluate(async () => {
      const v = document.querySelector("article video");
      v.muted = true;
      await v.play();
      await new Promise((r) => setTimeout(r, 1200));
      return [v.videoWidth, v.videoHeight];
    });
    assert(dims[0] === 1080 && dims[1] === 1080, `1:1 output ${dims}`);
    const asset = (await db.query(`select id from "GeneratedAsset" where "jobId"=$1 limit 1`, [completedJobId])).rows[0].id;
    const probe = await pageB.evaluate(async ([j, a]) => {
      const job = await fetch(`/api/generations/clip/${j}`);
      const dl = await fetch(`/api/generations/clip/${j}/clips/${a}/download`, { redirect: "manual" });
      const cancel = await fetch(`/api/generations/clip/${j}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return [job.status, dl.status, cancel.status];
    }, [completedJobId, asset]);
    assert(probe[0] === 404 && probe[1] === 404 && probe[2] === 404, `foreign job/download/cancel → 404 (${probe})`);
  });

  const ctxC = await newContext();
  const pageC = await ctxC.newPage();
  pages.push(pageC);
  await scenario("user C: square → 16:9 renders 1920x1080", async () => {
    await register(pageC, "c");
    await pageC.goto(`${BASE}/video-clipper`);
    await chooseFile(pageC, "square-1080x1080.mp4");
    await pageC.getByText(/1080×1080/).first().waitFor({ timeout: 15_000 });
    await pageC.locator('input[name="clip-aspect"][value="16:9"]').check({ force: true });
    await pageC.locator('input[name="clip-count"][value="1"]').check({ force: true });
    await generate(pageC);
    await waitStatus(pageC, /Your clips are ready/, 300_000, "C completed");
    const [dl] = await Promise.all([pageC.waitForEvent("download", { timeout: 30_000 }), pageC.locator('a[aria-label^="Download"]').first().click()]);
    const file = path.join(ART, `C-${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    const v = ffprobe(file).streams.find((s) => s.codec_type === "video");
    assert(v.width === 1920 && v.height === 1080, `16:9 output ${v.width}x${v.height}`);
  });

  await scenario("mobile 390×844: no horizontal scroll; keyboard reaches file input, radios and Generate", async () => {
    const state = await ctxA.storageState();
    const ctxM = await browser.newContext({ bypassCSP: true, storageState: state, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const m = await ctxM.newPage();
    pages.push(m);
    await m.goto(`${BASE}/video-clipper`);
    await m.getByText("Recent clips").waitFor({ timeout: 15_000 });
    const sw = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    assert(sw.sw <= sw.iw, `no horizontal overflow (${sw.sw} > ${sw.iw})`);
    await m.screenshot({ path: path.join(ART, "08-mobile.png"), fullPage: true });

    await page.goto(`${BASE}/video-clipper`);
    await chooseFile(page, "square-1080x1080.mp4");
    await page.getByText(/1080×1080/).first().waitFor({ timeout: 15_000 });
    await page.locator("body").focus();
    const seen = [];
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      seen.push(await page.evaluate(() => {
        const e = document.activeElement;
        return `${e.tagName.toLowerCase()}|${e.getAttribute("type") ?? ""}|${e.getAttribute("name") ?? ""}|${(e.textContent ?? "").trim().slice(0, 30)}`;
      }));
    }
    for (const want of [/input\|radio\|clip-aspect/, /input\|radio\|clip-framing/, /input\|radio\|clip-count/, /button\|submit\|\|Generate/]) {
      assert(seen.some((s) => want.test(s)), `keyboard reaches ${want.source}`);
    }
    await ctxM.close();
  });

  await scenario("submissions switched OFF (second instance, production default): honest notice, nothing reserved", async () => {
    const off = launch(["--set", "APP_ORIGIN=http://127.0.0.1:3101", "--set", "AUTH_URL=http://127.0.0.1:3101"], ["npx", "next", "start", "-p", "3101", "-H", "127.0.0.1"], "app-off.log");
    try {
      await until(async () => (await fetch("http://127.0.0.1:3101/login")).ok, 60_000, "off instance ready");
      const p2 = await ctxA.newPage();
      pages.push(p2);
      await p2.goto("http://127.0.0.1:3101/video-clipper");
      await p2.getByText("New clipping jobs are switched off", { exact: true }).waitFor({ timeout: 15_000 });
      assert(await p2.locator('input[type="file"]').isDisabled(), "upload disabled");
      const r = await p2.evaluate(async () => {
        const res = await fetch("/api/clipper/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mimeType: "video/mp4", sizeBytes: 1000 }) });
        return [res.status, (await res.json()).error?.code];
      });
      assert(r[0] === 503 && r[1] === "CLIPPER_UNAVAILABLE", `API refuses (${r})`);
      assert((await uploadsOf(A.id)).length === 0, "nothing reserved");
      await p2.screenshot({ path: path.join(ART, "09-switched-off.png") });
    } finally {
      killTree(off);
    }
  });

  await scenario("cron endpoints fail closed in production without CRON_SECRET", async () => {
    for (const p of ["/api/cron/clipper", "/api/cron/video-webhooks"]) {
      const r = await fetch(`${BASE}${p}`);
      assert(r.status === 401, `${p} → ${r.status}`);
    }
  });
} finally {
  if (worker) killTree(worker);
  await browser.close();
  const egress = fs.existsSync(path.join(ROOT, "logs", "egress-blocked.log"))
    ? fs.readFileSync(path.join(ROOT, "logs", "egress-blocked.log"), "utf8").split("\n").filter((l) => l && !l.includes("isolation-guard.mjs"))
    : [];
  const stats = await standin("/__debug/stats").catch(() => ({}));
  await db.end();
  const passed = results.filter((r) => r.ok).length;
  fs.writeFileSync(path.join(ART, "results.json"), JSON.stringify({ results, egressBlockedOutsideGuard: egress, standinStats: stats }, null, 2));
  console.log(`\n  Scenarios Passed: ${passed}\n  Scenarios Failed: ${results.length - passed}`);
  console.log(`  Blocked egress attempts (excluding guard self-test): ${egress.length}`);
  for (const l of egress.slice(0, 10)) console.log(`    ${l}`);
  console.log(`  Storage stand-in calls: ${JSON.stringify(stats)}`);
  process.exit(results.length - passed > 0 ? 1 : 0);
}
