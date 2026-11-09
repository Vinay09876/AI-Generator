// Stage 6 / B5 offline tests: recent-images gallery logic, rendering, and isolation of the
// "viewing an earlier image" state from the live generation and the stored pending request.
// No network, database, Cloudflare or Supabase. Run: npm run test:ui-gallery
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let realNetworkAttempts = 0;
globalThis.fetch = (async () => {
  realNetworkAttempts++;
  throw new Error("Network access is forbidden in offline tests");
}) as typeof fetch;

const gallery = await import("@/features/generations/client/gallery");
const { GenerationController } = await import("@/features/generations/client/generation-controller");
const pr = await import("@/features/generations/client/pending-request");
const { RecentImages } = await import("@/components/image-generator/recent-images");
const { PreviewStage } = await import("@/components/image-generator/preview-stage");
type GalleryItem = import("@/features/generations/client/gallery").GalleryItem;
type GenerationApiResult = import("@/features/generations/client/api").GenerationApiResult;

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const section = (s: string) => console.log(`\n# ${s}`);
const tick = () => new Promise((r) => setImmediate(r));

const item = (n: number, over: { status?: string; asset?: null | { url: string }; prompt?: string | null; quality?: "fast" | "detailed" } = {}): GalleryItem => ({
  job: {
    id: `cjobgallery00000000000000${String(n).padStart(2, "0")}`, status: (over.status ?? "COMPLETED") as never, quality: over.quality ?? (n % 2 ? "detailed" : "fast"),
    prompt: over.prompt === undefined ? `Prompt number ${n}: a lighthouse at dawn` : over.prompt, creditsCharged: 1,
    createdAt: `2026-11-${String(1 + n).padStart(2, "0")}T10:00:00.000Z`, completedAt: null, outcomeUnknown: false, error: null,
  },
  asset: over.asset === null ? null : { id: `asset-${n}`, url: over.asset?.url ?? `/api/assets/asset-${n}`, width: 1024, height: 1024, mimeType: "image/webp", sizeBytes: 100 },
});
const EIGHT = Array.from({ length: 8 }, (_, i) => item(i + 1));

try {
  section("Gallery view logic");
  {
    const v0 = gallery.GENERATION_VIEW;
    const v1 = gallery.selectHistory(v0, EIGHT, EIGHT[2].job.id);
    ok(v1.kind === "history" && v1.jobId === EIGHT[2].job.id, "select a listed image → history view");
    const v2 = gallery.selectHistory(v1, EIGHT, EIGHT[5].job.id);
    ok(v2.kind === "history" && v2.jobId === EIGHT[5].job.id, "switching to another image");
    ok(gallery.selectHistory(v1, EIGHT, "cjobNOTINLIST000000000000") === v1, "unknown job id → unchanged");
    const failed = [item(1, { status: "FAILED" }), item(2, { asset: null }), item(3, { asset: { url: "https://x.supabase.co/storage/v1/object/sign/k" } })];
    ok(failed.every((f) => gallery.selectHistory(v0, failed, f.job.id) === v0), "failed / asset-less / non-/api/assets/ items can't be selected");
    ok(gallery.showGeneration().kind === "generation", "back to the generation view");

    const r1 = gallery.resolvePreview(v2, EIGHT);
    ok(r1.kind === "history" && r1.item.asset.url === "/api/assets/asset-6", "resolve: selected item with its /api/assets/ URL");
    ok(gallery.resolvePreview(v2, EIGHT.slice(0, 3)).kind === "generation", "selected item no longer in the list (after refresh) → falls back to the generation");

    const H = { kind: "history", jobId: EIGHT[0].job.id } as const;
    const change = (from: string, to: string) => gallery.onGenerationPhaseChange(H, from as never, to as never).kind;
    ok(change("idle", "submitting") === "generation", "a new submission brings the live generation back into view");
    ok(change("polling", "completed") === "generation" && change("polling", "failed") === "generation" && change("polling", "stalled") === "generation",
      "a generation's outcome (completed / failed / stalled) is shown");
    ok(change("submitting", "polling") === "history" && change("polling", "polling") === "history", "while a generation runs, the selected earlier image stays (user's choice)");
    ok(change("submitting", "error") === "history" && change("error", "idle") === "history", "a rejection (shown by the button) keeps the selected image");
    ok(gallery.onGenerationPhaseChange(gallery.GENERATION_VIEW, "idle", "submitting").kind === "generation", "generation view is unaffected");

    ok(gallery.promptExcerpt("  a\n\n lighthouse   at dawn ") === "a lighthouse at dawn", "excerpt collapses whitespace");
    ok(gallery.promptExcerpt("x".repeat(200)).length === 90 && gallery.promptExcerpt("x".repeat(200)).endsWith("…"), "excerpt bounded to 90 characters");
    ok(gallery.promptExcerpt(null) === "Untitled image" && gallery.promptExcerpt("   ") === "Untitled image", "empty prompt → 'Untitled image'");
  }

  section("Isolation from the live generation and the stored request");
  {
    // A generation in progress (POST acknowledged, polling a job that stays PROCESSING).
    class MemoryStore { map = new Map<string, string>(); getItem(k: string) { return this.map.get(k) ?? null; } setItem(k: string, v: string) { this.map.set(k, v); } removeItem(k: string) { this.map.delete(k); } }
    const store = new MemoryStore();
    const USER = "cuser000000000000000000001";
    const calls: string[] = [];
    let clock = Date.parse("2026-11-10T09:00:00.000Z");
    const processing: GenerationApiResult = { kind: "job", httpStatus: 202, body: { ...EIGHT[0], job: { ...EIGHT[0].job, id: "cjobLIVE00000000000000001", status: "PROCESSING" }, asset: null, replayed: false, balance: 99 } as never, retryAfterSeconds: 3 };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const c = new GenerationController({
      userId: USER, store,
      api: { post: async (r) => { calls.push(`POST ${r.idempotencyKey}`); return processing; }, get: async (id) => { calls.push(`GET ${id}`); await gate; return processing; } },
      now: () => clock, sleep: async (ms) => { clock += ms; await tick(); },
      visibility: { isHidden: () => false, waitUntilVisible: async () => {} },
      randomId: () => "live-key-0001-aaaaaaaa",
    });
    c.attach();
    c.submit({ prompt: "live prompt", quality: "fast" });
    for (let i = 0; i < 50 && calls.length < 2; i++) await tick();
    const stateBefore = c.getState();
    const storedBefore = store.map.get(pr.pendingStorageKey(USER));
    const callsBefore = calls.length;
    ok(stateBefore.phase === "polling" && storedBefore?.includes("live-key-0001") === true, "setup: generation in progress, request stored");

    // The user browses earlier images (pure view state).
    let view = gallery.GENERATION_VIEW as import("@/features/generations/client/gallery").PreviewView;
    for (const g of EIGHT) view = gallery.selectHistory(view, EIGHT, g.job.id);
    view = gallery.onGenerationPhaseChange(view, "polling", "polling");
    const shown = gallery.resolvePreview(view, EIGHT);
    ok(shown.kind === "history" && shown.item.job.id === EIGHT[7].job.id, "selecting during a generation shows the earlier image");
    ok(c.getState() === stateBefore && c.busy, "controller state object untouched (still polling)");
    ok(store.map.get(pr.pendingStorageKey(USER)) === storedBefore, "stored pending request untouched (same key, same content)");
    ok(calls.length === callsBefore, "no request was sent by selecting images");
    ok(!c.submit({ prompt: "x", quality: "fast" }), "the composer still cannot start a second generation");

    // The live job completes → the view returns to the generation.
    view = gallery.onGenerationPhaseChange(view, "polling", "completed");
    ok(view.kind === "generation", "when the live job finishes, its result is shown");
    release();
    c.detach();
  }
  {
    // A held request (recovery) is not affected by browsing either.
    class MemoryStore { map = new Map<string, string>(); getItem(k: string) { return this.map.get(k) ?? null; } setItem(k: string, v: string) { this.map.set(k, v); } removeItem(k: string) { this.map.delete(k); } }
    const store = new MemoryStore();
    const USER = "cuser000000000000000000001";
    pr.savePendingRequest(store, USER, { v: 1, key: "held-key-0001-aaaaaaaa", prompt: "a cat", quality: "fast", startedAt: Date.now() - 60_000 });
    const before = store.map.get(pr.pendingStorageKey(USER));
    let view = gallery.selectHistory(gallery.GENERATION_VIEW, EIGHT, EIGHT[0].job.id);
    view = gallery.showGeneration();
    ok(store.map.get(pr.pendingStorageKey(USER)) === before && view.kind === "generation", "held / pending request in storage unchanged by select + back");
  }

  section("RecentImages rendering");
  {
    const empty = renderToStaticMarkup(createElement(RecentImages, { items: [], selectedJobId: null, onSelect: () => {} }));
    ok(empty.includes("No images yet") && empty.includes('href="/history?type=image"') && !empty.includes("<img"), "empty gallery: message, link to image history, no images");
    const onlyBad = renderToStaticMarkup(createElement(RecentImages, { items: [item(1, { status: "FAILED" }), item(2, { asset: null })], selectedJobId: null, onSelect: () => {} }));
    ok(onlyBad.includes("No images yet"), "only non-viewable items → empty state");

    const html = renderToStaticMarkup(createElement(RecentImages, { items: EIGHT, selectedJobId: EIGHT[1].job.id, onSelect: () => {} }));
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    ok(imgs.length === 8 && (html.match(/<button /g) ?? []).length === 8, "8 thumbnails, each a button");
    ok(imgs.every((t) => t.includes('loading="lazy"') && t.includes('decoding="async"') && t.includes('width="1024"') && t.includes('height="1024"')), "lazy loading, async decoding, intrinsic 1024×1024 dimensions");
    ok(imgs.every((t) => /src="\/api\/assets\/asset-\d+"/.test(t)) && !html.includes("supabase") && !html.includes("users/"), "only same-origin /api/assets/ URLs; no storage URLs or keys");
    ok((html.match(/aria-pressed="true"/g) ?? []).length === 1 && html.includes(`aria-label="Viewing image: ${EIGHT[1].job.prompt}"`), "exactly one selected (aria-pressed) with a 'Viewing' label");
    ok(html.includes("Viewing</span>"), "visible selected badge");
    ok(html.includes("grid-cols-2") && html.includes("sm:grid-cols-3") && html.includes("lg:grid-cols-4"), "2 / 3 / 4 columns (mobile / tablet / desktop)");
    ok(html.includes("Detailed") && html.includes("Fast") && html.includes('<time dateTime="2026-11-02T10:00:00.000Z">Nov 2, 2026</time>'), "quality and date (UTC, deterministic for hydration)");
    ok(html.includes('href="/history?type=image"') && html.includes("View all history"), "link to the image history");
    ok(html.includes("focus-visible:outline-2") && html.includes("motion-reduce:transition-none"), "visible focus ring; hover zoom disabled for reduced motion");

    const long = renderToStaticMarkup(createElement(RecentImages, { items: [item(1, { prompt: `<script>alert(1)</script> ${"word ".repeat(80)}` })], selectedJobId: null, onSelect: () => {} }));
    ok(!long.includes("<script>") && long.includes("&lt;script&gt;") && long.includes("…"), "prompt rendered as escaped text and truncated");
    const mixed = renderToStaticMarkup(createElement(RecentImages, { items: [...EIGHT.slice(0, 2), item(9, { status: "FAILED" }), item(10, { asset: { url: "https://evil.example/x.webp" } })], selectedJobId: null, onSelect: () => {} }));
    ok((mixed.match(/<img /g) ?? []).length === 2 && !mixed.includes("evil.example"), "non-viewable items are not rendered");
  }

  section("PreviewStage for an earlier image");
  {
    const it = EIGHT[0] as { job: GalleryItem["job"]; asset: NonNullable<GalleryItem["asset"]> };
    const base = { state: { phase: "completed" as const, job: it.job, asset: it.asset }, onCheckAgain: () => {}, onCheckNow: () => {}, onTryAgain: () => {} };
    const withBanner = renderToStaticMarkup(createElement(PreviewStage, { ...base, banner: createElement("p", null, "Viewing an earlier image"), onUsePrompt: () => {} }));
    ok(withBanner.includes("Viewing an earlier image") && withBanner.includes('src="/api/assets/asset-1"') && withBanner.includes("Use this prompt"), "banner + image + actions (Use this prompt available when idle)");
    const busy = renderToStaticMarkup(createElement(PreviewStage, { ...base, onUsePrompt: undefined }));
    ok(!busy.includes("Use this prompt") && busy.includes("Download") && busy.includes("Copy prompt"), "while a generation runs: Use this prompt hidden; download / open / copy still available");
  }

  ok(realNetworkAttempts === 0, "no real network request was attempted");
} catch (e) {
  fail++;
  console.error("UNCAUGHT", e);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
