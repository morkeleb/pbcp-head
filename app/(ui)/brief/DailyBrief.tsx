'use client';

// DailyBrief: the paragraph each day opens with (RFC 0.6 §8; lib/brief/fold.ts), as the reference UI shows it. The iOS
// app mirrors this component. The paragraph is made of the day's card leads, each linked to its card, and rendered by
// the head; this renders nothing on a day with no paragraph, rather than a sentence that could be printed any day.

export interface DailyBriefProps {
  /** "Today's brief", or the day's name for an earlier day. */
  heading: string;
  /** Safe inline HTML from the head: the `head:daily` card's lead, or `daily_paragraph.html`. */
  html: string | null;
  /** Until the day's nightly card exists: the same fold, made now. */
  soFar?: boolean;
  compact?: boolean;
}

export function DailyBrief({ heading, html, soFar, compact }: DailyBriefProps) {
  if (!html) return null;
  return (
    <section aria-label={heading} className={compact ? 'py-2' : 'py-3'}>
      <h2 className="flex items-center gap-2 font-serif text-day font-semibold tracking-editorial">
        {heading}
        {soFar && (
          <span className="flex items-center gap-1.5 font-sans text-lead font-normal tracking-normal text-muted-foreground">
            <span aria-hidden>·</span> so far today
          </span>
        )}
      </h2>
      <p
        className="daily-paragraph mt-1 max-w-[68ch] text-body text-foreground [&_a]:underline [&_a]:decoration-border [&_a]:underline-offset-2 hover:[&_a]:decoration-foreground"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </section>
  );
}
