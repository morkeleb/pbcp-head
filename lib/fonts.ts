// The two typefaces (globals.css): Newsreader for editorial text (masthead, day headings, card titles), Inter for
// everything else. next/font self-hosts them at build time, so the page CSP's font-src 'self' holds.

import { Inter, Newsreader } from 'next/font/google';

export const interfaceFont = Inter({ subsets: ['latin'], variable: '--font-interface', display: 'swap' });

export const editorialFont = Newsreader({ subsets: ['latin'], variable: '--font-editorial', display: 'swap', weight: ['500', '600'] });
