// Copies the onnxruntime-web runtime (wasm backend only) into public/vendor/ort so it is
// self-hosted (same origin, no CDN). Runs before dev/build; output is gitignored.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const src = join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist');
const dst = join(process.cwd(), 'public', 'vendor', 'ort');
if (!existsSync(src)) { console.warn('[vendor-ort] onnxruntime-web not installed; skipping'); process.exit(0); }
mkdirSync(dst, { recursive: true });
for (const f of ['ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) cpSync(join(src, f), join(dst, f));
console.log('[vendor-ort] copied wasm runtime to public/vendor/ort');
