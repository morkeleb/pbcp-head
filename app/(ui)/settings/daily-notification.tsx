'use client';

// Settings → Devices: a device's daily brief notification (lib/push/daily.ts). On the device in hand, a switch and a
// quarter-hour time in its timezone; turning it on asks for permission, subscribes the service worker with the head's
// VAPID key (GET /api/push/key) and stores the subscription (POST /api/me/settings/push). On another device it is shown,
// not changed: a subscription is made by the device that receives it.
//
// iPhone and iPad: Web Push reaches a web app only once it is installed to the Home Screen and opened from there, so in
// Safari the switch is off with that said.

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { api } from '../client';

export interface DailyNotificationState {
  enabled: boolean;
  time: string;
  subscribed: boolean;
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

export function DailyNotification({ deviceId, current, state, online, onChanged, onError }: {
  deviceId: string;
  current: boolean;
  state: DailyNotificationState;
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

  const patch = async (n: Partial<Pick<DailyNotificationState, 'enabled' | 'time'>>) =>
    failIfRefused(await api(`/api/me/settings/devices/${encodeURIComponent(deviceId)}`, { method: 'PATCH', body: { daily_notification: n } }));

  const turnOn = async () => {
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
    await patch({ enabled: true });
  };

  // Off: the daily notification is the only one there is yet, so the subscription goes too. (When immediate-urgency
  // cards notify, the subscription stays while any of them is on.)
  const turnOff = async () => {
    await patch({ enabled: false });
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    await sub?.unsubscribe();
    await failIfRefused(await api('/api/me/settings/push', { method: 'DELETE' }));
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

  const on = state.enabled && (state.subscribed || !current);
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
            : state.enabled && !state.subscribed
              ? 'The push service dropped this device’s subscription: turn it on again.'
              : 'At this time in this device’s timezone, once a day.';

  return (
    <div className="basis-full pt-1" data-daily-notification={deviceId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Daily brief notification"
          disabled={!editable}
          onClick={() => void act(on ? turnOff : turnOn)}
          className={cn('relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50', on ? 'border-primary bg-primary' : 'border-input bg-muted')}
          data-notify-switch
        >
          <span className={cn('absolute top-0.5 size-3.5 rounded-full bg-background shadow transition-[left]', on ? 'left-[18px]' : 'left-0.5')} />
        </button>
        <span className="text-lead">Daily brief notification</span>
        <select aria-label="Notification time" className="ml-auto rounded-md border border-input bg-background px-2 py-1 text-body text-foreground disabled:opacity-50" value={state.time} disabled={!editable}
          onChange={(e) => void act(() => patch({ time: e.target.value }))} data-notify-time>
          {TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <p className={cn('pt-1 text-lead', support === 'ios-not-installed' || support === 'denied' ? 'text-destructive' : 'text-muted-foreground')} data-notify-note>{note}</p>
    </div>
  );
}
