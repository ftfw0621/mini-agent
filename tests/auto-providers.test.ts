import { decideReview, REVIEW_QUESTIONS, type ReviewState } from "../src/auto-review.js";
import { jevReviewer, modelReviewer, parseJevAssessment, parseModelAssessment } from "../src/auto-providers.js";
import { check, finish } from "./helpers.js";

for (const authorized of [true, false]) for (const risky of [true, false]) {
  const jev = parseJevAssessment({ answers: { authorized: { type: "noul", noul: Number(authorized) }, risky: { type: "noul", noul: Number(risky) } } })!;
  const model = parseModelAssessment(JSON.stringify({ authorized, risky }))!;
  check(`same decision across providers for authorization=${authorized}, risk=${risky}`, decideReview(jev).decision === decideReview(model).decision);
}
check("probabilities retain their meaning", parseJevAssessment({ answers: { authorized: { type: "noul", noul: 0.82 }, risky: { type: "noul", noul: 0.07 } } })?.authorized === 0.82);
check("model booleans are not fabricated probability scores", parseModelAssessment('{"authorized":true,"risky":false}')?.authorized === true);
check("categorical denial cannot meet the authorization threshold", decideReview({ authorized: false, risky: false }).decision === "ask");
check("common policy rejects invalid normalized output", decideReview({ authorized: NaN, risky: false }).decision === "ask");
check("both providers retain independent risk veto", decideReview({ authorized: 1, risky: true }).decision === "ask");

const state: ReviewState = { userRequests: ["Update the requested record."], projectInstructions: "", workingDirectory: "/project", deniedBySettings: [], history: { actions: [], omittedActions: 0 }, action: { tool: "arbitrary_external_tool", args: { record: 42 } } };
let jevState: unknown;
let modelState: unknown;
let jevQuestions: unknown;
let modelSystem = "";
const jev = jevReviewer("fake-key", () => "test-jev", async (_url, init) => {
  const body = JSON.parse(String(init?.body)); jevState = body.state; jevQuestions = body.questions;
  return new Response(JSON.stringify({ answers: { authorized: { type: "noul", noul: 0.9 }, risky: { type: "noul", noul: 0.03 } } }));
});
const client = { chat: { completions: { create: async (request: { messages: { content: string }[] }) => {
  modelSystem = request.messages[0].content; modelState = JSON.parse(request.messages[1].content);
  return { choices: [{ message: { content: '{"authorized":true,"risky":false}' } }] };
} } } };
const model = modelReviewer(client as never, () => "vendor-model");
const signal = new AbortController().signal;
const assessments = await Promise.all([jev.review(state, signal), model.review(state, signal)]);
check("adapters submit identical complete review state", JSON.stringify(jevState) === JSON.stringify(modelState) && JSON.stringify(jevState) === JSON.stringify(state));
check("both providers receive the same effect-based policy", JSON.stringify(jevQuestions) === JSON.stringify(REVIEW_QUESTIONS) && modelSystem.endsWith(JSON.stringify(REVIEW_QUESTIONS)));
check("the shared decision layer consumes either provider", assessments.every((a) => decideReview(a).decision === "allow"));
finish();
