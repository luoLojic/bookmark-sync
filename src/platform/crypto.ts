/**
 * platform/crypto.ts —— domain 层所需的哈希与随机源的真实实现。
 *
 * domain/ 必须保持纯函数，哈希与随机数由调用方注入（方案 1.2 红线一）。
 * 本文件就是那个「调用方」侧的实现，engine 在每轮同步开始时注入。
 *
 * 为什么自己实现 SHA-256 而不用 crypto.subtle.digest：
 *   digest() 返回 Promise，而 domain/hash.ts 的 HashFn 是同步签名。若改为异步，
 *   merge / diff 全链路都要变成 async，纯函数的可测试性和可推理性都会变差。
 *   SHA-256 本体约 60 行、零依赖，代价远低于把整个 domain 层异步化。
 *   正确性由 test/platform/crypto.test.ts 与 WebCrypto 逐项交叉校验保证。
 */

/** SHA-256 轮常量：前 64 个素数立方根小数部分的前 32 位（FIPS 180-4）。 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

const utf8 = new TextEncoder();

/** SHA-256 原始摘要（32 字节）。SigV4 需要对任意字节做哈希与 HMAC。 */
export function sha256Bytes(msg: Uint8Array): Uint8Array {

  // 填充：0x80 一字节 + 若干 0 + 8 字节大端比特长度，补齐到 64 字节整数倍。
  const bitLen = msg.length * 8;
  const withPad = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
  withPad.set(msg);
  withPad[msg.length] = 0x80;
  // 长度字段用两个 32 位写入，避免 BigInt 与 2^32 位以上的精度问题。
  const padView = new DataView(withPad.buffer);
  padView.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);
  padView.setUint32(withPad.length - 4, bitLen >>> 0, false);

  // 初始哈希值：前 8 个素数平方根小数部分的前 32 位。
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = padView.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, i) => view.setUint32(i * 4, word, false));
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** SHA-256，输入按 UTF-8 编码，输出 64 位小写十六进制。 */
export function sha256Hex(text: string): string {
  return toHex(sha256Bytes(utf8.encode(text)));
}

export function sha256HexBytes(bytes: Uint8Array): string {
  return toHex(sha256Bytes(bytes));
}

/**
 * HMAC-SHA256（RFC 2104）。SigV4 的签名密钥派生链全靠它。
 * 自己实现的理由同 SHA-256：crypto.subtle 是异步的，而调用方需要同步签名。
 */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = sha256Bytes(k);

  const padded = new Uint8Array(blockSize);
  padded.set(k);

  const inner = new Uint8Array(blockSize + data.length);
  const outer = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padded[i]! ^ 0x36;
    outer[i] = padded[i]! ^ 0x5c;
  }
  inner.set(data, blockSize);
  outer.set(sha256Bytes(inner), blockSize);
  return sha256Bytes(outer);
}

export function hmacSha256Text(key: Uint8Array, text: string): Uint8Array {
  return hmacSha256(key, utf8.encode(text));
}

/**
 * 注入给 domain/hash.ts 的 HashFn。
 * 带算法前缀，与需求 5.2 的 `"contentHash": "sha256:..."` 一致。
 */
export function contentHasher(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

/** 密码学随机十六进制串。用于 writerNonce（需求 5.2）与设备名后缀。 */
export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 注入给 domain/guid.ts 的随机源，签名与 Math.random 一致。
 * 底层用 getRandomValues 而非 Math.random —— GUID 终身不变，碰撞代价高。
 */
export function randomSource(): () => number {
  return () => {
    const buf = crypto.getRandomValues(new Uint32Array(1));
    return buf[0]! / 0x100000000;
  };
}
