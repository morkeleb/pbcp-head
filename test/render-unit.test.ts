import { describe, expect, it } from 'vitest';
import { isPublicAddress } from '../lib/render/fetch-image';
import { diagramTitle, diagramType, sanitiseFence, tierOf } from '../lib/render/mermaid';

describe('mermaid fences (§3.1)', () => {
  it('strips click lines, URL-loading init, htmlLabels init, and front-matter config, keeping the title', () => {
    const stripped = new Set<string>();
    const src = [
      '---', 'title: Pipeline', 'config:', '  flowchart:', '    htmlLabels: true', '---',
      '%%{init: {"theme": "forest"}}%%',
      '%%{init: {"themeCSS": "@import url(https://evil.example/a.css);"}}%%',
      '%%{init: {"flowchart": {"htmlLabels": true}}}%%',
      'flowchart LR', '  A --> B', '  click A "https://evil.example"', '  click B callback',
    ].join('\n');
    const out = sanitiseFence(src, stripped);
    expect(out).toBe('---\ntitle: Pipeline\n---\n%%{init: {"theme": "forest"}}%%\nflowchart LR\n  A --> B');
    expect([...stripped].sort()).toEqual(['click', 'htmlLabels', 'init']);
    expect(diagramType(out)).toBe('flowchart');
    expect(diagramTitle(out)).toBe('Pipeline');
  });

  it('types and tiers match §3.1 exactly; aliases are Other', () => {
    expect(tierOf('xychart-beta')).toBe('core');
    expect(tierOf('gitGraph')).toBe('extended');
    expect(tierOf('graph')).toBe('other');
    expect(tierOf('stateDiagram')).toBe('other');
    expect(diagramType('\n%% a comment\npie title X\n "a": 1')).toBe('pie');
  });

  it('finds the caption in pie, title lines and quotes', () => {
    expect(diagramTitle('pie title Decisions this week\n "A": 1')).toBe('Decisions this week');
    expect(diagramTitle('xychart-beta\n  title "Cards per day"\n  bar [1]')).toBe('Cards per day');
    expect(diagramTitle('flowchart LR\n A-->B')).toBeNull();
  });
});

describe('image proxy address check', () => {
  it('refuses private, loopback, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

import { addDays, dayRange, localDate, localMinutes, zonedInstant } from '../lib/time';

describe('the owner’s calendar', () => {
  it('converts wall-clock times to instants across DST', () => {
    expect(zonedInstant('2026-10-07', '05:30', 'Europe/Copenhagen').toISOString()).toBe('2026-10-07T03:30:00.000Z');
    expect(zonedInstant('2026-12-07', '05:30', 'Europe/Copenhagen').toISOString()).toBe('2026-12-07T04:30:00.000Z');
    expect(zonedInstant('2026-10-07', '05:30', 'Asia/Kolkata').toISOString()).toBe('2026-10-07T00:00:00.000Z');
    const [start, end] = dayRange('2026-10-25', 'Europe/Copenhagen'); // the day DST ends: 25 hours
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it('reads the local date and time of an instant', () => {
    const t = new Date('2026-10-06T23:30:00Z');
    expect(localDate(t, 'UTC')).toBe('2026-10-06');
    expect(localDate(t, 'Europe/Copenhagen')).toBe('2026-10-07');
    expect(localMinutes(t, 'Europe/Copenhagen')).toBe(90);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
