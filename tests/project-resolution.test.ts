import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { realpathSync } from "fs";
import { resolveProjectDir, findProjectRoot, type ProjectDirectory } from "../src/config.js";

let tempRoot: string;

beforeEach(() => {
  // realpath: macOS /var/folders temp dirs are symlinks to /private/var/...,
  // and resolve() in the code under test returns the real path.
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "ce-resolve-test-")));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// 🔒 [SCORE-ACCEPTS-PATH] — these tests exist to stop a regression to name-only
// lookup. `score /Users/yan/Projects/PLANK.io` used to fail with "Project not
// found" while listing PLANK.io among the available projects.
describe("resolveProjectDir", () => {
  it("resolves a known project by name, case-insensitively", () => {
    const dirs: ProjectDirectory[] = [{ name: "PLANK.io", path: join(tempRoot, "PLANK.io") }];
    mkdirSync(dirs[0].path);

    expect(resolveProjectDir("PLANK.io", dirs)?.path).toBe(dirs[0].path);
    expect(resolveProjectDir("plank.io", dirs)?.path).toBe(dirs[0].path);
  });

  it("resolves an absolute path to a KNOWN project, preferring the configured entry", () => {
    const projPath = join(tempRoot, "PLANK.io");
    mkdirSync(projPath);
    const dirs: ProjectDirectory[] = [{ name: "PLANK.io", path: projPath }];

    const resolved = resolveProjectDir(projPath, dirs);
    expect(resolved).not.toBeNull();
    expect(resolved!.path).toBe(projPath);
    // Name comes from the fleet config, not basename(), so reports stay consistent.
    expect(resolved!.name).toBe("PLANK.io");
  });

  it("resolves an absolute path to a project OUTSIDE any configured workspace", () => {
    const outside = join(tempRoot, "elsewhere");
    mkdirSync(outside);

    const resolved = resolveProjectDir(outside, []);
    expect(resolved).not.toBeNull();
    expect(resolved!.path).toBe(outside);
    expect(resolved!.name).toBe("elsewhere");
  });

  it("returns null for a path that does not exist", () => {
    expect(resolveProjectDir(join(tempRoot, "nope"), [])).toBeNull();
  });

  it("returns null for a path that exists but is a FILE, not a directory", () => {
    const file = join(tempRoot, "README.md");
    writeFileSync(file, "x", "utf-8");
    expect(resolveProjectDir(file, [])).toBeNull();
  });

  it("returns null for an unknown bare name", () => {
    const dirs: ProjectDirectory[] = [{ name: "PLANK.io", path: join(tempRoot, "PLANK.io") }];
    expect(resolveProjectDir("NotAProject", dirs)).toBeNull();
  });

  it("prefers the name index over a same-named directory in the cwd", () => {
    // A bare name must never be silently reinterpreted as a relative path when
    // it matches a real project — that would change existing behaviour.
    const configured = join(tempRoot, "configured", "PLANK.io");
    mkdirSync(configured, { recursive: true });
    const dirs: ProjectDirectory[] = [{ name: "PLANK.io", path: configured }];

    expect(resolveProjectDir("PLANK.io", dirs)?.path).toBe(configured);
  });
});

// 🔒 [SCORE-FLEET-IS-OPT-IN] — no-argument `score` resolves the enclosing
// project, so running it from src/ scores the project and not the subdirectory.
describe("findProjectRoot", () => {
  it("walks up from a subdirectory to the directory holding .git", () => {
    const proj = join(tempRoot, "proj");
    const nested = join(proj, "src", "deep");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(proj, ".git"));

    expect(findProjectRoot(nested)).toBe(proj);
  });

  it("walks up to a directory holding package.json when there is no .git", () => {
    const proj = join(tempRoot, "proj");
    const nested = join(proj, "lib");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(proj, "package.json"), "{}", "utf-8");

    expect(findProjectRoot(nested)).toBe(proj);
  });

  it("returns the project root itself when already standing in it", () => {
    const proj = join(tempRoot, "proj");
    mkdirSync(proj);
    mkdirSync(join(proj, ".git"));

    expect(findProjectRoot(proj)).toBe(proj);
  });

  // 🔒 [SCORE-CWD-MUST-BE-A-PROJECT] — the caller refuses to score on null.
  it("returns null when no marker is found anywhere above — never falls back", () => {
    // A directory that is not a project must not be scored as one. Returning the
    // start directory here is what wrote a bogus `~/Projects/SCORE.md` claiming
    // the CONTAINER of 37 projects scored 27/100.
    const orphan = join(tempRoot, "orphan");
    mkdirSync(orphan);

    expect(findProjectRoot(orphan)).toBeNull();
  });

  it("returns null for the filesystem root, which is not a project", () => {
    expect(findProjectRoot("/")).toBeNull();
  });

  it("still finds the root when a marker sits above an un-marked subdirectory", () => {
    // Guards against over-correcting: null must mean "no marker anywhere",
    // not "no marker in this exact directory".
    const proj = join(tempRoot, "proj");
    const deep = join(proj, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(proj, "package.json"), "{}", "utf-8");

    expect(findProjectRoot(deep)).toBe(proj);
    expect(basename(findProjectRoot(deep)!)).toBe("proj");
  });
});
