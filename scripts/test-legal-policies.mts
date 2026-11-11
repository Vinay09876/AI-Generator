import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LEGAL_ROUTES, ROUTES, INITIAL_CREDITS, SITE } from "../src/lib/constants";
import { DAILY_USER_IMAGE_LIMIT, IMAGE_QUALITIES, PROMPT_MAX_LENGTH } from "../src/features/generations/config";
import { DEFAULT_DAILY_USER_VIDEO_LIMIT, DEFAULT_VIDEO_CREDIT_COST } from "../src/features/video/config";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res
        .then(() => {
          passed++;
          console.log(`PASS  ${name}`);
        })
        .catch((err) => {
          failed++;
          console.error(`FAIL  ${name}:`, err);
        });
    }
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}:`, err);
  }
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

async function run() {
  console.log("\n# Sub-Batch 3B — Legal Routes & Constants Consistency");

  await test("LEGAL_ROUTES defines terms, privacy, acceptableUse matching ROUTES", () => {
    assert.equal(LEGAL_ROUTES.terms, "/terms");
    assert.equal(LEGAL_ROUTES.privacy, "/privacy");
    assert.equal(LEGAL_ROUTES.acceptableUse, "/acceptable-use");

    assert.equal(ROUTES.terms, LEGAL_ROUTES.terms);
    assert.equal(ROUTES.privacy, LEGAL_ROUTES.privacy);
    assert.equal(ROUTES.acceptableUse, LEGAL_ROUTES.acceptableUse);
  });

  console.log("\n# Sub-Batch 3B — Terms of Service Page (/terms)");

  await test("Terms of Service page exists, exports metadata and default component", async () => {
    const termsMod = await import("../src/app/(marketing)/terms/page");
    assert.ok(termsMod.default, "Terms page must have default export");
    assert.ok(termsMod.metadata, "Terms page must have metadata export");
    assert.equal(termsMod.metadata.title, "Terms of Service");
  });

  await test("Terms of Service content is grounded in actual architecture", () => {
    const content = readFile("src/app/(marketing)/terms/page.tsx");

    // Fast & Detailed pricing matching config
    assert.ok(
      content.includes("IMAGE_QUALITIES.fast.credits") || content.includes(`${IMAGE_QUALITIES.fast.credits} credit`),
      "Must state Fast generation pricing",
    );
    assert.ok(
      content.includes("IMAGE_QUALITIES.detailed.credits") || content.includes(`${IMAGE_QUALITIES.detailed.credits} credits`),
      "Must state Detailed generation pricing",
    );

    // Initial promotional credit grant
    assert.ok(
      content.includes("INITIAL_CREDITS") || content.includes(`${INITIAL_CREDITS}`),
      "Must state 100 promotional credits initial grant",
    );

    // Daily limit
    assert.ok(
      content.includes("DAILY_USER_IMAGE_LIMIT") || content.includes(`${DAILY_USER_IMAGE_LIMIT}`),
      "Must state daily limit of 10 jobs per UTC day",
    );

    // Concurrency
    assert.ok(content.includes("1 active"), "Must state 1 active concurrent generation job limit");

    // Promotional & Automatic Credit Restoration
    assert.ok(content.toLowerCase().includes("promotional"), "Must state promotional nature of credits");
    assert.ok(content.toLowerCase().includes("no cash value"), "Must disclose promotional credits have no cash value");
    assert.ok(
      content.includes("Automatic Credit Restoration") || content.includes("restored"),
      "Must explain automatic credit restoration on generation failure",
    );
    assert.ok(
      content.toLowerCase().includes("downstream") || content.toLowerCase().includes("reconciliation"),
      "Must explain failure conditions under which credits are restored",
    );

    // Disclaimers of uniqueness, accuracy, commercial safety
    assert.ok(content.toLowerCase().includes("uniqueness"), "Must disclose no guarantee of uniqueness");
    assert.ok(content.toLowerCase().includes("accuracy"), "Must disclose no warranty of accuracy");
    assert.ok(content.toLowerCase().includes("commercial"), "Must disclose commercial risks");

    // Governing law & jurisdiction flagged for qualified legal review
    assert.ok(content.includes("India"), "Governing law must specify India as draft provision");
    assert.ok(
      content.toLowerCase().includes("legal review") || content.toLowerCase().includes("provisional"),
      "Jurisdiction and dispute resolution must be flagged for qualified legal review",
    );

    // Account deletion disclosure
    assert.ok(
      content.includes("unsupported") && content.includes("deletion"),
      "Must disclose self-service account deletion is currently unsupported in software",
    );

    // Contact notice - pre-launch status without fake email
    assert.ok(content.includes("pre-release"), "Must acknowledge pre-release status");
  });

  console.log("\n# Sub-Batch 3B — Privacy Policy Page (/privacy)");

  await test("Privacy Policy page exists, exports metadata and default component", async () => {
    const privacyMod = await import("../src/app/(marketing)/privacy/page");
    assert.ok(privacyMod.default, "Privacy page must have default export");
    assert.ok(privacyMod.metadata, "Privacy page must have metadata export");
    assert.equal(privacyMod.metadata.title, "Privacy Policy");
  });

  await test("Privacy Policy accurately reflects data collection and infrastructure", () => {
    const content = readFile("src/app/(marketing)/privacy/page.tsx");

    // Account information & security
    assert.ok(content.includes("bcryptjs"), "Must document bcryptjs password hashing");
    assert.ok(content.includes("email"), "Must document collection of email");

    // Session authentication & cookies
    assert.ok(content.includes("authjs.session-token"), "Must document Auth.js v5 session cookie");
    assert.ok(content.includes("HttpOnly"), "Must document HttpOnly cookie flag");

    // Client storage
    assert.ok(content.includes("localStorage"), "Must document localStorage");
    assert.ok(
      content.includes("recovery") || content.includes("pending"),
      "Must document localStorage is used solely for client-side crash/refresh recovery",
    );

    // Subprocessors & Regions
    assert.ok(content.includes("Cloudflare"), "Must document Cloudflare Workers AI subprocessor");
    assert.ok(content.includes("Supabase"), "Must document Supabase subprocessor");
    assert.ok(content.includes("Tokyo"), "Must document Supabase Tokyo region (AWS ap-northeast-1)");

    // Private storage & signed URLs
    assert.ok(content.includes("10 minutes") || content.includes("600 seconds"), "Must document 10-minute signed URL validity");
    assert.ok(content.includes("private"), "Must document private object storage");

    // Deletion disclosure
    assert.ok(
      content.includes("unsupported") && content.includes("deletion"),
      "Must disclose that automated self-service account deletion is currently unsupported",
    );
  });

  console.log("\n# Sub-Batch 3B — Acceptable Use Policy Page (/acceptable-use)");

  await test("Acceptable Use Policy page exists, exports metadata and default component", async () => {
    const aupMod = await import("../src/app/(marketing)/acceptable-use/page");
    assert.ok(aupMod.default, "AUP page must have default export");
    assert.ok(aupMod.metadata, "AUP page must have metadata export");
    assert.equal(aupMod.metadata.title, "Acceptable Use Policy");
  });

  await test("Acceptable Use Policy accurately specifies prohibited content and realistic enforcement", () => {
    const content = readFile("src/app/(marketing)/acceptable-use/page.tsx");

    // Zero-tolerance CSAM / CSAE with qualified referral language
    assert.ok(content.includes("CSAM") || content.includes("CSAE"), "Must state zero tolerance for CSAM/CSAE");
    assert.ok(content.toLowerCase().includes("law enforcement") || content.toLowerCase().includes("statutory"), "Must state reserved referral to authorities");
    assert.ok(content.toLowerCase().includes("legal review"), "Referral must be qualified as subject to legal review");
    assert.ok(
      content.toLowerCase().includes("not currently operate") || content.toLowerCase().includes("no automated"),
      "Must clarify absence of an automated direct reporting API integration",
    );

    // NCII and real persons
    assert.ok(content.includes("Non-Consensual") || content.includes("NCII"), "Must prohibit NCII");

    // Hate speech, violence, fraud
    assert.ok(content.toLowerCase().includes("hate speech"), "Must prohibit hate speech");
    assert.ok(content.toLowerCase().includes("violence"), "Must prohibit violence");
    assert.ok(content.toLowerCase().includes("fraud") || content.toLowerCase().includes("phishing"), "Must prohibit fraud/phishing");

    // System abuse & prompt limits
    assert.ok(content.toLowerCase().includes("rate limit"), "Must prohibit bypassing rate limits");
    assert.ok(
      content.includes("PROMPT_MAX_LENGTH") || content.includes(`${PROMPT_MAX_LENGTH}`),
      `Must reference prompt max length (${PROMPT_MAX_LENGTH})`,
    );

    // Realistic enforcement (truthful disclosure of software vs contractual rights)
    assert.ok(
      content.toLowerCase().includes("no automated pre-inference"),
      "Must truthfully disclose absence of automated pre-inference safety screening",
    );
    assert.ok(
      content.toLowerCase().includes("absence of internal moderation tooling") || content.toLowerCase().includes("not currently implemented"),
      "Must disclose that moderation tooling and intake queues are not implemented in software",
    );
    assert.ok(
      content.toLowerCase().includes("contractually reserves") || content.toLowerCase().includes("reserves the full legal right"),
      "Must distinguish contractual termination rights from software capabilities",
    );
  });

  console.log("\n# Sub-Batch 3B — UX Discoverability & Navigation Touchpoints");

  await test("Footer contains Legal column and bottom bar links to all 3 policies", () => {
    const footerContent = readFile("src/components/layout/footer.tsx");
    assert.ok(footerContent.includes("ROUTES.terms"), "Footer must link to Terms of Service");
    assert.ok(footerContent.includes("ROUTES.privacy"), "Footer must link to Privacy Policy");
    assert.ok(footerContent.includes("ROUTES.acceptableUse"), "Footer must link to Acceptable Use Policy");
    assert.ok(footerContent.includes("Legal"), "Footer must include a 'Legal' section header");
  });

  await test("Registration Form contains agreement disclaimer linking to all 3 policies", () => {
    const regContent = readFile("src/features/auth/components/register-form.tsx");
    assert.ok(regContent.includes("ROUTES.terms"), "Register form must link to Terms of Service");
    assert.ok(regContent.includes("ROUTES.privacy"), "Register form must link to Privacy Policy");
    assert.ok(regContent.includes("ROUTES.acceptableUse"), "Register form must link to Acceptable Use Policy");
  });

  await test("Image prompt editor & composer link to Acceptable Use Policy", () => {
    const editorContent = readFile("src/components/image-generator/prompt-editor.tsx");
    const composerContent = readFile("src/components/image-generator/image-generator.tsx");
    assert.ok(
      editorContent.includes("ROUTES.acceptableUse") || composerContent.includes("ROUTES.acceptableUse"),
      "Image generator must link to Acceptable Use Policy",
    );
  });

  await test("Settings page contains Data, Privacy & Legal panel with required disclosures", () => {
    const settingsContent = readFile("src/app/(dashboard)/settings/page.tsx");
    assert.ok(settingsContent.includes("ROUTES.terms"), "Settings must link to Terms of Service");
    assert.ok(settingsContent.includes("ROUTES.privacy"), "Settings must link to Privacy Policy");
    assert.ok(settingsContent.includes("ROUTES.acceptableUse"), "Settings must link to Acceptable Use Policy");
    assert.ok(
      settingsContent.includes("unsupported") && settingsContent.includes("deletion"),
      "Settings must disclose that self-service account deletion is currently unsupported",
    );
    assert.ok(
      settingsContent.includes("Tokyo") || settingsContent.includes("Supabase Storage"),
      "Settings must disclose Tokyo asset storage",
    );
    assert.ok(settingsContent.includes("10-minute"), "Settings must disclose 10-minute signed URLs");
  });

  console.log("\n# Sub-Batch 3B — Negative Invariants & Truthfulness Verifications");

  await test("No fabricated operator emails exist in legal pages or touchpoints", () => {
    const filesToCheck = [
      "src/app/(marketing)/terms/page.tsx",
      "src/app/(marketing)/privacy/page.tsx",
      "src/app/(marketing)/acceptable-use/page.tsx",
      "src/components/layout/footer.tsx",
      "src/features/auth/components/register-form.tsx",
      "src/app/(dashboard)/settings/page.tsx",
    ];

    const fabricatedPatterns = [
      /@yourai\./i,
      /support@/i,
      /legal@/i,
      /privacy@/i,
      /contact@/i,
      /help@/i,
      /admin@/i,
      /dpo@/i,
      /grievance@/i,
      /abuse@/i,
    ];

    for (const file of filesToCheck) {
      const content = readFile(file);
      for (const pattern of fabricatedPatterns) {
        assert.ok(
          !pattern.test(content),
          `File ${file} must not contain fabricated email matching ${pattern}`,
        );
      }
    }
  });

  await test("No fictitious automated AI scanners or vision classifiers claimed in legal policies", () => {
    const filesToCheck = [
      "src/app/(marketing)/terms/page.tsx",
      "src/app/(marketing)/privacy/page.tsx",
      "src/app/(marketing)/acceptable-use/page.tsx",
    ];

    const fakeScannerPhrases = [
      "automated ai scanner",
      "automated computer vision filter",
      "ai moderation bot",
      "autonomous content scanner",
      "computer vision classifier scans all",
      "cloudflare deploys built-in model safety",
    ];

    for (const file of filesToCheck) {
      const lower = readFile(file).toLowerCase();
      for (const phrase of fakeScannerPhrases) {
        assert.ok(
          !lower.includes(phrase),
          `File ${file} must not claim fictional capability "${phrase}"`,
        );
      }
    }
  });

  await test("No automated self-service account deletion claimed", () => {
    const filesToCheck = [
      "src/app/(marketing)/terms/page.tsx",
      "src/app/(marketing)/privacy/page.tsx",
      "src/app/(dashboard)/settings/page.tsx",
    ];

    for (const file of filesToCheck) {
      const content = readFile(file);
      assert.ok(
        content.includes("unsupported"),
        `File ${file} must explicitly state self-service account deletion is unsupported`,
      );
    }
  });

  await test("No operational moderation workflow, queue, or admin dashboard claimed", () => {
    const filesToCheck = [
      "src/app/(marketing)/terms/page.tsx",
      "src/app/(marketing)/privacy/page.tsx",
      "src/app/(marketing)/acceptable-use/page.tsx",
    ];

    const fakeOperationalPhrases = [
      "operational moderation queue",
      "dedicated moderation team",
      "24/7 moderation desk",
      "automated suspension workflow",
      "intake queue processes",
      "moderators actively monitor",
    ];

    for (const file of filesToCheck) {
      const lower = readFile(file).toLowerCase();
      for (const phrase of fakeOperationalPhrases) {
        assert.ok(
          !lower.includes(phrase),
          `File ${file} must not claim unbuilt operational capability "${phrase}"`,
        );
      }
    }
  });

  console.log("\n# Stage 8 — Video Legal Reconciliation & Negative Invariants");

  await test("Terms of Service accurately discloses video generation pricing, model & quotas", () => {
    const content = readFile("src/app/(marketing)/terms/page.tsx");
    assert.ok(
      content.includes(`${DEFAULT_VIDEO_CREDIT_COST} credits`) || content.includes("DEFAULT_VIDEO_CREDIT_COST"),
      "Terms must disclose video credit pricing (10 credits)",
    );
    assert.ok(
      content.includes("Wan 2.1"),
      "Terms must disclose Tongyi Wan 2.1 video model",
    );
    assert.ok(
      content.includes("Fal.ai"),
      "Terms must disclose Fal.ai inference hosting",
    );
    assert.ok(
      content.includes("16 FPS") || content.includes("16 fps"),
      "Terms must accurately disclose native 16 FPS frame rate",
    );
    assert.ok(
      content.includes("Apache 2.0"),
      "Terms must disclose Apache 2.0 open weights licensing for Wan 2.1",
    );
    assert.ok(
      content.includes("1 active concurrent") || content.includes("maximum of 1 active concurrent"),
      "Terms must disclose platform-wide 1 active generation job concurrency lock across all media types",
    );
  });

  await test("Terms of Service accurately discloses ambiguous submission handling and operator review", () => {
    const content = readFile("src/app/(marketing)/terms/page.tsx");
    assert.ok(
      content.toLowerCase().includes("not automatically refunded") || content.toLowerCase().includes("not automatically refunded merely"),
      "Terms must state ambiguous submissions are not automatically refunded merely due to 15-minute timeout",
    );
    assert.ok(
      content.includes("pending_operator_review") || content.toLowerCase().includes("operator review"),
      "Terms must disclose operator review for ambiguous submissions",
    );
    assert.ok(
      content.toLowerCase().includes("correlation token"),
      "Terms must reference cryptographic correlation token for webhook recovery",
    );
  });

  await test("Privacy Policy accurately documents Fal.ai subprocessor and video metadata", () => {
    const content = readFile("src/app/(marketing)/privacy/page.tsx");
    assert.ok(
      content.includes("Fal.ai") || content.includes("Features Analytics"),
      "Privacy policy must list Fal.ai / Features Analytics Inc. as a subprocessor",
    );
    assert.ok(
      content.includes("Wan 2.1"),
      "Privacy policy must identify Wan 2.1 video generation model",
    );
    assert.ok(
      content.includes("Ed25519"),
      "Privacy policy must document Ed25519 cryptographic webhook verification",
    );
    assert.ok(
      content.includes("MP4") && content.includes("WebP"),
      "Privacy policy must document storage of MP4 video and WebP thumbnail assets",
    );
  });

  await test("Acceptable Use Policy accurately specifies video technical boundaries & safety checker", () => {
    const content = readFile("src/app/(marketing)/acceptable-use/page.tsx");
    assert.ok(
      content.includes("safety_checker") || content.toLowerCase().includes("safety checker"),
      "AUP must disclose provider AI safety checker enabled for video generation",
    );
    assert.ok(
      content.includes(`${PROMPT_MAX_LENGTH}`) || content.includes("PROMPT_MAX_LENGTH"),
      "AUP must enforce prompt max length limit",
    );
    assert.ok(
      content.toLowerCase().includes("correlation token") || content.toLowerCase().includes("webhook"),
      "AUP must prohibit tampering with webhook correlation tokens",
    );
  });

  await test("No fabricated retention periods (no 30-day promise without cleanup mechanism)", () => {
    const files = [
      "src/app/(marketing)/terms/page.tsx",
      "src/app/(marketing)/privacy/page.tsx",
    ];

    for (const file of files) {
      const lower = readFile(file).toLowerCase();
      assert.ok(
        !lower.includes("30 days") && !lower.includes("30-day retention"),
        `File ${file} must not claim unbuilt 30-day retention cleanup schedule`,
      );
      assert.ok(
        lower.includes("does not currently operate an automated") || lower.includes("does not operate an automated"),
        `File ${file} must truthfully disclose absence of automated background media deletion`,
      );
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
