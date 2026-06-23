import { startBackground, pendingNotifications, readBackground, listBackground, hasRunningBackground, killAllBackground } from "../src/background.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

// Background tasks are inherently timing-dependent (a real child process runs),
// so instead of fixed sleeps we POLL the task's status (via listBackground,
// which never consumes the notification) until it leaves `running`, with a
// generous ceiling so a slow CI box doesn't flake.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntilDone(id: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = listBackground().find((x) => x.id === id);
    if (t && t.status !== "running") return t.status;
    await sleep(20);
  }
  return "timeout";
}

async function main() {
  // ---- a command that completes: id now, notification later --------------------
  const id = startBackground("echo hello-from-bg && echo second-line");
  check("startBackground returns a bg_ id", /^bg_\d+$/.test(id), id);
  check("the task is running immediately", hasRunningBackground());
  check("no notification while still running", pendingNotifications() === "");

  const status = await waitUntilDone(id);
  check("a quick command reaches completed", status === "completed", status);

  const note = pendingNotifications();
  checkContains("notification uses the <task_notification> tag", note, "<task_notification>");
  checkContains("notification names the task id", note, `<task_id>${id}</task_id>`);
  checkContains("notification reports completed status", note, "<status>completed</status>");
  checkContains("notification carries the exit code", note, "<exit_code>0</exit_code>");
  checkContains("notification echoes the command", note, "echo hello-from-bg");
  checkContains("notification summary includes the output", note, "second-line");

  check("a finished task notifies exactly once", pendingNotifications() === "");

  // ---- bash_output polling -----------------------------------------------------
  const full = readBackground(id, true);
  checkContains("full read shows the status header", full, "completed");
  checkContains("full read shows the captured output", full, "hello-from-bg");
  checkContains("unknown id errors with the known list", readBackground("bg_does_not_exist"), "No background task");

  // a fresh poll after a full read shows no NEW output (cursor was at the end)
  startBackground("true"); // unrelated, ensures the registry has more than one
  const incremental = readBackground(id); // not full → only new output since last poll
  checkContains("incremental read reports no new output", incremental, "no new output");

  // ---- a failing command ------------------------------------------------------
  const failId = startBackground("exit 7");
  const failStatus = await waitUntilDone(failId);
  check("a non-zero exit is recorded as failed", failStatus === "failed", failStatus);
  checkContains("failed notification carries the exit code", pendingNotifications(), "<exit_code>7</exit_code>");

  // ---- kill-on-exit semantics --------------------------------------------------
  const longId = startBackground("sleep 30");
  await sleep(50); // let it actually start
  check("a long runner is still running", hasRunningBackground());
  killAllBackground();
  check("killAllBackground stops everything", !hasRunningBackground());
  const killNote = pendingNotifications();
  checkContains("killed task reports a killed status", killNote, "<status>killed</status>");
  checkContains("killed notification names the long runner", killNote, "sleep 30");

  finish();
}
main();
