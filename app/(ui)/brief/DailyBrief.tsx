'use client';

// DailyBrief: the brief each day opens with (RFC §8; lib/brief/fold.ts), as the reference UI shows it: under one
// heading, one short paragraph per part (lib/brief/paragraph.ts): what waits, what was decided the day before, what
// mattered, and the rest counted. Each named card is its title linked to the card, an em dash and its lead ("Re:
// Offsite on the 14th — Jonas asks whether you join both days; …"), rendered by the head. The titles carry the weight,
// so a card with a weak lead can still be told apart; the leads read as quieter text. Nothing renders on a day with
// no paragraphs.
//
// A fold (RFC 0.9 §8: decisions from one producer sharing a default action, "6 the mail reader proposes archiving") is one
// line that opens, in place, to its cards' titles, each linked to its card. It has no control of its own: each card is
// decided on its card.

import { useState } from 'react';
import { FOLD_MARK, listing, type FoldView } from '../../../lib/brief/paragraph';

export interface DailyBriefProps {
  /** "Today's brief", or the day's name for an earlier day. */
  heading: string;
  /** Safe inline HTML from the head, one string per paragraph. */
  paragraphs: string[];
  /** Until the day's nightly card exists: the same fold, made now. */
  soFar?: boolean;
  /** The folds the paragraphs mark (composeParagraphs with `foldMarks`), by their index. */
  folds?: FoldView[];
}

const MARKED = new RegExp(`${FOLD_MARK}(\\d+)${FOLD_MARK}`);

/** A paragraph's HTML, with each marked fold as a line that opens to its cards. */
function Paragraph({ html, folds }: { html: string; folds: FoldView[] }) {
  if (!html.includes(FOLD_MARK)) return <p dangerouslySetInnerHTML={{ __html: html }} />;
  // split with one group: text, index, text, index, …
  const pieces = html.split(MARKED);
  return (
    <p>
      {pieces.map((piece, i) => {
        if (i % 2 === 0) return piece ? <span key={i} dangerouslySetInnerHTML={{ __html: piece }} /> : null;
        const fold = folds.find((f) => f.index === Number(piece));
        return fold ? <Fold key={i} fold={fold} /> : null;
      })}
    </p>
  );
}

function Fold({ fold }: { fold: FoldView }) {
  const [open, setOpen] = useState(false);
  return (
    <span data-fold={fold.index} data-fold-open={open ? '' : undefined}>
      <button
        type="button"
        className="font-medium text-foreground underline decoration-dotted decoration-border underline-offset-2 hover:decoration-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {fold.phrase}
      </button>
      {open ? (
        <>
          {': '}
          <span data-fold-cards dangerouslySetInnerHTML={{ __html: listing(fold.entries.map((e) => e.text)) }} />
        </>
      ) : null}
    </span>
  );
}

export function DailyBrief({ heading, paragraphs, soFar, folds = [] }: DailyBriefProps) {
  if (paragraphs.length === 0) return null;
  return (
    <section aria-label={heading} className="py-3">
      <h2 className="flex items-center gap-2 font-serif text-day font-semibold tracking-editorial">
        {heading}
        {soFar && (
          <span className="flex items-center gap-1.5 font-sans text-lead font-normal tracking-normal text-muted-foreground">
            <span aria-hidden>·</span> so far today
          </span>
        )}
      </h2>
      <div className="daily-paragraph mt-1 max-w-[68ch] space-y-2 text-body text-muted-foreground [&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:decoration-border [&_a]:underline-offset-2 hover:[&_a]:decoration-foreground">
        {paragraphs.map((html, i) => <Paragraph key={i} html={html} folds={folds} />)}
      </div>
    </section>
  );
}
