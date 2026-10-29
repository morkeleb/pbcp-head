// The front door: what a browser gets at GET / (proxy.ts rewrites here when text/html is preferred over
// application/json; everything else at / gets the describe JSON, RFC §7.5, unchanged). The one page that may use product
// language (CLAUDE.md). It shows the product, Brief, with the brief's own components on the demo head
// (lib/demo/replay.ts), rendered here on the server so the page works without JavaScript, and holds no signed-in data:
// a visitor who is signed in on this device is sent on to the brief (SignedIn).
//
//   masthead · hero (what a head is, and the brief itself) · the problem / the solution (the architecture figure) ·
//   the same card on four views · request an invite · footer

import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Layers, MessagesSquare, Puzzle, TimerOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { db } from '../../db/client';
import { demoHead, DEMO_TIMEZONE, type DemoHead } from '../../lib/demo/replay';
import { DEPLOY_GUIDE_URL, DOCS_URL, GITHUB_URL } from '../../lib/front-door';
import { NAME, timeOfDay } from '../../lib/masthead';
import { Architecture } from './architecture';
import { HeroBrief, SameCard } from './demo';
import { InviteForm } from './invite-form';
import { SignedIn } from './signed-in';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: { absolute: NAME },
  description: 'Brief: one place where your tools and agents bring you what they need from you, and every decision you make goes back to them.',
};

const PROBLEMS: Array<[ReactNode, string, string]> = [
  [<Layers key="i" />, 'Fragmented context', 'What matters is spread across a dozen inboxes and dashboards.'],
  [<TimerOff key="i" />, 'Interrupted focus', 'Every tool asks for you on its own schedule.'],
  [<MessagesSquare key="i" />, 'Lost decisions', 'What you decided, and why, lives nowhere you can find again.'],
  [<Puzzle key="i" />, 'One-off integrations', 'Every tool speaks its own language, so nothing connects.'],
];

const link = 'underline decoration-border underline-offset-4 hover:decoration-foreground';
const eyebrow = 'text-meta font-semibold uppercase tracking-meta text-muted-foreground';

function dateline(date: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: DEMO_TIMEZONE }).format(new Date()));
  return `${day} · ${timeOfDay(hour)}`;
}

export default async function FrontDoor({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const requested = (await searchParams).invite === 'requested';
  let head: DemoHead | null = null;
  try {
    head = await demoHead(db());
  } catch (e) {
    console.error('the front door’s demo brief could not be made', e);
  }
  const line = head ? dateline(head.date) : '';
  // Named here, in one locale, so the demo reads the same before and after it hydrates.
  const name = (date: string, word: string) => `${word} · ${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))}`;
  const names = head ? { [head.date]: name(head.date, 'Today'), [head.tomorrow.date]: name(head.tomorrow.date, 'Tomorrow') } : {};

  return (
    <div className="min-h-dvh bg-background text-foreground" id="top">
      <SignedIn />
      <header className="border-b">
        <div className="mx-auto flex max-w-[1100px] items-center gap-6 px-4 py-4 min-[900px]:px-6">
          <Link href="/" className="font-serif text-masthead-sm font-semibold tracking-editorial">{NAME}</Link>
          <nav className="hidden items-center gap-5 text-lead text-muted-foreground min-[900px]:flex" aria-label="Site">
            <a href="#top" className="text-foreground">Overview</a>
            <a href={DOCS_URL} className="hover:text-foreground">Protocol</a>
            <Link href="/connect" className="hover:text-foreground">Docs</Link>
            <a href={GITHUB_URL} className="inline-flex items-center gap-1 hover:text-foreground">GitHub <ArrowUpRight className="size-3.5" aria-hidden /></a>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-lead text-muted-foreground min-[560px]:inline" data-invite-only>Invite only</span>
            <Button asChild size="sm" variant="outline">
              <a href="#invite">Request an invite</a>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto grid max-w-[1100px] grid-cols-[minmax(0,1fr)] gap-10 px-4 py-12 min-[900px]:px-6 min-[1100px]:grid-cols-[minmax(0,1fr)_576px] min-[1100px]:items-start min-[1100px]:py-16">
          <div className="min-[1100px]:pt-6">
            <p className={eyebrow}>Your personal head</p>
            <h1 className="mt-4 font-serif text-[38px] font-semibold leading-[1.08] tracking-editorial min-[560px]:text-[48px]">
              Your day, unified.
              <br />
              Across all your tools.
            </h1>
            <p className="mt-6 max-w-[34rem] text-[16px] leading-relaxed text-muted-foreground">
              Brief is your personal head: the one place your mail, calendar, project tools and agents send what they need from
              you — what they made, what they noticed, and the decisions only you can make. Each morning it folds them into one
              brief, and every decision you make goes straight back to the tool that asked. Built on the{' '}
              <a href={DOCS_URL} className={`text-foreground ${link}`}>Personal Brief Card Protocol</a>.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Button asChild>
                <a href="#invite">Request an invite</a>
              </Button>
              <a href={DEPLOY_GUIDE_URL} className={`text-lead text-muted-foreground ${link}`}>Or run it yourself today</a>
            </div>
          </div>
          {head ? (
            <HeroBrief head={head} names={names} dateline={line} />
          ) : (
            <p className="rounded-lg border p-6 text-lead text-muted-foreground">The example brief is being drawn; reload in a moment.</p>
          )}
        </section>

        {/* The problem / the solution */}
        <section className="border-t">
          <div className="mx-auto grid max-w-[1100px] grid-cols-[minmax(0,1fr)] gap-12 px-4 py-14 min-[900px]:grid-cols-2 min-[900px]:px-6">
            <div>
              <p className={eyebrow}>The problem</p>
              <h2 className="mt-3 font-serif text-[30px] font-semibold leading-tight tracking-editorial">Your tools don’t work together.</h2>
              <p className="mt-4 max-w-[30rem] text-body text-muted-foreground">
                Your mail, calendar, project tools and assistants all know something you need. None of them knows what you need,
                when you need it, or what you decided last time.
              </p>
              <ul className="mt-8 space-y-6" data-problems>
                {PROBLEMS.map(([icon, name, text]) => (
                  <li key={name} className="flex gap-4">
                    <span className="grid size-10 flex-none place-items-center rounded-md border text-foreground [&_svg]:size-[18px] [&_svg]:stroke-[1.5]" aria-hidden>{icon}</span>
                    <span>
                      <span className="block text-body font-medium text-foreground">{name}</span>
                      <span className="block text-lead text-muted-foreground">{text}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className={eyebrow}>The solution</p>
              <h2 className="mt-3 font-serif text-[30px] font-semibold leading-tight tracking-editorial">One head every tool can talk to.</h2>
              <p className="mt-4 max-w-[30rem] text-body text-muted-foreground">
                Each tool sends small cards to your head over plain HTTP and reads your decisions back. Your head keeps them,
                folds them into your brief, and remembers everything you decided.
              </p>
              <div className="mt-8 rounded-lg border p-5">
                <Architecture />
              </div>
              <a href={`${DOCS_URL.replace(/\/+$/, '')}/rfc/`} className="mt-4 inline-flex items-center gap-1 text-lead text-primary hover:underline">
                Read the protocol <ArrowRight className="size-3.5" aria-hidden />
              </a>
            </div>
          </div>
        </section>

        {/* The same card, any view */}
        {head && (
          <section className="border-t">
            <div className="mx-auto max-w-[1100px] px-4 py-14 min-[900px]:px-6">
              <p className={eyebrow}>See it in action</p>
              <h2 className="mt-3 font-serif text-[30px] font-semibold leading-tight tracking-editorial">The same card. Any device. Any view.</h2>
              <p className="mt-4 max-w-[40rem] text-body text-muted-foreground">
                Brief fits your screen: a timeline on your phone, a broadsheet on your desk. The same cards and the same actions,
                in the layout that suits where you are. These are the app’s own views, on the same example cards as above.
              </p>
              <div className="mt-8">
                <SameCard head={head} names={names} dateline={line} />
              </div>
            </div>
          </section>
        )}

        {/* Request an invite */}
        <section className="border-t" id="invite">
          <div className="mx-auto max-w-[1100px] px-4 py-14 min-[900px]:px-6">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6 rounded-lg border p-6 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,420px)] min-[900px]:items-center min-[900px]:p-8">
              <div>
                <p className={eyebrow}>Invite only</p>
                <h2 className="mt-3 font-serif text-[28px] font-semibold leading-tight tracking-editorial">Request an invite.</h2>
                <p className="mt-3 text-body text-muted-foreground">
                  The hosted Brief is invite-only for now. Leave your address and we’ll write when there’s a place for you.
                  Self-hosting works today: <a href={DEPLOY_GUIDE_URL} className={`text-foreground ${link}`}>the deploy guide</a>.
                </p>
              </div>
              <div>
                <InviteForm requested={requested} />
                <p className="mt-2 text-meta text-muted-foreground">Used only to answer your request.</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-8 text-lead text-muted-foreground min-[900px]:px-6">
          <span className="font-serif text-[18px] font-semibold tracking-editorial text-foreground">{NAME}</span>
          <a href={DOCS_URL} className="hover:text-foreground">Personal Brief Card Protocol</a>
          <nav className="flex items-center gap-5 min-[560px]:ml-auto" aria-label="Footer">
            <a href={DOCS_URL} className="hover:text-foreground">Protocol</a>
            <Link href="/connect" className="hover:text-foreground">Docs</Link>
            <a href={GITHUB_URL} className="inline-flex items-center gap-1 hover:text-foreground">GitHub <ArrowUpRight className="size-3.5" aria-hidden /></a>
            <Link href="/signin" className="hover:text-foreground">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
