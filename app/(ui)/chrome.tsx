'use client';

// The masthead every (ui) route shares (app/(ui)/layout.tsx): the name in the serif, the dateline, the density toggle,
// search, theme and the menu, in the same places on every route. Under the name sits one row that is the page's own:
// the week strip on the brief; "← Brief" and the page's title everywhere else. The row has one height on every route, so
// nothing in the masthead moves between them. A page fills its row through `MastheadRow` (a portal) and tells search
// which cards it has on screen through `useChromeCards`.
//
//   phone                                        broadsheet (≥ 900 px)
//   Brief                    [Density] ⌕ ☾ ☰     Brief                  [row: strip, or ← Brief  Title]   [Density] ⌕ ☾ ☰
//   Tue 27 Oct · morning                         Tue 27 Oct · morning
//   [row: strip, or ← Brief  Title]

import { ChevronDown, Menu, Moon, Search, Sun } from 'lucide-react';
import Link from 'next/link';
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { Density } from './brief/DecisionCard';
import { dateline, NAME } from '../../lib/masthead';
import { api, cardHref, loadTokens, saveTokens } from './client';
import { AsOf, useDark, type MeCard } from './components';

const DENSITY_KEY = 'pbcp.density';
const THEME_KEY = 'pbcp.theme';
const WIDE = '(min-width: 900px)';


interface Chrome {
  density: Density;
  setDensity: (d: Density) => void;
  /** The broadsheet layout (≥ 900 px); null until known on the client. */
  wide: boolean | null;
  row: HTMLElement | null;
  /** The page's own tool beside the density control (the brief's label filter); empty elsewhere. */
  pageTools: HTMLElement | null;
  setCards: (cards: MeCard[]) => void;
  setAsOf: (asOf: { at: string | null; timezone?: string }) => void;
}

const ChromeContext = createContext<Chrome | null>(null);

export function useChrome(): Chrome {
  const c = useContext(ChromeContext);
  if (!c) throw new Error('useChrome outside the (ui) layout');
  return c;
}

/** The cards on screen, for search; and when what is on screen came from the device's copy ("as of"). */
export function useChromeCards(cards: MeCard[], asOf: { at: string | null; timezone?: string } = { at: null }) {
  const { setCards, setAsOf } = useChrome();
  const key = cards.map((c) => `${c.id}:${c.change_seq}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the cards
  useEffect(() => setCards(cards), [key, setCards]);
  useEffect(() => setAsOf(asOf), [asOf.at, asOf.timezone, setAsOf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    setCards([]);
    setAsOf({ at: null });
  }, [setCards, setAsOf]);
}

/** Puts the page's row (the week strip, or the back link and title) into the masthead. */
export function MastheadRow({ children }: { children: ReactNode }) {
  const { row } = useChrome();
  return row ? createPortal(children, row) : null;
}

/** Puts the page's own tool into the masthead, right of the density control (the brief's label filter). */
export function MastheadTools({ children }: { children: ReactNode }) {
  const { pageTools } = useChrome();
  return pageTools ? createPortal(children, pageTools) : null;
}

/** "← Brief" and the page's own title: the row of every route but the brief. */
export function PageRow({ title }: { title: string }) {
  return (
    <MastheadRow>
      <div className="flex h-full min-w-0 items-center gap-3 font-serif text-day font-semibold tracking-editorial" data-page-row>
        <Link href="/brief" className="flex-none text-muted-foreground hover:text-foreground">← Brief</Link>
        <h2 className="min-w-0 truncate text-foreground">{title}</h2>
      </div>
    </MastheadRow>
  );
}

function useDensityState(): [Density, (d: Density) => void] {
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

function useWide(): boolean | null {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const m = matchMedia(WIDE);
    const set = () => setWide(m.matches);
    set();
    m.addEventListener('change', set);
    return () => m.removeEventListener('change', set);
  }, []);
  return wide;
}

/** The dateline, kept current: it is the device's clock, so it is filled in on the client and every minute after. */
function useDateline(): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setText(dateline(new Date()));
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);
  return text;
}

export function ChromeProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = useDensityState();
  const wide = useWide();
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [pageTools, setPageTools] = useState<HTMLElement | null>(null);
  const [cards, setCards] = useState<MeCard[]>([]);
  const [asOf, setAsOf] = useState<{ at: string | null; timezone?: string }>({ at: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setDensity is stable in effect (it only sets state and storage)
  const value = useMemo<Chrome>(() => ({ density, setDensity, wide, row, pageTools, setCards, setAsOf }), [density, wide, row, pageTools]);
  return (
    <ChromeContext.Provider value={value}>
      <Masthead density={density} onDensity={setDensity} wide={wide} cards={cards} asOf={asOf} rowRef={setRow} pageToolsRef={setPageTools} />
      {children}
    </ChromeContext.Provider>
  );
}

export type ThemeChoice = 'system' | 'light' | 'dark';

/** The theme saved on this device: `light` or `dark`, or `system` when none is (the root layout reads it before paint). */
export function savedTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

const THEME_EVENT = 'pbcp:theme';

/**
 * Saves the theme on this device and applies it now. `system` saves nothing, so the page follows the system's scheme,
 * live, through the listener the root layout installs before paint.
 */
export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // the choice lasts as long as the page
  }
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** The saved choice, followed live: the masthead and Settings show the same one. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(
    (changed) => {
      window.addEventListener(THEME_EVENT, changed);
      window.addEventListener('storage', changed);
      return () => {
        window.removeEventListener(THEME_EVENT, changed);
        window.removeEventListener('storage', changed);
      };
    },
    savedTheme,
    () => 'system',
  );
}

const THEMES: Array<[ThemeChoice, string]> = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

function ThemeMenu() {
  const dark = useDark(); // the icon is what the page is now; the menu says why
  const choice = useThemeChoice();
  const label = THEMES.find(([c]) => c === choice)![1];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${label}`} data-theme-menu>
          {dark ? <Moon /> : <Sun />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={choice} onValueChange={(v) => setTheme(v as ThemeChoice)}>
          {THEMES.map(([c, l]) => <DropdownMenuRadioItem key={c} value={c} data-theme-choice={c}>{l}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Finds a card among those on screen, by its title or lead. */
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
          <DialogDescription>Titles and leads of the cards on screen.</DialogDescription>
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

function PagesMenu() {
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
        <DropdownMenuItem asChild><Link href="/brief">Brief</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link href="/orders">Orders</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link href="/settings">Settings</Link></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface MastheadProps {
  density: Density;
  onDensity: (d: Density) => void;
  wide: boolean | null;
  cards: MeCard[];
  asOf: { at: string | null; timezone?: string };
  rowRef: (el: HTMLElement | null) => void;
  pageToolsRef: (el: HTMLElement | null) => void;
}

function Masthead({ density, onDensity, wide, cards, asOf, rowRef, pageToolsRef }: MastheadProps) {
  const date = useDateline();
  const label = { comfortable: 'Comfortable', ledger: 'Ledger' } as const;
  // `data-masthead-shared`: the parts that are the same on every route (the UI tests compare them).
  const tools = (
    <div className="flex items-center gap-1" data-masthead-shared="tools">
      {wide ? (
        <Tabs value={density} onValueChange={(v) => onDensity(v as Density)}>
          {/* The size of the masthead's small buttons (the label filter's): 24 px tall, 12 px text. */}
          <TabsList className="h-6 p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
            <TabsTrigger value="comfortable" className="px-2 py-0 text-xs">Comfortable</TabsTrigger>
            <TabsTrigger value="ledger" className="px-2 py-0 text-xs">Ledger</TabsTrigger>
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
      {/* The page's own tool, if it has one (MastheadTools); takes no room when empty. */}
      <span ref={pageToolsRef} className="contents" data-masthead-page-tools />
      <SearchDialog cards={cards} />
      <ThemeMenu />
      <PagesMenu />
    </div>
  );
  const name = <h1 className={cn('font-serif font-semibold tracking-editorial', wide ? 'text-masthead' : 'text-masthead-sm')} data-masthead-shared="name">{NAME}</h1>;
  const dateLine = (
    <p className="mt-0.5 flex min-h-[1lh] items-center gap-x-2 whitespace-nowrap text-lead text-muted-foreground" data-masthead-shared="dateline">
      <span data-dateline>{date}</span> <AsOf at={asOf.at} timezone={asOf.timezone} />
    </p>
  );

  // The masthead's height, for the sticky day headers, the "Back to today" chip and scroll padding.
  useEffect(() => {
    const m = document.querySelector<HTMLElement>('[data-masthead]');
    if (!m) return;
    const set = () => document.documentElement.style.setProperty('--masthead-h', `${m.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(m);
    return () => ro.disconnect();
  }, [wide]);

  return (
    // Hidden, not absent, until the layout is known on the client: a phone's masthead must not flash on a broadsheet.
    // Opaque: what scrolls under the masthead never shows through it.
    <header className={cn('sticky top-0 z-20 border-b bg-background', wide === null && 'invisible')} data-masthead>
      <div className={cn('mx-auto max-w-[1440px]', wide ? 'flex items-center gap-8 px-6 py-3' : 'px-4 pt-3 pb-2')}>
        {wide ? (
          <div className="flex-none">
            {name}
            {dateLine}
          </div>
        ) : (
          // A phone: the name and the tools on one line, the dateline whole on the next.
          <>
            <div className="flex items-center justify-between gap-3">
              {name}
              {tools}
            </div>
            {dateLine}
          </>
        )}
        {/* The page's row: one height on every route (the week strip's), whatever it holds. */}
        <div ref={rowRef} className={cn('h-[76px]', wide ? 'max-w-xl min-w-0 flex-1' : 'mt-2')} data-masthead-row />
        {wide && <div className="ml-auto">{tools}</div>}
      </div>
    </header>
  );
}
