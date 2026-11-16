import {
  parseTaskInput,
  parseTaskOutput,
  type LabelingInput,
  type LabelingOutput,
  type RlhfInput,
  type RlhfOutput,
  type TaskType,
  type TranslationInput,
  type TranslationOutput,
} from '@veriwork/shared/task-content';

/** A task input that matched its type's schema, tagged with the type (rendered as text, never HTML). */
export type ParsedTask =
  | { readonly taskType: 'LABELING'; readonly input: LabelingInput }
  | { readonly taskType: 'TRANSLATION_VALIDATION'; readonly input: TranslationInput }
  | { readonly taskType: 'RLHF'; readonly input: RlhfInput };

export type TaskOutputFor<T extends ParsedTask['taskType']> = T extends 'LABELING'
  ? LabelingOutput
  : T extends 'TRANSLATION_VALIDATION'
    ? TranslationOutput
    : RlhfOutput;

export type AnyTaskOutput = LabelingOutput | TranslationOutput | RlhfOutput;

/** `null` when the input does not match its declared type (it is then shown as plain JSON text). */
export function parseTask(taskType: TaskType, input: unknown): ParsedTask | null {
  const parsed = parseTaskInput(taskType, input);
  if (!parsed.ok) return null;
  return { taskType, input: parsed.value } as ParsedTask;
}

/** A draft or correction that is a valid output for this item, else `null`. */
export function parseOutput(task: ParsedTask, value: unknown): AnyTaskOutput | null {
  const parsed = parseTaskOutput(task.taskType, task.input, value);
  return parsed.ok ? (parsed.value as AnyTaskOutput) : null;
}

/** Where the editor starts when there is no usable draft (not complete yet, except a correct translation). */
export function emptyCorrection(task: ParsedTask): AnyTaskOutput {
  switch (task.taskType) {
    case 'LABELING':
      return { labels: [] };
    case 'TRANSLATION_VALIDATION':
      return { verdict: 'correct', correctedTranslation: null, issues: [] };
    case 'RLHF':
      return { ranking: task.input.responses.map((_, index) => index), rationale: '' };
  }
}

/** The worker starts from the AI draft when it is valid for this item. */
export function initialCorrection(task: ParsedTask, draft: unknown): AnyTaskOutput {
  const fromDraft = draft === null || draft === undefined ? null : parseOutput(task, draft);
  return fromDraft ?? emptyCorrection(task);
}

/** `A`, `B`, `C`, `D`: how responses are named to people. */
export function responseLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Text of an issues box: trimmed non-empty lines, at most 10 (the output schema's bound). */
export function issuesFromText(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 10);
}

/** Moves `ranking[index]` one place up (-1) or down (+1); returns a new ranking. */
export function moveRank(ranking: readonly number[], index: number, direction: -1 | 1): number[] {
  const target = index + direction;
  if (target < 0 || target >= ranking.length) return [...ranking];
  const next = [...ranking];
  const moved = next[index] as number;
  next[index] = next[target] as number;
  next[target] = moved;
  return next;
}
