/**
 * 生成扩展图标 PNG。零依赖：自己写最小 PNG 编码器（zlib 来自 node 标准库）。
 * 图案：圆角方块底 + 书签形状 + 同步箭头缺口，纯手写像素，无字体依赖。
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'icons');

const BG = [37, 99, 235]; // 蓝
const FG = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** rgba: Uint8Array，长度 w*h*4 */
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
      : Buffer.from(rgba).copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 以浮点坐标（0..1）定义图形，按 4x 超采样抗锯齿。
 * inside(x, y) → null 表示透明，否则返回 [r,g,b]
 */
function render(size, inside) {
  const S = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          const c = inside(u, v);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      if (a > 0) {
        const cov = a / n / 255;
        out[i] = Math.round(r / (a / 255));
        out[i + 1] = Math.round(g / (a / 255));
        out[i + 2] = Math.round(b / (a / 255));
        out[i + 3] = Math.round(cov * 255);
      }
    }
  }
  return out;
}

/** 圆角矩形：整个画布内缩 2%，圆角半径 22% */
function inRoundRect(u, v, m = 0.02, r = 0.22) {
  const x0 = m,
    x1 = 1 - m,
    y0 = m,
    y1 = 1 - m;
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

/** 书签形状（旗标带 V 形缺口）：x∈[0.30,0.70], y∈[0.20,0.78] */
function inBookmark(u, v) {
  if (u < 0.3 || u > 0.7 || v < 0.2 || v > 0.78) return false;
  // 底部 V 形缺口
  const notchTop = 0.6;
  if (v > notchTop) {
    const t = (v - notchTop) / (0.78 - notchTop);
    const half = 0.2 * (1 - t);
    return Math.abs(u - 0.5) >= 0.2 - 0.2 * t ? false : Math.abs(u - 0.5) > half ? true : false;
  }
  return true;
}

/** 环形同步箭头：半径 0.36 的圆环，留两个缺口，端点带箭头三角 */
function inSyncRing(u, v) {
  const dx = u - 0.5,
    dy = v - 0.5;
  const d = Math.hypot(dx, dy);
  if (Math.abs(d - 0.375) > 0.045) return false;
  const ang = Math.atan2(dy, dx); // -π..π
  // 左右各留一个缺口（书签进出处）
  const deg = (ang * 180) / Math.PI;
  if (deg > -115 && deg < -65) return false;
  if (deg > 65 && deg < 115) return false;
  return true;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const detail = size >= 32;
    const rgba = render(size, (u, v) => {
      if (!inRoundRect(u, v)) return null;
      if (inBookmark(u, v)) return FG;
      if (detail && inSyncRing(u, v)) return FG;
      return BG;
    });
    const png = encodePng(size, size, rgba);
    await writeFile(path.join(outDir, `icon${size}.png`), png);
    console.log(`icons/icon${size}.png  ${png.length} B`);
  }
}

await main();
