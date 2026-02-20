import { describe, it, expect } from "vitest";
import { LEARNING_CATEGORIES, type Learning, type LearningCategory } from "../src/learnings.js";

describe("LEARNING_CATEGORIES", () => {
  it("contains expected core categories", () => {
    expect(LEARNING_CATEGORIES).toContain("deployment");
    expect(LEARNING_CATEGORIES).toContain("security");
    expect(LEARNING_CATEGORIES).toContain("api");
    expect(LEARNING_CATEGORIES).toContain("frontend");
    expect(LEARNING_CATEGORIES).toContain("backend");
    expect(LEARNING_CATEGORIES).toContain("database");
    expect(LEARNING_CATEGORIES).toContain("devops");
    expect(LEARNING_CATEGORIES).toContain("testing");
    expect(LEARNING_CATEGORIES).toContain("other");
  });

  it("has at least 15 categories", () => {
    expect(LEARNING_CATEGORIES.length).toBeGreaterThanOrEqual(15);
  });

  it("has no duplicate categories", () => {
    const unique = new Set(LEARNING_CATEGORIES);
    expect(unique.size).toBe(LEARNING_CATEGORIES.length);
  });

  it("all categories are lowercase strings", () => {
    for (const cat of LEARNING_CATEGORIES) {
      expect(cat).toBe(cat.toLowerCase());
      expect(typeof cat).toBe("string");
      expect(cat.length).toBeGreaterThan(0);
    }
  });
});

describe("Learning interface", () => {
  it("can construct a valid learning object", () => {
    const learning: Learning = {
      id: "test-123",
      category: "security",
      rule: "Always use parameterized SQL queries",
      context: "Prevents SQL injection attacks",
      project: "ContextEngine",
      tags: ["sql", "security", "injection"],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    expect(learning.id).toBe("test-123");
    expect(learning.category).toBe("security");
    expect(learning.tags).toHaveLength(3);
  });

  it("project field is optional", () => {
    const learning: Learning = {
      id: "test-456",
      category: "deployment",
      rule: "Use PM2 for Node.js process management",
      context: "Handles crashes and restarts automatically",
      tags: ["pm2", "node"],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    expect(learning.project).toBeUndefined();
  });
});
