// Runs before every test file (vitest setupFiles). Points every ~/.contextengine consumer at a
// per-worker temp dir BEFORE any module computes its paths. audit.ts reads CONTEXTENGINE_HOME
// lazily; learnings.ts reads it at import, which is still after this file.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "ce-test-home-"));
process.env.HOME = home;
process.env.CONTEXTENGINE_HOME = join(home, ".contextengine");
