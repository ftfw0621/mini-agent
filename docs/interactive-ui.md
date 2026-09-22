# Interactive activity and image input

## Reference and scope

The inspected sibling `claude-code-sourcemap` tree describes a reconstruction of
Claude Code 2.1.88. Relevant files under `restored-src/src` are:

- `components/messages/GroupedToolUseContent.tsx`: passes grouped calls, results,
  errors and running state to each tool's compact renderer.
- `components/Spinner/SpinnerAnimationRow.tsx`: updates a dedicated animation
  row with time and token counters instead of appending progress messages.
- `components/Spinner/TeammateSpinnerTree.tsx` and `TeammateSpinnerLine.tsx`:
  distinguish main/worker selection, activity, idle status, elapsed time and
  per-worker usage, with a responsive layout.
- `components/PromptInput/PromptInput.tsx`: separates input editing from footer
  navigation. `state/teammateViewHelpers.ts` selects a worker transcript and
  releases it on exit.

mini-agent applies these ideas to its existing Ink frontend. It shows at most two
recent tool groups (one in smaller terminals) in the transient viewport. It does
not claim Claude hides every tool by default. Assistant prose remains visible;
routine thinking/tool-round/background-completion announcements stop accumulating.
Approval dialogs, denials and service fallback tips remain explicit.

The details viewport reads the same output stream dimensions as Ink and
repaginates on resize. The tool/reasoning panel stays below the terminal height,
with a bounded editor and a one-line status bar. This prevents oversized redraws
from repeatedly clearing/reprinting the screen after Ctrl+T. Detail panels also
hide redundant transient activity rows while open.

## Ownership

- `loop.ts` reports execution and model activity. Permission checks remain on
  the execution path regardless of what the UI hides.
- `tui.ts` retains the latest 100 main-agent tool calls per turn. Arguments and
  results are capped at 32,000 characters each, with truncation notices.
- `ink/activity.ts` derives compact summaries and bounds detail pages by wrapped
  terminal rows. `ink/sink.ts` owns independent spinner handles; concurrent calls
  cannot clear each other's status. Partial answer renderers close on interrupt.
- `AgentProgress` observes each worker's output, tools, time and usage. Its
  transcript retains the latest 32,000 characters with an omission marker.
  Provider output-token usage replaces stream estimates; missing usage stays
  marked approximate. Completed elapsed time freezes.
- `ink/agents.tsx` renders a bounded list and navigates by stable agent ID.
  Subagents and teammates share the same display contract. Enter opens the live
  output/tool transcript; selection never changes task execution or tool policy.
  Unattended workers defer actions requiring human approval to the parent.

This change does not add a durable job scheduler or reduce background polling.
Background processes still survive turn interruption, but not session exit.
Their completion notifications are delivered at existing loop checkpoints;
finishing after the parent turn has ended does not itself start another turn.

## Follow-up input

During a running turn, Enter queues prepared human input (including image parts)
in `FollowUpQueue`. The UI shows a bounded pending preview; it becomes a committed
user message only when the lead consumes it. The loop consumes at model/tool
boundaries, after any in-flight tool returns. Unstarted calls based on the old
request receive explicit skipped tool results before new user messages enter
history; the next model call replans with the new instructions. This preserves
the API's tool-call/result pairing.

Ctrl+Enter requests interruption and immediate processing. Esc does the same
when messages are queued, after closing any open detail panel first. The current
controller is aborted, then the same history/queue resumes with a fresh controller;
there are never two active lead loops. Already completed side effects cannot be
undone by inserting a message. Terminals must encode modified Enter distinctly;
Enter followed by Esc provides a portable alternative.

Only original human text updates authorization at delivery. Hook/file content
and images stay separate, and existing children cannot consume the lead's queue
or silently inherit new grants. Messages arriving at final-answer or turn-cleanup
time are handled too. Slash commands remain idle-only to avoid changing session
state underneath a running loop. This interaction is available in the Ink UI.

## Image input boundary

`ClipboardSource.read()` returns image bytes or text. Platform adapters in
`clipboard.ts` implement it using native helpers, invoked with argv and no shell.
The UI reads only when the user presses Ctrl+V, never at startup or by polling.
Adapters have timeout and output limits. No clipboard content is changed.

`images.ts` validates supported image signatures and the 5 MB limit, creates a
numbered attachment, and builds typed text/image content parts. The editable
buffer, title generator and permission reviewer receive labels, not base64.
Removing a label removes its attachment. Up to four images go into one message.
`ink/chat.ts` sends them to the existing vendor/client. There is no hidden switch
to a different vendor or OCR service. Saved conversations retain image data.

Token estimation reserves 4,096 tokens per image rather than treating base64 as
prose. This is a budgeting estimate, not a model-independent image-token formula;
actual accounting uses API usage and context errors still trigger compaction.

The model must accept image content alongside tools. A rejected multimodal
request yields a dedicated message explaining how to change models/check image
limits. Images stay in conversation history so a supported model can retry them.

Native contracts were checked against [Apple's pasteboard API](https://developer.apple.com/documentation/appkit/nspasteboard),
[Windows Forms Clipboard.GetImage](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.clipboard.getimage),
the [wl-clipboard implementation](https://github.com/bugaevc/wl-clipboard/blob/master/src/wl-paste.c),
and [xclip's implementation](https://github.com/astrand/xclip/blob/master/xclip.c).
Linux needs the corresponding helper installed and a graphical clipboard session.

## Verification

Automated tests cover real-loop tool grouping and hidden details, concurrent
spinner completion, stream cancellation, separate worker progress and transcripts,
provider token accounting, keyboard selection, all platform adapter contracts,
image validation and actual frontend-to-API image content. They use fake provider
responses; image-recognition quality is not tested against a live vision model.

An actual Ink render was exercised with keyboard events for Ctrl+T/Ctrl+R,
agent selection and live inspection, approval/escape, clipboard image paste,
attachment removal and sending. macOS AppKit TIFF-to-PNG conversion was exercised
on an image fixture without modifying the clipboard. Windows and Linux native
helpers were tested with simulated command responses, not on those operating
systems. The readline fallback remains a text interface.

`tests/follow-up.test.ts` exercises delivery between real loop tool calls,
skipping stale calls, ordered multimodal input, permission provenance, worker
isolation and interrupt/resume. `tests/follow-up-ui.test.tsx` renders real Ink
frames with keyboard events for busy input, image paste, queued previews,
delivery, Escape and modified Enter. Resizing to 42 columns by 12 rows reproduces
the former repeated-screen bug; the regression verifies a bounded detail view
without recurring full-screen clears, including long CJK tool results/drafts.
