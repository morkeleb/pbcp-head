'use client';

// The masthead every (ui) route shares (app/(ui)/layout.tsx): the name in the serif, the dateline, search, theme and
// the menu, in the same places on every route. Under the name sits one row that is the page's own:
// the week strip on the brief; "← Brief" and the page's title everywhere else. The row has one height on every route, so
// nothing in the masthead moves between them. A page fills its row through `MastheadRow` (a portal) and tells search
// which cards it has on screen through `useChromeCards`.
//
//   phone                                        broadsheet (≥ 900 px)
//   Brief                              ⌕ ☾ ☰     Brief                  [row: strip, or ← Brief  Title]             ⌕ ☾ ☰
//   Tue 27 Oct · morning                         Tue 27 Oct · morning
//   [row: strip, or ← Brief  Title]

import { Menu, Moon, Search, Sun } from 'lucide-react';
import Link from 'next/link';
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { dateline, NAME } from '../../lib/masthead';
import { api, cardHref, loadTokens, saveTokens } from './client';
import { AsOf, useDark, type MeCard } from './components';
import { blockedBy, drain, waitingCount } from './local/outbox';
import { search, type Hit } from './local/search';
import { onStore } from './local/store';

const THEME_KEY = 'pbcp.theme';
const WIDE = '(min-width: 900px)';


interface Chrome {
  /** A wide screen (≥ 900 px): the masthead on one line, keys on the brief; null until known on the client. */
  wide: boolean | null;
  row: HTMLElement | null;
  /** The page's own tool in the masthead's tools (the brief's label filter); empty elsewhere. */
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

/** Puts the page's own tool into the masthead, first among its tools (the brief's label filter). */
export function MastheadTools({ children }: { children: ReactNode }) {
  const { pageTools } = useChrome();
  return pageTools ? createPortal(children, pageTools) : null;
}

/** "← Brief" (or `back`, a settings page's "← Settings") and the page's own title: the row of every route but the brief. */
export function PageRow({ title, back = { href: '/brief', label: 'Brief' } }: { title: string; back?: { href: string; label: string } }) {
  return (
    <MastheadRow>
      <div className="flex h-full min-w-0 items-center gap-3 font-serif text-day font-semibold tracking-editorial" data-page-row>
        <Link href={back.href} className="flex-none text-muted-foreground hover:text-foreground">← {back.label}</Link>
        <h2 className="min-w-0 truncate text-foreground">{title}</h2>
      </div>
    </MastheadRow>
  );
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
  const wide = useWide();
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [pageTools, setPageTools] = useState<HTMLElement | null>(null);
  const [cards, setCards] = useState<MeCard[]>([]);
  const [asOf, setAsOf] = useState<{ at: string | null; timezone?: string }>({ at: null });
  const value = useMemo<Chrome>(() => ({ wide, row, pageTools, setCards, setAsOf }), [wide, row, pageTools]);
  return (
    <ChromeContext.Provider value={value}>
      <Masthead wide={wide} cards={cards} asOf={asOf} rowRef={setRow} pageToolsRef={setPageTools} />
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

/**
 * Search over the device (local/search.ts): every card the store holds, by its title, summary, lead and body, grouped by
 * day and opening the card. Nothing is sent to the head. Without a store (a private window, storage refused), the cards on
 * screen, by title and lead, as before.
 */
function SearchDialog({ cards }: { cards: MeCard[] }) {
  const [q, setQ] = useState('');
  const [days, setDays] = useState<Array<{ day: string; hits: Hit[] }> | null>(null);
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void search(q).then((r) => {
      if (!live) return;
      setLocal(r !== null);
      setDays(r);
    });
    return () => void (live = false);
  }, [q]);
  const text = (c: MeCard) => `${c.title} ${(c.rendered_lead ?? '').replace(/<[^>]*>/g, '')} ${c.producer}`.toLowerCase();
  const onScreen: Array<{ day: string; hits: Hit[] }> =
    local === false && q.trim()
      ? [{ day: '', hits: cards.filter((c) => text(c).includes(q.trim().toLowerCase())).slice(0, 30).map((c) => ({ id: c.id, title: c.title, producer: c.producer, day: c.day ?? '', kind: c.kind })) }]
      : [];
  const groups = local ? (days ?? []) : onScreen;
  const none = q.trim() && groups.every((g) => g.hits.length === 0);
  const dayName = (d: string) => (d ? new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)) : '');
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
          <DialogDescription>{local === false ? 'Titles and leads of the cards on screen.' : 'Every card on this device: titles, leads and bodies. Nothing is sent to the head.'}</DialogDescription>
        </DialogHeader>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Anna, invoice, build…"
          aria-label="Search the brief"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="max-h-[50vh] overflow-y-auto" data-search-results>
          {groups.map((g) => (
            <section key={g.day} data-search-day={g.day}>
              {g.day && <h4 className="pt-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">{dayName(g.day)}</h4>}
              <ul className="divide-y">
                {g.hits.map((c) => (
                  <li key={c.id} className="py-2" data-search-hit={c.id}>
                    <Link href={cardHref(c.id)} className="block">
                      <span className="text-meta uppercase tracking-meta text-muted-foreground">{c.producer}</span>
                      <span className="block font-serif text-body font-semibold">{c.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {none && <p className="py-2 text-lead text-muted-foreground">{local === false ? 'Nothing on screen matches.' : 'Nothing on this device matches.'}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "2 changes waiting to send": what the outbox holds (local/outbox.ts), quiet, beside the dateline; nothing when empty.
 * When the first row waits for the passkey, every row behind it waits too, so the line says so and links to that card.
 */
function Waiting() {
  const [n, setN] = useState(0);
  const [blocked, setBlocked] = useState<{ card_id: string; title: string } | null>(null);
  useEffect(() => {
    const read = () => {
      void waitingCount().then(setN);
      void blockedBy().then(setBlocked);
    };
    read();
    // The sender runs on every open (and after each sync, local/feed.ts): what was written offline before the app was
    // closed goes now. It joins a drain already running.
    void drain();
    return onStore((e) => void (e.outbox && read()));
  }, []);
  if (n === 0) return null;
  return (
    <span className="text-meta text-muted-foreground" role="status" data-outbox-count={n}>
      · {n} {n === 1 ? 'change' : 'changes'} waiting to send
      {blocked && (
        <>
          {' — '}
          <Link href={cardHref(blocked.card_id)} className="underline underline-offset-2" data-outbox-blocked={blocked.card_id}>one needs your passkey</Link>
        </>
      )}
    </span>
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
  wide: boolean | null;
  cards: MeCard[];
  asOf: { at: string | null; timezone?: string };
  rowRef: (el: HTMLElement | null) => void;
  pageToolsRef: (el: HTMLElement | null) => void;
}

function Masthead({ wide, cards, asOf, rowRef, pageToolsRef }: MastheadProps) {
  const date = useDateline();
  // `data-masthead-shared`: the parts that are the same on every route (the UI tests compare them).
  const tools = (
    <div className="flex items-center gap-1" data-masthead-shared="tools">
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
      <span data-dateline>{date}</span> <AsOf at={asOf.at} timezone={asOf.timezone} /> <Waiting />
    </p>
  );

  // The masthead's height, for the sticky day header and scroll padding.
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
