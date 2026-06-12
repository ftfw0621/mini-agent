// The tiny assertion helper shared by every suite. No test framework on
// purpose: the project's dependency budget is part of its teaching value,
// and PASS/FAIL lines plus an exit code are all CI ever needs.
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
