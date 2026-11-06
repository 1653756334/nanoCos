/**
 * 纯 TypeScript 零依赖的 FIPS 180-4 标准增量 SHA-256 哈希计算器。
 * 内存恒定占用仅 64 字节缓冲区，支持任意分片 chunk 增量喂入（update）。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class StreamingSHA256 {
  private h: Uint32Array;
  private block: Uint8Array;
  private blockLen: number;
  private bytesHashed: number;
  private w: Uint32Array;

  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.bytesHashed = 0;
    this.w = new Uint32Array(64);
  }

  /**
   * 增量传入任意体积的数据切片
   */
  update(data: Uint8Array): void {
    let offset = 0;
    const len = data.length;
    this.bytesHashed += len;

    if (this.blockLen > 0) {
      const needed = 64 - this.blockLen;
      if (len >= needed) {
        this.block.set(data.subarray(0, needed), this.blockLen);
        this.processBlock(this.block);
        this.blockLen = 0;
        offset = needed;
      } else {
        this.block.set(data, this.blockLen);
        this.blockLen += len;
        return;
      }
    }

    while (offset + 64 <= len) {
      this.processBlock(data.subarray(offset, offset + 64));
      offset += 64;
    }

    if (offset < len) {
      this.block.set(data.subarray(offset), 0);
      this.blockLen = len - offset;
    }
  }

  private processBlock(block: Uint8Array): void {
    const w = this.w;
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const s0 =
        ((w15 >>> 7) | (w15 << 25)) ^
        ((w15 >>> 18) | (w15 << 14)) ^
        (w15 >>> 3);
      const w2 = w[i - 2];
      const s1 =
        ((w2 >>> 17) | (w2 << 15)) ^
        ((w2 >>> 19) | (w2 << 13)) ^
        (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];
    let e = this.h[4];
    let f = this.h[5];
    let g = this.h[6];
    let h = this.h[7];

    for (let i = 0; i < 64; i++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
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

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }

  /**
   * 完成填充并产出最终的 64 位十六进制 SHA-256 字符串
   */
  digest(): string {
    const totalBits = this.bytesHashed * 8;
    this.block[this.blockLen++] = 0x80;

    if (this.blockLen > 56) {
      while (this.blockLen < 64) {
        this.block[this.blockLen++] = 0x00;
      }
      this.processBlock(this.block);
      this.blockLen = 0;
    }

    while (this.blockLen < 56) {
      this.block[this.blockLen++] = 0x00;
    }

    const view = new DataView(this.block.buffer, this.block.byteOffset, 64);
    const high = Math.floor(totalBits / 0x100000000);
    const low = totalBits >>> 0;
    view.setUint32(56, high, false);
    view.setUint32(60, low, false);
    this.processBlock(this.block);

    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += this.h[i].toString(16).padStart(8, '0');
    }
    return hex;
  }
}
