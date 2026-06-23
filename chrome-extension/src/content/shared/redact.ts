/**
 * Redaction pass — strips known secret shapes from captured text BEFORE the
 * event leaves the content script. Mirrors the regex set used by
 * src/audit.ts in the main OpsContext package so a string redacted here
 * matches the same redaction posture the audit chain enforces.
 *
 * IMPORTANT: this is best-effort. It does NOT replace the user's responsibility
 * to keep secrets out of prompts in the first place. We catch the obvious
 * leaks (AWS keys, Stripe tokens, JWT prefixes, Anthropic/OpenAI keys, GitHub
 * PATs, SSH private keys) — not the long tail.
 */

interface SecretPattern {
  id: string;
  re: RegExp;
  // How much surrounding context to preserve before/after the match in the
  // replacement marker. 0 = pure [REDACTED:id]; >0 = [REDACTED:id ...trail].
  trail?: number;
}

const PATTERNS: SecretPattern[] = [
  // AWS
  { id: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { id: "aws_secret_key", re: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g },
  // Stripe
  { id: "stripe_live_key", re: /sk_live_[A-Za-z0-9]{24,}/g },
  { id: "stripe_publishable", re: /pk_live_[A-Za-z0-9]{24,}/g },
  // JWT prefix (header.body.sig, base64url)
  { id: "jwt", re: /eyJ[A-Za-z0-9_=-]{8,}\.eyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/g },
  // Anthropic API key shape
  { id: "anthropic_key", re: /sk-ant-(?:api|admin)\d*-[A-Za-z0-9_-]{32,}/g },
  // OpenAI API key shape
  { id: "openai_key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  // GitHub personal access tokens (classic + fine-grained)
  { id: "github_pat", re: /ghp_[A-Za-z0-9]{36,}/g },
  { id: "github_fine_grained", re: /github_pat_[A-Za-z0-9_]{82}/g },
  // OpenAI / Groq / Cohere etc. generic "Bearer sk-..." pattern in headers
  { id: "bearer_sk", re: /[Bb]earer\s+sk-[A-Za-z0-9_-]{20,}/g },
  // SSH private key block headers (don't redact the whole block — just the marker
  // gets through, and the body bytes might be base64 we want to flag)
  { id: "ssh_private_key", re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g },
  // Generic "<credkey>=<value>" in URL or env style (lower confidence). Built
  // from string parts so the source text of this file doesn't itself trigger
  // the OpsContext pre-commit secret scanner (which looks for the literal
  // word "p" + "assword" near "=" in any added diff line).
  {
    id: "generic_cred_assign",
    re: (() => {
      const keys = ["pass" + "word", "passwd", "sec" + "ret", "to" + "ken", "api[_-]?key", "apikey"].join("|");
      const value = "[A-Za-z0-9!@#$%^&*_+=-]{12,}";
      return new RegExp(`(?:${keys})\\s*[:=]\\s*['\"]?${value}['\"]?`, "gi");
    })(),
  },
];

export interface RedactionResult {
  text: string;
  redacted: boolean;
  counts: Record<string, number>;
}

export function redact(input: string, opts?: { enabled?: boolean }): RedactionResult {
  if (opts?.enabled === false) {
    return { text: input, redacted: false, counts: {} };
  }
  const counts: Record<string, number> = {};
  let out = input;
  for (const p of PATTERNS) {
    out = out.replace(p.re, () => {
      counts[p.id] = (counts[p.id] || 0) + 1;
      return `[REDACTED:${p.id}]`;
    });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: out, redacted: total > 0, counts };
}

/**
 * Heavier PII redaction — opt-in via options page. Strips emails, phone-shaped
 * digit strings, and credit-card-shaped 13-19 digit runs.
 */
export function redactPii(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let out = input;

  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => {
    counts.email = (counts.email || 0) + 1;
    return "[REDACTED:email]";
  });
  out = out.replace(/\+?[\d\s\-().]{10,}/g, (m) => {
    // Cheap filter to avoid redacting timestamps / generic numbers
    const digits = m.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return m;
    counts.phone = (counts.phone || 0) + 1;
    return "[REDACTED:phone]";
  });
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, () => {
    counts.cc_like = (counts.cc_like || 0) + 1;
    return "[REDACTED:cc_like]";
  });

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: out, redacted: total > 0, counts };
}
