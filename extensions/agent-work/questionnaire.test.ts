import assert from "node:assert/strict";
import {
  buildQuestionnaireParamsSchema,
  cancelledResult,
  childInvocationDisablesExtensions,
  errorResult,
  formatSubmittedText,
  MAX_QUESTIONS,
  MIN_QUESTIONS,
  normalizeQuestions,
  QUESTIONNAIRE_PROMPT_GUIDELINES,
  QUESTIONNAIRE_TOOL_NAME,
  submittedResult,
  uiUnavailableResult,
  validateQuestions,
  type Answer,
  type QuestionInput,
} from "./questionnaire.ts";
import { FEATURE_WORKFLOW_PROTOCOL, SUBAGENT_AMBIGUITY_PROTOCOL } from "./policy.ts";

const sampleInput: QuestionInput[] = [
  {
    id: "scope",
    label: "Scope",
    prompt: "What is the initial scope?",
    options: [
      { value: "mvp", label: "MVP", description: "Smallest useful slice" },
      { value: "full", label: "Full" },
    ],
  },
  {
    id: "clients",
    prompt: "Which clients?",
    multiSelect: true,
    allowOther: true,
    options: [
      { value: "web", label: "Web" },
      { value: "ios", label: "iOS" },
    ],
  },
];

// --- normalize / validate ---
{
  const normalized = normalizeQuestions(sampleInput);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].label, "Scope");
  assert.equal(normalized[1].label, "Q2");
  assert.equal(normalized[0].multiSelect, false);
  assert.equal(normalized[1].multiSelect, true);
  assert.equal(normalized[0].allowOther, true);
  assert.equal(validateQuestions(normalized), undefined);
}

{
  const tooMany: QuestionInput[] = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
    id: `q${i}`,
    prompt: `P${i}`,
    options: [{ value: "a", label: "A" }],
  }));
  assert.match(validateQuestions(normalizeQuestions(tooMany)) ?? "", /1–5/);
  assert.equal(validateQuestions(normalizeQuestions([])), `Questionnaire accepts ${MIN_QUESTIONS}–${MAX_QUESTIONS} questions (got 0).`);
}

{
  const dup = normalizeQuestions([
    { id: "a", prompt: "A", options: [{ value: "1", label: "One" }] },
    { id: "a", prompt: "B", options: [{ value: "1", label: "One" }] },
  ]);
  assert.match(validateQuestions(dup) ?? "", /Duplicate question id/);
}

{
  const dupOpt = normalizeQuestions([{
    id: "a",
    prompt: "A",
    options: [
      { value: "x", label: "X" },
      { value: "x", label: "Y" },
    ],
  }]);
  assert.match(validateQuestions(dupOpt) ?? "", /duplicate option value/);
}

// --- structured results ---
{
  const questions = normalizeQuestions(sampleInput);
  const answers: Answer[] = [
    {
      id: "scope",
      multiSelect: false,
      selections: [{ value: "mvp", label: "MVP", wasCustom: false, index: 1 }],
    },
    {
      id: "clients",
      multiSelect: true,
      selections: [
        { value: "web", label: "Web", wasCustom: false, index: 1 },
        { value: "desktop linux", label: "desktop linux", wasCustom: true },
      ],
    },
  ];

  const submitted = submittedResult(questions, answers);
  assert.equal(submitted.details.status, "submitted");
  assert.equal(submitted.details.cancelled, false);
  assert.equal(submitted.details.uiAvailable, true);
  assert.equal(submitted.details.answers.length, 2);
  assert.equal(submitted.details.answers[1].selections[1].wasCustom, true);
  assert.match(submitted.content[0].text, /Questionnaire submitted/);
  assert.match(submitted.content[0].text, /Scope: 1\. MVP \(mvp\)/);
  assert.match(submitted.content[0].text, /custom: desktop linux/);
  assert.match(formatSubmittedText(questions, answers), /\[1\. Web \(web\); custom: desktop linux\]/);
}

{
  const cancelled = cancelledResult(normalizeQuestions(sampleInput));
  assert.equal(cancelled.details.status, "cancelled");
  assert.equal(cancelled.details.cancelled, true);
  assert.equal(cancelled.details.uiAvailable, true);
  assert.equal(cancelled.details.answers.length, 0);
  assert.match(cancelled.content[0].text, /conversationally/i);
}

{
  for (const mode of ["print", "json", "rpc"] as const) {
    const result = uiUnavailableResult(normalizeQuestions(sampleInput), mode);
    assert.equal(result.details.status, "ui_unavailable");
    assert.equal(result.details.uiAvailable, false);
    assert.equal(result.details.cancelled, false);
    assert.match(result.content[0].text, new RegExp(`mode=${mode}`));
    assert.match(result.content[0].text, /conversationally/i);
  }
}

{
  const err = errorResult("bad input");
  assert.equal(err.details.status, "error");
  assert.match(err.content[0].text, /bad input/);
}

// --- schema builder shape (no real typebox required) ---
{
  const calls: string[] = [];
  const stub = {
    Object: (shape: unknown) => { calls.push("Object"); return { kind: "object", shape }; },
    String: (opts?: unknown) => { calls.push("String"); return { kind: "string", opts }; },
    Optional: (inner: unknown) => { calls.push("Optional"); return { kind: "optional", inner }; },
    Array: (inner: unknown, opts?: unknown) => { calls.push("Array"); return { kind: "array", inner, opts }; },
    Boolean: (opts?: unknown) => { calls.push("Boolean"); return { kind: "boolean", opts }; },
  };
  const schema = buildQuestionnaireParamsSchema(stub) as { kind: string; shape: { questions: { opts: { minItems: number; maxItems: number } } } };
  assert.equal(schema.kind, "object");
  assert.equal(schema.shape.questions.opts.minItems, MIN_QUESTIONS);
  assert.equal(schema.shape.questions.opts.maxItems, MAX_QUESTIONS);
  assert.ok(calls.includes("Object"));
  assert.ok(calls.includes("Array"));
  assert.ok(calls.includes("Boolean"));
}

// --- subagent isolation policy helpers ---
{
  assert.equal(childInvocationDisablesExtensions(["--mode", "json", "-p", "--no-extensions"]), true);
  assert.equal(childInvocationDisablesExtensions(["--mode", "json", "-p"]), false);
  assert.equal(QUESTIONNAIRE_TOOL_NAME, "agent_questionnaire");
  assert.ok(QUESTIONNAIRE_PROMPT_GUIDELINES.some((g) => /agent_questionnaire/.test(g)));
}

// --- workflow + subagent instructions ---
{
  assert.match(FEATURE_WORKFLOW_PROTOCOL, /agent_questionnaire/);
  assert.match(FEATURE_WORKFLOW_PROTOCOL, /batches of 1–5/);
  assert.match(FEATURE_WORKFLOW_PROTOCOL, /ui_unavailable or cancelled/);
  assert.match(FEATURE_WORKFLOW_PROTOCOL, /status=blocked/);
  assert.match(SUBAGENT_AMBIGUITY_PROTOCOL, /status="blocked"/);
  assert.match(SUBAGENT_AMBIGUITY_PROTOCOL, /Never invent product decisions/);
  assert.match(SUBAGENT_AMBIGUITY_PROTOCOL, /Do not attempt to call agent_questionnaire/);
}

console.log("questionnaire tests passed");
