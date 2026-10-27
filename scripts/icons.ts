// pnpm icons — the web app's PNG icons (public/icons) from app/icon.svg. Run after changing the icon.
//   icon-192.png, icon-512.png   the icon as drawn: rounded, transparent corners (manifest, `any`)
//   maskable-512.png             full-bleed, the glyph inside the 80% safe zone (manifest, `maskable`)
//   apple-touch-icon.png         180×180, full-bleed and opaque: iOS rounds it itself and shows transparency as black

import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const svg = readFileSync('app/icon.svg', 'utf8').trim();
const BLUE = /fill="(#[0-9a-f]{6})"/i.exec(svg)![1]!;
// The glyph alone: the icon without its rounded background.
const glyph = svg.replace(/<rect width="32" height="32"[^>]*\/>/, '');
const fullBleed = (scale: number) => {
  const pad = (32 * (1 - scale)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${BLUE}"/><g transform="translate(${pad} ${pad}) scale(${scale})">${glyph.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g></svg>`;
};

const out = async (file: string, source: string, size: number, flatten = false) => {
  let img = sharp(Buffer.from(source), { density: 72 * (size / 32) * 2 }).resize(size, size);
  if (flatten) img = img.flatten({ background: BLUE });
  await img.png({ compressionLevel: 9 }).toFile(`public/icons/${file}`);
  console.log(`public/icons/${file}`);
};

await out('icon-192.png', svg, 192);
await out('icon-512.png', svg, 512);
await out('maskable-512.png', fullBleed(0.8), 512, true);
await out('apple-touch-icon.png', fullBleed(0.9), 180, true);
