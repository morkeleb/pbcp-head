'use client';

// DailyBrief: the brief each day opens with (RFC §8; lib/brief/fold.ts), as the reference UI shows it: under one
// heading, one short paragraph per part (lib/brief/paragraph.ts): what waits, what was decided the day before, what
// mattered, and the rest counted. Each named card is its title linked to the card, an em dash and its lead ("Re:
// Offsite on the 14th — Jonas asks whether you join both days; …"), rendered by the head. The titles carry the weight,
// so a card with a weak lead can still be told apart; the leads read as quieter text. Nothing renders on a day with
// no paragraphs.

export interface DailyBriefProps {
  /** "Today's brief", or the day's name for an earlier day. */
  heading: string;
  /** Safe inline HTML from the head, one string per paragraph. */
  paragraphs: string[];
  /** Until the day's nightly card exists: the same fold, made now. */
  soFar?: boolean;
}

export function DailyBrief({ heading, paragraphs, soFar }: DailyBriefProps) {
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
        {paragraphs.map((html, i) => <p key={i} dangerouslySetInnerHTML={{ __html: html }} />)}
      </div>
    </section>
  );
}
