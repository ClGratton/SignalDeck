// Deterministic 1-bit grayscale PNG encoder for the edit mask (1 = selected -> white/255).
// Canvas toBlob() is NOT used: Brave (and other fingerprinting-resistant browsers) perturb canvas
// pixels on readback, which makes the mask non-binary and the relay rejects it ("mask not binary").
let table: Uint32Array | null = null;
function crc32(parts: Uint8Array[]): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = table[(c ^ p[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new Uint8Array([...type].map(c => c.charCodeAt(0)));
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0); out.set(t, 4); out.set(data, 8); out.set(u32(crc32([t, data])), 8 + data.length);
  return out;
}
export function encodeMaskPng(mask: Uint8Array, w: number, h: number): Blob {
  const rb = (w + 7) >> 3;
  const raw = new Uint8Array((rb + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (rb + 1) + 1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) raw[o + (x >> 3)] |= 0x80 >> (x & 7);
  }
  // zlib stream made of stored (uncompressed) deflate blocks: deterministic and dependency-free.
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78; z[1] = 0x01; let p = 2;
  for (let b = 0; b < blocks; b++) {
    const s = b * 65535, n = Math.min(65535, raw.length - s);
    z[p++] = b === blocks - 1 ? 1 : 0; z[p++] = n & 255; z[p++] = n >> 8; z[p++] = ~n & 255; z[p++] = (~n >> 8) & 255;
    z.set(raw.subarray(s, s + n), p); p += n;
  }
  let a = 1, b2 = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b2 = (b2 + a) % 65521; }
  z.set(u32(((b2 << 16) | a) >>> 0), p);
  const ihdr = new Uint8Array(13); ihdr.set(u32(w), 0); ihdr.set(u32(h), 4); ihdr[8] = 1; ihdr[9] = 0;
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Blob([sig as BlobPart, chunk('IHDR', ihdr) as BlobPart, chunk('IDAT', z) as BlobPart, chunk('IEND', new Uint8Array(0)) as BlobPart], { type: 'image/png' });
}
