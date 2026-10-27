import { describe, expect, it } from 'vitest';
import { prefersHtml } from '../lib/accept';

describe('prefersHtml (GET / negotiation, RFC §7.5)', () => {
  it('is true only when text/html is strictly preferred over application/json', () => {
    expect(prefersHtml('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(true); // Safari, Firefox
    expect(prefersHtml('text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7')).toBe(true); // Chrome
    expect(prefersHtml('text/*, application/json;q=0.5')).toBe(true);
    expect(prefersHtml(null)).toBe(false); // no Accept: a producer
    expect(prefersHtml('')).toBe(false);
    expect(prefersHtml('*/*')).toBe(false); // curl, Node's fetch
    expect(prefersHtml('application/json')).toBe(false); // HeadClient
    expect(prefersHtml('text/html, application/json')).toBe(false); // a tie keeps the JSON
    expect(prefersHtml('text/html;q=0.4, application/json;q=0.5')).toBe(false);
    expect(prefersHtml('TEXT/HTML; Q=1, application/json; q=0')).toBe(true);
    expect(prefersHtml('text/html;q=abc, application/json')).toBe(false); // a bad q counts as 0
  });
});
