import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_ROUTES, ROUTES, SITE } from "@/lib/constants";
import { DAILY_USER_IMAGE_LIMIT, PROMPT_MAX_LENGTH } from "@/features/generations/config";
import { DEFAULT_DAILY_USER_VIDEO_LIMIT } from "@/features/video/config";

export const metadata: Metadata = {
  title: "Acceptable Use Policy",
  description: "Rules, safety standards, and prohibited content policies governing YourAI.",
};

export default function AcceptableUsePolicyPage() {
  const lastUpdated = "November 11, 2026";

  return (
    <article className="mx-auto max-w-4xl px-4 py-16 sm:px-6 sm:py-24">
      <header className="mb-12 border-b border-white/[0.08] pb-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-rose-400/30 bg-rose-400/10 px-3 py-1 text-xs font-medium text-rose-300">
          Safety &amp; Compliance Standards
        </div>
        <h1 className="mt-4 font-display text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Acceptable Use Policy
        </h1>
        <p className="mt-2 text-sm text-muted">Last updated: {lastUpdated} • Version 1.1 (Pre-Release)</p>
      </header>

      <div className="space-y-10 text-[15px] leading-relaxed text-muted">
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">1. Purpose &amp; Core Principles</h2>
          <p>
            {SITE.name} is dedicated to providing creative generative tools while preventing harm, exploitation, and abuse.
            This Acceptable Use Policy (&quot;AUP&quot;) defines the rules governing prompts, text submissions, generated assets
            (including raster images and synthesized videos), and platform interaction across all services.
          </p>
          <p>
            Your access to {SITE.name} is conditioned on strict compliance with this policy. We enforce a zero-tolerance approach
            to malicious or unlawful activity.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">2. Strictly Prohibited Content</h2>
          <p>You may not generate, attempt to generate, upload, or solicit any content within the following categories:</p>

          <div className="space-y-4">
            <div className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.08] p-5">
              <h3 className="text-base font-semibold text-rose-200">
                Zero Tolerance: Child Exploitation &amp; Abuse Material (CSAM / CSAE)
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-rose-100/90">
                Any generation, prompt, or depiction involving child sexual abuse material or child sexual exploitation and abuse (CSAM/CSAE)
                is strictly prohibited. Any account attempting to create such content is subject to immediate permanent termination.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-rose-200/80">
                {SITE.name} reserves the right, where legally required or appropriate, to preserve account records and refer violations to
                competent law enforcement authorities and statutory bodies, subject to legal review. The platform does not currently operate
                an automated direct reporting API integration.
              </p>
            </div>

            <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-surface p-5">
              <h3 className="text-base font-semibold text-foreground">Non-Consensual Imagery &amp; Real Persons</h3>
              <p>
                Generating Non-Consensual Intimate Imagery (NCII), sexually explicit deepfakes, or depicting real individuals in
                compromising, defamatory, or non-consensual situations without their verifiable consent is strictly prohibited.
              </p>
            </div>

            <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-surface p-5">
              <h3 className="text-base font-semibold text-foreground">Hate Speech, Harassment &amp; Violence</h3>
              <p>You may not generate content that promotes, depicts, or incites:</p>
              <ul className="list-disc space-y-1.5 pl-6 text-sm">
                <li>Violence, physical harm, torture, or self-harm.</li>
                <li>Hate speech or discrimination based on race, ethnicity, religion, caste, gender, sexual orientation, disability, or national origin.</li>
                <li>Harassment, stalking, intimidation, extortion, or defamation of any person.</li>
                <li>Terrorism, violent extremism, or instructions on constructing weapons or explosives.</li>
              </ul>
            </div>

            <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-surface p-5">
              <h3 className="text-base font-semibold text-foreground">Fraud, Deception &amp; Illegal Activities</h3>
              <p>You may not use the Service to generate or support:</p>
              <ul className="list-disc space-y-1.5 pl-6 text-sm">
                <li>Phishing, financial scams, identity theft, or deceptive impersonation of government or financial institutions.</li>
                <li>The sale or promotion of illicit drugs, weapons, or counterfeit goods.</li>
                <li>Malware distribution or cyberattacks.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">3. System &amp; Infrastructure Abuse</h2>
          <p>
            To maintain service reliability for all creators, you must respect platform constraints. The following technical
            abuses are strictly forbidden:
          </p>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Bypassing Rate Limits:</strong> Using automated scripts, scrapers, headless browsers, or botnets to bypass
              burst rate limiters or query throttles.
            </li>
            <li>
              <strong>Circumventing Generation Quotas:</strong> Creating multiple accounts, rotating IP addresses, or exploiting
              system vulnerabilities to evade the daily limits ({DAILY_USER_IMAGE_LIMIT} images/day, {DEFAULT_DAILY_USER_VIDEO_LIMIT} video/day on promotional accounts) or the 1 active generation job concurrency lock.
            </li>
            <li>
              <strong>Reverse Engineering &amp; Extraction:</strong> Attempting to probe, decompile, extract weights, bypass
              cryptographic webhook signatures, forge correlation tokens, or tamper with signed asset URLs.
            </li>
            <li>
              <strong>Payload Abuse:</strong> Crafting oversized, malformed, or hostile payloads exceeding the maximum prompt
              length of {PROMPT_MAX_LENGTH} characters.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">4. Implemented Technical Controls &amp; Enforcement Limitations</h2>
          <p>
            We provide truthful disclosure of the technical controls currently implemented in software, without claiming fictitious
            automated moderation capabilities:
          </p>
          <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-surface p-5">
            <h3 className="text-base font-semibold text-foreground">What Is Implemented in Software</h3>
            <ul className="list-disc space-y-2 pl-6 text-sm">
              <li>
                <strong>Input Validation &amp; Payload Boundaries:</strong> Strict server-side schema validation rejects requests
                with empty prompts, prompts exceeding {PROMPT_MAX_LENGTH} characters, unapproved aspect ratios, unsupported frame rates, non-UTF-8 characters,
                or malformed JSON payloads.
              </li>
              <li>
                <strong>Rate Limiting &amp; Concurrency Guards:</strong> Process-local sliding window rate limiters restrict submission
                bursts, and PostgreSQL database locks enforce daily quotas and platform concurrency (maximum 1 active generation across image and video).
              </li>
              <li>
                <strong>Provider AI Safety Checker (Video):</strong> Video generation requests submitted to Fal.ai enforce the provider-level AI safety checker (<code>enable_safety_checker: true</code>), which filters explicit, defamatory, or policy-violating prompts and outputs before delivery.
              </li>
              <li>
                <strong>No Automated Pre-Inference NLP Filters (Image):</strong> Image generation dispatches prompts directly to FLUX.1 Schnell without pre-inference natural language processing (NLP) content moderation or automated keyword blocks. Users remain solely responsible for the prompts submitted and the resulting outputs.
              </li>
              <li>
                <strong>Absence of Internal Moderation Tooling:</strong> The current software does not contain an administrative dashboard,
                abuse-report intake queue, automated user suspension workflows, or content review tooling.
              </li>
            </ul>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">5. Contractual Rights &amp; Pre-Launch Operational Status</h2>
          <p>
            While software-level moderation tooling is not currently implemented in the codebase, {SITE.name} contractually reserves
            the full legal right to restrict, suspend, or terminate accounts, cancel running generation jobs, or revoke promotional credit
            balances for violations of this policy or applicable law.
          </p>
          <p>
            Where legally required or appropriate, {SITE.name} further reserves the contractual right to preserve records and refer unlawful
            conduct to competent law enforcement or regulatory authorities, subject to qualified legal review.
          </p>
          <div className="rounded-2xl border border-white/[0.08] bg-surface p-4 text-xs leading-relaxed text-muted">
            <p className="font-semibold text-foreground/90">Operational Status Notice:</p>
            <p className="mt-1">
              Operational abuse-intake mechanisms, administrative review processes, and manual account suspension workflows are not yet
              operational in software or infrastructure. Dedicated abuse reporting channels and administrative intake procedures will be
              established prior to public commercial launch.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">6. Related Policies</h2>
          <p>
            Please review our{" "}
            <Link href={LEGAL_ROUTES.terms} className="text-violet-300 underline underline-offset-4 hover:text-violet-200">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href={LEGAL_ROUTES.privacy} className="text-violet-300 underline underline-offset-4 hover:text-violet-200">
              Privacy Policy
            </Link>{" "}
            for additional legal and data governance provisions.
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
