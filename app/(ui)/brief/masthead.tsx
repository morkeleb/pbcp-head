'use client';

// The brief's masthead: the title in the serif, the date, the density toggle, search, theme, and the way to the other
// pages. The week strip sits under it on a phone and inside it on the broadsheet.

import { ChevronDown, Menu, Moon, Search, Sun } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { api, cardHref, loadTokens, saveTokens } from '../client';
import { AsOf, type MeCard } from '../components';
import type { Density } from './DecisionCard';

const DENSITY_KEY = 'pbcp.density';
const THEME_KEY = 'pbcp.theme';

/** Comfortable or ledger, remembered on this device. */
export function useDensity(): [Density, (d: Density) => void] {
  const [density, setDensity] = useState<Density>('comfortable');
  useEffect(() => {
    try {
      if (localStorage.getItem(DENSITY_KEY) === 'ledger') setDensity('ledger');
    } catch {
      // storage unavailable: comfortable
    }
  }, []);
  const set = (d: Density) => {
    setDensity(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      // the choice lasts as long as the page
    }
  };
  return [density, set];
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
    } catch {
      // the choice lasts as long as the page
    }
  };
  return (
    <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={dark ? 'Light theme' : 'Dark theme'} aria-pressed={dark}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

/** Finds a card among those loaded, by its title or lead. */
function SearchDialog({ cards }: { cards: MeCard[] }) {
  const [q, setQ] = useState('');
  const text = (c: MeCard) => `${c.title} ${(c.rendered_lead ?? '').replace(/<[^>]*>/g, '')} ${c.producer}`.toLowerCase();
  const hits = q.trim() ? cards.filter((c) => text(c).includes(q.trim().toLowerCase())).slice(0, 30) : [];
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Search">
          <Search />
        </Button>
      </DialogTrigger>
      <DialogContent className="top-[12vh] translate-y-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif tracking-editorial">Search</DialogTitle>
          <DialogDescription>Titles and leads of the days on screen.</DialogDescription>
        </DialogHeader>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Anna, invoice, build…"
          aria-label="Search the brief"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <ul className="max-h-[50vh] divide-y overflow-y-auto">
          {hits.map((c) => (
            <li key={c.id} className="py-2">
              <Link href={cardHref(c.id)} className="block">
                <span className="text-meta uppercase tracking-meta text-muted-foreground">{c.producer}</span>
                <span className="block font-serif text-body font-semibold">{c.title}</span>
              </Link>
            </li>
          ))}
          {q.trim() && hits.length === 0 && <li className="py-2 text-lead text-muted-foreground">Nothing on screen matches.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function PagesMenu({ today }: { today: string }) {
  const signOut = async () => {
    if (loadTokens()) await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    saveTokens(null);
    location.href = '/signin';
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Pages">
          <Menu />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild><Link href="/orders">Orders</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link href={`/day/${today}`}>Day view</Link></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface MastheadProps {
  today: string;
  timezone: string;
  density: Density;
  onDensity: (d: Density) => void;
  cards: MeCard[];
  cachedAt: string | null;
  /** The week strip: under the title on a phone, beside it on the broadsheet. */
  strip: ReactNode;
  wide: boolean;
}

export function Masthead({ today, timezone, density, onDensity, cards, cachedAt, strip, wide }: MastheadProps) {
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${today}T00:00:00Z`));
  const label = { comfortable: 'Comfortable', ledger: 'Ledger' } as const;
  const tools = (
    <div className="flex items-center gap-1">
      {wide ? (
        <Tabs value={density} onValueChange={(v) => onDensity(v as Density)}>
          <TabsList className="h-8">
            <TabsTrigger value="comfortable" className="px-2 text-control">Comfortable</TabsTrigger>
            <TabsTrigger value="ledger" className="px-2 text-control">Ledger</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" aria-label={`Density: ${label[density]}`}>
              {label[density]} <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={density} onValueChange={(v) => onDensity(v as Density)}>
              <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="ledger">Ledger</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <SearchDialog cards={cards} />
      <ThemeToggle />
      <PagesMenu today={today} />
    </div>
  );
  return (
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85" data-masthead>
      <div className={cn('mx-auto max-w-[1440px]', wide ? 'flex items-center gap-8 px-6 py-3' : 'px-4 pt-3 pb-2')}>
        <div className={cn('flex items-start justify-between gap-3', wide && 'flex-none')}>
          <div>
            <h1 className={cn('font-serif font-semibold tracking-editorial', wide ? 'text-masthead' : 'text-masthead-sm')}>Morning Brief</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-lead text-muted-foreground">
              {date} <AsOf at={cachedAt} timezone={timezone} />
            </p>
          </div>
          {!wide && tools}
        </div>
        <div className={cn(wide ? 'max-w-xl flex-1' : 'mt-2')}>{strip}</div>
        {wide && <div className="ml-auto">{tools}</div>}
      </div>
    </header>
  );
}
