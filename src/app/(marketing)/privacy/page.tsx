import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_ROUTES, ROUTES, SITE } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How YourAI collects, processes, and protects your personal data and generation inputs.",
};

export default function PrivacyPolicyPage() {
  const lastUpdated = "November 11, 2026";

  return (
    <article className="mx-auto max-w-4xl px-4 py-16 sm:px-6 sm:py-24">
      <header className="mb-12 border-b border-white/[0.08] pb-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-violet/30 bg-violet/10 px-3 py-1 text-xs font-medium text-violet-300">
          Data Governance
        </div>
        <h1 className="mt-4 font-display text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-muted">Last updated: {lastUpdated} • Version 1.1 (Pre-Release)</p>
      </header>

      <div className="space-y-10 text-[15px] leading-relaxed text-muted">
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">1. Introduction &amp; Scope</h2>
          <p>
            This Privacy Policy explains how {SITE.name} (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) collects, uses,
            stores, and safeguards your personal data when you interact with our website and generative AI services (including AI Image Generation and AI Video Generation).
            We are committed to operating transparently, adhering to sound data protection principles, and disclosing the
            exact technical infrastructure powering the platform.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">2. Data We Collect</h2>
          <p>We collect and process the following categories of information:</p>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Account Information:</strong> When you register, we collect your display name, email address, and an
              irreversible cryptographic password hash generated using bcryptjs. We never store, transmit, or log your plaintext password.
            </li>
            <li>
              <strong>Generative Prompts &amp; Parameters:</strong> When you submit a creative request, we store the text prompt,
              chosen quality configuration (&quot;fast&quot; or &quot;detailed&quot; for images), aspect ratio selection (16:9, 9:16, 1:1 for video),
              frame parameters, timestamp, and client execution parameters.
            </li>
            <li>
              <strong>Ledger &amp; Transaction Records:</strong> We maintain an immutable double-entry ledger recording all credit
              grants, authorizations, holds, debits, refunds, and balance states associated with your account.
            </li>
            <li>
              <strong>Generated Assets:</strong> We store the raster image assets (WebP) and synthesized video assets (H.264 MP4, WebP poster frame)
              output by the inference engines and link their private storage keys to your user record.
            </li>
            <li>
              <strong>Operational &amp; Network Metadata:</strong> For security, abuse prevention, rate-limiting, and webhook correlation purposes, our
              edge proxies and application handlers process HTTP request headers, browser user-agent strings, client IP addresses, and provider webhook delivery identifiers.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">3. Authentication, Cookies &amp; Local Storage</h2>
          <p>
            {SITE.name} uses minimal client-side state required strictly for security and functional session continuity:
          </p>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Session Cookies (Auth.js v5):</strong> We issue encrypted JSON Web Token (JWT) session cookies
              (<code>authjs.session-token</code>) with the <code>HttpOnly</code>, <code>SameSite=Lax</code>, and <code>Secure</code> flags
              enabled in production environments. These cookies are strictly necessary to maintain your authenticated state across requests.
            </li>
            <li>
              <strong>Local Browser Storage (localStorage):</strong> We use browser <code>localStorage</code> exclusively for
              transient client-side crash and page-refresh recovery of pending generation requests. If your network disconnects or your
              browser closes mid-generation, this local record allows the generator interface to re-attach to the server job upon return.
              We do not use tracking cookies, cross-site trackers, or third-party marketing beacons.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">4. Infrastructure &amp; Third-Party Subprocessors</h2>
          <p>
            To deliver generative capabilities and maintain secure infrastructure, we partner with verified cloud infrastructure providers:
          </p>
          <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/[0.08] bg-white/[0.02] text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-3">Subprocessor</th>
                  <th className="px-4 py-3">Purpose &amp; Processing Scope</th>
                  <th className="px-4 py-3">Region / Location</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                <tr>
                  <td className="px-4 py-3 font-medium text-foreground">Supabase Inc.</td>
                  <td className="px-4 py-3">Relational PostgreSQL database &amp; private object storage (generated assets bucket)</td>
                  <td className="px-4 py-3">Tokyo, Japan (AWS ap-northeast-1)</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-foreground">Cloudflare, Inc.</td>
                  <td className="px-4 py-3">AI Image Model Inference (Workers AI FLUX.1 Schnell) &amp; Edge Security CDN</td>
                  <td className="px-4 py-3">Global Edge Network</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-foreground">Features Analytics Inc. (Fal.ai)</td>
                  <td className="px-4 py-3">AI Video Model Inference (Alibaba Tongyi Wan 2.1 720p) &amp; Webhook Delivery</td>
                  <td className="px-4 py-3">United States / Global Cloud</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">
            Text prompts submitted for image generation are dispatched via encrypted HTTPS to Cloudflare Workers AI for neural inference.
            Text prompts and video parameters submitted for video generation are dispatched via encrypted HTTPS to Fal.ai. Fal.ai returns completion notifications via asynchronous webhooks verified with Ed25519 signatures and HMAC-SHA256 correlation tokens.
            Neither provider uses prompts submitted through our enterprise API configurations to train base frontier models without customer consent.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">5. Private Asset Storage &amp; 10-Minute Signed URLs</h2>
          <p>
            Protecting your generated imagery and video assets from unauthorized third-party access is a fundamental architectural commitment:
          </p>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Private Object Storage:</strong> All generated image (WebP) and video (H.264 MP4, WebP thumbnail) files are written to a strictly private bucket on Supabase Storage.
              Direct unauthenticated HTTP access to the storage bucket is entirely disabled.
            </li>
            <li>
              <strong>Time-Limited Signed URLs:</strong> To view, stream, or download an asset, your client makes an authenticated request to our
              asset gateway. After verifying your session and confirming account ownership of the asset prefix (<code>users/{'{userId}'}/...</code>), the server issues a cryptographically
              signed HMAC URL with a strictly limited expiration time of 10 minutes (600 seconds). Once expired, the URL cannot be reused.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">6. Data Retention &amp; Account Deletion Status</h2>
          <p>
            We retain account data and generation records for as long as your account exists to provide history, gallery access, and auditability.
            The Service does not operate an automated deletion schedule for generated media files. Users should download assets they wish to keep permanently.
          </p>
          <div className="rounded-2xl border border-amber-300/20 bg-amber-400/[0.06] p-4 text-amber-100">
            <h3 className="text-sm font-semibold text-amber-200">Notice Regarding Account Deletion</h3>
            <p className="mt-1 text-xs leading-relaxed text-amber-200/80">
              Automated self-service account deletion is currently unsupported in software. The relational data schema maintains
              strict transactional integrity across concurrent budget reservations, ledger credits, generation jobs, and generated asset records. Due to these
              architectural dependencies, automated self-service account deletion is currently disabled. Manual deletion workflows and
              dedicated administrative closure channels will be established prior to public launch.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">7. Security &amp; Data Safeguards</h2>
          <p>
            We employ industry-standard administrative, physical, and technical defenses, including TLS 1.3 transport encryption,
            Content Security Policies (CSP), HTTP Strict Transport Security (HSTS), process-local burst rate limiting, Ed25519 webhook signature validation,
            DNS connection pinning against SSRF and rebinding attacks, and strictly credentialed server boundaries.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">8. Operator Contact &amp; Grievances</h2>
          <p>
            {SITE.name} is currently in active pre-release development. In accordance with applicable data protection regulations
            (including India&apos;s Digital Personal Data Protection Act), verified Data Protection Officer (DPO) and grievance redressal
            contact addresses will be published on this page before public commercial availability.
          </p>
        </section>
      </div>

      <footer className="mt-16 border-t border-white/[0.08] pt-8 text-center">
        <Link
          href={ROUTES.register}
          className="inline-flex items-center gap-2 rounded-xl bg-violet px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet/90"
        >
          Return to Registration
        </Link>
      </footer>
    </article>
  );
}
