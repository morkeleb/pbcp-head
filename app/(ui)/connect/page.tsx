// GET /connect: how a producer connects to this head. Public (no sign-in; it reads nothing private), under the shared
// masthead. The facts from the description (§7.5), the three values and a curl with <token> as the only placeholder, and
// the links; the same as /llms.txt, from the same code (lib/connect.ts).

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { db } from '../../../db/client';
import { assistantAccess, connectLinks, connectSnippets, OWNER, pairCurl, pairingSteps, TOKEN, type Link as DocLink } from '../../../lib/connect';
import { connectFacts, headOrigin } from '../../../lib/settings/head';
import { PageRow } from '../chrome';
import { Copyable } from '../copy';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Connect a producer' };

/** The origin this request came in on, for when WEBAUTHN_ORIGIN does not name one. */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  return `${h.get('x-forwarded-proto') ?? 'http'}://${host}`;
}

export default async function ConnectPage() {
  const origin = headOrigin(await requestOrigin());
  const facts = await connectFacts(db(), origin);
  const { config, curl, curlRoot } = connectSnippets(facts, TOKEN);
  const links = connectLinks(origin);
  const link = 'underline decoration-border underline-offset-2 hover:decoration-foreground';

  return (
    <>
      <PageRow title="Connect" />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-4 min-[900px]:px-6" data-connect-page>
        <p className="text-body">
          A producer sends cards to this head with a token bound to one root. Tokens are minted by this head’s owner on the{' '}
          <Link href="/settings" className={link}>settings page</Link>: either the owner gives you one, or gives you a pairing code and you mint your own.
        </p>
        {facts.owner === null && (
          <p className="mt-2 text-lead text-muted-foreground" data-multi-head>
            This deployment serves several heads: <code>{OWNER}</code> stands for the owner id, which the owner gives you from their settings page.
          </p>
        )}

        <Section title="This head">
          <table className="w-full text-body" data-connect-facts>
            <tbody className="divide-y border-y">
              <Row name="API base"><Copyable text={facts.api} label="api" wrap /></Row>
              <Row name="Owner id"><Copyable text={facts.owner ?? OWNER} label="owner" /></Row>
              <Row name="Protocol"><code className="text-body">{facts.protocol}</code></Row>
              <Row name="Extensions">{facts.extensions.length ? facts.extensions.map((e) => <code key={e} className="mr-2 text-body">{e}</code>) : 'none'}</Row>
            </tbody>
          </table>
        </Section>

        <Section title="Pairing: a token with a code">
          <ol className="list-decimal space-y-1 pl-5 text-body" data-pairing-steps>
            {pairingSteps(facts.api).map((step) => <li key={step}>{step}</li>)}
          </ol>
          <div className="mt-3"><Copyable text={pairCurl(facts.api)} label="pair" block /></div>
          <p className="pt-2 text-lead text-muted-foreground">
            A wrong, expired or used code is <code>400 invalid_code</code>, and every outstanding code is then void: ask for a new one. A root that already has a token is <code>409 root_taken</code>: choose another and use the same code.
          </p>
        </Section>

        <Section title="The three values">
          <p className="pb-2 text-lead text-muted-foreground">Every producer needs these; replace <code>{TOKEN}</code> with the token the owner gave you.</p>
          <table className="w-full text-body" data-producer-config>
            <tbody className="divide-y border-y">
              {Object.entries(config).map(([k, v]) => (
                <Row key={k} name={<code className="text-lead text-muted-foreground">{k}</code>}><Copyable text={v} label={k} wrap /></Row>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="A first card">
          <p className="pb-2 text-lead text-muted-foreground">
            With curl. The card is the specification’s example, whose id is under the root <code>{curlRoot}</code>: the command needs a token for that root (§12).
          </p>
          <Copyable text={curl} label="curl" block />
        </Section>

        <Section title="Use this head from an assistant">
          <p className="pb-2 text-lead text-muted-foreground">
            For an assistant acting for the owner (reading the brief, recording decisions), not a producer: the owner’s MCP server. It signs in with OAuth (PKCE and dynamic
            registration); the owner allows the app with their passkey and can sign it out in Settings → Devices.
          </p>
          <table className="w-full text-body" data-assistant>
            <tbody className="divide-y border-y">
              <Row name="MCP URL"><Copyable text={assistantAccess(origin).url} label="mcp" wrap /></Row>
              <Row name="Tools">{assistantAccess(origin).tools.map((t) => <code key={t} className="mr-2 text-body">{t}</code>)}</Row>
            </tbody>
          </table>
        </Section>

        <Section title="Read more">
          <LinkList links={links.head} />
          <h4 className="pb-1 pt-4 text-meta font-semibold uppercase tracking-meta text-muted-foreground">Connector setup</h4>
          <LinkList links={links.connectors} inline />
        </Section>
      </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pt-8">
      <h3 className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Row({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <tr>
      <th scope="row" className="w-40 py-2 pr-3 text-left align-middle font-normal text-muted-foreground">{name}</th>
      <td className="max-w-0 py-2">{children}</td>
    </tr>
  );
}

function LinkList({ links, inline = false }: { links: DocLink[]; inline?: boolean }) {
  return (
    <ul className={inline ? 'flex flex-wrap gap-x-4 gap-y-1 text-body' : 'space-y-1 text-body'} data-links>
      {links.map((l) => (
        <li key={l.href}>
          <a href={l.href} className="underline decoration-border underline-offset-2 hover:decoration-foreground" {...(l.href.startsWith('http') && !l.href.includes('/api/openapi.json') ? { target: '_blank', rel: 'noopener' } : {})}>
            {l.label}
          </a>
          {l.note && <span className="text-lead text-muted-foreground"> — {l.note}</span>}
        </li>
      ))}
    </ul>
  );
}
