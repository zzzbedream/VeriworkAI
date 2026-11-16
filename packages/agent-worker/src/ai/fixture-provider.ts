import {
  parseTaskOutput,
  type Hex,
  type LabelingInput,
  type RlhfInput,
  type TaskOutput,
  type TranslationInput,
} from '@veriwork/shared';
import { demoItemKey, loadDemoDataset, type DemoDataset } from '../demo/dataset';
import { DraftError, type DraftProvider, type DraftRequest, type DraftResult } from './types';

/** `aiModel` of an item drafted by the offline heuristic (not in the curated dataset). */
export const HEURISTIC_DRAFT_MODEL = 'veriwork-offline-heuristic-v1';

/** Deterministic, deliberately naive draft for items outside the curated dataset (no network). */
export function heuristicDraft(request: DraftRequest): TaskOutput {
  switch (request.taskType) {
    case 'TRANSLATION_VALIDATION': {
      const input = request.input as TranslationInput;
      return {
        verdict: 'minor_issues',
        correctedTranslation: input.candidateTranslation,
        issues: ['offline draft: check meaning, numbers, negations and register'],
      };
    }
    case 'LABELING': {
      const input = request.input as LabelingInput;
      return { labels: input.labels.slice(0, 1) };
    }
    case 'RLHF': {
      const input = request.input as RlhfInput;
      return {
        ranking: input.responses.map((_, index) => index),
        rationale:
          'Offline draft: the original order was kept; compare correctness, safety and fit.',
      };
    }
  }
}

/**
 * Default provider (`AI_PROVIDER=fixture`): the curated, deliberately imperfect drafts of the demo
 * dataset, looked up by the item's canonical input hash; any other item gets the offline heuristic.
 */
export class FixtureDraftProvider implements DraftProvider {
  readonly name = 'fixture' as const;
  private readonly drafts: ReadonlyMap<Hex, TaskOutput>;

  constructor(private readonly dataset: DemoDataset = loadDemoDataset()) {
    this.drafts = new Map(
      dataset.campaigns.flatMap((campaign) =>
        campaign.items.map(
          (item) => [demoItemKey(campaign.taskType, item.input), item.draft] as const,
        ),
      ),
    );
  }

  async draft(request: DraftRequest): Promise<DraftResult> {
    const curated = this.drafts.get(demoItemKey(request.taskType, request.input));
    const parsed = parseTaskOutput(
      request.taskType,
      request.input,
      curated ?? heuristicDraft(request),
    );
    if (!parsed.ok)
      throw new DraftError('INVALID_OUTPUT', `Invalid fixture draft: ${parsed.error}`);
    return {
      output: parsed.value,
      model: curated === undefined ? HEURISTIC_DRAFT_MODEL : this.dataset.model,
      fallbackUsed: false,
    };
  }
}
