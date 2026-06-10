import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  validatePolicy,
  parsePolicy,
  loadRepoPolicy,
  repoPolicyPath,
  formatPolicySummary,
  PolicySchema,
} from "../src/policy.js";

let tempRepo: string;

beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), "ce-policy-test-"));
});

afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
});

describe("validatePolicy — minimal valid policies", () => {
  it("accepts the smallest legal policy ({ version: 1 })", () => {
    const r = validatePolicy({ version: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.version).toBe(1);
      expect(r.policy.secret_patterns).toEqual([]);
      expect(r.policy.doc_coverage).toEqual([]);
      expect(r.policy.deploy_verify_hosts).toEqual([]);
      expect(r.policy.bypass_tokens).toEqual([]);
    }
  });

  it("accepts a fully-populated policy with all four sections", () => {
    const raw = {
      version: 1,
      secret_patterns: [
        { id: "jwt_in_session", pattern: "eyJ[A-Za-z0-9_=-]{20,}", paths: ["docs/sessions/**/*.md"], severity: "block" },
      ],
      doc_coverage: [
        { paths: ["src/firewall.ts"], requires_section: "SKILLS.md#protocol-firewall" },
      ],
      deploy_verify_hosts: [
        { host: "invoc.me", require_probe: "curl -sf https://invoc.me/healthz", within_seconds: 60 },
      ],
      bypass_tokens: [
        { id: "emergency", ttl_seconds: 300, requires_reason_min_length: 20 },
      ],
    };
    const r = validatePolicy(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.secret_patterns).toHaveLength(1);
      expect(r.policy.doc_coverage).toHaveLength(1);
      expect(r.policy.deploy_verify_hosts).toHaveLength(1);
      expect(r.policy.bypass_tokens).toHaveLength(1);
    }
  });

  it("defaults severity to 'block' when omitted on a secret pattern", () => {
    const r = validatePolicy({
      version: 1,
      secret_patterns: [{ id: "p1", pattern: "secret123" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.secret_patterns[0].severity).toBe("block");
  });

  it("defaults within_seconds to 60 for deploy_verify_hosts", () => {
    const r = validatePolicy({
      version: 1,
      deploy_verify_hosts: [{ host: "prod.example.com", require_probe: "curl -sf https://prod.example.com" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.deploy_verify_hosts[0].within_seconds).toBe(60);
  });
});

describe("validatePolicy — rejection cases", () => {
  it("rejects a policy without version", () => {
    const r = validatePolicy({ secret_patterns: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path.includes("version"))).toBe(true);
  });

  it("rejects a policy with version !== 1", () => {
    const r = validatePolicy({ version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "version")).toBe(true);
  });

  it("rejects a secret pattern missing id", () => {
    const r = validatePolicy({
      version: 1,
      secret_patterns: [{ pattern: "sk_live_test" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path.includes("id"))).toBe(true);
  });

  it("rejects a doc_coverage entry with empty paths array", () => {
    const r = validatePolicy({
      version: 1,
      doc_coverage: [{ paths: [], requires_section: "X.md#y" }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects extends that is not a URL", () => {
    const r = validatePolicy({ version: 1, extends: "not-a-url" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "extends")).toBe(true);
  });

  it("rejects a bypass_token with negative ttl_seconds", () => {
    const r = validatePolicy({
      version: 1,
      bypass_tokens: [{ id: "bad", ttl_seconds: -5 }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("parsePolicy — JSON parsing layer", () => {
  it("returns a clean validation error on malformed JSON", () => {
    const r = parsePolicy("{ not valid json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].message).toMatch(/Invalid JSON/);
    }
  });

  it("parses + validates valid JSON in one shot", () => {
    const r = parsePolicy('{"version": 1}');
    expect(r.ok).toBe(true);
  });
});

describe("loadRepoPolicy — disk integration", () => {
  it("returns null when .contextengine/policy.json is absent", () => {
    expect(loadRepoPolicy(tempRepo)).toBeNull();
  });

  it("loads + validates an on-disk policy", () => {
    mkdirSync(join(tempRepo, ".contextengine"), { recursive: true });
    writeFileSync(
      join(tempRepo, ".contextengine", "policy.json"),
      JSON.stringify({
        version: 1,
        secret_patterns: [{ id: "jwt", pattern: "eyJ[A-Za-z0-9_=-]+\\.[A-Za-z0-9_=-]+\\.[A-Za-z0-9_=-]+" }],
      }),
    );
    const r = loadRepoPolicy(tempRepo);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    if (r!.ok) expect(r!.policy.secret_patterns).toHaveLength(1);
  });

  it("surfaces JSON-parse errors as a validation result, not a throw", () => {
    mkdirSync(join(tempRepo, ".contextengine"), { recursive: true });
    writeFileSync(join(tempRepo, ".contextengine", "policy.json"), "not json");
    const r = loadRepoPolicy(tempRepo);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
  });

  it("computes the expected repo policy path", () => {
    expect(repoPolicyPath(tempRepo)).toBe(join(tempRepo, ".contextengine", "policy.json"));
  });
});

describe("formatPolicySummary", () => {
  it("renders a multi-section policy with all section counts", () => {
    const policy = PolicySchema.parse({
      version: 1,
      secret_patterns: [{ id: "p1", pattern: "x" }],
      doc_coverage: [{ paths: ["src/x.ts"], requires_section: "DOC.md#x" }],
      deploy_verify_hosts: [{ host: "h", require_probe: "curl h" }],
      bypass_tokens: [{ id: "b1" }],
    });
    const out = formatPolicySummary(policy);
    expect(out).toMatch(/Secret patterns: 1/);
    expect(out).toMatch(/Doc coverage rules: 1/);
    expect(out).toMatch(/Deploy-verify hosts: 1/);
    expect(out).toMatch(/Bypass tokens: 1/);
  });

  it("shows the extends URL when present, with the unimplemented-marker", () => {
    const policy = PolicySchema.parse({
      version: 1,
      extends: "https://policy.example.com/v1.yaml",
    });
    const out = formatPolicySummary(policy);
    expect(out).toMatch(/Extends:/);
    expect(out).toMatch(/not yet implemented/i);
  });
});
