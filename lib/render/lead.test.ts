import { describe, expect, it } from 'vitest';
import { cutSummary, inlineLead } from './lead';

describe('presenting a lead', () => {
  it('keeps a body lead on one line: block markers escaped only when they are markers', () => {
    expect(inlineLead('- **From:** Jonas\nDate: today')).toBe('\\- **From:** Jonas Date: today');
    expect(inlineLead('**Done** (accepted)')).toBe('**Done** (accepted)'); // bold, not a list item
    expect(inlineLead('> quoted')).toBe('\\> quoted');
    expect(inlineLead('12. twelfth')).toBe('12\\. twelfth');
    expect(inlineLead('2026.10.27 release')).toBe('2026.10.27 release');
  });

  it('cuts a summary at 280 characters, at a word, with an ellipsis', () => {
    const cut = cutSummary('word '.repeat(100).trim());
    expect(cut.length).toBeLessThanOrEqual(280);
    expect(cut).toMatch(/word…$/);
    expect(cutSummary('short')).toBe('short');
  });
});
