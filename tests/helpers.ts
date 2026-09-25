// The tiny assertion helper shared by every suite. No test framework on
// purpose: the project's dependency budget is part of its teaching value,
// and PASS/FAIL lines plus an exit code are all CI ever needs.

// Every suite imports this module, so tracing is switched off here for ALL of
// them, however they are launched: config.ts copies MINI_AGENT_REVIEW_DEBUG=1
// from .env, and a suite run directly (`npx tsx tests/x.test.ts`) would append
// mocked reviews to the real .mini-agent/review-debug.jsonl. The flag is read
// per call, so suites that test tracing set "1" themselves inside a temp dir.
process.env.MINI_AGENT_REVIEW_DEBUG = "0";
// Peer sessions register in a machine-wide directory; a suite (or a CLI it
// spawns, which inherits this) must never show up in your real /peers list.
// Next-prompt suggestions make an extra model call after every turn; suites that
// count calls must not see it (the UI suite switches it on where it tests it).
process.env.MINI_AGENT_PROMPT_SUGGESTIONS = "0";
process.env.MINI_AGENT_SESSIONS_DIR ||= `${process.env.TMPDIR || "/tmp"}/mini-agent-test-sessions-${process.pid}`;

let passCount = 0; // how many checks passed so far
let failCount = 0; // how many failed

// Check that `actual` contains `expected` (the common case for tool output).
export function checkContains(name: string, actual: string, expected: string): void {
  record(name, actual.includes(expected), `expected to contain "${expected}", got: ${actual.slice(0, 120)}`);
}

// Check a plain boolean condition.
export function check(name: string, ok: boolean, detail = ""): void {
  record(name, ok, detail);
}

// Print one PASS/FAIL line and keep score.
function record(name: string, ok: boolean, detail: string): void {
  ok ? passCount++ : failCount++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` => ${detail}`}`);
}

// Print the summary and exit with the suite's verdict.
export function finish(): never {
  console.log(`\n${passCount} pass, ${failCount} fail`);
  process.exit(failCount ? 1 : 0); // non-zero on any failure — CI-friendly
}
