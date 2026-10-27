// The two typefaces (globals.css): Newsreader for editorial text (masthead, day headings, card titles), Inter for
// everything else. The files are checked in under app/fonts (Latin subsets of the variable fonts, from Google Fonts,
// SIL OFL 1.1), so a build needs no network; next/font serves them from the app, so the page CSP's font-src 'self'
// holds. Same weights as before: Inter over its whole range, Newsreader at 500 and 600.

import localFont from 'next/font/local';

export const interfaceFont = localFont({
  src: '../app/fonts/inter-latin-wght.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-interface',
  display: 'swap',
});

export const editorialFont = localFont({
  src: '../app/fonts/newsreader-latin-wght.woff2',
  weight: '500 600',
  style: 'normal',
  variable: '--font-editorial',
  display: 'swap',
});
