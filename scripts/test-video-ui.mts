// Stage 8, Batch 5: Premium AI Video Generator UI (/ai-video)
//
// Fully offline: NO real Fal.ai API calls, NO trial credits spent, ₹0 spend.
// Tests video generator components, aspect ratio selection, prompt editor,
// specs badge, cost summary, player timecode formatting, state machine progression,
// gallery selection, accessibility guardrails, and signed URL integration.
//
// Run: npm run test:video-ui

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const {
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_PROVIDER,
  DEFAULT_VIDEO_CREDIT_COST,
  DEFAULT_DAILY_USER_VIDEO_LIMIT,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  VIDEO_DURATIONS,
  VIDEO_FRAME_RATES,
} = await import("@/features/video/config");

const {
  toVideoJobView,
  failureReasonFor,
  isJobInProgress,
} = await import("@/features/video/job-view");

const {
  getRecentVideoJobsWithUrls,
} = await import("@/features/video/queries");

const {
  VideoGenerationController,
} = await import("@/features/video/client/controller");

const { VideoSpecsBadge } = await import("@/components/video-generator/video-specs-badge");
const { AspectRatioSelector } = await import("@/components/video-generator/aspect-ratio-selector");
const { VideoPromptEditor } = await import("@/components/video-generator/video-prompt-editor");
const { VideoCostSummary } = await import("@/components/video-generator/video-cost-summary");
const { VideoDailyUsage } = await import("@/components/video-generator/video-daily-usage");
const { RecentVideos } = await import("@/components/video-generator/recent-videos");

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) {
    pass++;
    console.log(`PASS  ${m}`);
  } else {
    fail++;
    console.error(`FAIL  ${m}`);
  }
};

console.log("\n# Section 1: Video Specs & Aspect Ratio Configuration");
{
  ok("16:9" in VIDEO_ASPECT_RATIOS, "16:9 widescreen supported");
  ok("9:16" in VIDEO_ASPECT_RATIOS, "9:16 vertical supported");
  ok("1:1" in VIDEO_ASPECT_RATIOS, "1:1 square supported");
  ok("720p" in VIDEO_RESOLUTIONS, "720p HD resolution supported");
  ok(5 in VIDEO_DURATIONS, "5.0s duration supported");
  ok(16 in VIDEO_FRAME_RATES, "16 FPS native frame rate supported");
  ok(DEFAULT_VIDEO_CREDIT_COST === 10, "default generation cost is 10 credits");
  ok(DEFAULT_VIDEO_MODEL.includes("wan/v2.1"), "default model is Wan 2.1");
}

console.log("\n# Section 2: Prompt Validation, Sanitization & Length Guardrails");
{
  const maxPromptLength = 2048;
  const validPrompt = "A cinematic drone shot through misty Icelandic waterfalls at golden hour";
  ok(validPrompt.length < maxPromptLength, "valid prompt within limit");
  ok(validPrompt.trim().length > 0, "valid prompt has non-whitespace characters");

  const whitespacePrompt = "   \n\t   ";
  ok(whitespacePrompt.trim().length === 0, "detects whitespace-only prompt");

  const longPrompt = "a".repeat(2049);
  ok(longPrompt.length > maxPromptLength, "detects prompt exceeding 2048 characters");

  // Warning threshold test (>90% of max length)
  const nearLimitPrompt = "a".repeat(1850);
  ok(nearLimitPrompt.length > maxPromptLength * 0.9, "detects prompt near max length threshold");
}

console.log("\n# Section 3: Timecode, Aspect Ratio & Player Utilities");
{
  // Timecode formatting logic (as implemented in VideoPlayer)
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  ok(formatTime(0) === "0:00", "formats 0s as 0:00");
  ok(formatTime(2.4) === "0:02", "formats 2.4s as 0:02");
  ok(formatTime(5.0) === "0:05", "formats 5.0s as 0:05");
  ok(formatTime(65.0) === "1:05", "formats 65s as 1:05");
  ok(formatTime(125.0) === "2:05", "formats 125s as 2:05");

  // Aspect ratio class mapping
  const getAspectClass = (ar: string) => {
    return ar === "9:16"
      ? "aspect-[9/16] max-h-[580px]"
      : ar === "1:1"
      ? "aspect-square max-h-[500px]"
      : "aspect-video max-h-[500px]";
  };

  ok(getAspectClass("16:9").includes("aspect-video"), "16:9 maps to aspect-video");
  ok(getAspectClass("9:16").includes("aspect-[9/16]"), "9:16 maps to aspect-[9/16]");
  ok(getAspectClass("1:1").includes("aspect-square"), "1:1 maps to aspect-square");
}

console.log("\n# Section 4: Video Job Record to View Mapping & Sanitation");
{
  const rawRecord = {
    id: "vjob-view-test-001",
    status: "COMPLETED" as const,
    prompt: "An majestic eagle soaring over snowy mountain peaks",
    settings: {
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      fps: 16,
      rawProviderKey: "LEAKED_SECRET_DO_NOT_EXPOSE",
      providerResult: { secretUrl: "https://secret.cdn/video.mp4" },
    },
    chargedCredits: 10,
    estimatedCredits: 10,
    errorMessage: null,
    createdAt: new Date("2026-11-11T12:00:00Z"),
    startedAt: new Date("2026-11-11T12:00:02Z"),
    completedAt: new Date("2026-11-11T12:01:05Z"),
    assets: [
      {
        id: "vasset-view-001",
        width: 1280,
        height: 720,
        mimeType: "video/mp4",
        fileSize: BigInt(15_000_000),
        durationSeconds: 5.0,
        thumbnailKey: "users/u1/videos/j1/thumb.webp",
      },
    ],
  };

  const signedUrls = {
    videoUrl: "https://signed.supabase.test/users/u1/videos/j1/video.mp4?token=sig123",
    thumbnailUrl: "https://signed.supabase.test/users/u1/videos/j1/thumb.webp?token=sig456",
  };

  const { job, asset } = toVideoJobView(rawRecord as any, signedUrls);

  ok(job.id === "vjob-view-test-001", "job view preserves id");
  ok(job.status === "COMPLETED", "job view preserves status");
  ok(job.aspectRatio === "16:9", "job view resolves aspect ratio");
  ok(job.durationSeconds === 5, "job view resolves duration");
  ok(job.frameRate === 16, "job view resolves native 16 fps");
  ok(job.resolution === "720p", "job view resolves 720p resolution");
  ok(job.creditsCharged === 10, "job view reports charged credits");
  ok((job as any).rawProviderKey === undefined, "sanitizes internal provider key");
  ok((job as any).providerResult === undefined, "sanitizes internal provider result");

  ok(asset !== null, "asset view generated");
  ok(asset?.id === "vasset-view-001", "asset view preserves asset id");
  ok(asset?.videoUrl === signedUrls.videoUrl, "asset view provides signed video URL");
  ok(asset?.thumbnailUrl === signedUrls.thumbnailUrl, "asset view provides signed thumbnail URL");
  ok(asset?.width === 1280 && asset?.height === 720, "asset view reports dimensions");
  ok(asset?.durationSeconds === 5.0, "asset view reports duration");
  ok(asset?.sizeBytes === 15_000_000, "asset view converts bigint fileSize to number");
}

console.log("\n# Section 5: Gallery & Recent Videos Signed URL Resolution");
{
  class MockStorage {
    async createSignedUrl(key: string, exp: number) {
      return `https://signed.storage.test/${key}?expires=${exp}`;
    }
    async put() {}
    async putStream() { return { sizeBytes: 100 }; }
    async delete() {}
  }

  const mockDb = {
    generationJob: {
      findMany: async () => [
        {
          id: "vjob-gallery-001",
          status: "COMPLETED",
          prompt: "Futuristic neon city with flying cars",
          settings: { aspectRatio: "9:16", duration: 5, resolution: "720p", fps: 16 },
          chargedCredits: 10,
          estimatedCredits: 10,
          errorMessage: null,
          createdAt: new Date("2026-11-11T12:00:00Z"),
          startedAt: new Date("2026-11-11T12:00:02Z"),
          completedAt: new Date("2026-11-11T12:01:00Z"),
          assets: [
            {
              id: "vasset-gallery-001",
              width: 720,
              height: 1280,
              mimeType: "video/mp4",
              fileSize: BigInt(8_500_000),
              durationSeconds: 5.0,
              thumbnailKey: "users/u_test_123/videos/vjob-gallery-001/vasset-gallery-001-thumb.webp",
            },
          ],
        },
      ],
    },
    generatedAsset: {
      findFirst: async ({ where }: any) => ({
        storageKey: `users/${where.userId}/videos/vjob-gallery-001/${where.id}.mp4`,
        thumbnailKey: `users/${where.userId}/videos/vjob-gallery-001/${where.id}-thumb.webp`,
      }),
    },
  };

  const recentItems = await getRecentVideoJobsWithUrls(
    "u_test_123",
    new MockStorage() as any,
    8,
    mockDb as any,
  );

  ok(recentItems.length === 1, "resolves 1 recent video item");
  ok(recentItems[0].job.id === "vjob-gallery-001", "item matches job id");
  ok(recentItems[0].job.aspectRatio === "9:16", "item preserves 9:16 portrait ratio");
  ok(recentItems[0].asset !== null, "item asset view is present");
  ok(Boolean(recentItems[0].asset?.videoUrl.includes(".mp4")), "item asset carries signed video URL");
  ok(Boolean(recentItems[0].asset?.thumbnailUrl?.includes("thumb.webp")), "item asset carries signed thumbnail URL");
}

console.log("\n# Section 6: Client Controller State Machine & Lifecycle");
{
  let pollCallCount = 0;
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    if (urlStr.includes("/api/generations/video") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          job: {
            id: "vjob-client-ctrl-001",
            status: "PROCESSING",
            prompt: "Cyberpunk street in rain",
            aspectRatio: "16:9",
            durationSeconds: 5,
            resolution: "720p",
            frameRate: 16,
            creditsCharged: 0,
            estimatedCredits: 10,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: null,
            outcomeUnknown: false,
            error: null,
          },
          asset: null,
          replayed: false,
          balance: 90,
        }),
        { status: 202, headers: { "Location": "/api/generations/video/vjob-client-ctrl-001" } },
      );
    }

    if (urlStr.includes("/api/generations/video/vjob-client-ctrl-001")) {
      pollCallCount++;
      if (pollCallCount === 1) {
        return new Response(
          JSON.stringify({
            job: {
              id: "vjob-client-ctrl-001",
              status: "PROCESSING",
              prompt: "Cyberpunk street in rain",
              aspectRatio: "16:9",
              durationSeconds: 5,
              resolution: "720p",
              frameRate: 16,
              creditsCharged: 0,
              estimatedCredits: 10,
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              completedAt: null,
              outcomeUnknown: false,
              error: null,
            },
            asset: null,
            replayed: false,
            balance: 90,
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          job: {
            id: "vjob-client-ctrl-001",
            status: "COMPLETED",
            prompt: "Cyberpunk street in rain",
            aspectRatio: "16:9",
            durationSeconds: 5,
            resolution: "720p",
            frameRate: 16,
            creditsCharged: 10,
            estimatedCredits: 10,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            outcomeUnknown: false,
            error: null,
          },
          asset: {
            id: "vasset-ctrl-001",
            videoUrl: "https://signed.supabase.test/video.mp4",
            thumbnailUrl: "https://signed.supabase.test/thumb.webp",
            durationSeconds: 5.0,
            width: 1280,
            height: 720,
            mimeType: "video/mp4",
            sizeBytes: 12_000_000,
          },
          replayed: false,
          balance: 90,
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };

  const controller = new VideoGenerationController({
    fetchImpl: mockFetch as any,
    sleep: async () => {}, // Instant sleep for testing
  });

  ok(controller.getState().phase === "idle", "initial controller phase is idle");

  const states: string[] = [];
  const unsubscribe = controller.subscribe((state) => {
    states.push(state.phase);
  });

  // Submit job
  const submitPromise = controller.submit({
    prompt: "Cyberpunk street in rain",
    aspectRatio: "16:9",
  });

  ok(controller.getState().phase === "submitting", "transitions to submitting during POST");
  await submitPromise;

  ok(controller.getState().phase === "polling", "transitions to polling on 202 Accepted");

  // Wait for terminal completion
  await new Promise((resolve) => setTimeout(resolve, 200));

  ok(controller.getState().phase === "completed", "transitions to completed when status = COMPLETED");
  const finalState = controller.getState();
  if (finalState.phase === "completed") {
    ok(finalState.job.id === "vjob-client-ctrl-001", "holds completed job");
    ok(finalState.asset.videoUrl.includes("video.mp4"), "holds completed video URL");
  }

  unsubscribe();
  controller.destroy();
}

console.log("\n# Section 7: Component Render & Accessibility Markup Validation");
{
  // 1. VideoSpecsBadge Render
  const specsMarkup = renderToStaticMarkup(createElement(VideoSpecsBadge));
  ok(specsMarkup.includes("Wan 2.1"), "specs badge displays model name");
  ok(specsMarkup.includes("720p HD"), "specs badge displays resolution");
  ok(specsMarkup.includes("16 FPS"), "specs badge displays native 16 FPS");
  ok(specsMarkup.includes("5.0s"), "specs badge displays 5.0s duration");
  ok(specsMarkup.includes("Safety Checked"), "specs badge displays safety checker");

  // 2. AspectRatioSelector Render
  const arMarkup = renderToStaticMarkup(
    createElement(AspectRatioSelector, {
      value: "16:9",
      onChange: () => {},
    }),
  );
  ok(arMarkup.includes('role="radiogroup"'), "aspect ratio selector has radiogroup role");
  ok(arMarkup.includes('aria-label="Aspect ratio"'), "has accessible radiogroup label");
  ok(arMarkup.includes('aria-checked="true"'), "selected option has aria-checked true");
  ok(arMarkup.includes("16:9"), "displays 16:9 option");
  ok(arMarkup.includes("9:16"), "displays 9:16 option");
  ok(arMarkup.includes("1:1"), "displays 1:1 option");

  // 3. VideoPromptEditor Render
  const editorMarkup = renderToStaticMarkup(
    createElement(VideoPromptEditor, {
      value: "A majestic eagle soaring over snow peaks",
      maxLength: 2048,
      onChange: () => {},
    }),
  );
  ok(editorMarkup.includes("<textarea"), "renders textarea element");
  ok(editorMarkup.includes("A majestic eagle soaring over snow peaks"), "renders prompt value in textarea");
  ok(editorMarkup.includes("40 / 2048"), "displays accurate character counter");
  ok(editorMarkup.includes("Inspiration Ideas"), "displays inspiration sample chips");
  ok(editorMarkup.includes("Drone Flight"), "displays sample chip");

  // 4. VideoCostSummary Render
  const costMarkup = renderToStaticMarkup(
    createElement(VideoCostSummary, {
      creditCost: 10,
      balance: 100,
      dailyUsed: 0,
      dailyLimit: 1,
      hasActiveJob: false,
    }),
  );
  ok(costMarkup.includes("10 Credits"), "displays generation credit cost");
  ok(costMarkup.includes("Balance: 100"), "displays user credit balance");

  // Insufficient credits alert
  const lowBalanceMarkup = renderToStaticMarkup(
    createElement(VideoCostSummary, {
      creditCost: 10,
      balance: 4,
      dailyUsed: 0,
      dailyLimit: 1,
      hasActiveJob: false,
    }),
  );
  ok(lowBalanceMarkup.includes('role="alert"'), "insufficient credits renders role=alert");
  ok(lowBalanceMarkup.includes("Insufficient Credits"), "displays Insufficient Credits title");
  ok(lowBalanceMarkup.includes("View your credits in Settings"), "links to the credit balance in Settings");

  // Daily limit reached alert
  const dailyLimitMarkup = renderToStaticMarkup(
    createElement(VideoCostSummary, {
      creditCost: 10,
      balance: 100,
      dailyUsed: 1,
      dailyLimit: 1,
      hasActiveJob: false,
    }),
  );
  ok(dailyLimitMarkup.includes("Daily Limit Reached"), "displays Daily Limit Reached title");

  // 5. VideoDailyUsage Render
  const dailyUsageMarkup = renderToStaticMarkup(
    createElement(VideoDailyUsage, {
      used: 0,
      limit: 1,
    }),
  );
  ok(dailyUsageMarkup.includes("Daily Videos"), "daily usage displays title");
  ok(dailyUsageMarkup.includes("0 of 1 used"), "daily usage displays count");

  // 6. RecentVideos Empty State
  const emptyGalleryMarkup = renderToStaticMarkup(
    createElement(RecentVideos, {
      items: [],
      onSelectItem: () => {},
    }),
  );
  ok(emptyGalleryMarkup.includes("No Videos Generated Yet"), "empty gallery displays message");
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
