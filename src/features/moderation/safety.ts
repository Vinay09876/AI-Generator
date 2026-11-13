export class ContentPolicyViolationError extends Error {
  public readonly status = 400;
  public readonly code = "CONTENT_POLICY_VIOLATION";
  public readonly category: string;

  constructor(message: string, category = "unspecified") {
    super(message);
    this.name = "ContentPolicyViolationError";
    this.category = category;
  }
}

interface SafetyRule {
  pattern: RegExp;
  category: string;
  reason: string;
}

/**
 * Pre-inference content safety rules.
 * Pure local heuristic evaluation; zero live provider or network calls.
 * Evaluated strictly BEFORE database transaction, wallet debit, or provider dispatch,
 * guaranteeing zero credit deduction for blocked inputs.
 */
const SAFETY_RULES: SafetyRule[] = [
  // Child Sexual Abuse Material (CSAM / CSAS) — Zero tolerance
  {
    pattern: /\b(?:csam|child\s*porn|pedophil|paedophil|underage\s*sex|child\s*nude)\b/i,
    category: "csam",
    reason: "Severe policy violation: Child sexual exploitation and abuse material is strictly prohibited.",
  },
  // Extreme Violence & Terrorism
  {
    pattern: /\b(?:suicide\s*bomb|beheading\s*video|mass\s*murder\s*tutorial|how\s*to\s*make\s*(?:a\s*)?(?:dirty\s*)?bomb)\b/i,
    category: "extreme_violence",
    reason: "Severe policy violation: Depictions of terrorism, bomb creation, or extreme violence are strictly prohibited.",
  },
  // Self-Harm & Suicide Encouragement
  {
    pattern: /\b(?:how\s*to\s*(?:kill|hang|poison)\s*(?:myself|yourself)|encourage\s*suicide)\b/i,
    category: "self_harm",
    reason: "Policy violation: Content encouraging or depicting suicide or self-harm is strictly prohibited.",
  },
  // Severe Hate Speech / Direct Violence Incitement
  {
    pattern: /\b(?:kill\s*all\s*(?:jews|muslims|christians|hindus|blacks|whites)|gas\s*the\s*(?:jews|minorities))\b/i,
    category: "hate_speech",
    reason: "Policy violation: Hate speech inciting violence against protected groups is strictly prohibited.",
  },
];

/**
 * Checks a text prompt against internal content safety guardrails.
 */
export function checkPromptContentSafety(prompt: string): {
  safe: boolean;
  category?: string;
  reason?: string;
} {
  const normalized = prompt.trim();
  if (!normalized) return { safe: true };

  for (const rule of SAFETY_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        safe: false,
        category: rule.category,
        reason: rule.reason,
      };
    }
  }

  return { safe: true };
}

/**
 * Asserts that a prompt passes internal content safety checks.
 * Throws ContentPolicyViolationError (400) if unsafe.
 */
export function assertPromptContentSafety(prompt: string): void {
  const result = checkPromptContentSafety(prompt);
  if (!result.safe) {
    throw new ContentPolicyViolationError(
      result.reason || "Prompt violates platform content safety guidelines.",
      result.category,
    );
  }
}
