'use client';

import { ArrowUpRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { api, OfflineError, when } from './client';

// --- types: the /api/me card shape ----------------------------------------------------

export type ActionEntry = string | { id: string; label?: string; body?: string; default?: boolean };

export interface MeCard {
  id: string;
  kind: 'decision' | 'artifact' | 'signal' | 'order';
  producer: string;
  title: string;
  body: string;
  thread?: string;
  urgency?: string;
  actions?: ActionEntry[];
  source?: { url: string; label?: string };
  state: 'open' | 'decided' | 'superseded';
  change_seq: number;
  received_at: string;
  seen_at?: string;
  acknowledged_at?: string;
  snoozed_until?: string;
  decision?: string;
  edited_proposal?: string;
  comment?: string;
  decided_at?: string;
  delegated_to?: string;
  rendered_html: string;
  rendered_actions?: Record<string, string>;
  first_visual?: { kind: 'diagram' | 'image'; src: string; caption: string };
  order_outcome?: 'applied' | 'stale';
  to_producer?: string;
  exec_state?: 'open' | 'claimed' | 'done' | 'failed' | 'cancelled';
  claimed_by?: string;
  claim_expires_at?: string;
  claim_seq?: number;
  /** On an outcome (A.3): the claim it reports on, and how that run ended. */
  'orders.claim_seq'?: number;
  'orders.result'?: 'done' | 'failed';
  /** RFC 0.6 §4.1: one or two plain-text sentences from the producer; the card's lead when present. */
  summary?: string;
  /** RFC 0.6 §3.1, core's leadOf: the summary, or the body's first paragraph as markdown. */
  lead?: string;
  lead_source?: 'summary' | 'body';
  /** The lead as safe inline HTML, rendered by the head (a summary escaped and cut at 280 characters). */
  rendered_lead?: string;
}

// --- offline ---------------------------------------------------------------------------

/** "as of <time>": shown when what is on screen came from the service worker's cache, not the network. */
export function AsOf({ at, timezone }: { at?: string | null; timezone?: string }) {
  if (!at) return null;
  return (
    <span className="badge as-of rounded-full border border-dashed px-2 text-meta text-muted-foreground" title="Shown from this device’s copy; it updates when the network answers">
      as of {when(at, timezone)}
    </span>
  );
}


/** Why a card's controls are disabled offline, in one line (the controls themselves say the rest). */
export const OFFLINE_REASON_SHORT = 'Offline: deciding needs a connection, and nothing is saved to send later.';

/** What a write that was not sent says: nothing is queued. */
export const NOT_SENT = 'Not sent: you’re offline. Nothing was saved to send later; do it again when you’re back online.';


// --- the page theme, and diagrams drawn for it -------------------------------------------

/** Whether the page is dark (the `.dark` class on <html>, set before paint and by the theme toggle), followed live. */
export function useDark(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const o = new MutationObserver(changed);
      o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => o.disconnect();
    },
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
}

/** A drawn diagram's address for the page's theme: `?theme=dark` on a dark page (app/api/me/svg). Other images as they are. */
export function themedSrc(src: string, dark: boolean): string {
  if (!src.startsWith('/api/me/svg/')) return src;
  const bare = src.replace(/[?&]theme=dark\b/, '');
  return dark ? `${bare}${bare.includes('?') ? '&' : '?'}theme=dark` : bare;
}

// --- rendered bodies and the full-screen viewer ----------------------------------------

interface Visual {
  src: string;
  caption: string;
  source?: string;
}

/** Server-rendered, sanitised card HTML. Tapping a visual opens it full-screen (§3.1 Presentation). */
// --- source: the card's way out to the thing it is about (RFC 0.6 §4.1) ----------------------

/**
 * A followable source (§3.1 Links: http, https or mailto only): its host, and its label when the label says something
 * the host does not (no label, or a label that is the host, gives the host alone).
 */
export function sourceLink(source: MeCard['source']): { href: string; label: string | null; host: string } | null {
  if (!source?.url) return null;
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
  const host = url.protocol === 'mailto:' ? url.pathname.split('@').pop() || url.pathname : url.host;
  const label = source.label?.trim() ?? '';
  const same = (s: string) => s.toLowerCase().replace(/^www\./, '').replace(/\/$/, '');
  return { href: url.href, label: label && same(label) !== same(host) ? label : null, host };
}

/**
 * The source on a card's header line, "label · host ↗", opening in a new tab. The label is the producer's display
 * text; the host is where the link goes, which the producer does not control (§12: a head SHOULD show the destination
 * hostname beside a link and treat source.label as untrusted). When the line is too narrow for both, the label goes
 * and the host stays, never the other way round: the host comes first in the DOM, the row is laid out reversed, and
 * whatever wraps (the label) falls onto a clipped second line. A host too long for the line truncates. Nothing when
 * the card has no followable source.
 */
export function SourceLink({ source, className }: { source: MeCard['source']; className?: string }) {
  const link = sourceLink(source);
  if (!link) return null;
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener"
      title={link.host}
      aria-label={`${link.label ? `${link.label}, ` : ''}${link.host} (opens in a new tab)`}
      data-source
      className={`flex h-[1lh] min-w-0 flex-row-reverse flex-wrap items-center justify-end overflow-hidden normal-case tracking-normal hover:text-foreground hover:underline ${className ?? ''}`}
    >
      <span className="flex min-w-0 items-center gap-0.5" data-source-host>
        <span className="truncate">{link.host}</span>
        <ArrowUpRight className="size-3 flex-none" aria-hidden />
      </span>
      {link.label && (
        <span className="flex-none whitespace-nowrap pr-1" data-source-label>
          {link.label} <span aria-hidden>·</span>
        </span>
      )}
    </a>
  );
}

export function Rendered({ html, className }: { html: string; className?: string }) {
  const [open, setOpen] = useState<Visual | null>(null);
  const dark = useDark();
  const root = useRef<HTMLDivElement>(null);
  // The server renders one address per diagram; the page points it at the drawing for its theme.
  useEffect(() => {
    for (const img of root.current?.querySelectorAll<HTMLImageElement>('img[src^="/api/me/svg/"]') ?? []) {
      const src = themedSrc(img.getAttribute('src')!, dark);
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    }
  }, [html, dark]);
  const onClick = (e: React.MouseEvent) => {
    const img = (e.target as HTMLElement).closest('img');
    if (!img) return;
    e.preventDefault();
    const figure = img.closest('figure');
    setOpen({
      src: img.getAttribute('src') ?? '',
      caption: figure?.querySelector('figcaption')?.textContent ?? img.getAttribute('alt') ?? '',
      source: figure?.querySelector('.diagram-source code')?.textContent ?? undefined,
    });
  };
  return (
    <>
      <div ref={root} className={`rendered ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {open && <Viewer visual={open} onClose={() => setOpen(null)} />}
    </>
  );
}


/** Full-screen, native size first, pinch or wheel to zoom, drag to pan; the fence source behind a disclosure. */
export function Viewer({ visual: given, onClose }: { visual: Visual; onClose: () => void }) {
  const dark = useDark();
  const visual = { ...given, src: themedSrc(given.src, dark) };
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  const fit = useCallback(() => {
    const el = stage.current;
    if (!el || !natural) return;
    // A diagram is vector: fit fills the screen. A photo is not enlarged past its own pixels.
    const scale = Math.min(el.clientWidth / natural.w, el.clientHeight / natural.h, visual.src.includes('/api/me/svg/') ? Infinity : 1);
    setView({ scale, x: (el.clientWidth - natural.w * scale) / 2, y: (el.clientHeight - natural.h * scale) / 2 });
  }, [natural, visual.src]);
  // §3.1 Presentation: open at native size, and never smaller than the thumbnail: at least the screen's width.
  const open = useCallback(() => {
    const el = stage.current;
    if (!el || !natural) return;
    const scale = Math.max(1, el.clientWidth / natural.w);
    setView({ scale, x: Math.max(0, (el.clientWidth - natural.w * scale) / 2), y: Math.max(0, (el.clientHeight - natural.h * scale) / 2) });
  }, [natural]);
  useEffect(open, [open]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const scale = Math.min(Math.max(v.scale * factor, 0.1), 12);
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  const centre = () => ({ cx: (stage.current?.clientWidth ?? 0) / 2, cy: (stage.current?.clientHeight ?? 0) / 2 });

  const down = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
    }
  };
  const move = (e: ReactPointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const rect = stage.current!.getBoundingClientRect();
      const factor = (pinch.current.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.dist)) / view.scale;
      zoomAt(factor, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
    } else if (pointers.current.size === 1) {
      setView((v) => ({ ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y }));
    }
  };
  const up = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const wheel = (e: ReactWheelEvent) => {
    const rect = stage.current!.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY / 300), e.clientX - rect.left, e.clientY - rect.top);
  };
  const share = async () => {
    const url = new URL(visual.src, location.href).href;
    if (navigator.share) await navigator.share({ title: visual.caption, url }).catch(() => undefined);
    else window.open(url, '_blank', 'noopener');
  };

  return (
    <div className="viewer" role="dialog" aria-label={visual.caption || 'Visual'}>
      <div className="bar">
        <button onClick={onClose} aria-label="Close">✕</button>
        <button onClick={() => zoomAt(1 / 1.4, centre().cx, centre().cy)} aria-label="Zoom out">−</button>
        <button onClick={() => zoomAt(1.4, centre().cx, centre().cy)} aria-label="Zoom in">+</button>
        <button onClick={() => setView((v) => ({ ...v, scale: 1 }))}>1:1</button>
        <button onClick={fit}>Fit</button>
        <span className="flex-1" />
        <button onClick={share}>Share</button>
      </div>
      <div className="stage" ref={stage} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
        <img
          src={visual.src}
          alt={visual.caption}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 800, h: e.currentTarget.naturalHeight || 600 })}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, width: natural?.w, height: natural?.h }}
        />
      </div>
      {visual.caption && <div className="caption">{visual.caption}</div>}
      {visual.source && (
        <details>
          <summary>Source</summary>
          <pre>{visual.source}</pre>
        </details>
      )}
    </div>
  );
}

// --- announcements -----------------------------------------------------------------------

let announced: (message: string) => void = () => undefined;

/** Says a state change out loud to assistive technology, through the one live region on the page. */
export function announce(message: string): void {
  announced(message);
}

/** The page's live region (rendered once, in the layout). */
export function Announcer() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    announced = (m) => {
      // Cleared first, so the same words twice are announced twice.
      setMessage('');
      setTimeout(() => setMessage(m), 50);
    };
    return () => {
      announced = () => undefined;
    };
  }, []);
  return <div className="sr-only" role="status" aria-live="polite">{message}</div>;
}

// --- the lead, the proposal, and the rest (RFC 0.6 §3.1 Lead, §4.5) ---------------------

const PROPOSAL = /^propos(al|ed)/i;

interface BodyParts {
  /** The first heading, at any level, beginning "Proposal" or "Proposed" (any case) and what follows, to the next heading of the same or a higher level (§4.5). */
  proposal: string;
  /** Everything else, in order, without the paragraph that is already the lead. */
  rest: string;
}

/**
 * Splits a card's rendered (server-sanitised) HTML around its proposal, and drops the lead's paragraph from the
 * rest. The lead itself is the head's (`rendered_lead`, from core's leadOf); in the rendered body it is the first
 * block after any headings, rules and diagrams (§3.1), when that block is a paragraph. Runs in the browser only, on
 * HTML the head rendered: it re-serialises those nodes and renders nothing of its own.
 */
export function splitBody(html: string, leadFromBody: boolean): BodyParts {
  const t = document.createElement('template');
  t.innerHTML = html;
  const nodes = [...t.content.childNodes].filter((n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()));
  const tag = (n: Node) => (n instanceof HTMLElement ? n.tagName : '');
  const level = (n: Node) => (/^H[1-6]$/.test(tag(n)) ? Number(tag(n)[1]) : 0);
  const from = nodes.findIndex((n) => level(n) > 0 && PROPOSAL.test(n.textContent?.trim() ?? ''));
  let to = from < 0 ? -1 : nodes.findIndex((n, j) => j > from && level(n) > 0 && level(n) <= level(nodes[from]!));
  if (from >= 0 && to < 0) to = nodes.length;
  const inProposal = (i: number) => from >= 0 && i >= from && i < to;
  // §3.1 step 1 skips headings, thematic breaks and fences (drawn diagrams, code, collapsed fences).
  const skipped = (n: Node) => level(n) > 0 || ['HR', 'FIGURE', 'PRE', 'DETAILS'].includes(tag(n));
  const first = nodes.findIndex((n) => !skipped(n));
  const lead = leadFromBody && first >= 0 && tag(nodes[first]!) === 'P' ? first : -1;
  const out = (n: Node) => (n instanceof Element ? n.outerHTML : (n.textContent ?? '').replace(/[&<>]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt' } as Record<string, string>)[c]};`));
  return {
    proposal: nodes.filter((_, i) => inProposal(i)).map(out).join(''),
    rest: nodes.filter((_, i) => i !== lead && !inProposal(i)).map(out).join(''),
  };
}



// --- swipes: deferred, with undo (docs/mobile-prd.md gesture table) --------------------------

/** How long a swiped decision or acknowledgement waits, undoable, before it is sent. A tap does not wait. */
export const SWIPE_UNDO_MS = 4000;

/**
 * A swipe commits after SWIPE_UNDO_MS behind an undo toast; Undo cancels it before anything is sent. Only one
 * swipe waits at a time; a second commits the first at once.
 */
export function useDeferred() {
  const [pending, setPending] = useState<{ label: string; run: () => void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const schedule = (label: string, run: () => void) => {
    flush.current?.();
    const go = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      flush.current = null;
      setPending(null);
      run();
    };
    flush.current = go;
    setPending({ label, run });
    timer.current = setTimeout(go, SWIPE_UNDO_MS);
    announce(`${label}. Undo within four seconds.`);
  };
  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    flush.current = null;
    setPending(null);
    announce('Undone');
  };
  const toast = pending && (
    <div className="toast fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-[560px] items-center gap-3 rounded-md bg-foreground px-3 py-2.5 text-lead text-background" role="status">
      <span className="min-w-0 flex-1">{pending.label}</span>
      <button className="rounded-md border border-current px-2.5 py-1 text-control" onClick={undo}>Undo</button>
    </div>
  );
  return { schedule, toast, pending: !!pending };
}

/**
 * A horizontal swipe on a touch screen (a finger, or a pencil, which iOS reports as touch; never a mouse drag, which
 * selects text): left or right past 80 px. Built on touch events rather than pointer events: iOS Safari cancels a
 * touch's pointer stream as soon as it suspects a scroll, so a swipe that drifts a little vertically never ended.
 * Once a gesture is clearly sideways (after 8 px) the card owns it and stops the page from scrolling; a vertical
 * one stays the browser's. A touch that starts on a control (a link, a button, an option) is that control's.
 */
export function useSwipe(onSwipe: (direction: 'left' | 'right') => void) {
  const [dx, setDx] = useState(0);
  const latest = useRef(onSwipe);
  latest.current = onSwipe;
  const detach = useRef<(() => void) | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let axis: 'x' | 'y' | null = null;
    let x = 0;
    const reset = () => {
      start = null;
      axis = null;
      x = 0;
      setDx(0);
    };
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || (e.target as Element).closest('button, a, input, textarea, label, summary, img, [role="radio"]')) return reset();
      start = { x: t.clientX, y: t.clientY };
      axis = null;
      x = 0;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const mx = t.clientX - start.x;
      const my = t.clientY - start.y;
      if (!axis) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      }
      if (axis !== 'x') return;
      e.preventDefault(); // sideways: the card's gesture, not a scroll
      x = mx;
      setDx(mx);
    };
    const end = () => {
      if (start && axis === 'x' && Math.abs(x) >= 80) latest.current(x > 0 ? 'right' : 'left');
      reset();
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', reset);
    detach.current = () => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', reset);
    };
  }, []);
  return { dx, ref };
}

// --- deciding (§4.3, §4.4) ------------------------------------------------------------------

export interface Option {
  id: string;
  label: string;
  isDefault: boolean;
  hasBody: boolean;
}

export function options(card: MeCard): { list: Option[]; edit: boolean; byDefault: Option | null } {
  const actions = card.actions ?? ['approve', 'reject'];
  const list = actions
    .filter((a) => (typeof a === 'string' ? a : a.id) !== 'edit')
    .map((a) => (typeof a === 'string' ? { id: a, label: a, isDefault: false, hasBody: false } : { id: a.id, label: a.label ?? a.id, isDefault: a.default === true, hasBody: !!a.body }));
  const edit = actions.some((a) => (typeof a === 'string' ? a : a.id) === 'edit');
  // §4.4: the default is the option marked so; on the plain string list it is `approve` (the bare approve
  // gesture). With neither, there is no default, and no option is drawn above the others.
  const plain = actions.every((a) => typeof a === 'string');
  const byDefault = list.find((o) => o.isDefault) ?? (plain ? (list.find((o) => o.id === 'approve') ?? null) : null);
  return { list, edit, byDefault };
}

/**
 * What a swipe chooses (docs/mobile-prd.md): right the default, nothing without one; left `dismissed`, which every
 * decision card offers (§4.5). Never `reject`: that is one of the producer's actions, chosen by tapping it.
 */
export function swipeChoice(card: MeCard, direction: 'left' | 'right'): { decision: string; label: string } | null {
  if (direction === 'left') return { decision: 'dismissed', label: 'Dismiss' };
  const { byDefault } = options(card);
  return byDefault ? { decision: byDefault.id, label: byDefault.label } : null;
}


/** What a recorded decision reads as: the option's label, or the protocol decision's name (§4.3). */
export function decisionLabel(card: MeCard): string {
  const { list } = options(card);
  const named: Record<string, string> = { dismissed: 'Dismissed', edited: 'Edited', delegated: 'Delegated' };
  return list.find((o) => o.id === card.decision)?.label ?? named[card.decision ?? ''] ?? card.decision ?? '';
}

export type DecisionBody = { decision: string; edited_proposal?: string; comment?: string };

/**
 * Records a decision (§7.3) the way every surface does: the card changes at once (optimistic), the head is asked,
 * and a refusal or a lost connection puts the card back with the error. Nothing is queued.
 */
export function useDecide(card: MeCard, onChange: (c: MeCard) => void) {
  const [error, setError] = useState<string | null>(null);
  const decide = async (body: DecisionBody) => {
    const before = card;
    const optimistic: MeCard = { ...card, ...body, state: 'decided', decided_at: new Date().toISOString() };
    setError(null);
    onChange(optimistic);
    announce(`${decidedLine(optimistic)}. ${card.title}`);
    const failed = (message: string) => {
      onChange(before);
      setError(message);
      announce(`Not recorded: ${message}`);
    };
    try {
      const r = await api<MeCard & { message?: string }>(`/api/me/cards/${encodeURIComponent(card.id)}/decision`, { method: 'POST', body });
      if (r.status === 200 || r.status === 409) onChange({ ...before, ...r.body });
      else failed(r.body?.message ?? `the head answered ${r.status}`);
    } catch (e) {
      failed(e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed');
    }
  };
  return { decide, error };
}

/** "Approved", "Rejected", "Dismissed", "Edited", or the option's label: what the state line says was decided. */
export function decidedLine(card: MeCard): string {
  const past: Record<string, string> = { approve: 'Approved', reject: 'Rejected', dismissed: 'Dismissed', edited: 'Edited', delegated: 'Delegated' };
  return past[card.decision ?? ''] ?? decisionLabel(card);
}


