'use client';

// LabelFilter: the brief's filter by label (RFC 0.7 §4.1: a head SHOULD let the owner filter the brief by label), in the
// masthead row beside the week strip. It lists the labels on the loaded days with how many cards carry each; choosing
// one or more shows only the cards that carry any of them, in decisions, updates and signals, and the daily paragraph
// keeps only their entries. The choice is remembered on this device and shown as a chip with a clear control while it
// is on. Labels filter; they never group (§8). The iOS app mirrors this component.
//
//   [Labels ⌄]                   off
//   [billing-revamp +1 ×]        on: the first chosen label, how many more, clear

import { ChevronDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const KEY = 'pbcp.labels';

/** The labels chosen on this device. */
export function useLabelFilter(): [string[], (labels: string[]) => void] {
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
      if (Array.isArray(saved)) setChosen(saved.filter((l): l is string => typeof l === 'string'));
    } catch {
      // storage unavailable or unreadable: no filter
    }
  }, []);
  const set = (labels: string[]) => {
    setChosen(labels);
    try {
      if (labels.length) localStorage.setItem(KEY, JSON.stringify(labels));
      else localStorage.removeItem(KEY);
    } catch {
      // the choice lasts as long as the page
    }
  };
  return [chosen, set];
}

export interface LabelFilterProps {
  /** The labels on the loaded days, with how many cards carry each. */
  counts: Map<string, number>;
  chosen: string[];
  onChange: (labels: string[]) => void;
}

export function LabelFilter({ counts, chosen, onChange }: LabelFilterProps) {
  // A chosen label stays listed even when no loaded card carries it now, so it can be unchosen.
  const labels = [...new Set([...counts.keys(), ...chosen])].sort();
  const toggle = (l: string, on: boolean) => onChange(on ? [...chosen, l] : chosen.filter((c) => c !== l));
  return (
    <div className="flex items-center gap-1" data-label-filter>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" aria-label={chosen.length ? `Labels: ${chosen.join(', ')}` : 'Filter by label'} className="max-w-48">
            {chosen.length ? (
              <span className="truncate" data-label-chip>
                {chosen[0]}
                {chosen.length > 1 && ` +${chosen.length - 1}`}
              </span>
            ) : (
              'Labels'
            )}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuLabel className="text-meta uppercase tracking-meta text-muted-foreground">Show cards labelled</DropdownMenuLabel>
          {labels.length === 0 && <p className="px-2 py-1.5 text-lead text-muted-foreground">No labels on these days.</p>}
          {labels.map((l) => (
            <DropdownMenuCheckboxItem key={l} checked={chosen.includes(l)} onCheckedChange={(on) => toggle(l, on === true)} onSelect={(e) => e.preventDefault()} data-label={l}>
              <span className="flex-1">{l}</span>
              <span className="pl-4 text-meta tabular-nums text-muted-foreground">{counts.get(l) ?? 0}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {chosen.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={false} onCheckedChange={() => onChange([])}>Show all cards</DropdownMenuCheckboxItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {chosen.length > 0 && (
        <Button variant="ghost" size="icon-xs" aria-label="Clear the label filter" onClick={() => onChange([])} data-label-clear>
          <X />
        </Button>
      )}
    </div>
  );
}
