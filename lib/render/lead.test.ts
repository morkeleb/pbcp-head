import { describe, expect, it } from 'vitest';
import { cutSummary, inlineLead } from './lead';

describe('presenting a lead', () => {
  it('keeps a body lead on one line, a list item or quotation without its marker', () => {
    expect(inlineLead('- **From:** Jonas\nDate: today')).toBe('**From:** Jonas Date: today');
    expect(inlineLead('* item')).toBe('item');
    expect(inlineLead('+ item')).toBe('item');
    expect(inlineLead('12. twelfth')).toBe('twelfth');
    expect(inlineLead('3) third')).toBe('third');
    expect(inlineLead('> quoted')).toBe('quoted');
    expect(inlineLead('>> twice quoted')).toBe('twice quoted');
    expect(inlineLead('**Done** (accepted)')).toBe('**Done** (accepted)'); // bold, not a list item
    expect(inlineLead('2026.10.27 release')).toBe('2026.10.27 release');
    expect(inlineLead('-5 degrees tonight')).toBe('-5 degrees tonight'); // no space: not a marker
    expect(inlineLead('| a | b |')).toBe('\\| a | b |');
  });

  it('cuts a summary at 280 characters, at a word, with an ellipsis', () => {
    const cut = cutSummary('word '.repeat(100).trim());
    expect(cut.length).toBeLessThanOrEqual(280);
    expect(cut).toMatch(/word…$/);
    expect(cutSummary('short')).toBe('short');
  });
});
