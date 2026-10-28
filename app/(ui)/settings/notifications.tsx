'use client';

// Settings → Devices: a device's notifications, two switches side by side: "Daily brief at <time>" (lib/push/daily.ts,
// a quarter hour in the device's timezone) and "Urgent cards" (lib/push/urgent.ts, a push for each card stored with
// delivery immediate). Both use the device's one Web Push subscription: turning either on asks for permission,
// subscribes the service worker with the head's VAPID key (GET /api/push/key) and stores the subscription (POST
// /api/me/settings/push); turning the last one off removes it. On another device they are shown, not changed: a
// subscription is made by the device that receives it.
//
// iPhone and iPad: Web Push reaches a web app only once it is installed to the Home Screen and opened from there, so in
// Safari the switch is off with that said.

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { api } from '../client';

export interface NotificationState {
  daily_notification: { enabled: boolean; time: string; subscribed: boolean };
  urgent_notification: { enabled: boolean; subscribed: boolean };
}

const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

type Support = 'checking' | 'ok' | 'ios-not-installed' | 'unsupported' | 'denied' | 'no-keys';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const raw = atob((base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function failIfRefused(r: { status: number; body: unknown }) {
  if (r.status >= 400) throw new Error((r.body as { message?: string } | null)?.message ?? `the head answered ${r.status}`);
}

function Switch({ on, label, disabled, onToggle, kind }: { on: boolean; label: string; disabled: boolean; onToggle: () => void; kind: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn('relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50', on ? 'border-primary bg-primary' : 'border-input bg-muted')}
      data-notify-switch={kind}
    >
      <span className={cn('absolute top-0.5 size-3.5 rounded-full bg-background shadow transition-[left]', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

export function DeviceNotifications({ deviceId, current, state, online, onChanged, onError }: {
  deviceId: string;
  current: boolean;
  state: NotificationState;
  online: boolean;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [support, setSupport] = useState<Support>('checking');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!current) return;
    void (async () => {
      if (isIos() && !installed()) return setSupport('ios-not-installed');
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setSupport('unsupported');
      if (Notification.permission === 'denied') return setSupport('denied');
      const key = await api<{ public_key?: string }>('/api/push/key');
      setSupport(key.status === 200 ? 'ok' : 'no-keys');
    })();
  }, [current]);

  const daily = state.daily_notification;
  const urgent = state.urgent_notification;
  const subscribed = daily.subscribed;

  const patch = async (body: { daily_notification?: { enabled?: boolean; time?: string }; urgent_notification?: { enabled: boolean } }) =>
    failIfRefused(await api(`/api/me/settings/devices/${encodeURIComponent(deviceId)}`, { method: 'PATCH', body }));

  /** Permission, and the subscription stored on the head: what either switch needs before it is on. */
  const subscribe = async () => {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setSupport(permission === 'denied' ? 'denied' : 'ok');
      throw new Error('Notifications were not allowed.');
    }
    const key = await api<{ public_key: string }>('/api/push/key');
    await failIfRefused(key);
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.body.public_key) }));
    await failIfRefused(await api('/api/me/settings/push', { method: 'POST', body: sub.toJSON() }));
  };

  /** With neither switch on, the subscription goes too. */
  const unsubscribe = async () => {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    await sub?.unsubscribe();
    await failIfRefused(await api('/api/me/settings/push', { method: 'DELETE' }));
  };

  const toggle = (which: 'daily' | 'urgent', on: boolean) => async () => {
    if (!on) await subscribe();
    await patch(which === 'daily' ? { daily_notification: { enabled: !on } } : { urgent_notification: { enabled: !on } });
    const other = which === 'daily' ? urgent.enabled : daily.enabled;
    if (on && !other) await unsubscribe();
  };

  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      onError(e);
    }
    await onChanged();
    setBusy(false);
  };

  // On this device a switch is on only while the head can reach it; another device's shows its setting.
  const dailyOn = daily.enabled && (subscribed || !current);
  const urgentOn = urgent.enabled && (subscribed || !current);
  const editable = current && support === 'ok' && online && !busy;
  const note = !current
    ? 'Set on that device.'
    : support === 'ios-not-installed'
      ? 'On iPhone this works only when Brief is installed to the Home Screen (Share → Add to Home Screen) and opened from there.'
      : support === 'unsupported'
        ? 'This browser cannot receive notifications.'
        : support === 'denied'
          ? 'Notifications are blocked for this site in the browser’s settings.'
          : support === 'no-keys'
            ? 'This head has no push keys (VAPID), so it cannot send notifications.'
            : (daily.enabled || urgent.enabled) && !subscribed
              ? 'The push service dropped this device’s subscription: turn it on again.'
              : 'The brief’s time is in this device’s timezone.';

  return (
    <div className="basis-full pt-1" data-notifications={deviceId}>
      {/* Two columns, side by side at any width: each a switch and its label, the daily one's time under its label. */}
      <div className="grid grid-cols-2 gap-x-4">
        <div className="flex items-start gap-2" data-daily-notification={deviceId}>
          <span className="pt-0.5"><Switch on={dailyOn} label="Daily brief" kind="daily" disabled={!editable} onToggle={() => void act(toggle('daily', dailyOn))} /></span>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-lead">Daily brief</span>
            <label className="flex items-center gap-1.5 text-lead text-muted-foreground">
              at
              <select aria-label="Daily brief time" className="rounded-md border border-input bg-background px-1.5 py-0.5 text-body text-foreground disabled:opacity-50" value={daily.time} disabled={!editable}
                onChange={(e) => void act(() => patch({ daily_notification: { time: e.target.value } }))} data-notify-time>
                {TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </span>
        </div>
        <div className="flex items-start gap-2" data-urgent-notification={deviceId}>
          <span className="pt-0.5"><Switch on={urgentOn} label="Urgent cards" kind="urgent" disabled={!editable} onToggle={() => void act(toggle('urgent', urgentOn))} /></span>
          <span className="flex flex-col gap-1">
            <span className="text-lead">Urgent cards</span>
            <span className="text-lead text-muted-foreground">as they arrive</span>
          </span>
        </div>
      </div>
      <p className={cn('pt-1 text-lead', support === 'ios-not-installed' || support === 'denied' ? 'text-destructive' : 'text-muted-foreground')} data-notify-note>{note}</p>
    </div>
  );
}
