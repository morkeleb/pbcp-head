'use client';

// A producer's name in Settings → Producers, edited in place: tap it, type, Enter or leaving the field saves, Escape puts
// it back. A producer with no name shows its root. The name is display only (PATCH /api/me/settings/producers/{id}
// { name }); the root never changes.

import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export const PRODUCER_NAME_MAX = 60;

export function ProducerName({ name, root, disabled, onSave }: { name: string | null; root: string; disabled: boolean; onSave: (name: string) => Promise<void> }) {
  const shown = name ?? root;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Escape ends the edit; the blur that follows must not save.
  const done = useRef(false);

  const start = () => {
    done.current = false;
    setValue(shown);
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    done.current = true;
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    if (done.current) return;
    const next = value.trim();
    if (next === shown) return cancel();
    if (next.length === 0 || [...next].length > PRODUCER_NAME_MAX) {
      setError(`A name is 1 to ${PRODUCER_NAME_MAX} characters.`);
      return;
    }
    done.current = true;
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
      setError(null);
    } catch (e) {
      done.current = false;
      setError(e instanceof Error ? e.message : 'the name was not saved');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button type="button" className={cn('max-w-full text-left font-medium underline-offset-4 hover:underline disabled:no-underline', !name && 'text-foreground')} onClick={start} disabled={disabled} aria-label={`Rename ${shown}`} data-producer-name>
        {shown}
      </button>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <input
        autoFocus
        value={value}
        maxLength={PRODUCER_NAME_MAX + 10}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void save()}
        disabled={saving}
        aria-label={`Name for ${root}`}
        aria-invalid={error !== null}
        className="w-full max-w-72 rounded-md border border-input bg-background px-2 py-0.5 font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-producer-name-input
      />
      {error && <span className="text-lead font-normal text-destructive" role="alert">{error}</span>}
    </span>
  );
}
