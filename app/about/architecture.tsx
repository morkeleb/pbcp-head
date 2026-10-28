// The front door's architecture figure: producers → HTTP PUT + polling sync → the head → you and the executors. Inline
// SVG in the app's tokens, drawn as the pbcp site's home-page diagram is (vendor/pbcp/site/src/pages/index.astro): hairline
// boxes with 6 px corners, a serif title over muted lines, mono labels on the connections, open chevron arrowheads. A
// wide figure from 560 px, a tall one below, as on the site.

import { Bot, CalendarDays, Mail, SquareCheck, Target, Terminal, type LucideIcon } from 'lucide-react';

const PRODUCERS: Array<[string, LucideIcon]> = [
  ['Mail', Mail],
  ['Calendar', CalendarDays],
  ['Agents', Bot],
  ['GoalPath', Target],
  ['Todoist', SquareCheck],
  ['Scripts', Terminal],
];

const LABEL =
  'Producers (mail, calendar, agents, GoalPath, Todoist, scripts) send cards to your head with HTTP PUT and read your decisions back by polling sync. The head receives, organises, presents and records them; you review, decide and act, and executors do the work you hand them.';

function Marker({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0,0.5 L7,4 L0,7.5" className="fill-none stroke-muted-foreground" strokeWidth={1} />
      </marker>
    </defs>
  );
}

const box = 'fill-card stroke-border';
const title = 'fill-foreground font-serif text-[17px] font-medium';
const sub = 'fill-muted-foreground font-sans text-[11.5px]';
const code = 'fill-muted-foreground font-mono text-[11px]';
const arrow = 'fill-none stroke-muted-foreground';

export function Architecture() {
  return (
    <figure className="m-0" data-architecture>
      {/* Wide: producers in a row of six, the head across, you and the executors side by side. */}
      <svg className="hidden h-auto w-full min-[560px]:block" viewBox="0 0 440 330" role="img" aria-label={LABEL}>
        <Marker id="arch-w" />
        <text x="0.5" y="12" className="fill-foreground font-sans text-[12px] font-medium">Producers</text>
        {PRODUCERS.map(([name, Icon], i) => (
          <g key={name} transform={`translate(${0.5 + i * 73.5}, 22.5)`}>
            <rect width="66" height="62" rx="6" className={box} />
            <Icon x={24} y={11} width={18} height={18} strokeWidth={1.5} className="stroke-foreground" />
            <text x="33" y="48" textAnchor="middle" className={sub}>{name}</text>
          </g>
        ))}
        <line x1="210" y1="94" x2="210" y2="134" className={arrow} markerStart="url(#arch-w)" markerEnd="url(#arch-w)" />
        <text x="222" y="118" className={code}>HTTP PUT + polling sync</text>
        <g transform="translate(0.5, 142.5)">
          <rect width="439" height="70" rx="6" className={box} />
          <text x="219.5" y="30" textAnchor="middle" className={title}>Your head</text>
          <text x="219.5" y="52" textAnchor="middle" className={sub}>receives · organises · presents · records</text>
        </g>
        <line x1="110" y1="214" x2="110" y2="250" className={arrow} markerEnd="url(#arch-w)" />
        <line x1="330" y1="214" x2="330" y2="250" className={arrow} markerEnd="url(#arch-w)" />
        <g transform="translate(0.5, 256.5)">
          <rect width="200" height="66" rx="6" className={box} />
          <text x="100" y="28" textAnchor="middle" className={title}>You</text>
          <text x="100" y="49" textAnchor="middle" className={sub}>review · decide · act</text>
        </g>
        <line x1="208" y1="289" x2="232" y2="289" className={arrow} markerStart="url(#arch-w)" markerEnd="url(#arch-w)" />
        <g transform="translate(239.5, 256.5)">
          <rect width="200" height="66" rx="6" className={box} />
          <text x="100" y="28" textAnchor="middle" className={title}>Executors</text>
          <text x="100" y="49" textAnchor="middle" className={sub}>do the work</text>
        </g>
      </svg>
      {/* Tall: producers in two rows of three, then down the page. */}
      <svg className="mx-auto block h-auto w-full max-w-[328px] min-[560px]:hidden" viewBox="0 0 328 470" role="img" aria-label={LABEL}>
        <Marker id="arch-t" />
        <text x="0.5" y="12" className="fill-foreground font-sans text-[12px] font-medium">Producers</text>
        {PRODUCERS.map(([name, Icon], i) => (
          <g key={name} transform={`translate(${0.5 + (i % 3) * 109.5}, ${22.5 + Math.floor(i / 3) * 70})`}>
            <rect width="104" height="62" rx="6" className={box} />
            <Icon x={43} y={11} width={18} height={18} strokeWidth={1.5} className="stroke-foreground" />
            <text x="52" y="48" textAnchor="middle" className={sub}>{name}</text>
          </g>
        ))}
        <line x1="164" y1="164" x2="164" y2="206" className={arrow} markerStart="url(#arch-t)" markerEnd="url(#arch-t)" />
        <text x="174" y="189" className={code}>HTTP PUT + polling sync</text>
        <g transform="translate(0.5, 214.5)">
          <rect width="327" height="78" rx="6" className={box} />
          <text x="163.5" y="32" textAnchor="middle" className={title}>Your head</text>
          <text x="163.5" y="55" textAnchor="middle" className={sub}>receives · organises · presents · records</text>
        </g>
        <line x1="82" y1="294" x2="82" y2="334" className={arrow} markerEnd="url(#arch-t)" />
        <line x1="246" y1="294" x2="246" y2="334" className={arrow} markerEnd="url(#arch-t)" />
        <g transform="translate(0.5, 340.5)">
          <rect width="154" height="76" rx="6" className={box} />
          <text x="77" y="32" textAnchor="middle" className={title}>You</text>
          <text x="77" y="54" textAnchor="middle" className={sub}>review · decide · act</text>
        </g>
        <line x1="158" y1="378" x2="170" y2="378" className={arrow} markerStart="url(#arch-t)" markerEnd="url(#arch-t)" />
        <g transform="translate(173.5, 340.5)">
          <rect width="154" height="76" rx="6" className={box} />
          <text x="77" y="32" textAnchor="middle" className={title}>Executors</text>
          <text x="77" y="54" textAnchor="middle" className={sub}>do the work</text>
        </g>
      </svg>
    </figure>
  );
}
