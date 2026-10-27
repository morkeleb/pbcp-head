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
  useEffect(fit, [fit]);
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

// --- deciding (§4.3, §4.4; mobile PRD gesture model) -----------------------------------

interface Option {
  id: string;
  label: string;
  isDefault: boolean;
  hasBody: boolean;
}

/** At most this many options are buttons on the card itself; a longer list opens the sheet. */
const INLINE_OPTIONS = 3;

function options(card: MeCard): { list: Option[]; edit: boolean; primary: Option | null; reject: Option | null } {
  const actions = card.actions ?? ['approve', 'reject'];
  const list = actions
    .filter((a) => (typeof a === 'string' ? a : a.id) !== 'edit')
    .map((a) => (typeof a === 'string' ? { id: a, label: a, isDefault: false, hasBody: false } : { id: a.id, label: a.label ?? a.id, isDefault: a.default === true, hasBody: !!a.body }));
  const edit = actions.some((a) => (typeof a === 'string' ? a : a.id) === 'edit');
  const plainDefault = actions.every((a) => typeof a === 'string') && list.some((o) => o.id === 'approve');
  // §4.4: the default is the bare-approve gesture; with the plain list that is `approve`; with no default, none.
  const primary = list.find((o) => o.isDefault) ?? (plainDefault ? list.find((o) => o.id === 'approve')! : null);
  const reject = list.find((o) => o.id === 'reject' && o !== primary) ?? null;
  return { list, edit, primary, reject };
}

type Pending = { decision: string; edited_proposal?: string; comment?: string; label: string };

/** Decide buttons: the default (swipe right), reject (swipe left), and the sheet. Every decision waits behind an undo toast. */
export function DecisionControls({ card, onDecided }: { card: MeCard; onDecided: (c: MeCard) => void }) {
  const { list, edit, primary, reject } = options(card);
  // A short list is decided on the card: one button per option, in the producer's order (§4.4). The sheet is
  // for what a button cannot carry: a long list, option bodies to read, an edited proposal, a comment.
  const inline = list.length <= INLINE_OPTIONS;
  const shown = inline ? list : primary ? [primary] : [];
  const more = !inline || edit || list.some((o) => o.hasBody);
  const tone = (o: Option) => (o === primary ? 'primary' : o === reject ? 'danger' : undefined);
  const [sheet, setSheet] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const online = useOnline();
  const post = useCallback(
    async (p: Pending) => {
      const { label: _label, ...decision } = p;
      try {
        const r = await api<MeCard & { message?: string }>(`/api/me/cards/${encodeURIComponent(card.id)}/decision`, { method: 'POST', body: decision });
        setPending(null);
        if (r.status === 200 || r.status === 409) onDecided(r.body);
        else setError(r.body.message ?? `could not record the decision (${r.status})`);
      } catch (e) {
        // The network went while the undo toast was up: the decision is dropped, not kept for later.
        if (!(e instanceof OfflineError)) throw e;
        setPending(null);
        setError(NOT_SENT);
      }
    },
    [card.id, onDecided],
  );
  const choose = (p: Pending) => {
    setSheet(false);
    setError(null);
    setPending(p);
    timer.current = setTimeout(() => post(p), 4000);
  };
  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    setPending(null);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (card.state !== 'open' || card.kind !== 'decision') return null;
  return (
    <>
      <div className="row decide">
        {shown.map((o) => (
          <button key={o.id} className={tone(o)} disabled={!!pending || !online} onClick={() => choose({ decision: o.id, label: o.label })}>{o.label}</button>
        ))}
        {(more || shown.length === 0) && <button disabled={!!pending || !online} onClick={() => setSheet(true)}>{shown.length ? 'More…' : 'Decide…'}</button>}
      </div>
      <OfflineNote />
      {error && <p className="error">{error}</p>}
      {pending && (
        <div className="toast" role="status">
          <span>{pending.label}: {card.title}</span>
          <button onClick={undo}>Undo</button>
        </div>
      )}
      {sheet && online && <DecideSheet card={card} list={list} edit={edit} onChoose={choose} onClose={() => setSheet(false)} />}
    </>
  );
}

function DecideSheet({ card, list, edit, onChoose, onClose }: { card: MeCard; list: Option[]; edit: boolean; onChoose: (p: Pending) => void; onClose: () => void }) {
  const [selected, setSelected] = useState<string | null>(list.find((o) => o.isDefault)?.id ?? null);
  const [other, setOther] = useState('');
  const [comment, setComment] = useState('');
  const withComment = (p: Pending): Pending => (comment.trim() ? { ...p, comment: comment.trim() } : p);
  const submit = () => {
    if (selected === '\u0000edit') onChoose(withComment({ decision: 'edited', edited_proposal: other, label: 'Edited' }));
    else if (selected) onChoose(withComment({ decision: selected, label: list.find((o) => o.id === selected)!.label }));
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Decide">
        <h3 style={{ marginTop: 0 }}>{card.title}</h3>
        {list.map((o) => (
          <label key={o.id} className={`option ${selected === o.id ? 'selected' : ''}`}>
            <input type="radio" name="option" checked={selected === o.id} onChange={() => setSelected(o.id)} style={{ marginRight: 8 }} />
            <span className="label">{o.label}</span>
            {o.isDefault && <span className="default">default</span>}
            {card.rendered_actions?.[o.id] && <Rendered html={card.rendered_actions[o.id]!} />}
          </label>
        ))}
        {edit && (
          <label className={`option ${selected === '\u0000edit' ? 'selected' : ''}`}>
            <input type="radio" name="option" checked={selected === '\u0000edit'} onChange={() => setSelected('\u0000edit')} style={{ marginRight: 8 }} />
            <span className="label">Other…</span>
            {selected === '\u0000edit' && <textarea rows={4} value={other} onChange={(e) => setOther(e.target.value)} placeholder="What you want instead" autoFocus />}
          </label>
        )}
        <p className="muted" style={{ marginBottom: 4 }}>Comment (optional)</p>
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="row">
          <button className="primary" onClick={submit} disabled={!selected || (selected === '\u0000edit' && other.trim() === '')}>Decide</button>
          <button onClick={() => onChoose(withComment({ decision: 'dismissed', label: 'Dismissed' }))}>Dismiss</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
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
