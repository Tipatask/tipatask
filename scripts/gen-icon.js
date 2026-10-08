'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const SIZE = 1024;
// Website wordmark delta (`Tip<span class="tt-brand-delta">Δ</span>Task`):
// Literata ExtraBold (800) U+0394 outline in font units (1000 UPM, y-down,
// baseline at y=0), pre-skewed by x -= 0.25 * y — the browser's synthetic
// italic, since website/public/css/marketing.css loads only upright Literata
// but styles .tt-brand-delta `font-style: italic`. Two contours: outer Δ and
// its triangular counter (opposite winding, so nonzero fill leaves it open).
const DELTA_PATH = 'M667 0L29 0L31.25 -73L426.25 -701L620.25 -701L701 -72L667 0Z'
  + 'M444.75 -551L187.5 -126L478.5 -126L447.75 -551L444.75 -551Z';
const DELTA_BBOX = { minX: 29, minY: -701, maxX: 701, maxY: 0 };
const FILL = '#14b8a6'; // website --tt-teal
const CONTENT = 780; // longest glyph side on the 1024 canvas
const SCALE = CONTENT / Math.max(DELTA_BBOX.maxX - DELTA_BBOX.minX, DELTA_BBOX.maxY - DELTA_BBOX.minY);
const OFFSET_X = SIZE / 2 - ((DELTA_BBOX.minX + DELTA_BBOX.maxX) / 2) * SCALE;
const OFFSET_Y = SIZE / 2 - ((DELTA_BBOX.minY + DELTA_BBOX.maxY) / 2) * SCALE;

const rootDir = path.resolve(__dirname, '..');
const assetsDir = path.join(rootDir, 'assets');
const pngPath = path.join(assetsDir, 'icon.png');
const icnsPath = path.join(assetsDir, 'icon.icns');
const icoPath = path.join(assetsDir, 'icon.ico');
const faviconSvgPath = path.join(assetsDir, 'favicon.svg');
const faviconIcoPath = path.join(assetsDir, 'favicon.ico');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <path
    d="${DELTA_PATH}"
    fill="${FILL}"
    fill-rule="nonzero"
    transform="translate(${OFFSET_X} ${OFFSET_Y}) scale(${SCALE})"
  />
</svg>`;

// Favicon (TPT289): same Δ outline, but a tight square viewBox straight in font
// units — the app icon's padding would shrink the glyph to a few pixels in a
// 16px browser tab. build.js copies both outputs into dist/.
const round2 = (n) => Math.round(n * 100) / 100;
const FAVICON_SIDE = round2(Math.max(DELTA_BBOX.maxX - DELTA_BBOX.minX, DELTA_BBOX.maxY - DELTA_BBOX.minY) * 1.04);
const FAVICON_X = round2((DELTA_BBOX.minX + DELTA_BBOX.maxX) / 2 - FAVICON_SIDE / 2);
const FAVICON_Y = round2((DELTA_BBOX.minY + DELTA_BBOX.maxY) / 2 - FAVICON_SIDE / 2);
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${FAVICON_X} ${FAVICON_Y} ${FAVICON_SIDE} ${FAVICON_SIDE}">`
  + `<path d="${DELTA_PATH}" fill="${FILL}" fill-rule="nonzero"/></svg>\n`;

function getIcoSize(byte) {
  return byte === 0 ? 256 : byte;
}

function filterIcoSizes(icoBuffer, sizes) {
  const count = icoBuffer.readUInt16LE(4);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    const entryOffset = 6 + i * 16;
    const width = getIcoSize(icoBuffer[entryOffset]);
    const height = getIcoSize(icoBuffer[entryOffset + 1]);
    entries.push({
      width,
      height,
      entry: icoBuffer.subarray(entryOffset, entryOffset + 16),
      bytesInRes: icoBuffer.readUInt32LE(entryOffset + 8),
      imageOffset: icoBuffer.readUInt32LE(entryOffset + 12),
    });
  }

  const selected = sizes.map((size) => {
    const entry = entries.find((candidate) => candidate.width === size && candidate.height === size);
    if (!entry) throw new Error(`ICO output missing ${size}x${size} icon`);
    return entry;
  });

  const headerSize = 6 + selected.length * 16;
  const header = Buffer.alloc(headerSize);
  icoBuffer.copy(header, 0, 0, 4);
  header.writeUInt16LE(selected.length, 4);

  const images = [];
  let imageOffset = headerSize;
  selected.forEach((entry, index) => {
    const entryOffset = 6 + index * 16;
    entry.entry.copy(header, entryOffset);
    header.writeUInt32LE(entry.bytesInRes, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    images.push(icoBuffer.subarray(entry.imageOffset, entry.imageOffset + entry.bytesInRes));
    imageOffset += entry.bytesInRes;
  });

  return Buffer.concat([header, ...images]);
}

async function main() {
  fs.mkdirSync(assetsDir, { recursive: true });

  const pngBuffer = await sharp(Buffer.from(svg))
    .resize(SIZE, SIZE)
    .png()
    .toBuffer();

  const icnsBuffer = png2icons.createICNS(pngBuffer, png2icons.BICUBIC, 0);
  if (!icnsBuffer) throw new Error('Failed to create ICNS icon');

  const icoBuffer = png2icons.createICO(pngBuffer, png2icons.BICUBIC, 0, false, true);
  if (!icoBuffer) throw new Error('Failed to create ICO icon');
  // TPT563: Windows picks 24px for the small taskbar and 64px at 125–150% DPI; a
  // missing frame is downscaled from the next size or left blank.
  const filteredIcoBuffer = filterIcoSizes(icoBuffer, [256, 64, 48, 32, 24, 16]);

  const faviconPngBuffer = await sharp(Buffer.from(faviconSvg))
    .resize(256, 256)
    .png()
    .toBuffer();
  const faviconIcoBuffer = png2icons.createICO(faviconPngBuffer, png2icons.BICUBIC, 0, false, true);
  if (!faviconIcoBuffer) throw new Error('Failed to create favicon ICO');

  fs.writeFileSync(pngPath, pngBuffer);
  fs.writeFileSync(icnsPath, icnsBuffer);
  fs.writeFileSync(icoPath, filteredIcoBuffer);
  fs.writeFileSync(faviconSvgPath, faviconSvg);
  fs.writeFileSync(faviconIcoPath, filterIcoSizes(faviconIcoBuffer, [48, 32, 16]));

  console.log(`Wrote ${path.relative(rootDir, pngPath)}`);
  console.log(`Wrote ${path.relative(rootDir, icnsPath)}`);
  console.log(`Wrote ${path.relative(rootDir, icoPath)}`);
  console.log(`Wrote ${path.relative(rootDir, faviconSvgPath)}`);
  console.log(`Wrote ${path.relative(rootDir, faviconIcoPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
