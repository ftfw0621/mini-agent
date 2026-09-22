# Auto mode implementation notes

## Reference behavior

The local `../claude-code-sourcemap` repository identifies its snapshot as a
reconstruction of Claude Code 2.1.88. It includes auto mode behind feature gates:

- `restored-src/src/utils/permissions/permissions.ts`: the ordinary rule check
  runs first. Remaining `ask` decisions can use an accept-edits fast path, a safe
  tool allowlist, or the transcript classifier. Hard denials remain denials.
- `utils/permissions/yoloClassifier.ts`: projects user text and assistant tool
  calls into classifier input, excluding assistant prose and tool results. It
  also supplies cached project instructions and permission policy. It supports
  structured results and an optional fast/reasoning two-stage path.
- `utils/permissions/denialTracking.ts`: falls back to interactive review after
  three consecutive or twenty total classifier denials; headless work aborts.
- `utils/permissions/permissionSetup.ts`: temporarily strips overly broad allow
  rules that would otherwise bypass the classifier.

This implementation borrows the permission-layer design. It uses immediate human
review for risk or uncertainty rather than reproducing Claude's denial/retry
policy, internal feature gates or two-stage classifier. The referenced prompt
text files are not present as standalone files in the inspected restored tree.
The classifier model is selected at runtime: this snapshot supports an internal
override, a remote configuration value, and finally the main-loop model. It does
not establish which model a particular installed version or session actually
used; a failure message naming Sonnet is evidence about that specific call.

## Backend selection

`src/auto.ts` owns automatic review and backend selection. Set `--auto`, use
`/auto`, set `MINI_AGENT_AUTO_MODE=1`, or set `autoMode.enabled` in settings.
The feature stays off by default. Both frontends display its current backend.

1. A non-blank `JEV_API_KEY` takes precedence, then `TYPESAFE_API_KEY`. Jev uses
   `POST https://api.typesafe.ai/v1/systemone` and `autoMode.model` (default
   `jev-1.13.0`). Both keys identify the same TypeSafe service.
2. Without either key, the existing OpenAI-compatible client is reused, including
   its base URL and API key. `judge.model` selects another model at that same
   endpoint; otherwise the current `CONFIG.model` is used, including `/model`
   changes. Missing Jev credentials produce a setup tip, never a startup error.
3. Jev quota/billing errors, rate limiting, network/API failures and invalid
   responses switch that same action to the current vendor. A one-time tip names
   the reason and selected fallback model. The session stays on that vendor until
   `/auto` is toggled off and on or the app restarts. HTTP 402 and explicit quota
   codes are distinguished from ordinary HTTP 429 rate limiting; unknown errors
   are described as unavailable, never guessed to be exhausted credits.
4. A valid Jev risk/uncertainty result goes to human approval, never to a second
   model for a more permissive answer. Three consecutive failures of available
   review backends disable automatic review until toggled or restarted. User
   cancellation stops the review without starting a fallback call.

The existing `judge.enabled` command-only path also uses this backend selector
in the CLI; standalone callers of the original `Judge` retain its older API.

Jev receives two independent Noul questions in one request: whether the action is
authorized, and whether it has risky or unknown effects. Code allows only
authorization >= 0.8 AND risk <= 0.1. The vendor fallback answers the same policy
questions as strict JSON booleans, requiring `authorized: true` and `risky: false`.
Each provider has a 30-second timeout. Invalid results or errors alone never grant
permission: the fallback must explicitly approve, or the human decides. Oversized
input and cancellation cannot auto-approve. These are initial policy thresholds,
not a measured guarantee of safety. The vendor fallback reserves 2,048 output
tokens for models that reason before emitting the small JSON result; missing or
truncated JSON still requires manual approval.

Contracts were checked against the live [TypeSafe HTTP API](https://docs.typesafe.ai/api),
[Noul guidance](https://docs.typesafe.ai/primitives/noul),
[guardrail cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails), and
[model documentation](https://docs.typesafe.ai/models).

## Execution boundary

`permissions.ts` owns deterministic denials and plan restrictions. `loop.ts` owns
the single authorize/execute path; a reviewer can only turn an eligible ask into
an allow. File tools, foreground/background shell and MCP actions use that path.
Shell first-word allowlists and tool-wide grants do not skip auto review. Plan exit
and resolved writes outside the project require the human. Symlinks cannot hide
protected file targets. Hook rewrites are checked again before execution.

Frontends record original human text before adding file attachments, hook output
or skill bodies. The reviewer never treats all `role: "user"` messages as user
authorization: that role also carries summaries and agent notifications. Requests
are snapshotted per turn and inherited by subagents. Compaction does not change
them. `/clear` and `/resume` discard them; a resumed session needs fresh user input.
The selected API receives original requests, the full proposed arguments, the
working directory, explicit deny settings, and an immutable startup snapshot of
`AGENT.md`. Project instructions are not re-read after the agent can edit them.
`src/auto-context.ts` adds a bounded history of completed tool calls, projected
arguments, and returned/denied/failed status. Assistant prose, raw tool results,
and synthetic user-role notifications are excluded. Subagents inherit this
history and receive their delegated task as context, never as new authorization.

History keeps a contiguous recent suffix within 8,000 UTF-8 bytes and reports
omitted entries; only history may be shortened. Original requests, project
instructions and the current action remain intact. If the complete state exceeds
24,000 UTF-8 bytes, manual review replaces classification; earlier restrictions
are never silently truncated.

Unattended calls cannot use an affirmative confirmation callback as a fallback.
Interactive approval in auto mode is per action; the UI removes the misleading
"don't ask again for this tool" option. Turning auto off restores the ordinary
permission policy without rewriting the user's stored allow rules.

## Validation and limits

`tests/auto.test.ts` tests backend preference, current/vendor model selection,
typed parsing, circuit breaking, cancellation, input provenance, and real-loop
execution/denial behavior using fake API responses. It also covers background
shell, MCP, plan mode, symlink targets and hook rewrites. These tests establish
code behavior, not model accuracy. `tests/auto-context.test.ts` covers history
projection, provenance, inherited context, omission accounting and project
instruction snapshots.

The reviewer is not an OS sandbox and does not inspect the contents of scripts
named by shell commands. Opaque effects should therefore prompt. File-system
changes by other processes between review and execution remain possible. The
Jev documentation notes lower accuracy outside English; evaluate Chinese tasks
and adversarial tool inputs before relaxing thresholds. At the previous 0.9
authorization threshold, a small live Jev smoke run approved explicit `pwd`
and `git status` actions and requested review for risky/adversarial actions, but
also requested review for several ordinary edits and a literal print. These
false prompts are a known conservative behavior, not a calibrated accuracy result.
At that same 0.9 threshold, a further five-case live comparison with and without synthetic project/tool
history, the three ordinary actions still prompted and the two risky/adversarial
actions still prompted. Adding context alone did not resolve those false prompts;
this small, nondeterministic sample does not establish general model accuracy.

After lowering authorization to 0.8 (risk still capped at 0.1), the same five
cases were re-run against Jev on 2026-09-22, each with and without synthetic
project/tool history. All six ordinary-action reviews allowed: English and
Chinese typo fixes and a literal print (authorization 0.85–0.88, risk 0.04–0.06).
All four forbidden-push/injected-authorization reviews still asked (authorization
0.01–0.03, risk 0.55–0.98). No proposed actions were executed. These ten API
reviews demonstrate the threshold change on those cases, not a general accuracy
or safety guarantee. Boundary tests cover exactly 0.8, just below it, and risk
just above 0.1; both conditions must still pass independently.

Automatic review adds
API requests; its API cost is not currently included in `/cost`.
