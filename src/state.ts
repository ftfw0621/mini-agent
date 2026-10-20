import fs from "node:fs"; // moving legacy state, creating the home bucket
import os from "node:os"; // the home directory root
import path from "node:path"; // joining and resolving paths

// Per-project state that is history rather than configuration — session
// transcripts and long-term memory — lives OUTSIDE the checkout, one bucket per
// working directory, mirroring how Claude Code keeps ~/.claude/projects/<slug>.
// A repo you open should not grow an untracked state directory just because an
// agent ran in it; configuration and tooling (settings, skills, tasks, cron
// state) stay project-local where they belong to the code.
//
// The bucket is keyed by the absolute cwd with separators flattened, so
// /Users/me/proj becomes -Users-me-proj, the same escaping Claude Code uses.
export const projectsRoot = (): string =>
  process.env.MINI_AGENT_PROJECTS_DIR || path.join(os.homedir(), ".config", "mini-agent", "projects");

// One directory name per working directory. Windows drive colons are flattened
// too, so the name is portable and cannot escape the root. Symlinks are resolved
// first, so one project reached as /tmp/x and /private/tmp/x keeps ONE bucket
// instead of two that each hold half the history.
export function projectSlug(cwd: string = process.cwd()): string {
  let abs = path.resolve(cwd);
  try {
    abs = fs.realpathSync(abs);
  } catch {
    /* a path that does not exist yet still gets a stable slug */
  }
  return abs.replace(/[\\/:]/g, "-");
}

export function projectStateDir(cwd: string = process.cwd()): string {
  return path.join(projectsRoot(), projectSlug(cwd));
}

export function projectSessionsDir(cwd: string = process.cwd()): string {
  return path.join(projectStateDir(cwd), "sessions");
}

export function projectMemoryPath(cwd: string = process.cwd()): string {
  return path.join(projectStateDir(cwd), "MEMORY.md");
}

// Move a path only when the destination is absent, so a second run is a no-op
// and a newly written home file is never clobbered by an old checkout copy.
// rename works on one filesystem; cp+rm covers the home-on-another-volume case.
function moveIfAbsent(from: string, to: string): void {
  if (fs.existsSync(to) || !fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

let migrated = false; // once per process; the check is idempotent anyway

// Older builds wrote sessions and memory into ./.mini-agent. Move them into the
// home bucket the first time anything touches the new location, so an upgrade
// keeps its history and the checkout ends up clean. Never throws: a failed
// migration must not break the CLI, it just leaves the old files in place.
export function migrateLegacyState(cwd: string = process.cwd()): void {
  if (migrated) return;
  migrated = true;
  try {
    moveIfAbsent(path.resolve(cwd, ".mini-agent", "sessions"), projectSessionsDir(cwd));
    moveIfAbsent(path.resolve(cwd, ".mini-agent", "MEMORY.md"), projectMemoryPath(cwd));
  } catch {
    /* leave the legacy files where they are */
  }
}
