'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { api, loadTokens, OFFLINE_REASON, OfflineError, saveTokens, useOnline, when } from './client';

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
  /** RFC 0.6: one or two plain-text sentences from the producer; the card's lead when present. */
  summary?: string;
  /** The lead as plain text (lib/lead.ts): `summary`, else the body's first paragraph. */
  lead?: string;
}

// --- offline ---------------------------------------------------------------------------

/** "as of <time>": shown when what is on screen came from the service worker's cache, not the network. */
export function AsOf({ at, timezone }: { at?: string | null; timezone?: string }) {
  if (!at) return null;
  return <span className="badge as-of" title="Shown from this device’s copy; it updates when the network answers">as of {when(at, timezone)}</span>;
}

/** Why the controls below it are disabled. Renders nothing while online. */
export function OfflineNote() {
  const online = useOnline();
  if (online) return null;
  return <p className="muted offline" role="status">{OFFLINE_REASON}</p>;
}

/** What a write that was not sent says: nothing is queued. */
export const NOT_SENT = 'Not sent: you’re offline. Nothing was saved to send later; do it again when you’re back online.';

// --- navigation ----------------------------------------------------------------------

export function Nav() {
  const today = new Date().toISOString().slice(0, 10);
  const signOut = async () => {
    if (loadTokens()) await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    saveTokens(null);
    location.href = '/signin';
  };
  return (
    <nav className="top">
      <Link href="/brief">Brief</Link>
      <Link href={`/day/${today}`}>Day</Link>
      <Link href="/orders">Orders</Link>
      <span className="spacer" />
      <button onClick={signOut} style={{ minHeight: 32, padding: '4px 10px', fontSize: 14 }}>Sign out</button>
    </nav>
  );
}

// --- rendered bodies and the full-screen viewer ----------------------------------------

interface Visual {
  src: string;
  caption: string;
  source?: string;
}

/** Server-rendered, sanitised card HTML. Tapping a visual opens it full-screen (§3.1 Presentation). */
export function Rendered({ html, className }: { html: string; className?: string }) {
  const [open, setOpen] = useState<Visual | null>(null);
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
      <div className={`rendered ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {open && <Viewer visual={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The first visual of a card as a thumbnail, fitted to the width and never cropped. */
export function Thumb({ visual }: { visual: NonNullable<MeCard['first_visual']> }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className="thumb">
      <img src={visual.src} alt={visual.caption} loading="lazy" onClick={() => setOpen(true)} />
      {visual.caption && <figcaption>{visual.caption}</figcaption>}
      {open && <Viewer visual={visual} onClose={() => setOpen(false)} />}
    </figure>
  );
}

/** Full-screen, native size first, pinch or wheel to zoom, drag to pan; the fence source behind a disclosure. */
export function Viewer({ visual, onClose }: { visual: Visual; onClose: () => void }) {
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
        <span style={{ flex: 1 }} />
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

// --- the lead, the proposal, and the rest (§4.4; RFC 0.6 `summary`) ---------------------

const PROPOSAL = /^propos(al|ed)\b/i;

interface BodyParts {
  /** The first paragraph of the rendered body, when there is no summary to lead with. */
  lead: string;
  /** A section whose heading starts with "Proposal" or "Proposed": the heading and what follows, to the next heading of its level or above. */
  proposal: string;
  /** Everything else, in order. */
  rest: string;
}

/**
 * Splits a card's rendered (server-sanitised) HTML for the card view: the lead rule is lib/lead.ts's, applied
 * to the rendered body so the lead keeps its emphasis and links. Runs in the browser only, on HTML the head
 * rendered; it re-serialises those nodes and renders nothing of its own.
 */
function splitBody(html: string, hasSummary: boolean): BodyParts {
  const t = document.createElement('template');
  t.innerHTML = html;
  const nodes = [...t.content.childNodes].filter((n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()));
  const level = (n: Node) => (n instanceof HTMLElement && /^H[1-6]$/.test(n.tagName) ? Number(n.tagName[1]) : 0);
  let from = -1;
  let to = -1;
  for (let i = 0; i < nodes.length && from < 0; i++) {
    if (level(nodes[i]!) && PROPOSAL.test(nodes[i]!.textContent?.trim() ?? '')) {
      from = i;
      to = nodes.findIndex((n, j) => j > i && level(n) > 0 && level(n) <= level(nodes[i]!));
      if (to < 0) to = nodes.length;
    }
  }
  const inProposal = (i: number) => from >= 0 && i >= from && i < to;
  const isBlock = (n: Node, tags: string[]) => n instanceof HTMLElement && tags.includes(n.tagName) && !!n.textContent?.trim();
  let lead = -1;
  if (!hasSummary) {
    lead = nodes.findIndex((n, i) => !inProposal(i) && isBlock(n, ['P']));
    if (lead < 0) lead = nodes.findIndex((n, i) => !inProposal(i) && isBlock(n, ['UL', 'OL', 'BLOCKQUOTE']));
  }
  const html_ = (n: Node) => (n instanceof Element ? n.outerHTML : (n.textContent ?? '').replace(/[&<>]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt' } as Record<string, string>)[c]};`));
  return {
    lead: lead >= 0 ? html_(nodes[lead]!) : '',
    proposal: nodes.filter((_, i) => inProposal(i)).map(html_).join(''),
    rest: nodes.filter((_, i) => i !== lead && !inProposal(i)).map(html_).join(''),
  };
}

/** The card's own `summary` (RFC 0.6): plain text, never markdown. */
export const summaryOf = (card: MeCard): string | undefined => (typeof card.summary === 'string' && card.summary.trim() ? card.summary.trim() : undefined);

/** The lead, always visible: `summary` as text, else the rendered first paragraph. */
export function Lead({ card }: { card: MeCard }) {
  const summary = summaryOf(card);
  const [parts, setParts] = useState<BodyParts | null>(null);
  useEffect(() => setParts(splitBody(card.rendered_html, !!summary)), [card.rendered_html, summary]);
  if (summary) return <p className="lead">{summary}</p>;
  return parts?.lead ? <Rendered className="lead" html={parts.lead} /> : null;
}

/**
 * A card's body on the brief: the lead and any "Proposal" / "Proposed …" section are visible; everything else
 * is behind one "More". Expanding it is what presents the card (§4.2 seen_at); the lead alone is not.
 */
export function CardBody({ card }: { card: MeCard }) {
  const summary = summaryOf(card);
  const [parts, setParts] = useState<BodyParts | null>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => setParts(splitBody(card.rendered_html, !!summary)), [card.rendered_html, summary]);
  if (!parts) return null;
  const toggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || opened) return;
    setOpened(true);
    if (!card.seen_at) api(`/api/me/cards/${encodeURIComponent(card.id)}/seen`, { method: 'POST' }).catch(() => undefined);
  };
  return (
    <>
      {summary ? <p className="lead">{summary}</p> : parts.lead && <Rendered className="lead" html={parts.lead} />}
      {parts.proposal && <Rendered className="proposal" html={parts.proposal} />}
      {parts.rest.trim() && (
        <details className="more" onToggle={toggle}>
          <summary>More</summary>
          <Rendered html={parts.rest} />
        </details>
      )}
    </>
  );
}

// --- deciding (§4.3, §4.4) ------------------------------------------------------------------

interface Option {
  id: string;
  label: string;
  isDefault: boolean;
  hasBody: boolean;
}

function options(card: MeCard): { list: Option[]; edit: boolean } {
  const actions = card.actions ?? ['approve', 'reject'];
  const list = actions
    .filter((a) => (typeof a === 'string' ? a : a.id) !== 'edit')
    .map((a) => (typeof a === 'string' ? { id: a, label: a, isDefault: false, hasBody: false } : { id: a.id, label: a.label ?? a.id, isDefault: a.default === true, hasBody: !!a.body }));
  const edit = actions.some((a) => (typeof a === 'string' ? a : a.id) === 'edit');
  return { list, edit };
}

/** What a recorded decision reads as: the option's label, or the protocol decision's name (§4.3). */
export function decisionLabel(card: MeCard): string {
  const { list } = options(card);
  const named: Record<string, string> = { dismissed: 'Dismissed', edited: 'Edited', delegated: 'Delegated' };
  return list.find((o) => o.id === card.decision)?.label ?? named[card.decision ?? ''] ?? card.decision ?? '';
}

type DecisionBody = { decision: string; edited_proposal?: string; comment?: string };

/**
 * The card's actions, on the card (§4.4): a row of buttons in the producer's order, the default (else the
 * first) primary; or, for options with a `body`, a vertical group with each body under its label and the
 * default pre-selected. `Dismiss` is always there, quietly; "Edit…" only when `actions` offers `edit`. A
 * comment is behind "Add a comment". Deciding updates the card at once and posts; a failure puts the
 * controls back with the error. The head offers no undo, so none is shown.
 */
export function DecisionControls({ card, onChange, showDecided = false }: { card: MeCard; onChange: (c: MeCard) => void; showDecided?: boolean }) {
  const { list, edit } = options(card);
  const grouped = list.some((o) => o.hasBody || !!card.rendered_actions?.[o.id]);
  const primary = list.find((o) => o.isDefault) ?? list[0];
  const online = useOnline();
  const [selected, setSelected] = useState<string | null>(list.find((o) => o.isDefault)?.id ?? null);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const decide = async (d: DecisionBody) => {
    const before = card;
    const body = comment.trim() ? { ...d, comment: comment.trim() } : d;
    const optimistic: MeCard = { ...card, ...body, state: 'decided', decided_at: new Date().toISOString() };
    setError(null);
    onChange(optimistic);
    announce(`Decided: ${decisionLabel(optimistic)}. ${card.title}`);
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
      if (!(e instanceof OfflineError)) failed(e instanceof Error ? e.message : 'the request failed');
      else failed(NOT_SENT);
    }
  };

  if (card.kind !== 'decision') return null;
  if (card.state === 'decided') {
    if (!showDecided) return null;
    return (
      <p className="decided-line">
        Decided: <strong>{decisionLabel(card)}</strong>
        {card.decided_at && <> · {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(card.decided_at))}</>}
      </p>
    );
  }
  if (card.state !== 'open') return null;
  const off = !online;
  const chosen = list.find((o) => o.id === selected);
  return (
    <div className="decide-controls">
      {grouped ? (
        <fieldset className="choices" disabled={off}>
          <legend className="sr-only">Options</legend>
          {list.map((o) => (
            <label key={o.id} className={`option ${selected === o.id ? 'selected' : ''}`}>
              <input type="radio" name={`option-${card.id}`} checked={selected === o.id} onChange={() => setSelected(o.id)} />
              <span className="label">{o.label}</span>
              {o.isDefault && <span className="default">default</span>}
              {card.rendered_actions?.[o.id] && <Rendered className="option-body" html={card.rendered_actions[o.id]!} />}
            </label>
          ))}
        </fieldset>
      ) : null}
      {editing ? (
        <div className="edit">
          <label className="muted" htmlFor={`edit-${card.id}`}>What you want instead</label>
          <textarea id={`edit-${card.id}`} rows={4} value={edited} onChange={(e) => setEdited(e.target.value)} autoFocus />
        </div>
      ) : null}
      <div className="row decide">
        {editing ? (
          <>
            <button className="primary" disabled={off || edited.trim() === ''} onClick={() => decide({ decision: 'edited', edited_proposal: edited.trim() })}>Send edit</button>
            <button onClick={() => setEditing(false)}>Back</button>
          </>
        ) : grouped ? (
          <button className="primary" disabled={off || !chosen} onClick={() => chosen && decide({ decision: chosen.id })}>{chosen ? chosen.label : 'Pick an option'}</button>
        ) : (
          list.map((o) => (
            <button key={o.id} className={o === primary ? 'primary' : undefined} disabled={off} onClick={() => decide({ decision: o.id })}>{o.label}</button>
          ))
        )}
        {!editing && edit && <button disabled={off} onClick={() => setEditing(true)}>Edit…</button>}
        {!editing && <button className="quiet" disabled={off} onClick={() => decide({ decision: 'dismissed' })}>Dismiss</button>}
      </div>
      <details className="comment">
        <summary>Add a comment</summary>
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" disabled={off} />
      </details>
      <OfflineNote />
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function DecisionSummary({ card, timezone }: { card: MeCard; timezone?: string }) {
  if (!card.decision) return null;
  return (
    <div className="card" style={{ borderColor: 'var(--ok)' }}>
      <strong>{card.decision}</strong>
      {card.decided_at && <span className="muted"> · {when(card.decided_at, timezone)}</span>}
      {card.edited_proposal && <p style={{ whiteSpace: 'pre-wrap' }}>{card.edited_proposal}</p>}
      {card.delegated_to && <p>Delegated to {card.delegated_to}</p>}
      {card.comment && <p className="muted">“{card.comment}”</p>}
    </div>
  );
}
