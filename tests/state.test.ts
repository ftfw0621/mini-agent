import fs from "node:fs"; // build a fake checkout with legacy state
import os from "node:os"; // temp root
import path from "node:path"; // path joining
import { migrateLegacyState, projectMemoryPath, projectSessionsDir, projectSlug, projectStateDir, projectStateFile } from "../src/state.js"; // unit under test
import { check, finish } from "./helpers.js"; // assertions

// The bucket root is redirected into a temp dir so the real ~/.config stays clean.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ma-state-"));
process.env.MINI_AGENT_PROJECTS_DIR = path.join(root, "projects");
const proj = path.join(root, "proj", "sub");
fs.mkdirSync(proj, { recursive: true });

// ---- bucket naming ----------------------------------------------------------------------
check("slug flattens separators, Claude Code style", projectSlug("/Users/me/proj") === "-Users-me-proj");
check("slug contains no path separator", !projectSlug(proj).includes("/"));
check("state dir sits under the bucket root", projectStateDir(proj) === path.join(root, "projects", projectSlug(proj)));
check("sessions live inside the project bucket", projectSessionsDir(proj).startsWith(projectStateDir(proj)));
check("memory lives inside the project bucket", projectMemoryPath(proj).startsWith(projectStateDir(proj)));
check("bucket is keyed by cwd", projectStateDir(proj) !== projectStateDir(root));

// A symlinked route to the same project must not create a second bucket.
const link = path.join(root, "link-to-proj");
fs.symlinkSync(proj, link);
check("a symlinked path resolves to the same bucket", projectStateDir(link) === projectStateDir(proj));

// ---- legacy migration -------------------------------------------------------------------
const legacySessions = path.join(proj, ".mini-agent", "sessions");
const legacyMemory = path.join(proj, ".mini-agent", "MEMORY.md");
const legacyTelemetry = path.join(proj, ".mini-agent", "telemetry.jsonl");
const legacyTrace = path.join(proj, ".mini-agent", "review-debug.jsonl");
fs.mkdirSync(legacySessions, { recursive: true });
fs.writeFileSync(path.join(legacySessions, "s1.json"), "{}");
fs.writeFileSync(legacyMemory, "- [project] old fact\n");
fs.writeFileSync(legacyTelemetry, '{"event":"agent_api_call"}\n');
fs.writeFileSync(legacyTrace, '{"event":"request"}\n');

migrateLegacyState(proj);

check("legacy session landed in the home bucket", fs.existsSync(path.join(projectSessionsDir(proj), "s1.json")));
check("legacy memory landed in the home bucket", fs.existsSync(projectMemoryPath(proj)));
check("legacy telemetry landed in the home bucket", fs.existsSync(projectStateFile("telemetry.jsonl", proj)));
check("legacy review trace landed in the home bucket", fs.existsSync(projectStateFile("review-debug.jsonl", proj)));
check("legacy sessions directory is gone", !fs.existsSync(legacySessions));
check("legacy memory file is gone", !fs.existsSync(legacyMemory));
check("legacy telemetry file is gone", !fs.existsSync(legacyTelemetry));
check("legacy review trace is gone", !fs.existsSync(legacyTrace));
check("memory content survived the move", fs.readFileSync(projectMemoryPath(proj), "utf8").includes("old fact"));
check("telemetry content survived the move", fs.readFileSync(projectStateFile("telemetry.jsonl", proj), "utf8").includes("agent_api_call"));

// ---- idempotence ------------------------------------------------------------------------
fs.writeFileSync(projectMemoryPath(proj), "- [project] new fact\n");
migrateLegacyState(proj);
check("a second call leaves the migrated file alone", fs.readFileSync(projectMemoryPath(proj), "utf8").includes("new fact"));

// ---- a checkout with nothing legacy stays untouched --------------------------------------
const clean = path.join(root, "clean");
fs.mkdirSync(clean, { recursive: true });
migrateLegacyState(clean);
check("no legacy state means no stray bucket contents", !fs.existsSync(projectMemoryPath(clean)));
check("no legacy state means no .mini-agent in the checkout", !fs.existsSync(path.join(clean, ".mini-agent")));

fs.rmSync(root, { recursive: true, force: true });
finish();
