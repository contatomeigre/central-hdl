// Desenha o ícone da Central (4 blocos arredondados sobre o anil) e grava os PNGs.
// Node puro, sem Electron. Uso: npm run icone
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
// mesmas formas de scripts/icone.svg (coordenadas em 512)
const SHAPES = [
  { x: 0, y: 0, w: 512, h: 512, r: 112, c: hex('#1f3a6e') },
  { x: 96, y: 96, w: 144, h: 144, r: 32, c: hex('#e9b72f') },
  { x: 272, y: 96, w: 144, h: 144, r: 32, c: hex('#f2f4f8') },
  { x: 96, y: 272, w: 144, h: 144, r: 32, c: hex('#f2f4f8') },
  { x: 272, y: 272, w: 144, h: 144, r: 32, c: hex('#7ea6ff') },
];

/** Cobertura (0..1) de um retângulo arredondado no ponto, com borda suavizada. */
function coverage(s, px, py) {
  const cx = Math.min(Math.max(px, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(py, s.y + s.r), s.y + s.h - s.r);
  const d = Math.hypot(px - cx, py - cy) - s.r;
  return Math.min(Math.max(0.5 - d, 0), 1);
}

function render(size) {
  const k = 512 / size;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // byte 0 = filtro "nenhum"
    for (let x = 0; x < size; x++) {
      let rgb = [0, 0, 0];
      let a = 0;
      for (const s of SHAPES) {
        const cov = coverage(s, (x + 0.5) * k, (y + 0.5) * k);
        if (!cov) continue;
        const na = cov + a * (1 - cov);
        rgb = rgb.map((v, i) => (s.c[i] * cov + v * a * (1 - cov)) / na);
        a = na;
      }
      row.set([...rgb, a * 255].map(Math.round), 1 + x * 4);
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function png(size, raw) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'build/icon.png'), render(512));
fs.writeFileSync(path.join(ROOT, 'icone.png'), render(256));
console.log('ícones gerados');
