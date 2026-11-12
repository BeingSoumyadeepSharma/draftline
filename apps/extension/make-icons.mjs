/**
 * Draws the extension's icon (a white "D" on a rounded green square) as PNGs
 * at 16, 48 and 128 pixels, with no image libraries. Run once with
 * `node make-icons.mjs`; the results are committed in icons/.
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const GREEN = [47, 93, 80];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Coverage of a point in 0..1 units: background square, or the letter. */
function inRoundedSquare(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
/** A D shape: a straight left part, then a half circle centred at x = join. */
function inD(x, y, left, top, bottom, join) {
  const radius = (bottom - top) / 2;
  if (y < top || y > bottom || x < left) return false;
  if (x <= join) return true;
  return (x - join) ** 2 + (y - 0.5) ** 2 <= radius * radius;
}
// Outer and inner curves share a centre, so the stroke is even all round.
const inLetter = (x, y) =>
  inD(x, y, 0.28, 0.22, 0.78, 0.46) && !inD(x, y, 0.41, 0.35, 0.65, 0.46);

function icon(size) {
  const samples = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (inRoundedSquare(x, y)) {
            bg++;
            if (inLetter(x, y)) fg++;
          }
        }
      }
      const total = samples * samples;
      const white = bg ? fg / bg : 0;
      const offset = 1 + px * 4;
      for (let c = 0; c < 3; c++) {
        row[offset + c] = Math.round(GREEN[c] * (1 - white) + 255 * white);
      }
      row[offset + 3] = Math.round((255 * bg) / total);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) writeFileSync(`icons/icon-${size}.png`, icon(size));
console.log("wrote icons/icon-16.png, icon-48.png, icon-128.png");
