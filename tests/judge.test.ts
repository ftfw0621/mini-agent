import { interpretJudgeOutput, Judge } from "../src/judge.js"; // units under test
import { check, finish } from "./helpers.js"; // assertions

// ---- the parser is the safety core: fail closed on anything unclear -----------------
check("clean yes → allow", interpretJudgeOutput("<safe>yes</safe>") === "allow");
check("clean no → ask", interpretJudgeOutput("<safe>no</safe>") === "ask");
check("case/space tolerant", interpretJudgeOutput("  <safe> YES </safe>\n") === "allow");
check("extra prose around the tag still parses", interpretJudgeOutput("Sure. <safe>yes</safe> done.") === "allow");
check("no tag → ask (fail closed)", interpretJudgeOutput("yes, totally safe") === "ask");
check("empty → ask", interpretJudgeOutput("") === "ask");
check("garbage → ask", interpretJudgeOutput("<safe>maybe</safe>") === "ask");
check("a 'no' anywhere does not flip a missing tag", interpretJudgeOutput("the answer is no tag here") === "ask");

// ---- a fake client lets us test the orchestration without the network ----------------
// (Judge only needs .chat.completions.create — we stub exactly that.)
function fakeClient(reply: string | (() => never)) {
  return {
    chat: {
      completions: {
        create: async () => {
          if (typeof reply === "function") reply(); // throw, to simulate an API error
          return { choices: [{ message: { content: reply as string } }] };
        },
      },
    },
  } as never;
}

const allower = new Judge(fakeClient("<safe>yes</safe>"), "m");
check("classify allows a clear yes", (await allower.classify("ls -la")) === "allow");

const asker = new Judge(fakeClient("<safe>no</safe>"), "m");
check("classify asks on a clear no", (await asker.classify("rm -rf build")) === "ask");

// ---- circuit breaker: repeated errors disable the judge (degrade to asking) -----------
const flaky = new Judge(
  fakeClient(() => {
    throw new Error("api down");
  }),
  "m",
);
check("error 1 → ask (fail closed)", (await flaky.classify("ffmpeg x")) === "ask");
check("error 2 → ask", (await flaky.classify("ffmpeg x")) === "ask");
check("error 3 → ask (now disabled)", (await flaky.classify("ffmpeg x")) === "ask");
// Once disabled, it returns "ask" without even calling the client. Swap in a
// client that WOULD allow — the disabled judge must still say ask.
(flaky as unknown as { client: unknown }).client = fakeClient("<safe>yes</safe>");
check("disabled judge stays ask even if the model would allow", (await flaky.classify("ls")) === "ask");

finish();
