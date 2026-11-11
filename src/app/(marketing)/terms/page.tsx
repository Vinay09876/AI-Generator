import type { Metadata } from "next";
import Link from "next/link";
import { INITIAL_CREDITS, LEGAL_ROUTES, ROUTES, SITE } from "@/lib/constants";
import { DAILY_USER_IMAGE_LIMIT, IMAGE_QUALITIES } from "@/features/generations/config";
import { DEFAULT_DAILY_USER_VIDEO_LIMIT, DEFAULT_VIDEO_CREDIT_COST } from "@/features/video/config";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms and conditions governing your access to and use of YourAI.",
};

export default function TermsOfServicePage() {
  const lastUpdated = "November 11, 2026";

  return (
    <article className="mx-auto max-w-4xl px-4 py-16 sm:px-6 sm:py-24">
      <header className="mb-12 border-b border-white/[0.08] pb-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-violet/30 bg-violet/10 px-3 py-1 text-xs font-medium text-violet-300">
          Legal Agreement
        </div>
        <h1 className="mt-4 font-display text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-muted">Last updated: {lastUpdated} • Version 1.1 (Pre-Release)</p>
      </header>

      <div className="space-y-10 text-[15px] leading-relaxed text-muted">
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">1. Acceptance of Terms</h2>
          <p>
            Welcome to {SITE.name} (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;). By creating an account,
            accessing our website, or using any of our generative AI tools (collectively, the &quot;Service&quot;),
            you agree to be legally bound by these Terms of Service (&quot;Terms&quot;), our{" "}
            <Link href={LEGAL_ROUTES.privacy} className="text-violet-300 underline underline-offset-4 hover:text-violet-200">
              Privacy Policy
            </Link>
            , and our{" "}
            <Link href={LEGAL_ROUTES.acceptableUse} className="text-violet-300 underline underline-offset-4 hover:text-violet-200">
              Acceptable Use Policy
            </Link>
            . If you do not agree to these Terms, do not register for or use the Service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">2. Service Description &amp; Pre-Release Status</h2>
          <p>
            {SITE.name} is an AI-powered creative production platform. The Service currently provides:
          </p>
          <ul className="list-disc space-y-1.5 pl-6">
            <li>
              <strong>AI Image Generation:</strong> Text-to-image synthesis powered by FLUX.1 Schnell hosted on Cloudflare Workers AI.
            </li>
            <li>
              <strong>AI Video Generation:</strong> Text-to-video synthesis powered by Alibaba Tongyi Wan 2.1 (720p HD, 5 seconds at native 16 FPS) hosted on Fal.ai, operating under Stage 8 evaluation and access controls.
            </li>
          </ul>
          <p>
            Additional media capabilities, such as automated Video Clipping, are planned for subsequent development phases.
          </p>
          <p>
            The Service is currently in a pre-release evaluation phase. While we strive for high uptime and reliable inference,
            we make no contractual commitments regarding availability, latency, or uninterrupted access. We reserve the right to
            modify, throttle, suspend, or discontinue any feature at any time without prior notice.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">3. User Accounts &amp; Registration</h2>
          <p>
            To use the generation features of the Service, you must create an account by providing a valid email address,
            a secure password, and your name. You represent that you are at least 18 years of age (or the age of legal majority
            in your jurisdiction).
          </p>
          <p>
            You are solely responsible for maintaining the confidentiality of your account credentials and for all activities
            that occur under your account. You agree to notify us immediately of any unauthorized access or security breach.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">4. Promotional Credits, Accounting &amp; Refund Behavior</h2>
          <p>
            Access to computational inference is metered via credits tracked in an ACID-compliant double-entry ledger:
          </p>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Initial Promotional Grant:</strong> Upon successful account registration, new accounts receive a one-time promotional
              grant of {INITIAL_CREDITS} credits.
            </li>
            <li>
              <strong>Generation Pricing:</strong>
              <ul className="mt-1 list-disc space-y-1 pl-6 text-sm">
                <li>Fast image generation consumes {IMAGE_QUALITIES.fast.credits} credit per job.</li>
                <li>Detailed image generation consumes {IMAGE_QUALITIES.detailed.credits} credits per job.</li>
                <li>AI video generation consumes {DEFAULT_VIDEO_CREDIT_COST} credits per 5-second 720p generation.</li>
              </ul>
            </li>
            <li>
              <strong>Non-Redeemable Promotional Units:</strong> Promotional credits are granted gratuitously for product demonstration,
              evaluation, and testing. Promotional credits have no cash value, are not legal tender, cannot be cashed out or redeemed for fiat
              currency, and cannot be transferred between accounts. Paid credit purchases and commercial billing infrastructure are not yet
              active on the platform.
            </li>
            <li>
              <strong>Credit Debiting &amp; Automatic Failure Restorations:</strong> Credits debited for a generation job are restored to your account ledger under the following implemented conditions:
              <ul className="mt-1.5 list-disc space-y-1 pl-6 text-sm">
                <li>
                  <em>Upstream Rejection / Pre-Flight Failure:</em> The inference provider rejects the request before execution (e.g. invalid parameters or upstream rate limiting) or network connectivity fails before request transmission. In these cases, debited credits are restored immediately.
                </li>
                <li>
                  <em>Downstream Pipeline Failure:</em> The model completes inference, but downstream asset ingestion fails (e.g. payload decoding, storage upload, or database registration failure). Debited credits are restored automatically.
                </li>
                <li>
                  <em>Ordinary Job Reconciliation:</em> An in-flight job times out or suffers an unresolvable interruption where provider non-execution is confirmed; background reconciliation settles the job as failed and restores debited credits.
                </li>
              </ul>
            </li>
            <li>
              <strong>Ambiguous Submissions &amp; Operator Resolution:</strong> If an inference submission outcome is ambiguous (such as an in-flight network disconnection, gateway timeout, or unconfirmed provider queue status), debited credits are <strong>not automatically refunded merely due to an elapsed 15-minute timeout</strong>. To prevent double credit loss or duplicate generation charges while the third-party provider is actively processing, the job is preserved in an unresolved state (<code>pending_operator_review</code>) while the user&apos;s debit is held. If an authentic asynchronous webhook arrives with a cryptographically bound correlation token, the job completes normally. Otherwise, the job requires manual operator review and settlement, recording a permanent audit trail. Terminal refunds strictly prevent post-refund late completions.
            </li>
            <li>
              <strong>Finality of Completed Generations:</strong> When a generation job completes successfully and the resulting asset is
              registered in your account, the credit deduction is final. Credits cannot be refunded or restored on the basis of subjective
              dissatisfaction with artistic aesthetic, style, lighting, or compositional interpretation.
            </li>
            <li>
              <strong>Daily Generation Limits:</strong> To ensure equitable resource distribution and prevent automated resource
              exhaustion, promotional accounts are subject to authoritative daily quotas:
              <ul className="mt-1 list-disc space-y-1 pl-6 text-sm">
                <li>Up to {DAILY_USER_IMAGE_LIMIT} counted image generations per UTC day.</li>
                <li>Up to {DEFAULT_DAILY_USER_VIDEO_LIMIT} counted video generation per UTC day for promotional accounts. During Stage 8 evaluation, video generation in production environments is restricted to authorized QA accounts.</li>
              </ul>
            </li>
            <li>
              <strong>Concurrency Restrictions:</strong> Accounts are restricted to a maximum of 1 active concurrent generation job at
              any time across all media types (enforced by database constraint). Attempting to initiate concurrent jobs will be rejected until the running job reaches a terminal state.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">5. Intellectual Property &amp; Generated Content</h2>
          <p>
            <strong>Your Prompts:</strong> You retain ownership of the text prompts and inputs you provide to the Service. By submitting
            prompts, you grant us a worldwide, royalty-free license to transmit, process, and execute those prompts through our
            infrastructure and inference providers (including Cloudflare and Fal.ai) solely as necessary to provide and operate the Service.
          </p>
          <p>
            <strong>Generated Assets &amp; Model Terms:</strong> Subject to your compliance with these Terms, third-party provider licenses, and applicable law, we claim no ownership over
            the raster images or video outputs generated from your prompts. You acknowledge applicable model licenses:
          </p>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>FLUX.1 Schnell:</strong> Open weights released under the Apache 2.0 license, subject to Black Forest Labs usage policies.
            </li>
            <li>
              <strong>Tongyi Wan 2.1:</strong> Open weights released by Alibaba Cloud under the Apache 2.0 license, permitting commercial use subject to platform and provider acceptable use terms.
            </li>
            <li>
              <strong>No Guarantee of Uniqueness:</strong> Because generative models operate probabilistically on public datasets, other users may provide identical or substantially similar prompts and receive similar or identical outputs. The Service makes no representation that outputs will be unique or copyrightable.
            </li>
            <li>
              <strong>No Warranty of Accuracy or Legality:</strong> Generated imagery and video are produced algorithmically. We do not warrant
              that generated assets are accurate, safe, free of unintended artifacts, or compliant with third-party intellectual property rights.
            </li>
            <li>
              <strong>Commercial Risk:</strong> You assume all risks and liabilities associated with the commercial exploitation,
              publication, or distribution of generated outputs.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">6. Acceptable Use &amp; Prohibited Activities</h2>
          <p>
            You agree to strictly adhere to our{" "}
            <Link href={LEGAL_ROUTES.acceptableUse} className="text-violet-300 underline underline-offset-4 hover:text-violet-200">
              Acceptable Use Policy
            </Link>
            . In particular, you must never use the Service to generate Child Sexual Abuse Material (CSAM/CSAE), non-consensual
            sexual imagery (NCII), depictions of real individuals without authorization, hate speech, harassment, fraud, or content
            promoting real-world violence.
          </p>
          <p>
            You must not reverse engineer, decompile, scrape, abuse rate limits, or exploit concurrency controls of the Service.
            Violations will result in immediate account termination without notice.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">7. Storage, Retention &amp; Signed URLs</h2>
          <p>
            Generated image assets (WebP, up to 5 MB) and video assets (H.264 MP4, up to 35 MB, with WebP poster thumbnail) are stored in private cloud storage hosted on Supabase (Tokyo region). Direct public file access
            is disabled. Asset URLs provided through the interface are cryptographically signed HMAC tokens valid for a maximum
            duration of 10 minutes (600 seconds) and strictly require active account authorization and ownership verification to generate.
          </p>
          <p>
            <strong>Retention Disclosure:</strong> The Service does not currently operate an automated background expiration or deletion schedule for stored media assets. Assets remain accessible in your account history unless removed during platform maintenance or database resets. We do not promise fixed 30-day or permanent archival retention; you are strongly encouraged to download any generated assets you wish to preserve.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">8. Termination &amp; Account Status</h2>
          <p>
            We reserve the right to suspend or terminate your account and access to the Service at our sole discretion, without liability,
            for any conduct that violates these Terms, our Acceptable Use Policy, or applicable law, or for platform operational integrity.
          </p>
          <p>
            <strong>Self-Service Account Deletion:</strong> Please be advised that automated self-service account deletion is currently
            unsupported in the software due to data integrity constraints involving relational budget allocations, credit transaction
            ledgers, generation jobs, and asset records. Dedicated operator contact channels and manual account closure procedures will be published prior to public launch.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">9. Disclaimer of Warranties</h2>
          <p className="uppercase text-xs tracking-wider text-muted/80">
            THE SERVICE IS PROVIDED ON AN &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; BASIS WITHOUT WARRANTIES OF ANY KIND, EITHER
            EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
            ACCURACY, NON-INFRINGEMENT, OR UNINTERRUPTED AVAILABILITY.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">10. Limitation of Liability</h2>
          <p className="uppercase text-xs tracking-wider text-muted/80">
            TO THE FULLEST EXTENT PERMITTED BY LAW, IN NO EVENT SHALL {SITE.name}, ITS DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE
            FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL, SPECIAL, OR PUNITIVE DAMAGES, OR FOR LOSS OF PROFITS, DATA, OR GOODWILL,
            ARISING OUT OF OR RELATED TO YOUR USE OF OR INABILITY TO USE THE SERVICE. OUR TOTAL AGGREGATE LIABILITY FOR ANY CLAIM
            ARISING UNDER THESE TERMS SHALL NOT EXCEED THE TOTAL AMOUNT ACTUALLY PAID BY YOU TO US (IF ANY) IN THE THREE (3) MONTHS
            PRECEDING THE EVENT GIVING RISE TO LIABILITY, OR ₹1,000 INR (WHICHEVER IS LESS).
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">11. Governing Law &amp; Dispute Resolution (Draft Provisions)</h2>
          <p>
            {SITE.name} is initially targeted for users in India. These preliminary draft terms designate that the laws of India shall govern
            these Terms and any contractual disputes, without giving effect to conflict of law principles.
          </p>
          <div className="rounded-2xl border border-white/[0.08] bg-surface p-4 text-xs leading-relaxed text-muted">
            <p className="font-semibold text-foreground/90">Notice Regarding Legal Review &amp; Jurisdiction:</p>
            <p className="mt-1">
              Specific legal seat, territorial venue, judicial forum, and dispute resolution mechanisms (including informal negotiation or
              arbitration frameworks) are provisional placeholders. They have not yet been validated by qualified legal counsel and remain
              subject to formal legal review and amendment upon finalization of the operating corporate entity and registered office.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">12. Operator Contact &amp; Notices</h2>
          <p>
            {SITE.name} is currently in pre-release development. Dedicated corporate operator notices, verified legal contact
            addresses, and regulatory grievance officer details will be formally published on this page prior to general public
            commercial launch.
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
