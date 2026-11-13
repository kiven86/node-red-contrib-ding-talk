'use strict';

/**
 * 生成一张示例图片 test/demo.png（不依赖任何图形库）。
 * 用途：给「发送图片」节点一个开箱可用的本地文件示例。
 *
 *   node test/make-demo.js
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const W = 480;
const H = 220;

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 极简像素画：浅灰底 + 三条横向色块 + 底部小方格，看起来像一张报表缩略图
const bg = [246, 248, 250];
const bars = [
  { y: 40, h: 26, w: 320, color: [75, 139, 245] },
  { y: 86, h: 26, w: 240, color: [90, 169, 230] },
  { y: 132, h: 26, w: 400, color: [160, 200, 240] },
];

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  const rowStart = y * (W * 3 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    let color = bg;
    for (const b of bars) {
      if (y >= b.y && y < b.y + b.h && x >= 40 && x < 40 + b.w) color = b.color;
    }
    const o = rowStart + 1 + x * 3;
    raw[o] = color[0];
    raw[o + 1] = color[1];
    raw[o + 2] = color[2];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'demo.png');
fs.writeFileSync(out, png);
console.log(`已生成 ${out}  ${W}x${H}  ${(png.length / 1024).toFixed(1)}KB`);
