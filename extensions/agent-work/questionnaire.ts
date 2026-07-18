export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;

export type QuestionOptionInput = {
  value: string;
  label: string;
  description?: string;
};

export type QuestionInput = {
  id: string;
  label?: string;
  prompt: string;
  options: QuestionOptionInput[];
  multiSelect?: boolean;
  allowOther?: boolean;
};

export type QuestionnaireParams = {
  questions: QuestionInput[];
};

/** Lazy schema builder so unit tests can import helpers without typebox installed. */
export function buildQuestionnaireParamsSchema(Type: {
  Object: (...args: any[]) => unknown;
  String: (...args: any[]) => unknown;
  Optional: (...args: any[]) => unknown;
  Array: (...args: any[]) => unknown;
  Boolean: (...args: any[]) => unknown;
}): unknown {
  const QuestionOptionSchema = Type.Object({
    value: Type.String({ description: "Stable value returned when selected" }),
    label: Type.String({ description: "Display label for the option" }),
    description: Type.Optional(Type.String({ description: "Optional description shown below the label" })),
  });

  const QuestionSchema = Type.Object({
    id: Type.String({ description: "Stable unique identifier for this question" }),
    label: Type.Optional(
      Type.String({
        description: "Short tab label, e.g. 'Scope', 'Priority' (defaults to Q1, Q2, ...)",
      }),
    ),
    prompt: Type.String({ description: "Full question text shown to the user" }),
    options: Type.Array(QuestionOptionSchema, {
      description: "Labeled options the user can choose from",
      minItems: 1,
    }),
    multiSelect: Type.Optional(
      Type.Boolean({ description: "Allow selecting multiple options (default: false)" }),
    ),
    allowOther: Type.Optional(
      Type.Boolean({ description: "Allow a free-text answer path (default: true)" }),
    ),
  });

  return Type.Object({
    questions: Type.Array(QuestionSchema, {
      description: "Batch of 1–5 requirements questions",
      minItems: MIN_QUESTIONS,
      maxItems: MAX_QUESTIONS,
    }),
  });
}

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

export interface AnswerSelection {
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

export interface Answer {
  id: string;
  multiSelect: boolean;
  selections: AnswerSelection[];
}

export type QuestionnaireStatus = "submitted" | "cancelled" | "ui_unavailable" | "error";

export interface QuestionnaireResult {
  status: QuestionnaireStatus;
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  uiAvailable: boolean;
}

export interface ToolContentResult {
  content: { type: "text"; text: string }[];
  details: QuestionnaireResult;
}

export function normalizeQuestions(input: QuestionInput[]): Question[] {
  return input.map((q, i) => ({
    id: q.id,
    label: q.label?.trim() || `Q${i + 1}`,
    prompt: q.prompt,
    options: q.options.map((opt) => ({
      value: opt.value,
      label: opt.label,
      description: opt.description,
    })),
    multiSelect: q.multiSelect === true,
    allowOther: q.allowOther !== false,
  }));
}

export function validateQuestions(questions: Question[]): string | undefined {
  if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
    return `Questionnaire accepts ${MIN_QUESTIONS}–${MAX_QUESTIONS} questions (got ${questions.length}).`;
  }
  const ids = new Set<string>();
  for (const q of questions) {
    if (!q.id.trim()) return "Each question requires a non-empty id.";
    if (ids.has(q.id)) return `Duplicate question id: ${q.id}`;
    ids.add(q.id);
    if (!q.prompt.trim()) return `Question ${q.id} requires a prompt.`;
    if (q.options.length < 1) return `Question ${q.id} requires at least one option.`;
    const values = new Set<string>();
    for (const opt of q.options) {
      if (!opt.value.trim()) return `Question ${q.id} has an option with an empty value.`;
      if (!opt.label.trim()) return `Question ${q.id} has an option with an empty label.`;
      if (values.has(opt.value)) return `Question ${q.id} has duplicate option value: ${opt.value}`;
      values.add(opt.value);
    }
  }
  return undefined;
}

export function formatAnswerLine(question: Question | undefined, answer: Answer): string {
  const label = question?.label || answer.id;
  if (answer.selections.length === 0) return `${label}: (no selection)`;
  const parts = answer.selections.map((sel) => {
    if (sel.wasCustom) return `custom: ${sel.label}`;
    if (sel.index) return `${sel.index}. ${sel.label} (${sel.value})`;
    return `${sel.label} (${sel.value})`;
  });
  if (answer.multiSelect) return `${label}: [${parts.join("; ")}]`;
  return `${label}: ${parts[0]}`;
}

export function formatSubmittedText(questions: Question[], answers: Answer[]): string {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const lines = answers.map((a) => formatAnswerLine(byId.get(a.id), a));
  return ["Questionnaire submitted.", ...lines].join("\n");
}

export function submittedResult(questions: Question[], answers: Answer[]): ToolContentResult {
  return {
    content: [{ type: "text", text: formatSubmittedText(questions, answers) }],
    details: {
      status: "submitted",
      questions,
      answers,
      cancelled: false,
      uiAvailable: true,
    },
  };
}

export function cancelledResult(questions: Question[] = []): ToolContentResult {
  return {
    content: [{
      type: "text",
      text: "Questionnaire cancelled. Continue by asking these questions conversationally in chat rather than retrying the interactive UI immediately.",
    }],
    details: {
      status: "cancelled",
      questions,
      answers: [],
      cancelled: true,
      uiAvailable: true,
    },
  };
}

export function uiUnavailableResult(questions: Question[] = [], mode: string): ToolContentResult {
  return {
    content: [{
      type: "text",
      text: `UI unavailable (mode=${mode}). Ask these questions conversationally in chat; do not treat this as a hard failure.`,
    }],
    details: {
      status: "ui_unavailable",
      questions,
      answers: [],
      cancelled: false,
      uiAvailable: false,
    },
  };
}

export function errorResult(message: string, questions: Question[] = []): ToolContentResult {
  return {
    content: [{ type: "text", text: message }],
    details: {
      status: "error",
      questions,
      answers: [],
      cancelled: false,
      uiAvailable: true,
    },
  };
}

/** True when isolated child invocations intentionally omit interactive tools. */
export function childInvocationDisablesExtensions(args: string[]): boolean {
  return args.includes("--no-extensions");
}

export const QUESTIONNAIRE_TOOL_NAME = "agent_questionnaire";

export const QUESTIONNAIRE_DESCRIPTION =
  "Ask the user 1–5 requirements questions through an interactive questionnaire in TUI mode. Prefer this over freeform chat when collecting a small batch of high-impact product decisions. Each question may be single- or multi-select with optional free-text. In print/JSON/RPC modes the tool returns ui_unavailable so you MUST fall back to conversational questions. On cancellation, continue conversationally.";

export const QUESTIONNAIRE_PROMPT_GUIDELINES = [
  "Prefer agent_questionnaire in TUI mode for batches of 1–5 high-impact requirements questions; do not wait for a slash command.",
  "If agent_questionnaire returns status=ui_unavailable or status=cancelled, immediately continue by asking the same questions in ordinary chat.",
  "Never expose or attempt agent_questionnaire inside isolated subagents; subagents must end with status=blocked and describe clarification needed so the coordinator can resolve it.",
];
