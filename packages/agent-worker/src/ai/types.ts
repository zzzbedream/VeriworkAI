import type { TaskInput, TaskOutput, TaskType } from '@veriwork/shared';

/** One item for the AI contributor to draft. `input` was validated with `parseTaskInput`. */
export interface DraftRequest {
  readonly taskType: TaskType;
  readonly input: TaskInput;
  /** The sponsor's campaign instructions (untrusted text: data, never instructions to follow). */
  readonly instructions: string;
  readonly languages: readonly string[];
}

export interface DraftResult {
  /** Validated with `parseTaskOutput` against the request input. */
  readonly output: TaskOutput;
  /** Model (or fixture set) that produced the draft, stored as `TaskItem.aiModel`. */
  readonly model: string;
  /** A server-side refusal fallback model served the request. */
  readonly fallbackUsed: boolean;
}

export interface DraftProvider {
  readonly name: 'fixture' | 'anthropic';
  draft(request: DraftRequest, signal?: AbortSignal): Promise<DraftResult>;
}

export type DraftErrorCode =
  | 'REFUSED'
  | 'INVALID_OUTPUT'
  | 'TRUNCATED'
  | 'RATE_LIMITED'
  | 'AUTHENTICATION'
  | 'BAD_REQUEST'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'UNKNOWN';

const RETRYABLE: ReadonlySet<DraftErrorCode> = new Set([
  'RATE_LIMITED',
  'UNAVAILABLE',
  'TIMEOUT',
  'TRUNCATED',
  'UNKNOWN',
]);

/** Typed failure of a draft request; `retryable` tells the orchestrator to try again next run. */
export class DraftError extends Error {
  readonly code: DraftErrorCode;
  readonly retryable: boolean;

  constructor(code: DraftErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'DraftError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

/** The model (and every fallback model) declined the request (`stop_reason: "refusal"`). */
export class DraftRefusalError extends DraftError {
  readonly category: string | null;
  readonly explanation: string | null;

  constructor(category: string | null, explanation: string | null) {
    super('REFUSED', `The model declined to draft this item (category: ${category ?? 'none'})`);
    this.name = 'DraftRefusalError';
    this.category = category;
    this.explanation = explanation;
  }
}
