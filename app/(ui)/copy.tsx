'use client';

// A value with a copy control: inline (an id, a URL) or as a block (a command, a token, a link). The text stays whole and
// selectable when there is no clipboard. Settings and /connect use it.

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      // no clipboard (an insecure origin, a denied permission): the text is selectable
    }
  };
  return (
    <Button variant="ghost" size="icon-xs" aria-label={done ? `Copied ${label}` : `Copy ${label}`} onClick={() => void copy()} data-copy={label}>
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

/** A value shown whole, selectable, with a copy control. */
export function Copyable({ text, label, block = false, wrap = false }: { text: string; label: string; block?: boolean; wrap?: boolean }) {
  return block ? (
    <div className="relative rounded-md border bg-inset">
      {/* A token or a link wraps, whole and selectable; a snippet keeps its lines and scrolls. */}
      <pre className={cn('p-3 pr-10 text-[12px] leading-relaxed', wrap ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto')} data-snippet={label}>{text}</pre>
      <div className="absolute right-1.5 top-1.5"><CopyButton text={text} label={label} /></div>
    </div>
  ) : (
    <span className="flex min-w-0 items-center gap-1">
      {/* `wrap`: a URL shows whole on a phone rather than cut short. */}
      <code className={cn('min-w-0 text-body', wrap ? 'break-all' : 'truncate')} data-value={label}>{text}</code>
      <CopyButton text={text} label={label} />
    </span>
  );
}

