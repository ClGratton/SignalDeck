import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const base = () => process.env.COMFYUI_URL?.replace(/\/$/, '');
const workflowPath = () => process.env.COMFYUI_WORKFLOW_PATH;
const imageWorkflowPath = () => process.env.COMFYUI_IMG2IMG_WORKFLOW_PATH;
const imageEnabled = () => !!imageWorkflowPath();
// Inpaint template: explicit env, else next to the img2img template (same mounted provider dir).
const inpaintWorkflowPath = () => process.env.COMFYUI_INPAINT_WORKFLOW_PATH
  || (imageWorkflowPath() ? join(dirname(imageWorkflowPath()!), 'lustify-inpaint-template.json') : undefined);
const MODES = {
  recolor: { strength: 0.55, grow: 8, blend: 28, context: 1.5 },
  replace: { strength: 0.85, grow: 8, blend: 28, context: 1.5 },
  remove: { strength: 1.0, grow: 10, blend: 28, context: 2.0 },
} as const;
const num = (v: FormDataEntryValue | null, def: number, min: number, max: number, int = false) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : def;
  if (!Number.isFinite(n)) return def;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
};
function fillInpaint(value: unknown, map: Record<string, string | number>): unknown {
  if (typeof value === 'string' && value in map) return map[value];
  if (Array.isArray(value)) return value.map(v => fillInpaint(v, map));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillInpaint(v, map)]));
  return value;
}
const json = (error: string, status: number) => NextResponse.json({ error }, { status });
function providerError(status: number) {
  if (status === 409 || status === 429) return json('The image service is busy. Please try again shortly.', status);
  if (status >= 500) return json('The image service is temporarily unavailable.', 503);
  return json('The image service could not process the request.', 502);
}

async function comfy(path: string, init?: RequestInit) {
  const url = base();
  if (!url) throw new Error('Image generation is not configured.');
  const headers = new Headers(init?.headers);
  const tokenFile = process.env.COMFYUI_TOKEN_FILE;
  const token = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : process.env.COMFYUI_TOKEN;
  if (tokenFile && !token) throw new Error('Image service token file is empty.');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${url}${path}`, { ...init, headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
}
function replaceTokens(value: unknown, prompt: string, image: string | null, seed: number): unknown {
  if (value === '{{PROMPT}}') return prompt;
  if (value === '{{IMAGE}}') return image;
  if (value === '{{SEED}}') return seed;
  if (Array.isArray(value)) return value.map(v => replaceTokens(v, prompt, image, seed));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, replaceTokens(v, prompt, image, seed)]));
  return value;
}
async function capability(path: string | undefined): Promise<{ available: boolean; reason?: string }> {
  if (!base() || !path) return { available: false, reason: 'Image generation is not configured yet.' };
  try {
    const graph = JSON.parse(await readFile(path, 'utf8')) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    const raw = JSON.stringify(graph);
    if (!raw.includes('"{{PROMPT}}"') || (path === imageWorkflowPath() && !raw.includes('"{{IMAGE}}"'))) throw new Error('invalid graph');
    const loaders = Object.values(graph).filter(node => node?.class_type && /(?:unet|checkpoint|diffusionmodel)loader/i.test(node.class_type));
    if (!loaders.length) return { available: false, reason: 'The image workflow has no supported model loader.' };
    for (const node of loaders) {
      const name = node.inputs?.unet_name ?? node.inputs?.ckpt_name ?? node.inputs?.model_name;
      if (typeof name !== 'string') throw new Error('invalid loader');
      const response = await comfy(`/object_info/${encodeURIComponent(node.class_type!)}`);
      if (!response.ok) return { available: false, reason: 'The image model loader is unavailable.' };
      const info = await response.json();
      const choices = info[node.class_type!]?.input?.required?.[node.inputs?.unet_name ? 'unet_name' : node.inputs?.ckpt_name ? 'ckpt_name' : 'model_name']?.[0];
      if (!Array.isArray(choices) || !choices.includes(name)) return { available: false, reason: 'The configured image model is not available yet.' };
    }
    return { available: true };
  } catch { return { available: false, reason: 'The image service is unavailable or its workflow is invalid.' }; }
}
async function history(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid job ID.');
  const res = await comfy(`/history/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Could not retrieve the image job.');
  return (await res.json())[id];
}
function images(record: any): Array<{filename: string; subfolder: string; type: string}> {
  return Object.values(record?.outputs ?? {}).flatMap((v: any) => Array.isArray(v?.images) ? v.images : [])
    .filter((v: any) => typeof v?.filename === 'string' && typeof v?.subfolder === 'string' && v?.type === 'output');
}
export async function GET(req: NextRequest) {
  if (!(await hasValidSession())) return json('unauthorized', 401);
  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    const text = await capability(workflowPath());
    const reference = imageEnabled() ? await capability(imageWorkflowPath()) : { available: false };
    const ip = inpaintWorkflowPath();
    const inpaint = ip && base() ? await capability(ip) : { available: false };
    return NextResponse.json({ configured: text.available, reason: text.reason, img2img: reference.available, inpaint: inpaint.available });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return json('Invalid job ID.', 400);
  try {
    const record = await history(id);
    const output = images(record);
    const index = req.nextUrl.searchParams.get('image');
    if (index !== null) {
      if (!/^\d+$/.test(index) || !output[Number(index)]) return json('Image not found.', 404);
      const item = output[Number(index)];
      const query = new URLSearchParams(item);
      const res = await comfy(`/view?${query}`);
      if (!res.ok) return json('Could not retrieve image.', 502);
      return new Response(res.body, { headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (!record) return NextResponse.json({ status: 'running' });
    if (record.status?.status_str === 'error') return NextResponse.json({ status: 'error', error: 'Image generation failed on the server.' });
    if (output.length) return NextResponse.json({ status: 'complete', count: output.length });
    return NextResponse.json({ status: record.status?.completed ? 'error' : 'running', error: record.status?.completed ? 'The workflow completed without an image.' : undefined });
  } catch { return json('Image service is unavailable.', 502); }
}
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) return json('unauthorized', 401);
  if (!base() || !workflowPath()) return json('Image generation is not configured.', 503);
  try {
    const length = Number(req.headers.get('content-length') ?? 0);
    if (length > 17 * 1024 * 1024) return json('Request exceeds 17 MB.', 413);
    const form = await req.formData();
    const prompt = form.get('prompt');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) return json('Enter a prompt of up to 4000 characters.', 400);
    const file = form.get('image');
    const mask = form.get('mask');
    if (mask) return await startInpaint(prompt.trim(), file, mask, form);
    if (file && (!(file instanceof File) || !imageEnabled())) return json('Base images are not enabled.', 400);
    if (file instanceof File && file.size > 10 * 1024 * 1024) return json('Choose a PNG, JPEG or WebP up to 10 MB.', 400);
    const ready = await capability(file instanceof File ? imageWorkflowPath() : workflowPath());
    if (!ready.available) return json(ready.reason ?? 'Image generation is unavailable.', 503);
    let image: string | null = null;
    if (file instanceof File) {
      if (file.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return json('Choose a PNG, JPEG or WebP up to 10 MB.', 400);
      const upload = new FormData();
      upload.set('image', file, `reference-${crypto.randomUUID()}.${file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'}`);
      const result = await comfy('/upload/image', { method: 'POST', body: upload });
      if (!result.ok) return providerError(result.status);
      const uploaded = await result.json();
      if (typeof uploaded.name !== 'string') throw new Error('bad upload response');
      image = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    }
    const raw = await readFile(image ? imageWorkflowPath()! : workflowPath()!, 'utf8');
    if (!raw.includes('"{{PROMPT}}"') || (image && !raw.includes('"{{IMAGE}}"'))) throw new Error('invalid workflow');
    const workflow = replaceTokens(JSON.parse(raw), prompt.trim(), image, Math.floor(Math.random() * 2 ** 32));
    const result = await comfy('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow }) });
    if (!result.ok) return providerError(result.status);
    const payload = await result.json();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.prompt_id ?? '')) throw new Error('invalid response');
    return NextResponse.json({ id: payload.prompt_id });
  } catch { return json('The image service is temporarily unavailable.', 503); }
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
async function startInpaint(prompt: string, file: FormDataEntryValue | null, mask: FormDataEntryValue, form: FormData) {
  const ip = inpaintWorkflowPath();
  if (!ip) return json('Inpainting is not configured.', 503);
  if (!(file instanceof File) || !(mask instanceof File)) return json('Send both an image and a mask.', 400);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024 || file.size < 100) return json('Choose a PNG, JPEG or WebP up to 12 MB.', 400);
  if (mask.type !== 'image/png' || mask.size > 4 * 1024 * 1024 || mask.size < 60) return json('The mask must be a PNG up to 4 MB.', 400);
  const head = new Uint8Array(await mask.slice(0, 8).arrayBuffer());
  if (!PNG_SIG.every((b, i) => head[i] === b)) return json('The mask must be a PNG.', 400);
  const ready = await capability(ip);
  if (!ready.available) return json(ready.reason ?? 'Inpainting is unavailable.', 503);
  const modeKey = String(form.get('mode') ?? 'recolor');
  const d = MODES[(modeKey in MODES ? modeKey : 'recolor') as keyof typeof MODES];
  const strength = num(form.get('strength'), d.strength, 0.05, 1);
  const grow = num(form.get('grow'), d.grow, 0, 64, true);
  const blend = num(form.get('blend'), d.blend, 0, 128, true);
  const context = num(form.get('context'), d.context, 1, 3);
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const upload = new FormData();
  upload.set('image', file, `inpaint-${crypto.randomUUID()}.${ext}`);
  upload.set('mask', mask, `mask-${crypto.randomUUID()}.png`);
  const up = await comfy('/upload/inpaint', { method: 'POST', body: upload });
  if (up.status === 400) {
    const reason = (await up.text().catch(() => '')).replace(/^invalid image or mask:?\s*/, '').slice(0, 200).replace(/[^ -~]/g, '');
    return json(`The image or mask was rejected${reason ? `: ${reason}` : ''} (need 64-3072 px, at least one selected pixel, mask matching the image).`, 400);
  }
  if (!up.ok) return providerError(up.status);
  const handles = await up.json();
  if (typeof handles.image !== 'string' || typeof handles.mask !== 'string') throw new Error('bad upload response');
  const raw = await readFile(ip, 'utf8');
  const workflow = fillInpaint(JSON.parse(raw), {
    '{{PROMPT}}': prompt, '{{SEED}}': Math.floor(Math.random() * 2 ** 32), '{{IMAGE}}': handles.image, '{{MASK}}': handles.mask,
    '{{STRENGTH}}': strength, '{{GROW}}': grow, '{{BLEND}}': blend, '{{CONTEXT}}': context,
  });
  const result = await comfy('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow }) });
  if (!result.ok) return providerError(result.status);
  const payload = await result.json();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.prompt_id ?? '')) throw new Error('invalid response');
  return NextResponse.json({ id: payload.prompt_id });
}
