import fs from "node:fs"; // assert the board persists to disk (落盘)
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import { createTask, getTask, listTasks, canStart, claimTask, completeTask, claimNextAvailable, hasClaimableWork, hasOpenTasks, boardSummary, resetBoard, type Task } from "../src/board.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

// The board writes under the cwd's .mini-agent/tasks — chdir into a scratch dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-board-"));
process.chdir(tmp);

// ---- create + persist (落盘) -------------------------------------------------
const a = createTask("Create DB schema", "make schema.sql");
check("createTask returns a task_ id, pending + unowned", /^task_\d+$/.test(a.id) && a.status === "pending" && a.owner === null, JSON.stringify(a));
const onDisk = path.join(tmp, ".mini-agent", "tasks", `${a.id}.json`);
check("the task is a real json file on disk", fs.existsSync(onDisk));
check("getTask reads it back", getTask(a.id)?.subject === "Create DB schema");

// ---- dependencies / canStart ------------------------------------------------
const b = createTask("Write API routes", "routes", [a.id]); // blocked by a
check("a task with no deps can start", canStart(a.id));
check("a task blocked by an incomplete dep cannot start", !canStart(b.id));
check("a task blocked by a MISSING dep cannot start (fail closed)", !canStart(createTask("x", "", ["task_999"]).id));

// ---- claim: atomic read-check-write -----------------------------------------
const c1 = claimTask(a.id, "alice");
check("claiming a ready task succeeds and sets owner + in_progress", c1.ok && c1.task?.owner === "alice" && c1.task?.status === "in_progress", JSON.stringify(c1));
check("a second claim of the same task loses (no double-claim)", claimTask(a.id, "bob").ok === false);
check("claiming a blocked task fails", claimTask(b.id, "bob").ok === false);

// ---- complete + unblock -----------------------------------------------------
check("completing a task you don't own fails", completeTask(a.id, "bob").ok === false);
const done = completeTask(a.id, "alice");
check("completing your in_progress task succeeds", done.ok === true);
check("completing reports the newly-unblocked task", (done.unblocked ?? []).includes(b.id), JSON.stringify(done));
check("b can start now that a is complete", canStart(b.id));
check("completing an already-completed task fails", completeTask(a.id, "alice").ok === false);

// ---- claimNextAvailable: the autonomy primitive -----------------------------
const picked = claimNextAvailable("bob");
check("claimNextAvailable claims the next ready task", picked?.id === b.id && getTask(b.id)?.owner === "bob", JSON.stringify(picked));
// only the missing-dep task remains, and it's not claimable → nothing left to pick
check("claimNextAvailable returns null when nothing is ready", claimNextAvailable("bob") === null);

// ---- board-state predicates -------------------------------------------------
check("hasClaimableWork is false (everything ready is claimed or blocked)", !hasClaimableWork());
check("hasOpenTasks is true (b is in_progress, plus the blocked one)", hasOpenTasks());
completeTask(b.id, "bob");
check("hasOpenTasks still true while the blocked-forever task lingers", hasOpenTasks());

// ---- summary + reset --------------------------------------------------------
checkContains("boardSummary shows a task line", boardSummary(), a.id);
resetBoard();
check("resetBoard clears the board", listTasks().length === 0 && boardSummary().includes("empty"));
check("reset deletes the files too", !fs.existsSync(onDisk));

// fresh numbering after reset
const fresh = createTask("first after reset");
check("ids restart at task_1 after reset", fresh.id === "task_1", fresh.id);

// ---- blockedBy resolves by SUBJECT, not just id -----------------------------
// Models reference a dependency by its name ("schema"), not "task_1" — the board
// accepts either, isolated here on a clean board.
resetBoard();
const schema = createTask("schema", "build the schema");
const routes = createTask("routes", "build routes", ["schema"]); // depends on schema BY SUBJECT
check("a dep given by subject blocks until it's done", !canStart(routes.id));
claimTask(schema.id, "alice");
const fin = completeTask(schema.id, "alice");
check("completing the subject-named dep unblocks the dependent", canStart(routes.id) && (fin.unblocked ?? []).includes(routes.id), JSON.stringify(fin));

process.chdir(os.tmpdir());
finish();
