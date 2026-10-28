// The head's front door: what a browser gets at GET / (proxy.ts rewrites here when text/html is preferred over
// application/json; everything else at / gets the describe JSON, RFC §7.5). The masthead, what this head is, the
// way in, and the describe document's facts in words, so the JSON stays discoverable from the page.

import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { Button } from '@/components/ui/button';
import { db } from '../../db/client';
import { changeCounter } from '../../db/schema';
import { describeHead } from '../../lib/describe';
import { DOCS_URL } from '../../lib/front-door';
import { defaultHead } from '../../lib/heads';
import { NAME } from '../../lib/masthead';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: { absolute: NAME } };

const TIERS: Record<string, string> = { core: 'core', extended: 'extended', other: 'other types' };

export default async function FrontDoor() {
  const owner = await defaultHead(db());
  const [counter] = owner ? await db().select({ seq: changeCounter.seq }).from(changeCounter).where(eq(changeCounter.headId, owner)) : [];
  const d = owner ? describeHead(owner, counter?.seq ?? 0) : null;
  const link = 'underline decoration-border underline-offset-2 hover:decoration-foreground';

  return (
    <main className="mx-auto min-h-dvh max-w-xl px-4 py-12 min-[900px]:py-20">
      <h1 className="font-serif text-masthead-sm font-semibold tracking-editorial min-[900px]:text-masthead">{NAME}</h1>
      <p className="mt-4 text-body text-foreground">
        A personal head for the Personal Brief Card Protocol. Your agents and tools send it cards: things they made, things
        they noticed, and questions only you can answer. It folds them into one brief a day, and records every decision you
        make, so each producer can act on it.
      </p>

      <Button asChild className="mt-6">
        <Link href="/signin">Sign in</Link>
      </Button>

      <ul className="mt-8 space-y-2 text-body">
        <li>
          <Link href="/brief" className={link}>The brief</Link> <span className="text-muted-foreground">— for the owner, once signed in</span>
        </li>
        <li>
          <a href={DOCS_URL} className={link} rel="noopener">The protocol documentation</a> <span className="text-muted-foreground">— {new URL(DOCS_URL).host}</span>
        </li>
        <li>
          <Link href="/connect" className={link}>Connect a producer</Link> <span className="text-muted-foreground">— the head’s URL, owner id, and a first card</span>
        </li>
        <li>
          <a href="/api/openapi.json" className={link}>This head’s API</a> <span className="text-muted-foreground">— /api/openapi.json</span>
        </li>
      </ul>

      <section className="mt-12 border-t pt-4" aria-labelledby="describe">
        <h2 id="describe" className="text-meta font-semibold uppercase tracking-meta text-muted-foreground">What producers see at GET /</h2>
        {d ? (
          <table className="mt-2 w-full text-lead" data-describe>
            <tbody className="divide-y">
              <Row name="Owner id" note="what a producer sends as to_person" value={<code>{d.owner}</code>} />
              <Row name="Protocol" value={<code>{d.protocol}</code>} />
              <Row name="Extensions" value={d.extensions.length ? d.extensions.map((e) => <code key={e} className="mr-2">{e}</code>) : 'none (the core alone)'} />
              <Row name="Mermaid" note="diagram tiers drawn" value={d.render.mermaid.map((t) => TIERS[t] ?? t).join(', ') || 'none'} />
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-lead text-muted-foreground">This deployment serves several heads: a producer sends its token to GET / to learn its own.</p>
        )}
        <p className="mt-2 text-meta text-muted-foreground">
          The same facts, as JSON, at GET / for any request that does not prefer text/html: a producer, or <code>curl</code>.
        </p>
      </section>
    </main>
  );
}

function Row({ name, note, value }: { name: string; note?: string; value: React.ReactNode }) {
  return (
    <tr>
      <th scope="row" className="py-1.5 pr-4 text-left align-top font-normal text-muted-foreground">
        {name}
        {note && <span className="block text-meta">{note}</span>}
      </th>
      <td className="py-1.5 align-top text-foreground">{value}</td>
    </tr>
  );
}
