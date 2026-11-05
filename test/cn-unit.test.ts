// lib/utils.ts `cn`: the theme's own sizes and tracking merge as sizes and tracking, never as colours.

import { describe, expect, it } from 'vitest';
import { cn } from '../lib/utils';

describe('cn', () => {
  it('keeps a theme size beside a text colour, and lets a later theme size replace an earlier one', () => {
    expect(cn('flex-none text-meta tabular-nums', 'text-destructive')).toBe('flex-none text-meta tabular-nums text-destructive');
    expect(cn('font-serif text-title', 'text-muted-foreground')).toBe('font-serif text-title text-muted-foreground');
    expect(cn('text-lead', 'text-meta')).toBe('text-meta');
    expect(cn('text-foreground', 'text-muted-foreground')).toBe('text-muted-foreground');
  });

  it('merges the theme tracking with the others', () => {
    expect(cn('tracking-meta', 'tracking-normal')).toBe('tracking-normal');
  });
});
