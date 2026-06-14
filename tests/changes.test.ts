import fs from "node:fs"; // create/inspect the files we change
import os from "node:os"; // scratch dir
import path from "node:path"; // join scratch paths
import { recordMutation, sessionChanges, clearUndo } from "../src/undo.js"; // unit under test (/diff backend)
import { check, finish } from "./helpers.js"; // assertions

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-changes-"));
const find = (changes: ReturnType<typeof sessionChanges>, p: string) => changes.find((c) => c.path === p);

clearUndo(); // start from a clean ledger (other suites in the same process may have recorded)

// ---- a modified file: baseline is the FIRST-seen content ---------------------------------
const f = path.join(dir, "a.txt");
fs.writeFileSync(f, "v1\n");
recordMutation(f); // baseline captured: "v1\n"
fs.writeFileSync(f, "v2\n");
recordMutation(f); // baseline must NOT move to "v2\n"
fs.writeFileSync(f, "v3\n");
{
  const c = find(sessionChanges(), f);
  check("modified file is listed", c?.status === "modified");
  check("baseline is the session-origin content", c?.baseline === "v1\n");
  check("current is the latest content", c?.current === "v3\n");
}

// ---- a created file: baseline is empty, status is created --------------------------------
const created = path.join(dir, "new.txt");
recordMutation(created); // didn't exist yet → baseline null
fs.writeFileSync(created, "hello\n");
{
  const c = find(sessionChanges(), created);
  check("created file is listed as created", c?.status === "created");
  check("created file baseline is empty", c?.baseline === "");
}

// ---- a deleted file: existed at baseline, gone now --------------------------------------
const doomed = path.join(dir, "gone.txt");
fs.writeFileSync(doomed, "bye\n");
recordMutation(doomed); // baseline "bye\n"
fs.rmSync(doomed);
{
  const c = find(sessionChanges(), doomed);
  check("deleted file is listed as deleted", c?.status === "deleted");
  check("deleted file current is empty", c?.current === "");
}

// ---- net-zero change: edited then put back → NOT listed ----------------------------------
const wobble = path.join(dir, "wobble.txt");
fs.writeFileSync(wobble, "same\n");
recordMutation(wobble); // baseline "same\n"
fs.writeFileSync(wobble, "different\n");
fs.writeFileSync(wobble, "same\n"); // back to baseline
check("a file edited back to baseline is not a change", find(sessionChanges(), wobble) === undefined);

// ---- clearUndo wipes the change ledger too ----------------------------------------------
clearUndo();
check("clearUndo empties the session changes", sessionChanges().length === 0);

fs.rmSync(dir, { recursive: true, force: true });
finish();
