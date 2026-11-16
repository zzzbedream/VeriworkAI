import { describe, expect, it } from 'vitest';
import { emptyCorrection, initialCorrection, issuesFromText, moveRank, parseOutput, parseTask, responseLetter } from './content';

const LABELING = { text: 'Great', labels: ['positive', 'negative'], multiLabel: false };
const RLHF = { prompt: 'Explain UBI', responses: ['A', 'B', 'C'] };
const TRANSLATION = { sourceLanguage: 'en', targetLanguage: 'es', sourceText: 'Hi', candidateTranslation: 'Hola' };

describe('task content helpers', () => {
  it('parses an item for its type and refuses one that does not match', () => {
    expect(parseTask('LABELING', LABELING)).toEqual({ taskType: 'LABELING', input: LABELING });
    expect(parseTask('LABELING', { text: 'x' })).toBeNull();
    expect(parseTask('RLHF', LABELING)).toBeNull();
  });

  it('starts from a valid AI draft and from an empty correction otherwise', () => {
    const labeling = parseTask('LABELING', LABELING);
    const rlhf = parseTask('RLHF', RLHF);
    const translation = parseTask('TRANSLATION_VALIDATION', TRANSLATION);
    if (labeling === null || rlhf === null || translation === null) throw new Error('fixtures must parse');
    expect(initialCorrection(labeling, { labels: ['negative'] })).toEqual({ labels: ['negative'] });
    // A draft with a label that is not offered is not a valid starting point.
    expect(initialCorrection(labeling, { labels: ['angry'] })).toEqual({ labels: [] });
    expect(initialCorrection(rlhf, null)).toEqual({ ranking: [0, 1, 2], rationale: '' });
    expect(initialCorrection(rlhf, { ranking: [0, 0, 1], rationale: '' })).toEqual(emptyCorrection(rlhf));
    expect(emptyCorrection(translation)).toEqual({ verdict: 'correct', correctedTranslation: null, issues: [] });
    expect(parseOutput(labeling, { labels: [] })).toBeNull();
    expect(parseOutput(translation, { verdict: 'incorrect', correctedTranslation: null, issues: [] })).toBeNull();
  });

  it('turns an issues box into at most 10 trimmed lines', () => {
    expect(issuesFromText('  one \n\n two\r\n')).toEqual(['one', 'two']);
    expect(issuesFromText(Array.from({ length: 12 }, (_, index) => `issue ${index}`).join('\n'))).toHaveLength(10);
  });

  it('moves a response one place without mutating the ranking', () => {
    const ranking = [2, 0, 1];
    expect(moveRank(ranking, 2, -1)).toEqual([2, 1, 0]);
    expect(moveRank(ranking, 0, 1)).toEqual([0, 2, 1]);
    expect(moveRank(ranking, 0, -1)).toEqual([2, 0, 1]);
    expect(moveRank(ranking, 2, 1)).toEqual([2, 0, 1]);
    expect(ranking).toEqual([2, 0, 1]);
    expect([0, 1, 2, 3].map(responseLetter)).toEqual(['A', 'B', 'C', 'D']);
  });
});
