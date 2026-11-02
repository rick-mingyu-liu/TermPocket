// Builds every TermPocket brand asset from the geometry below.
//
//   node brand/build.mjs
//
// Needs Node 18+ and `rsvg-convert` (librsvg: `brew install librsvg`). Nothing
// is installed into the repo for it. The SVGs it writes are the source of
// truth; the PNG and ICO files are rasterised from them, never hand-edited.
//
// Coordinates are in the 1254 px space of the approved reference icon, so a
// shape can be checked against it directly. The wordmark is outlines of an
// open-licence typeface, converted to paths: see src/wordmark.json and README.md.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ROOT);
const PUBLIC = path.join(REPO, 'frontend', 'public');

// ---------------------------------------------------------------- colours

const LIGHT = {
  pocket: '#023C27', // deep forest green, front of the pocket
  back: '#01331E', // inside of the pocket, visible above the lip
  loop: '#023C27',
  card: '#DCF9DD', // pale mint calendar card
  header: '#87E09E', // calendar header
  mint: '#DAF8DC', // loop outlines and seam
  word: '#023A25',
};
// On a dark page the deep green pocket all but disappears (1.4:1 against
// gray-900), so the dark variant lifts it to 3.3:1+. Everything else is kept.
const DARK = { ...LIGHT, pocket: '#1E7A4E', back: '#186842', word: '#DCF9DD' };
const MONO = { pocket: '#000000', back: '#000000', loop: '#000000', card: '#FFFFFF', header: '#000000', mint: '#FFFFFF', word: '#000000' };

// ---------------------------------------------------------------- geometry

const CX = 626.5; // axis of symmetry
const L = 131;
const R = 1122;
const r1 = (n) => +n.toFixed(1);
const mirror = (x) => r1(2 * CX - x);

const BACK = `M${L} 470C${L} 380 195 326 262 322Q${CX} 300 ${mirror(262)} 322C${mirror(195)} 326 ${R} 380 ${R} 470V700H${L}Z`;

const CARD = { left: CX - 388.5, right: CX + 388.5, top: 170, radius: 105, headerBottom: 325 };
const cardPath = (bottom) => {
  const { left, right, top, radius: r } = CARD;
  return `M${left} ${bottom}V${top + r}A${r} ${r} 0 0 1 ${left + r} ${top}H${right - r}A${r} ${r} 0 0 1 ${right} ${top + r}V${bottom}Z`;
};

// Front of the pocket: the lip is a shallow curve, the sides straight, and
// the bottom two cubics meeting in a softly rounded point.
const FRONT = `M${L} 445Q${CX} 607 ${R} 445V775C${R} 970 ${mirror(400)} 1130 ${r1(CX + 60)} 1164Q${CX} 1183 ${r1(CX - 60)} 1164C400 1130 ${L} 970 ${L} 775Z`;

const LOOP_X = [CX - 185, CX + 185];

// Seam: dashes spaced evenly by arc length along a quadratic.
function seamPath(count, dash) {
  const p0 = [185, 562];
  const c = [CX, 708];
  const p2 = [1068, 562];
  const at = (t) => [0, 1].map((k) => (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * c[k] + t * t * p2[k]);
  const N = 1000;
  const pts = Array.from({ length: N + 1 }, (_, i) => at(i / N));
  const acc = [0];
  for (let i = 1; i <= N; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const pointAt = (s) => {
    let i = acc.findIndex((a) => a >= s);
    if (i === -1) i = N; // s overshot the end by a rounding error
    if (i < 1) i = 1;
    const t = (s - acc[i - 1]) / (acc[i] - acc[i - 1]);
    return pts[i - 1].map((v, k) => r1(v + t * (pts[i][k] - v)));
  };
  const gap = (acc[N] - count * dash) / (count - 1);
  let d = '';
  for (let k = 0; k < count; k++) {
    const a = pointAt(k * (dash + gap));
    const b = pointAt(k * (dash + gap) + dash);
    d += `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
  }
  return d;
}

// `small` is the 16–48 px variant: four heavier stitches instead of eight,
// thicker loop outlines, and no separate inside shade, all of which would
// otherwise blur into one smudge at favicon size. The silhouette is identical.
function iconShapes(c, { small = false, pocketClass = '' } = {}) {
  const cls = pocketClass ? ` class="${pocketClass}"` : '';
  const loopStroke = small ? 30 : 15;
  const loops = LOOP_X.map((x) => {
    const w = 120 - loopStroke;
    return `<rect x="${r1(x - 60 + loopStroke / 2)}" y="${90 + loopStroke / 2}" width="${w}" height="${205 - loopStroke}" rx="${w / 2}" fill="${c.loop}" stroke="${c.mint}" stroke-width="${loopStroke}"/>`;
  });
  const seam = small ? seamPath(4, 120) : seamPath(8, 56);
  return [
    `<path${cls} fill="${small ? c.pocket : c.back}" d="${BACK}"/>`,
    `<path fill="${c.card}" d="${cardPath(560)}"/>`,
    `<path fill="${c.header}" d="${cardPath(CARD.headerBottom)}"/>`,
    ...loops,
    `<path${cls} fill="${c.pocket}" d="${FRONT}"/>`,
    `<path fill="none" stroke="${c.mint}" stroke-width="${small ? 60 : 24}" stroke-linecap="round" d="${seam}"/>`,
  ].join('\n  ');
}

// Ink bounds of the icon: x 131–1122, y 90–1174.
const ICON_BOX = { x: 131, y: 90, w: 991, h: 1084 };
const ICON_VIEWBOX = '76.5 82 1100 1100'; // square, centred, ~5% margin

const svgDoc = (viewBox, body, { title, width, height } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${width ? ` width="${width}" height="${height}"` : ''}${title ? ' role="img"' : ''}>\n  ${title ? `<title>${title}</title>\n  ` : ''}${body}\n</svg>\n`;

// ---------------------------------------------------------------- wordmark

const WORD = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'wordmark.json'), 'utf8'));

// Lockup proportions measured from the approved horizontal logo: the icon is
// 1.97x the cap height, sits 0.22 cap heights left of the T, and its centre
// is 0.08 cap heights above the centre of the capitals.
const LOCKUP = { iconPerCap: 1.97, gapPerCap: 0.22, liftPerCap: 0.08 };

function lockup(c, title) {
  const [wx, wy, ww, wh] = WORD.viewBox;
  const cap = WORD.capHeight;
  const s = (LOCKUP.iconPerCap * cap) / ICON_BOX.h; // icon scale into wordmark units
  const iconW = ICON_BOX.w * s;
  const iconH = ICON_BOX.h * s;
  const gap = LOCKUP.gapPerCap * cap;
  const capMid = WORD.baselineY - cap / 2;
  const iconTop = capMid - LOCKUP.liftPerCap * cap - iconH / 2;
  const ox = wx - gap - iconW; // icon's left edge
  const pad = 0.12 * cap;
  const x0 = ox - pad;
  const y0 = Math.min(iconTop, wy) - pad;
  const x1 = wx + ww + pad;
  const y1 = Math.max(iconTop + iconH, wy + wh) + pad;
  const t = `translate(${r1(ox - ICON_BOX.x * s)} ${r1(iconTop - ICON_BOX.y * s)}) scale(${+s.toFixed(5)})`;
  const body = `<g transform="${t}">\n  ${iconShapes(c)}\n  </g>\n  <path fill="${c.word}" d="${WORD.d}"/>`;
  const vb = [x0, y0, x1 - x0, y1 - y0].map(r1).join(' ');
  return { svg: svgDoc(vb, body, { title }), w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- output

const write = (rel, text) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const raster = (svgFile, out, w, h = w, bg) => {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['-w', String(w), '-h', String(h), svgFile, '-o', out];
  if (bg) args.unshift('-b', bg);
  execFileSync('rsvg-convert', args);
  return out;
};
// A launcher tile: solid background, icon of `height` px centred.
const tile = (c, size, iconHeight, bg) => {
  const s = iconHeight / ICON_BOX.h;
  const tx = size / 2 - (ICON_BOX.x + ICON_BOX.w / 2) * s;
  const ty = size / 2 - (ICON_BOX.y + ICON_BOX.h / 2) * s;
  const back = bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>\n  ` : '';
  return svgDoc(`0 0 ${size} ${size}`, `${back}<g transform="translate(${r1(tx)} ${r1(ty)}) scale(${+s.toFixed(5)})">\n  ${iconShapes(c)}\n  </g>`);
};
// PNG-in-ICO, the format every browser since IE11 reads.
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

// Vector sources
const files = {
  icon: write('svg/termpocket-icon.svg', svgDoc(ICON_VIEWBOX, iconShapes(LIGHT), { title: 'TermPocket' })),
  iconDark: write('svg/termpocket-icon-dark.svg', svgDoc(ICON_VIEWBOX, iconShapes(DARK), { title: 'TermPocket' })),
  iconMono: write('svg/termpocket-icon-mono.svg', svgDoc(ICON_VIEWBOX, iconShapes(MONO), { title: 'TermPocket' })),
  iconSmall: write('svg/termpocket-icon-small.svg', svgDoc(ICON_VIEWBOX, iconShapes(LIGHT, { small: true }), { title: 'TermPocket' })),
};
const logos = {
  logo: lockup(LIGHT, 'TermPocket'),
  logoDark: lockup(DARK, 'TermPocket'),
  logoMono: lockup(MONO, 'TermPocket'),
};
files.logo = write('svg/termpocket-logo.svg', logos.logo.svg);
files.logoDark = write('svg/termpocket-logo-dark.svg', logos.logoDark.svg);
files.logoMono = write('svg/termpocket-logo-mono.svg', logos.logoMono.svg);

// Transparent PNGs for web use
for (const size of [64, 128, 256, 512, 1024]) {
  raster(files.icon, path.join(ROOT, 'png', `termpocket-icon-${size}.png`), size);
  raster(files.iconDark, path.join(ROOT, 'png', `termpocket-icon-dark-${size}.png`), size);
}
raster(files.iconMono, path.join(ROOT, 'png', 'termpocket-icon-mono-512.png'), 512);
for (const h of [160, 320]) {
  for (const [key, suffix] of [['logo', ''], ['logoDark', '-dark'], ['logoMono', '-mono']]) {
    const w = Math.round((logos[key].w / logos[key].h) * h);
    raster(files[key], path.join(ROOT, 'png', `termpocket-logo${suffix}-${h}h.png`), w, h);
  }
}

// Favicons: the simplified icon at 16–48, the full one above that.
fs.mkdirSync(path.join(ROOT, 'favicon'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-'));
try {
  const fav = [16, 32, 48].map((size) => ({ size, data: fs.readFileSync(raster(files.iconSmall, path.join(tmp, `f${size}.png`), size)) }));
  fs.writeFileSync(path.join(ROOT, 'favicon', 'favicon.ico'), ico(fav));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
// favicon.svg follows the browser's colour scheme, so the pocket does not
// vanish into a dark tab strip. The ICO cannot, and keeps the light colours.
write(
  'favicon/favicon.svg',
  svgDoc(
    ICON_VIEWBOX,
    `<style>@media (prefers-color-scheme: dark) { .pocket { fill: ${DARK.pocket} } }</style>\n  ` +
      iconShapes(LIGHT, { small: true, pocketClass: 'pocket' }),
  ),
);
// The Apple touch icon is opaque: iOS fills transparency with black. The
// manifest icons keep transparency, like any other web PNG.
const touch = write('favicon/.touch.svg', tile(LIGHT, 180, 180 * 0.74, '#FFFFFF'));
try {
  raster(touch, path.join(ROOT, 'favicon', 'apple-touch-icon.png'), 180);
} finally {
  fs.rmSync(touch, { force: true });
}
raster(files.icon, path.join(ROOT, 'favicon', 'icon-192.png'), 192);
raster(files.icon, path.join(ROOT, 'favicon', 'icon-512.png'), 512);

// Copies the web app serves.
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(PUBLIC, to)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, from), path.join(PUBLIC, to));
};
copy('svg/termpocket-logo.svg', 'brand/termpocket-logo.svg');
copy('svg/termpocket-logo-dark.svg', 'brand/termpocket-logo-dark.svg');
copy('svg/termpocket-icon.svg', 'brand/termpocket-icon.svg');
copy('svg/termpocket-icon-dark.svg', 'brand/termpocket-icon-dark.svg');
for (const f of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) copy(`favicon/${f}`, f);

console.log('logo aspect', (logos.logo.w / logos.logo.h).toFixed(4), 'viewBox', logos.logo.svg.match(/viewBox="([^"]+)"/)[1]);
