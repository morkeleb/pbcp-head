// The rendering profile (RFC §3.1): a card body (markdown) → safe HTML, plus the classification the
// conformance fixtures check (RenderResult). Runs on the server, once per body; nothing here is ever
// executed in a browser or on a phone.
//
//   1. CommonMark + GFM (tables, task lists) → mdast.
//   2. Raw HTML is stripped: tags removed, text kept; <script>, <style>, <iframe> go with their contents.
//   3. `mermaid` fences are lifted out, sanitised, classified by tier, and drawn (or not) through `diagram`.
//      A `fallback` image right after a fence is hidden when the fence drew, shown in its place when not.
//   4. Images: https → shown (through `imageSrc`, the head's proxy), data:image/png and sanitised
//      data:image/svg+xml → shown inline, anything else → the alt text, linked when it is http(s).
//   5. mdast → hast, links made inert-by-default (new tab, no referrer, destination host shown), and a final
//      allowlist sanitise of the whole tree.

import type { RenderedFence, RenderedImage, RenderResult } from '@pbcp/core/conformance';
import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { toHtml } from 'hast-util-to-html';
import { toText } from 'hast-util-to-text';
import { h } from 'hastscript';
import type { Code, Html, Image, Nodes, Paragraph, Parent, PhrasingContent, Root, RootContent, Text } from 'mdast';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { diagramTitle, diagramType, MAX_FENCE_BYTES, MAX_FENCES, sanitiseFence, tierOf } from './mermaid';
import { sanitiseSvg } from './svg';

export type DiagramOutcome = { status: 'render'; hash: string } | { status: 'fallback'; message: string };

export interface RenderDeps {
  /** Draws a sanitised fence (cached by content hash), or says why it cannot be drawn. */
  diagram(source: string): Promise<DiagramOutcome>;
  /** Where the browser loads an https image from; the head proxies them so no cookie is ever sent (§3.1). */
  imageSrc?(url: string): string;
  /** Where a drawn diagram is served from. */
  svgSrc?(hash: string): string;
}

export interface Visual {
  kind: 'diagram' | 'image';
  src: string;
  caption: string;
}

export interface Rendered {
  html: string;
  /** The first visual in reading order, for the brief's thumbnail (§3.1 Presentation). */
  firstVisual: Visual | null;
  result: RenderResult;
}

const STRIP_WITH_CONTENT = /^<(script|style|iframe)\b/i;

/** Raw HTML → its text: tags and comments removed, script/style/iframe removed with their contents (§3.1). */
function stripTags(html: string): string {
  return html
    .replace(/<(script|style|iframe)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/<\/?[A-Za-z][^>]*>?/g, '');
}

/** Step 2. Inline HTML arrives as separate open/close nodes, so the contents of an inline <script> are skipped too. */
function stripHtml(tree: Root, stripped: Set<string>): void {
  const walk = (parent: Parent) => {
    const out: RootContent[] = [];
    let skipping: string | null = null;
    for (const child of parent.children as RootContent[]) {
      if (child.type === 'html') {
        stripped.add('html');
        const value = (child as Html).value;
        if (skipping) {
          if (new RegExp(`</${skipping}\\s*>`, 'i').test(value)) skipping = null;
          continue;
        }
        const open = STRIP_WITH_CONTENT.exec(value);
        if (open && !new RegExp(`</${open[1]}\\s*>`, 'i').test(value)) skipping = open[1]!;
        const text = stripTags(value);
        if (text.trim() === '') continue;
        const node: Text = { type: 'text', value: text };
        const block = parent.type === 'root' || parent.type === 'blockquote' || parent.type === 'listItem';
        out.push(block ? ({ type: 'paragraph', children: [node] } satisfies Paragraph) : node);
        continue;
      }
      if (skipping && child.type === 'text') continue;
      if ('children' in child) walk(child as Parent);
      out.push(child);
    }
    parent.children = out as typeof parent.children;
  };
  walk(tree);
}

function visit(node: Nodes, fn: (node: Nodes, parent: Parent | null, index: number) => void, parent: Parent | null = null, index = 0): void {
  fn(node, parent, index);
  if ('children' in node) (node.children as Nodes[]).forEach((c, i) => visit(c, fn, node as Parent, i));
}

/** The `fallback` image that belongs to the fence at parent.children[index], if any (§3.1). */
function fallbackImageAfter(parent: Parent, index: number): { paragraph: Paragraph; image: Image } | null {
  const next = parent.children[index + 1] as RootContent | undefined;
  if (next?.type !== 'paragraph') return null;
  const first = next.children.find((c) => !(c.type === 'text' && c.value.trim() === ''));
  return first?.type === 'image' && first.alt === 'fallback' ? { paragraph: next, image: first } : null;
}

const SAFE_LINK = /^(https?:|mailto:)/i;

/** The head's own origin (WEBAUTHN_ORIGIN, where its pages are served). Links there are in-app links. */
export function ownOrigin(): string {
  try {
    return new URL(process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000').origin;
  } catch {
    return 'http://localhost:3000';
  }
}

interface Fence {
  node: Code;
  parent: Parent;
  info: RenderedFence;
  title: string | null;
  hash?: string;
  fallbackImage?: Image;
}

export async function renderMarkdown(body: string, deps: RenderDeps): Promise<Rendered> {
  const svgSrc = deps.svgSrc ?? ((hash: string) => `/api/me/svg/${hash}`);
  const imageSrc = deps.imageSrc ?? ((url: string) => url);
  const stripped = new Set<string>();
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as Root;
  stripHtml(tree, stripped);

  // Step 3: fences, in reading order.
  const fences: Fence[] = [];
  visit(tree, (node, parent) => {
    if (node.type === 'code' && node.lang === 'mermaid' && parent) {
      const source = sanitiseFence(node.value, stripped);
      fences.push({ node, parent, title: diagramTitle(source), info: { type: diagramType(source), class: 'render', source } });
    }
  });
  await Promise.all(
    fences.map(async (f, i) => {
      if (tierOf(f.info.type) === 'other') return void Object.assign(f.info, { class: 'fallback', message: 'diagram not supported' });
      if (Buffer.byteLength(f.info.source) > MAX_FENCE_BYTES) return void Object.assign(f.info, { class: 'fallback', message: 'diagram not supported: larger than 16 KiB' });
      const outcome = await deps.diagram(f.info.source);
      if (outcome.status === 'fallback') Object.assign(f.info, { class: 'fallback', message: outcome.message });
      else {
        f.hash = outcome.hash;
        // §3.1 Limits: the first eight are shown; the rest are drawn but collapsed behind a disclosure.
        if (i >= MAX_FENCES) f.info.class = 'collapsed';
      }
    }),
  );

  // Fallback images belong to the fence before them; mark them before images are classified.
  const owner = new Map<Image, Fence>();
  for (const f of fences) {
    const fb = fallbackImageAfter(f.parent, f.parent.children.indexOf(f.node as RootContent));
    if (fb) owner.set(fb.image, f);
  }

  // Step 4: images in reading order.
  const images: RenderedImage[] = [];
  const firstVisuals: Array<{ node: Nodes; visual: Visual }> = [];
  visit(tree, (node, parent, index) => {
    if (node.type !== 'image' || !parent) return;
    const img = node as Image;
    const src = img.url;
    const fence = owner.get(img);
    const rendered: RenderedImage = { alt: img.alt ?? '', src, class: 'link' };
    let shownSrc: string | null = null;
    if (/^https:/i.test(src)) shownSrc = imageSrc(src);
    else if (/^data:image\/png;base64,/i.test(src)) shownSrc = src;
    else {
      const svg = /^data:image\/svg\+xml;base64,(.*)$/i.exec(src);
      if (svg) {
        rendered.svg = sanitiseSvg(Buffer.from(svg[1]!, 'base64').toString('utf8'));
        shownSrc = `data:image/svg+xml;base64,${Buffer.from(rendered.svg).toString('base64')}`;
      }
    }
    if (shownSrc !== null) rendered.class = 'image';

    if (fence && fence.info.class !== 'fallback') {
      rendered.class = 'hidden';
      parent.children.splice(index, 1, { type: 'text', value: '' });
    } else if (fence && rendered.class === 'image') {
      fence.info.fallbackImage = true;
      fence.fallbackImage = { ...img, url: shownSrc! };
      parent.children.splice(index, 1, { type: 'text', value: '' });
    } else if (rendered.class === 'image') {
      img.url = shownSrc!;
      firstVisuals.push({ node: img, visual: { kind: 'image', src: shownSrc!, caption: img.alt ?? '' } });
    } else {
      const label: Text = { type: 'text', value: img.alt || src };
      parent.children.splice(index, 1, SAFE_LINK.test(src) ? { type: 'link', url: src, children: [label] } : label);
    }
    images.push(rendered);
  });

  // Replace each fence with its figure.
  for (const f of fences) {
    const caption = f.title ?? `${f.info.type || 'mermaid'} diagram`;
    const source = h('details', { className: ['diagram-source'] }, [h('summary', 'Source'), h('pre', [h('code', { className: ['language-mermaid'] }, f.info.source)])]);
    let figure: Element;
    let visual: Visual | null = null;
    if (f.info.class === 'fallback') {
      const shown: ElementContent[] = f.fallbackImage ? [h('img', { src: f.fallbackImage.url, alt: caption, loading: 'lazy' })] : [];
      figure = h('figure', { className: ['diagram', 'diagram-fallback'] }, [
        ...shown,
        h('figcaption', [h('strong', f.info.type || 'mermaid'), ` · ${f.info.message === 'diagram not supported' ? 'diagram not supported' : 'diagram could not be drawn'}`]),
        ...(f.info.message && f.info.message !== 'diagram not supported' ? [h('pre', { className: ['diagram-message'] }, f.info.message)] : []),
        source,
      ]);
      if (f.fallbackImage) visual = { kind: 'image', src: f.fallbackImage.url, caption };
    } else {
      const img = h('img', { className: ['diagram-svg'], src: svgSrc(f.hash!), alt: caption, loading: 'lazy' });
      const drawn = h('figure', { className: ['diagram', 'diagram-render'] }, [img, h('figcaption', caption), source]);
      figure = f.info.class === 'collapsed' ? h('details', { className: ['diagram-collapsed'] }, [h('summary', caption), drawn]) : drawn;
      visual = { kind: 'diagram', src: svgSrc(f.hash!), caption };
    }
    const slot = { type: 'html', value: '', data: { hChildren: [figure] } } as unknown as RootContent;
    (f.parent.children as RootContent[])[f.parent.children.indexOf(f.node as RootContent)] = slot;
    if (visual) firstVisuals.push({ node: slot, visual });
  }
  // Paragraphs left empty by a moved or hidden fallback image.
  visit(tree, (node) => {
    if ('children' in node) (node as Parent).children = (node as Parent).children.filter((c) => !(c.type === 'paragraph' && (c as Paragraph).children.every((x: PhrasingContent) => x.type === 'text' && x.value.trim() === '')));
  });

  // Step 5.
  const hast = (await unified().use(remarkRehype, { allowDangerousHtml: false, handlers: { html: (_s, node: Html) => (node.data as { hChildren?: Element[] } | undefined)?.hChildren?.[0] } }).use(links).use(rehypeSanitize, SCHEMA).run(tree)) as HastRoot;
  const html = toHtml(hast);

  const firstVisual = firstOf(tree, firstVisuals);
  return { html, firstVisual, result: { text: visibleText(hast), stripped: [...stripped], fences: fences.map((f) => f.info), images } };
}

/** The reading-order first of the collected visuals. */
function firstOf(tree: Root, candidates: Array<{ node: Nodes; visual: Visual }>): Visual | null {
  if (candidates.length === 0) return null;
  const order = new Map<Nodes, number>();
  let n = 0;
  visit(tree, (node) => void order.set(node, n++));
  const known = candidates.filter((c) => order.has(c.node));
  known.sort((a, b) => order.get(a.node)! - order.get(b.node)!);
  return (known[0] ?? candidates[0]!).visual;
}

/** The prose a reader sees: everything but diagram sources, which sit behind a disclosure. */
function visibleText(tree: HastRoot): string {
  const copy = structuredClone(tree);
  const prune = (node: HastRoot | Element) => {
    node.children = node.children.filter((c) => !(c.type === 'element' && (c.properties.className as string[] | undefined)?.includes('diagram-source')));
    for (const c of node.children) if (c.type === 'element') prune(c);
  };
  prune(copy);
  return toText(copy);
}

function inApp(href: string): string | null {
  try {
    const u = new URL(href);
    return u.origin === ownOrigin() && u.pathname.startsWith('/card/') ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

/**
 * Links: only http(s) and mailto keep an href; they open in a new tab without referrer, with the host shown (§12).
 * A link to one of the head's own card pages (the nightly brief's) stays in the app: a relative /card/… link.
 */
function links() {
  return (tree: HastRoot) => {
    const walk = (node: HastRoot | Element) => {
      node.children = node.children.flatMap((c): ElementContent[] => {
        if (c.type !== 'element') return [c as ElementContent];
        walk(c);
        if (c.tagName !== 'a') return [c];
        const href = String(c.properties.href ?? '');
        if (!SAFE_LINK.test(href)) return c.children;
        const own = inApp(href);
        if (own) {
          c.properties = { href: own };
          return [c];
        }
        c.properties = { href, rel: ['noopener', 'noreferrer', 'nofollow', 'ugc'], target: '_blank' };
        if (/^https?:/i.test(href)) {
          let host = '';
          try {
            host = new URL(href).host;
          } catch {
            return c.children;
          }
          return [c, h('span', { className: ['link-host'] }, ` (${host})`)];
        }
        return [c];
      });
    };
    walk(tree);
  };
}

const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: 'body-',
  tagNames: [...(defaultSchema.tagNames ?? []), 'figure', 'figcaption'],
  protocols: { ...defaultSchema.protocols, src: ['https', 'data'], href: ['http', 'https', 'mailto'] },
  attributes: {
    ...defaultSchema.attributes,
    a: ['href', 'rel', 'target'],
    img: ['src', 'alt', 'loading', 'className'],
    figure: ['className'],
    div: ['className'],
    details: ['className'],
    pre: ['className'],
    span: ['className'],
    code: [['className', /^language-./]],
  },
};
