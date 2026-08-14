/**
 * Scoring thresholds — the numbers that decide what earns what.
 *
 * 🔒 LOCKED [RUBRIC-SINGLE-TABLE] — 2026-08-14
 * ⛔ NEVER inline a scoring threshold back into src/agents.ts.
 * WHY: these values are what makes a score gameable — knowing ">50 lines earns the full 10"
 *      lets anyone pad a file to a number instead of writing the content. They were scattered
 *      as bare literals across ~10 call sites in agents.ts, so they shipped readable in
 *      dist/agents.js and could not be obscured without rewriting the whole scorer.
 * FIX: one table, one module. `scripts/obfuscate-rubric.mjs` rewrites dist/rubric.js at build
 *      time into an encoded blob, so the published package carries no readable thresholds.
 *      Adding a literal back into agents.ts silently re-exposes it — the obfuscator only
 *      touches this file.
 *
 * NOTE ON STRENGTH: this stops casual reading, not determined analysis. The surrounding
 * comparison logic still ships, and 2.1.3 remains on npm forever as a plaintext reference.
 * It is a speed bump for score-gaming, deliberately, and must never be described as more.
 * The real protections are the activation gate and BSL-1.1. See CLAUDE.md rules 1-3.
 */

export interface Rubric {
  /** copilot-instructions.md line counts for the 10 / 6 point tiers */
  copilotFull: number;
  copilotPartial: number;
  /** README.md line count for the full 8 points */
  readmeFull: number;
  /** SKILLS.md line count for the full 3 points */
  skillsFull: number;
  /** .env.example — documented variables needed for full marks */
  envExampleVars: number;
  /** .gitignore — essential patterns matched for full / partial credit */
  gitignoreFull: number;
  gitignorePartial: number;
  /** Test files present for the 8 / 5 point tiers */
  testsFull: number;
  testsPartial: number;
  /** tsconfig.json byte length below which it is treated as a stub */
  tsconfigSubstantive: number;
  /** Real (non-symlink) agent-pattern files for full 6 points */
  multiAgentFull: number;
}

export const RUBRIC: Rubric = {
  copilotFull: 50,
  copilotPartial: 15,
  readmeFull: 30,
  skillsFull: 10,
  envExampleVars: 3,
  gitignoreFull: 3,
  gitignorePartial: 1,
  testsFull: 5,
  testsPartial: 0,
  tsconfigSubstantive: 50,
  multiAgentFull: 2,
};
