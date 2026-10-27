import { describe, expect, it } from 'vitest';
import { firstParagraph, LEAD_MAX, leadOf, summaryOf } from './lead';

describe('the lead (summary, else the first paragraph)', () => {
  it('is the summary when there is one, as text, uncut', () => {
    const summary = 'Jonas needs to know by **Friday** whether you join both days. '.repeat(5);
    expect(leadOf({ body: 'Body text.', summary } as { body: string })).toBe(summary.trim().replace(/\s+/g, ' '));
    expect(summaryOf({ summary: '  ' })).toBeUndefined();
    expect(summaryOf({ summary: 3 })).toBeUndefined();
  });

  it('is the first paragraph as plain text, skipping headings, diagrams and tables', () => {
    const body = '## Evidence\n\n```mermaid\npie\n  "a": 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAnna asks whether the **September** invoice can be paid on the [20th](https://x.example).\nSecond line.\n\n## Proposed reply\n\n> Hi Anna';
    expect(firstParagraph(body)).toBe('Anna asks whether the September invoice can be paid on the 20th. Second line.');
  });

  it('falls back to the first list or quotation when the body has no paragraph', () => {
    expect(firstParagraph('- **From:** Jonas\n- **Date:** today\n\n> Can you join?')).toBe('From: Jonas Date: today');
    expect(firstParagraph('```mermaid\npie\n```')).toBe('');
  });

  it('cuts a long first paragraph at a word with an ellipsis', () => {
    const lead = leadOf({ body: 'word '.repeat(100) });
    expect(lead.length).toBeLessThanOrEqual(LEAD_MAX);
    expect(lead).toMatch(/word…$/);
  });
});
