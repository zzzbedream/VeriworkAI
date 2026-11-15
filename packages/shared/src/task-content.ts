import { z } from 'zod';
import { LanguageCodeSchema } from './schemas';

/** Mirrors the Prisma `TaskType` enum. */
export const TaskType = {
  RLHF: 'RLHF',
  TRANSLATION_VALIDATION: 'TRANSLATION_VALIDATION',
  LABELING: 'LABELING',
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];
export const TaskTypeSchema = z.enum(TaskType);

const Text = (max: number) => z.string().trim().min(1).max(max);

export const RlhfInputSchema = z.strictObject({
  prompt: Text(8_000),
  responses: z.array(Text(8_000)).min(2).max(4),
});

export const TranslationInputSchema = z.strictObject({
  sourceLanguage: LanguageCodeSchema,
  targetLanguage: LanguageCodeSchema,
  sourceText: Text(4_000),
  candidateTranslation: Text(4_000),
});

export const LabelingInputSchema = z.strictObject({
  text: Text(8_000),
  labels: z
    .array(Text(64))
    .min(2)
    .max(20)
    .refine((labels) => new Set(labels).size === labels.length, { error: 'Labels must be unique' }),
  multiLabel: z.boolean().default(false),
});

/** AI drafts and human corrections share one output shape per task type. */
export const RlhfOutputSchema = z.strictObject({
  /** Response indices, best first (a permutation of the input responses). */
  ranking: z.array(z.int().min(0).max(3)).min(2).max(4),
  rationale: z.string().trim().max(2_000),
});

export const TranslationOutputSchema = z.strictObject({
  verdict: z.enum(['correct', 'minor_issues', 'incorrect']),
  correctedTranslation: z.string().trim().max(4_000).nullable(),
  issues: z.array(Text(200)).max(10),
});

export const LabelingOutputSchema = z.strictObject({
  labels: z.array(Text(64)).min(1).max(20),
});

export type RlhfInput = z.infer<typeof RlhfInputSchema>;
export type TranslationInput = z.infer<typeof TranslationInputSchema>;
export type LabelingInput = z.infer<typeof LabelingInputSchema>;
export type RlhfOutput = z.infer<typeof RlhfOutputSchema>;
export type TranslationOutput = z.infer<typeof TranslationOutputSchema>;
export type LabelingOutput = z.infer<typeof LabelingOutputSchema>;

export type TaskInput = RlhfInput | TranslationInput | LabelingInput;
export type TaskOutput = RlhfOutput | TranslationOutput | LabelingOutput;

export const TASK_INPUT_SCHEMAS = {
  RLHF: RlhfInputSchema,
  TRANSLATION_VALIDATION: TranslationInputSchema,
  LABELING: LabelingInputSchema,
} as const;

export const TASK_OUTPUT_SCHEMAS = {
  RLHF: RlhfOutputSchema,
  TRANSLATION_VALIDATION: TranslationOutputSchema,
  LABELING: LabelingOutputSchema,
} as const;

export type ContentResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function fail<T>(error: string): ContentResult<T> {
  return { ok: false, error };
}

function zodResult<T>(result: z.ZodSafeParseResult<T>): ContentResult<T> {
  return result.success ? { ok: true, value: result.data } : fail(z.prettifyError(result.error));
}

export function parseTaskInput(taskType: TaskType, value: unknown): ContentResult<TaskInput> {
  return zodResult<TaskInput>(TASK_INPUT_SCHEMAS[taskType].safeParse(value));
}

function checkRlhf(input: RlhfInput, output: RlhfOutput): string | null {
  const expected = input.responses.length;
  const unique = new Set(output.ranking);
  const isPermutation =
    output.ranking.length === expected &&
    unique.size === expected &&
    output.ranking.every((i) => i < expected);
  return isPermutation ? null : `ranking must be a permutation of 0..${expected - 1}`;
}

function checkLabeling(input: LabelingInput, output: LabelingOutput): string | null {
  if (output.labels.some((label) => !input.labels.includes(label)))
    return 'labels must come from the input labels';
  if (new Set(output.labels).size !== output.labels.length) return 'labels must be unique';
  return input.multiLabel || output.labels.length === 1 ? null : 'exactly one label is required';
}

function checkTranslation(output: TranslationOutput): string | null {
  const needsCorrection = output.verdict !== 'correct';
  return needsCorrection && output.correctedTranslation === null
    ? 'correctedTranslation is required unless the verdict is "correct"'
    : null;
}

/** Validates an AI draft or a human correction against its (already parsed) input. */
export function parseTaskOutput(
  taskType: TaskType,
  input: TaskInput,
  value: unknown,
): ContentResult<TaskOutput> {
  const parsed = zodResult<TaskOutput>(TASK_OUTPUT_SCHEMAS[taskType].safeParse(value));
  if (!parsed.ok) return parsed;
  const problem =
    taskType === 'RLHF'
      ? checkRlhf(input as RlhfInput, parsed.value as RlhfOutput)
      : taskType === 'LABELING'
        ? checkLabeling(input as LabelingInput, parsed.value as LabelingOutput)
        : checkTranslation(parsed.value as TranslationOutput);
  return problem === null ? parsed : fail(problem);
}

export interface JsonlParseOptions {
  readonly maxItems: number;
  readonly maxBytes: number;
}

export interface JsonlLineError {
  readonly line: number;
  readonly message: string;
}

export interface JsonlParseResult {
  readonly items: readonly TaskInput[];
  readonly errors: readonly JsonlLineError[];
}

export const DEFAULT_JSONL_LIMITS: JsonlParseOptions = { maxItems: 500, maxBytes: 2_000_000 };

type LineResult =
  | { readonly ok: true; readonly value: TaskInput }
  | { readonly ok: false; readonly error: JsonlLineError };

function decodeJson(raw: string): ContentResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error: unknown) {
    return fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseLine(taskType: TaskType, raw: string, line: number): LineResult {
  const decoded = decodeJson(raw);
  const parsed = decoded.ok ? parseTaskInput(taskType, decoded.value) : decoded;
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: { line, message: parsed.error } };
}

/** Parses a B2B JSONL upload (one task input per line); blank lines are ignored. */
export function parseTaskJsonl(
  taskType: TaskType,
  text: string,
  options: JsonlParseOptions = DEFAULT_JSONL_LIMITS,
): JsonlParseResult {
  if (new TextEncoder().encode(text).length > options.maxBytes) {
    return {
      items: [],
      errors: [{ line: 0, message: `upload exceeds ${options.maxBytes} bytes` }],
    };
  }
  const lines = text
    .split(/\r?\n/)
    .map((raw, index) => ({ raw: raw.trim(), line: index + 1 }))
    .filter(({ raw }) => raw !== '');
  if (lines.length > options.maxItems) {
    return {
      items: [],
      errors: [{ line: 0, message: `upload exceeds ${options.maxItems} items` }],
    };
  }
  const results = lines.map(({ raw, line }) => parseLine(taskType, raw, line));
  return {
    items: results.flatMap((result) => (result.ok ? [result.value] : [])),
    errors: results.flatMap((result) => (result.ok ? [] : [result.error])),
  };
}
