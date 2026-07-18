import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  Answer,
  AnswerSelection,
  Question,
  QuestionnaireResult,
} from "./questionnaire.ts";

type RenderOption = {
  value: string;
  label: string;
  description?: string;
  isOther?: boolean;
  optionIndex?: number;
};

type Theme = {
  fg: (name: string, text: string) => string;
  bg: (name: string, text: string) => string;
  bold: (text: string) => string;
};

type TuiLike = {
  requestRender: () => void;
};

type CustomUiFactory = <T>(
  factory: (
    tui: TuiLike,
    theme: Theme,
    keybindings: unknown,
    done: (result: T) => void,
  ) => { render: (width: number) => string[]; invalidate?: () => void; handleInput: (data: string) => void },
) => Promise<T>;

function cloneSelections(answer: Answer | undefined): AnswerSelection[] {
  return answer ? answer.selections.map((s) => ({ ...s })) : [];
}

export async function runQuestionnaireUi(
  uiCustom: CustomUiFactory,
  questions: Question[],
): Promise<QuestionnaireResult> {
  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1; // questions + Submit

  return uiCustom<QuestionnaireResult>((tui, theme, _kb, done) => {
    let currentTab = 0;
    let optionIndex = 0;
    let inputMode = false;
    let inputQuestionId: string | null = null;
    let cachedLines: string[] | undefined;
    const committed = new Map<string, Answer>();
    // Working multi-select drafts (not committed until Leave/Next or explicit confirm)
    const drafts = new Map<string, AnswerSelection[]>();

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui as any, editorTheme);

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit(cancelled: boolean) {
      done({
        status: cancelled ? "cancelled" : "submitted",
        questions,
        answers: questions
          .map((q) => committed.get(q.id))
          .filter((a): a is Answer => Boolean(a)),
        cancelled,
        uiAvailable: true,
      });
    }

    function currentQuestion(): Question | undefined {
      return questions[currentTab];
    }

    function currentOptions(): RenderOption[] {
      const q = currentQuestion();
      if (!q) return [];
      const opts: RenderOption[] = q.options.map((opt, i) => ({
        ...opt,
        optionIndex: i + 1,
      }));
      if (q.allowOther) {
        opts.push({ value: "__other__", label: "Type something.", isOther: true });
      }
      return opts;
    }

    function workingSelections(questionId: string): AnswerSelection[] {
      if (drafts.has(questionId)) return drafts.get(questionId)!;
      return cloneSelections(committed.get(questionId));
    }

    function setWorkingSelections(questionId: string, selections: AnswerSelection[]) {
      drafts.set(questionId, selections);
    }

    function isSelected(questionId: string, value: string): boolean {
      return workingSelections(questionId).some((s) => s.value === value && !s.wasCustom);
    }

    function commitQuestion(q: Question, selections: AnswerSelection[]) {
      if (selections.length === 0) {
        committed.delete(q.id);
        drafts.delete(q.id);
        return;
      }
      committed.set(q.id, {
        id: q.id,
        multiSelect: q.multiSelect,
        selections,
      });
      drafts.delete(q.id);
    }

    function allAnswered(): boolean {
      return questions.every((q) => {
        const answer = committed.get(q.id);
        return Boolean(answer && answer.selections.length > 0);
      });
    }

    function finalizeCurrentDraft(): boolean {
      const q = currentQuestion();
      if (!q) return true;
      if (!q.multiSelect) return true;
      const working = workingSelections(q.id);
      if (working.length === 0) return false;
      commitQuestion(q, working);
      return true;
    }

    function goToTab(next: number) {
      if (currentTab < questions.length) {
        const q = questions[currentTab];
        if (q?.multiSelect) {
          const working = workingSelections(q.id);
          if (working.length > 0) commitQuestion(q, working);
        }
      }
      currentTab = next;
      optionIndex = 0;
      refresh();
    }

    function advanceAfterAnswer() {
      if (!isMulti) {
        submit(false);
        return;
      }
      if (currentTab < questions.length - 1) {
        goToTab(currentTab + 1);
      } else {
        goToTab(questions.length);
      }
    }

    editor.onSubmit = (value) => {
      if (!inputQuestionId) return;
      const q = questions.find((item) => item.id === inputQuestionId);
      if (!q) return;
      const trimmed = value.trim() || "(no response)";
      const custom: AnswerSelection = {
        value: trimmed,
        label: trimmed,
        wasCustom: true,
      };
      if (q.multiSelect) {
        const working = workingSelections(q.id).filter((s) => !s.wasCustom);
        working.push(custom);
        setWorkingSelections(q.id, working);
        commitQuestion(q, working);
      } else {
        commitQuestion(q, [custom]);
      }
      inputMode = false;
      inputQuestionId = null;
      editor.setText("");
      advanceAfterAnswer();
    };

    function toggleMultiOption(q: Question, opt: RenderOption) {
      const working = workingSelections(q.id).filter((s) => !s.wasCustom);
      const exists = working.findIndex((s) => s.value === opt.value);
      if (exists >= 0) working.splice(exists, 1);
      else {
        working.push({
          value: opt.value,
          label: opt.label,
          wasCustom: false,
          index: opt.optionIndex,
        });
      }
      setWorkingSelections(q.id, working);
      refresh();
    }

    function selectSingleOption(q: Question, opt: RenderOption) {
      commitQuestion(q, [{
        value: opt.value,
        label: opt.label,
        wasCustom: false,
        index: opt.optionIndex,
      }]);
      advanceAfterAnswer();
    }

    function handleInput(data: string) {
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      const q = currentQuestion();
      const opts = currentOptions();

      if (isMulti) {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          goToTab((currentTab + 1) % totalTabs);
          return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          goToTab((currentTab - 1 + totalTabs) % totalTabs);
          return;
        }
      }

      if (currentTab === questions.length) {
        if (matchesKey(data, Key.enter) && allAnswered()) {
          submit(false);
        } else if (matchesKey(data, Key.escape)) {
          submit(true);
        }
        return;
      }

      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(opts.length - 1, optionIndex + 1);
        refresh();
        return;
      }

      if (matchesKey(data, Key.enter) && q) {
        const opt = opts[optionIndex];
        if (!opt) return;
        if (opt.isOther) {
          inputMode = true;
          inputQuestionId = q.id;
          editor.setText("");
          refresh();
          return;
        }
        if (q.multiSelect) {
          toggleMultiOption(q, opt);
          return;
        }
        selectSingleOption(q, opt);
        return;
      }

      // Space toggles multi-select; also accepts on single-select like Enter.
      if (data === " " && q) {
        const opt = opts[optionIndex];
        if (!opt || opt.isOther) return;
        if (q.multiSelect) {
          toggleMultiOption(q, opt);
          return;
        }
        selectSingleOption(q, opt);
        return;
      }

      // On multi-select, Enter on a non-option path is handled above (toggle).
      // Use 'n' or confirm with Enter when focus is on "done" via tab? Keep simple:
      // multi-select commits when navigating away or when pressing Enter with >=1 and Shift+Enter?
      // Spec: support multi-select. Space toggles; press 'c' or Ctrl+Enter to continue.
      if ((matchesKey(data, Key.ctrl("enter")) || data === "c" || data === "C") && q?.multiSelect) {
        if (finalizeCurrentDraft()) advanceAfterAnswer();
        else refresh();
        return;
      }

      if (matchesKey(data, Key.escape)) {
        submit(true);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const renderWidth = Math.max(1, width);
      const q = currentQuestion();
      const opts = currentOptions();

      function addWrapped(text: string) {
        lines.push(...wrapTextWithAnsi(text, renderWidth));
      }

      function addWrappedWithPrefix(prefix: string, text: string) {
        const prefixWidth = visibleWidth(prefix);
        if (prefixWidth >= renderWidth) {
          addWrapped(prefix + text);
          return;
        }
        const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
        const continuationPrefix = " ".repeat(prefixWidth);
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
        }
      }

      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      if (isMulti) {
        const tabs: string[] = ["← "];
        for (let i = 0; i < questions.length; i++) {
          const isActive = i === currentTab;
          const answer = committed.get(questions[i].id);
          const draft = drafts.get(questions[i].id);
          const isAnswered = Boolean(answer && answer.selections.length > 0)
            || Boolean(draft && draft.length > 0);
          const lbl = questions[i].label;
          const box = isAnswered ? "■" : "□";
          const color = isAnswered ? "success" : "muted";
          const text = ` ${box} ${lbl} `;
          const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
          tabs.push(`${styled} `);
        }
        const canSubmit = allAnswered();
        const isSubmitTab = currentTab === questions.length;
        const submitText = " ✓ Submit ";
        const submitStyled = isSubmitTab
          ? theme.bg("selectedBg", theme.fg("text", submitText))
          : theme.fg(canSubmit ? "success" : "dim", submitText);
        tabs.push(`${submitStyled} →`);
        addWrappedWithPrefix(" ", tabs.join(""));
        lines.push("");
      }

      function renderOptions() {
        if (!q) return;
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const selected = i === optionIndex;
          const isOther = opt.isOther === true;
          const checked = !isOther && isSelected(q.id, opt.value);
          const marker = q.multiSelect
            ? (checked ? "[x] " : "[ ] ")
            : (checked ? "(•) " : "( ) ");
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const label = `${marker}${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
          const color = selected || (isOther && inputMode) ? "accent" : "text";

          addWrappedWithPrefix(prefix, theme.fg(color, label));
          if (opt.description) {
            addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
          }
        }
      }

      if (inputMode && q) {
        addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
        if (q.multiSelect) {
          addWrappedWithPrefix(" ", theme.fg("muted", "(multi-select — custom text adds an extra answer)"));
        }
        lines.push("");
        renderOptions();
        lines.push("");
        addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
        for (const line of editor.render(Math.max(1, renderWidth - 2))) {
          lines.push(` ${line}`);
        }
        lines.push("");
        addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
      } else if (currentTab === questions.length) {
        addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
        lines.push("");
        for (const question of questions) {
          const answer = committed.get(question.id);
          if (answer && answer.selections.length > 0) {
            const parts = answer.selections.map((sel) =>
              sel.wasCustom ? `(wrote) ${sel.label}` : sel.label
            );
            const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", parts.join("; "))}`;
            addWrappedWithPrefix(" ", summary);
          } else {
            addWrappedWithPrefix(
              " ",
              `${theme.fg("muted", `${question.label}: `)}${theme.fg("warning", "(unanswered)")}`,
            );
          }
        }
        lines.push("");
        if (allAnswered()) {
          addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
        } else {
          const missing = questions
            .filter((item) => {
              const answer = committed.get(item.id);
              return !(answer && answer.selections.length > 0);
            })
            .map((item) => item.label)
            .join(", ");
          addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
        }
      } else if (q) {
        addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
        if (q.multiSelect) {
          addWrappedWithPrefix(" ", theme.fg("muted", "Multi-select: Space/Enter toggles • c continues"));
        }
        lines.push("");
        renderOptions();
      }

      lines.push("");
      if (!inputMode) {
        const help = isMulti
          ? "Tab/←→ navigate • ↑↓ select • Enter/Space choose • Esc cancel"
          : "↑↓ navigate • Enter select • Esc cancel";
        addWrappedWithPrefix(" ", theme.fg("dim", help));
      }
      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}

