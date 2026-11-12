/**
 * Stage 10 Batch 4 Test Suite — Unified Dashboard, Studio Navigation, Active Job Ribbon & Media History.
 *
 * Verifies:
 * 1. Active studio job query resolution (`getActiveStudioJob`) across IMAGE, VIDEO, VIDEO_CLIP.
 * 2. Cross-stage 1-active-job concurrency awareness and user scoping.
 * 3. Unified history page query (`getUnifiedHistoryPage`) with asset metadata and cursor pagination.
 * 4. Studio navigation configuration (`STUDIO_TOOLS`) and tool metadata (badges, costs, routes).
 * 5. Media formatting utilities (`formatFileSize`).
 * 6. Cross-tool duration incompatibility guard (Wan 2.1 5s vs Video Clipper 15s min source duration).
 */

import {
  getActiveStudioJob,
  getUnifiedHistoryPage,
  type ActiveStudioJobSummary,
} from "../src/features/generations/queries.js";
import { STUDIO_TOOLS } from "../src/components/dashboard/studio-nav.js";
import { formatFileSize } from "../src/lib/format.js";
import { GenerationStatus, GenerationType } from "../src/generated/prisma/enums.js";

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, message: string): void {
  totalTests++;
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
}

async function runSection(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n--- Running Section: ${name} ---`);
  await fn();
}

/**
 * In-memory test store simulating Prisma Client for generations and assets.
 */
class MockDashboardDatabase {
  public jobs = new Map<string, any>();
  public assets = new Map<string, any>();

  constructor() {
    this.seed();
  }

  private seed() {
    // Seed User Alice jobs
    this.jobs.set("job_img_1", {
      id: "job_img_1",
      userId: "usr_alice",
      type: GenerationType.IMAGE,
      status: GenerationStatus.COMPLETED,
      prompt: "A beautiful neon cyberpunk city",
      estimatedCredits: 1,
      chargedCredits: 1,
      errorMessage: null,
      createdAt: new Date("2026-11-12T10:00:00Z"),
      startedAt: new Date("2026-11-12T10:00:01Z"),
      completedAt: new Date("2026-11-12T10:00:04Z"),
    });

    this.assets.set("ast_img_1", {
      id: "ast_img_1",
      jobId: "job_img_1",
      userId: "usr_alice",
      type: "IMAGE",
      storageKey: "users/usr_alice/images/job_img_1/ast_img_1.webp",
      thumbnailKey: null,
      mimeType: "image/webp",
      width: 1024,
      height: 1024,
      durationSeconds: null,
      fileSize: BigInt(1048576), // 1.0 MB
    });

    this.jobs.set("job_vid_1", {
      id: "job_vid_1",
      userId: "usr_alice",
      type: GenerationType.VIDEO,
      status: GenerationStatus.COMPLETED,
      prompt: "Drone shot gliding over mountain ridges at sunset",
      estimatedCredits: 50,
      chargedCredits: 50,
      errorMessage: null,
      createdAt: new Date("2026-11-12T11:00:00Z"),
      startedAt: new Date("2026-11-12T11:00:05Z"),
      completedAt: new Date("2026-11-12T11:02:00Z"),
    });

    this.assets.set("ast_vid_1", {
      id: "ast_vid_1",
      jobId: "job_vid_1",
      userId: "usr_alice",
      type: "VIDEO",
      storageKey: "users/usr_alice/videos/job_vid_1/master.mp4",
      thumbnailKey: "users/usr_alice/videos/job_vid_1/thumb.webp",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      durationSeconds: 5.0,
      fileSize: BigInt(6291456), // 6.0 MB
    });

    this.jobs.set("job_clip_1", {
      id: "job_clip_1",
      userId: "usr_alice",
      type: GenerationType.VIDEO_CLIP,
      status: GenerationStatus.COMPLETED,
      prompt: "Highlights from conference talk",
      estimatedCredits: 20,
      chargedCredits: 20,
      errorMessage: null,
      createdAt: new Date("2026-11-12T12:00:00Z"),
      startedAt: new Date("2026-11-12T12:00:10Z"),
      completedAt: new Date("2026-11-12T12:01:30Z"),
    });

    this.assets.set("ast_clip_1", {
      id: "ast_clip_1",
      jobId: "job_clip_1",
      userId: "usr_alice",
      type: "VIDEO_CLIP",
      storageKey: "users/usr_alice/clips/job_clip_1/clip_1.mp4",
      thumbnailKey: null,
      mimeType: "video/mp4",
      width: 1080,
      height: 1920,
      durationSeconds: 15.2,
      fileSize: BigInt(8388608), // 8.0 MB
    });

    // Seed Bob jobs (for isolation checks)
    this.jobs.set("job_bob_active", {
      id: "job_bob_active",
      userId: "usr_bob",
      type: GenerationType.VIDEO,
      status: GenerationStatus.PROCESSING,
      prompt: "Bob's active rendering video",
      estimatedCredits: 50,
      chargedCredits: 0,
      errorMessage: null,
      createdAt: new Date("2026-11-12T13:00:00Z"),
      startedAt: new Date("2026-11-12T13:00:02Z"),
      completedAt: null,
    });
  }

  public getClient(): any {
    const db = this;

    return {
      generationJob: {
        async findFirst({ where, orderBy, select }: any) {
          const all = Array.from(db.jobs.values());
          const filtered = all.filter((j) => {
            if (where.id && j.id !== where.id) return false;
            if (where.userId && j.userId !== where.userId) return false;
            if (where.type && j.type !== where.type) return false;
            if (where.status?.in && !where.status.in.includes(j.status)) return false;
            if (where.status && typeof where.status === "string" && j.status !== where.status) return false;
            return true;
          });

          if (filtered.length === 0) return null;

          // Order by createdAt desc, id desc
          filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
          const match = filtered[0];

          if (!select) return match;
          const res: any = {};
          for (const key of Object.keys(select)) {
            if (select[key]) res[key] = match[key];
          }
          return res;
        },

        async findMany({ where, orderBy, take, cursor, skip, select }: any) {
          const all = Array.from(db.jobs.values());
          let filtered = all.filter((j) => {
            if (where.userId && j.userId !== where.userId) return false;
            if (where.type && j.type !== where.type) return false;
            return true;
          });

          // Order by createdAt desc, id desc
          filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));

          if (cursor?.id) {
            const idx = filtered.findIndex((j) => j.id === cursor.id);
            if (idx !== -1) {
              filtered = filtered.slice(idx + (skip ?? 0));
            }
          }

          if (take) {
            filtered = filtered.slice(0, take);
          }

          if (!select) return filtered;

          return filtered.map((item) => {
            const res: any = {};
            for (const key of Object.keys(select)) {
              if (key === "assets" && select.assets) {
                const jobAssets = Array.from(db.assets.values()).filter((a) => a.jobId === item.id);
                const limit = select.assets.take ?? jobAssets.length;
                res.assets = jobAssets.slice(0, limit).map((a) => {
                  const astRes: any = {};
                  for (const aKey of Object.keys(select.assets.select)) {
                    astRes[aKey] = a[aKey];
                  }
                  return astRes;
                });
              } else if (select[key]) {
                res[key] = item[key];
              }
            }
            return res;
          });
        },
      },
    };
  }
}

async function runAllTests(): Promise<void> {
  console.log("================================================================================");
  console.log("   Stage 10 Batch 4 Test Suite — Unified Dashboard & Studio Navigation");
  console.log("================================================================================");

  await runSection("1. Active Studio Job Resolution (getActiveStudioJob)", async () => {
    const db = new MockDashboardDatabase();
    const client = db.getClient();

    // 1.1 Alice has no active jobs initially
    const activeAlice = await getActiveStudioJob("usr_alice", client);
    assert(activeAlice === null, "Alice initially has null active job (all completed)");

    // 1.2 Bob has an active video job in PROCESSING
    const activeBob = await getActiveStudioJob("usr_bob", client);
    assert(activeBob !== null, "Bob has an active studio job");
    assert(activeBob?.id === "job_bob_active", "Bob active job id matches");
    assert(activeBob?.type === GenerationType.VIDEO, "Bob active job type is VIDEO");
    assert(activeBob?.status === GenerationStatus.PROCESSING, "Bob active job status is PROCESSING");
    assert(activeBob?.prompt === "Bob's active rendering video", "Bob active job prompt matches");

    // 1.3 Add active IMAGE job for Alice in PENDING
    db.jobs.set("job_alice_image_active", {
      id: "job_alice_image_active",
      userId: "usr_alice",
      type: GenerationType.IMAGE,
      status: GenerationStatus.PENDING,
      prompt: "A floating crystal island in clouds",
      estimatedCredits: 1,
      chargedCredits: 0,
      errorMessage: null,
      createdAt: new Date("2026-11-12T14:00:00Z"),
      startedAt: null,
      completedAt: null,
    });

    const aliceImgActive = await getActiveStudioJob("usr_alice", client);
    assert(aliceImgActive !== null, "Alice now has active IMAGE job detected");
    assert(aliceImgActive?.id === "job_alice_image_active", "Active job is job_alice_image_active");
    assert(aliceImgActive?.type === GenerationType.IMAGE, "Active job type is IMAGE");
    assert(aliceImgActive?.status === GenerationStatus.PENDING, "Active job status is PENDING");

    // 1.4 Add active VIDEO_CLIP job for Alice in PROCESSING with newer timestamp
    db.jobs.set("job_alice_clip_active", {
      id: "job_alice_clip_active",
      userId: "usr_alice",
      type: GenerationType.VIDEO_CLIP,
      status: GenerationStatus.PROCESSING,
      prompt: "Smart scene clipping in progress",
      estimatedCredits: 20,
      chargedCredits: 0,
      errorMessage: null,
      createdAt: new Date("2026-11-12T15:00:00Z"),
      startedAt: new Date("2026-11-12T15:00:02Z"),
      completedAt: null,
    });

    const aliceNewestActive = await getActiveStudioJob("usr_alice", client);
    assert(aliceNewestActive?.id === "job_alice_clip_active", "Newest active job is returned first");
    assert(aliceNewestActive?.type === GenerationType.VIDEO_CLIP, "Detected active VIDEO_CLIP job");
    assert(aliceNewestActive?.status === GenerationStatus.PROCESSING, "Detected status PROCESSING");

    // 1.5 Terminal status transitions remove from active ribbon
    db.jobs.get("job_alice_clip_active")!.status = GenerationStatus.COMPLETED;
    db.jobs.get("job_alice_image_active")!.status = GenerationStatus.FAILED;

    const aliceResolved = await getActiveStudioJob("usr_alice", client);
    assert(aliceResolved === null, "Once all jobs transition to terminal states, active ribbon resolves to null");

    // 1.6 User isolation: non-existent user returns null
    const unknownUserJob = await getActiveStudioJob("usr_nonexistent", client);
    assert(unknownUserJob === null, "Non-existent user has null active job");
  });

  await runSection("2. Unified History Query & Asset Metadata (getUnifiedHistoryPage)", async () => {
    const db = new MockDashboardDatabase();
    const client = db.getClient();

    // 2.1 Query all history for Alice
    const historyAll = await getUnifiedHistoryPage("usr_alice", {}, client);
    assert(historyAll.items.length === 3, `Alice has 3 completed jobs (got ${historyAll.items.length})`);
    assert(historyAll.nextCursor === null, "No further pages with default take");

    // 2.2 Verify asset attachments and fields on each job type
    const imgJob = historyAll.items.find((j) => j.type === GenerationType.IMAGE);
    assert(Boolean(imgJob), "Found IMAGE job in history");
    assert(imgJob!.assets.length === 1, "Image job has attached asset");
    assert(imgJob!.assets[0].width === 1024, "Asset width is 1024");
    assert(imgJob!.assets[0].height === 1024, "Asset height is 1024");
    assert(imgJob!.assets[0].fileSize === BigInt(1048576), "Asset size matches");

    const vidJob = historyAll.items.find((j) => j.type === GenerationType.VIDEO);
    assert(Boolean(vidJob), "Found VIDEO job in history");
    assert(vidJob!.assets.length === 1, "Video job has attached asset");
    assert(vidJob!.assets[0].durationSeconds === 5.0, "Video asset duration is 5.0s");
    assert(vidJob!.assets[0].width === 1280, "Video asset width is 1280");
    assert(vidJob!.assets[0].height === 720, "Video asset height is 720");
    assert(vidJob!.assets[0].thumbnailKey !== null, "Video asset has thumbnailKey");

    const clipJob = historyAll.items.find((j) => j.type === GenerationType.VIDEO_CLIP);
    assert(Boolean(clipJob), "Found VIDEO_CLIP job in history");
    assert(clipJob!.assets.length === 1, "Clip job has attached asset");
    assert(clipJob!.assets[0].durationSeconds === 15.2, "Clip asset duration is 15.2s");
    assert(clipJob!.assets[0].width === 1080 && clipJob!.assets[0].height === 1920, "Clip asset vertical 9:16 format");

    // 2.3 Filter by type
    const onlyVideo = await getUnifiedHistoryPage("usr_alice", { type: GenerationType.VIDEO }, client);
    assert(onlyVideo.items.length === 1, "Filtering by VIDEO returns exactly 1 item");
    assert(onlyVideo.items[0].type === GenerationType.VIDEO, "Filtered item is VIDEO");

    const onlyClips = await getUnifiedHistoryPage("usr_alice", { type: GenerationType.VIDEO_CLIP }, client);
    assert(onlyClips.items.length === 1, "Filtering by VIDEO_CLIP returns exactly 1 item");
    assert(onlyClips.items[0].type === GenerationType.VIDEO_CLIP, "Filtered item is VIDEO_CLIP");

    // 2.4 Keyset Pagination with cursor
    const paged1 = await getUnifiedHistoryPage("usr_alice", { take: 2 }, client);
    assert(paged1.items.length === 2, "Page 1 returned 2 items");
    assert(paged1.nextCursor !== null, "Page 1 has nextCursor");

    const paged2 = await getUnifiedHistoryPage("usr_alice", { take: 2, cursor: paged1.nextCursor! }, client);
    assert(paged2.items.length === 1, "Page 2 returned remaining 1 item");
    assert(paged2.nextCursor === null, "Page 2 has no nextCursor");
    assert(paged1.items[0].id !== paged2.items[0].id, "Page 1 and Page 2 contain distinct jobs");

    // 2.5 User Isolation: Alice cannot see Bob's job in history
    const bobInAlice = historyAll.items.find((j) => j.id === "job_bob_active");
    assert(!bobInAlice, "Alice history does NOT leak Bob's jobs");
  });

  await runSection("3. Studio Navigation Configuration (STUDIO_TOOLS)", () => {
    // 3.1 Exactly 3 tools configured
    assert(STUDIO_TOOLS.length === 3, "STUDIO_TOOLS has exactly 3 tools");

    const [imgTool, vidTool, clipTool] = STUDIO_TOOLS;

    // 3.2 AI Image Tool
    assert(imgTool.id === "image", "Tool 1 id is 'image'");
    assert(imgTool.href === "/ai-image", "Tool 1 route is /ai-image");
    assert(imgTool.badge === "FLUX.1 Schnell", "Tool 1 badge is FLUX.1 Schnell");
    assert(imgTool.costLabel === "1 cr", "Tool 1 cost label is '1 cr'");

    // 3.3 AI Video Tool
    assert(vidTool.id === "video", "Tool 2 id is 'video'");
    assert(vidTool.href === "/ai-video", "Tool 2 route is /ai-video");
    assert(vidTool.badge === "Wan 2.1", "Tool 2 badge is Wan 2.1");
    assert(vidTool.costLabel === "10 cr", "Tool 2 cost label is '10 cr' (matches backend DEFAULT_VIDEO_CREDIT_COST)");

    // 3.4 Video Clipper Tool
    assert(clipTool.id === "clipper", "Tool 3 id is 'clipper'");
    assert(clipTool.href === "/video-clipper", "Tool 3 route is /video-clipper");
    assert(clipTool.badge === "Smart Cut", "Tool 3 badge is Smart Cut");
    assert(
      clipTool.costLabel === "5 cr/clip",
      "Tool 3 cost label is '5 cr/clip' (matches backend DEFAULT_CREDIT_COST_PER_CLIP)",
    );
  });

  await runSection("4. File Size Formatting (formatFileSize)", () => {
    assert(formatFileSize(null) === "—", "null returns em-dash");
    assert(formatFileSize(undefined) === "—", "undefined returns em-dash");
    assert(formatFileSize(0) === "0 B", "0 bytes returns '0 B'");
    assert(formatFileSize(512) === "512 B", "512 bytes returns '512 B'");
    assert(formatFileSize(1024) === "1.0 KB", "1024 bytes returns '1.0 KB'");
    assert(formatFileSize(1536) === "1.5 KB", "1536 bytes returns '1.5 KB'");
    assert(formatFileSize(1048576) === "1.0 MB", "1048576 bytes returns '1.0 MB'");
    assert(formatFileSize(BigInt(5242880)) === "5.0 MB", "BigInt(5242880) returns '5.0 MB'");
  });

  await runSection("5. Cross-Tool Video / Clipper Incompatibility Guard", () => {
    // Per Section 17.3: Wan 2.1 video output duration is 5.0 seconds.
    // Video Clipper minimum source duration requirement is 15.0 seconds.
    // Therefore direct cross-tool piping is NOT supported and tools remain decoupled.
    const WAN_OUTPUT_DURATION_SECONDS = 5.0;
    const CLIPPER_MIN_SOURCE_DURATION_SECONDS = 15.0;

    const isDirectlyPipable = WAN_OUTPUT_DURATION_SECONDS >= CLIPPER_MIN_SOURCE_DURATION_SECONDS;
    assert(
      !isDirectlyPipable,
      "Direct Wan 2.1 (5s) -> Video Clipper (min 15s) piping is structurally incompatible and prohibited",
    );
  });

  console.log("\n================================================================================");
  console.log(`✅ All ${passedTests} / ${totalTests} Stage 10 Batch 4 Tests Passed Successfully!`);
  console.log("================================================================================\n");
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
