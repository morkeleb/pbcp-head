// Mermaid fences (RFC §3.1): sanitising, type and tier, and the caption. Pure functions; drawing is ./draw.

export const CORE = ['flowchart', 'sequenceDiagram', 'stateDiagram-v2', 'gantt', 'timeline', 'pie', 'xychart-beta'] as const;
export const EXTENDED = ['classDiagram', 'erDiagram', 'quadrantChart', 'sankey-beta', 'mindmap', 'gitGraph', 'journey'] as const;

/** The tiers this head draws, as `GET /` reports them (§7.5). Other types fall back (§3.1 allows MAY). */
export const RENDERED_TIERS = ['core', 'extended'] as const;

export type Tier = 'core' | 'extended' | 'other';

/** Types are matched exactly as §3.1 lists them; an alias such as `graph` is Other. */
export function tierOf(type: string): Tier {
  if ((CORE as readonly string[]).includes(type)) return 'core';
  if ((EXTENDED as readonly string[]).includes(type)) return 'extended';
  return 'other';
}

export const MAX_FENCES = 8; // §3.1: MUST render up to 8 per card
export const MAX_FENCE_BYTES = 16 * 1024; // §3.1: a larger fence MAY be treated as unsupported

const URL_LOADING = /https?:|url\(|@import/i;

/**
 * §3.1 "Declarative only": removes `click` lines, `%%{init}%%` directives that load a URL or set
 * `htmlLabels`, and any front-matter `config:` (mermaid's other way to set the same options); keeps a
 * front-matter `title`. Records what it removed in `stripped`.
 */
export function sanitiseFence(src: string, stripped: Set<string>): string {
  let out = src.replace(/\r\n?/g, '\n');

  // Front matter: keep the title, drop config (which can set htmlLabels or themeCSS just like init).
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(out);
  if (fm) {
    const title = /^title:\s*(.+)$/m.exec(fm[1]!)?.[1];
    if (/^config:/m.test(fm[1]!)) {
      if (/htmlLabels/.test(fm[1]!)) stripped.add('htmlLabels');
      if (URL_LOADING.test(fm[1]!) || /htmlLabels/.test(fm[1]!)) stripped.add('init');
    }
    out = (title ? `---\ntitle: ${title}\n---\n` : '') + out.slice(fm[0].length);
  }

  out = out.replace(/%%\{[\s\S]*?\}%%\n?/g, (directive) => {
    const labels = /htmlLabels/.test(directive);
    if (labels) stripped.add('htmlLabels');
    if (labels || URL_LOADING.test(directive)) {
      stripped.add('init');
      return '';
    }
    return directive;
  });

  return out
    .split('\n')
    .filter((line) => {
      if (/^\s*click\s/.test(line)) {
        stripped.add('click');
        return false;
      }
      return true;
    })
    .join('\n');
}

const body = (src: string) => src.replace(/^---\n[\s\S]*?\n---\n?/, '');

/** The diagram type label: the first word of the first line that is not blank, a comment or a directive. */
export function diagramType(src: string): string {
  for (const line of body(src).split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('%%')) continue;
    return t.split(/\s+/)[0]!.replace(/:$/, '');
  }
  return '';
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

/** The fence's title, for the caption (§3.1 Presentation): front matter, `pie title …`, or a `title …` line. */
export function diagramTitle(src: string): string | null {
  const fm = /^---\n[\s\S]*?^title:\s*(.+)$[\s\S]*?\n---/m.exec(src);
  if (fm) return unquote(fm[1]!);
  for (const line of body(src).split('\n')) {
    const m = /^\s*(?:pie\s+)?title\s+(.+)$/.exec(line);
    if (m) return unquote(m[1]!);
  }
  return null;
}
