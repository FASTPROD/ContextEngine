import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { realpathSync } from "fs";
import { resolveProjectDir, findProjectRoot, loadProjectDirs, type ProjectDirectory } from "../src/config.js";

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
    // Must carry a project marker — see [RESOLVE-PATH-MUST-BE-A-PROJECT]. Before that
    // LOCK this fixture had no marker and still resolved, which is exactly how
    // `score ~/Projects` scored the container of 37 repos.
    const outside = join(tempRoot, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "package.json"), "{}", "utf-8");

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

// 🔒 [ENV-WORKSPACES-WINS] — the env var is the most specific statement of intent
// and must beat a config file. It was a fallback that only applied when the config
// defined no workspaces, so on a configured machine it was silently ignored — which
// let a "sandboxed" review agent write SCORE.md into 28 real repositories.
describe("CONTEXTENGINE_WORKSPACES precedence", () => {
  const saved = process.env.CONTEXTENGINE_WORKSPACES;
  const savedCfg = process.env.CONTEXTENGINE_CONFIG;

  afterEach(() => {
    if (saved === undefined) delete process.env.CONTEXTENGINE_WORKSPACES;
    else process.env.CONTEXTENGINE_WORKSPACES = saved;
    if (savedCfg === undefined) delete process.env.CONTEXTENGINE_CONFIG;
    else process.env.CONTEXTENGINE_CONFIG = savedCfg;
  });

  it("overrides workspaces defined in a config file", () => {
    const cfgDir = join(tempRoot, "cfg");
    const fromConfig = join(tempRoot, "config-ws", "ConfigProject");
    const fromEnv = join(tempRoot, "env-ws", "EnvProject");
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(fromConfig, { recursive: true });
    mkdirSync(fromEnv, { recursive: true });

    const cfgPath = join(cfgDir, "contextengine.json");
    writeFileSync(cfgPath, JSON.stringify({ workspaces: [join(tempRoot, "config-ws")] }), "utf-8");

    process.env.CONTEXTENGINE_CONFIG = cfgPath;
    process.env.CONTEXTENGINE_WORKSPACES = join(tempRoot, "env-ws");

    const names = loadProjectDirs().map((d) => d.name);
    expect(names).toContain("EnvProject");
    expect(names).not.toContain("ConfigProject");
  });

  it("falls back to the config file when the env var is unset", () => {
    const cfgDir = join(tempRoot, "cfg2");
    const fromConfig = join(tempRoot, "config-ws2", "ConfigOnly");
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(fromConfig, { recursive: true });

    const cfgPath = join(cfgDir, "contextengine.json");
    writeFileSync(cfgPath, JSON.stringify({ workspaces: [join(tempRoot, "config-ws2")] }), "utf-8");

    process.env.CONTEXTENGINE_CONFIG = cfgPath;
    delete process.env.CONTEXTENGINE_WORKSPACES;

    expect(loadProjectDirs().map((d) => d.name)).toContain("ConfigOnly");
  });
});

// 🔒 [RESOLVE-PATH-MUST-BE-A-PROJECT] — confirmed by adversarial review, 2026-08-16.
// `score .` from ~/Projects wrote ~/Projects/SCORE.md ("Projects: 27/100 F") into the
// container of 37 repos, and `score dist` wrote dist/SCORE.md into the npm-published
// artifact directory. Both because "it is a directory that exists" was treated as proof
// of being a project, and a bare name fell through to cwd-relative path resolution.
describe("resolveProjectDir — a directory is not automatically a project", () => {
  it("refuses a path to a container directory with no build/VCS marker", () => {
    const container = join(tempRoot, "Projects");
    mkdirSync(join(container, "RealProj"), { recursive: true });
    writeFileSync(join(container, "RealProj", "package.json"), "{}", "utf-8");

    expect(resolveProjectDir(container, [])).toBeNull();
  });

  it("accepts a path carrying any of the build/VCS markers", () => {
    for (const marker of ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Makefile"]) {
      const p = join(tempRoot, `m-${marker.replace(/\W/g, "")}`);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, marker), "", "utf-8");
      expect(resolveProjectDir(p, [])).not.toBeNull();
    }
    const g = join(tempRoot, "with-git");
    mkdirSync(join(g, ".git"), { recursive: true });
    expect(resolveProjectDir(g, [])).not.toBeNull();
  });

  it("accepts a CONFIGURED project even with no marker — it is the fleet by definition", () => {
    const p = join(tempRoot, "Configured");
    mkdirSync(p);
    const dirs: ProjectDirectory[] = [{ name: "Configured", path: p }];

    expect(resolveProjectDir(p, dirs)?.name).toBe("Configured");
  });

  it("never resolves a bare unknown name to a cwd-relative directory", () => {
    // Previously this depended on whether ./<name> happened to exist in the cwd,
    // so `score src` scored ./src instead of erroring. Now it is cwd-independent.
    const cwd = process.cwd();
    const proj = join(tempRoot, "standing-here");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "package.json"), "{}", "utf-8");
    try {
      process.chdir(proj);
      expect(resolveProjectDir("src", [])).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it("still resolves an explicit relative path to that same directory", () => {
    // The escape hatch the error message advertises: `score ./src`.
    const cwd = process.cwd();
    const proj = join(tempRoot, "standing-here2");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "package.json"), "{}", "utf-8");
    try {
      process.chdir(proj);
      expect(resolveProjectDir("./src", [])?.path).toBe(join(proj, "src"));
    } finally {
      process.chdir(cwd);
    }
  });
});

// 🔒 [GIT-ROOT-IS-THE-PROJECT-BOUNDARY] — `cd ContextEngine/server && score` reported
// "server ... Not a git repo, No CI pipeline, README.md Missing" and wrote
// server/SCORE.md, all false about the project the user was standing in.
describe("findProjectRoot — .git is the boundary, not the nearest build file", () => {
  it("prefers the .git root over a nearer package.json", () => {
    const repo = join(tempRoot, "repo");
    const pkg = join(repo, "server");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "package.json"), "{}", "utf-8");
    writeFileSync(join(pkg, "package.json"), "{}", "utf-8");

    expect(findProjectRoot(pkg)).toBe(repo);
  });

  it("finds the .git root however deep the starting directory is", () => {
    const repo = join(tempRoot, "repo2");
    const deep = join(repo, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(deep, "package.json"), "{}", "utf-8");

    expect(findProjectRoot(deep)).toBe(repo);
  });

  it("falls back to a standalone package when no .git exists anywhere above", () => {
    const pkg = join(tempRoot, "standalone");
    const sub = join(pkg, "lib");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(pkg, "pyproject.toml"), "", "utf-8");

    expect(findProjectRoot(sub)).toBe(pkg);
  });
});
