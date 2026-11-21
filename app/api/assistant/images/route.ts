import { readFile } from 'node:fs/promises';
import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const base = () => process.env.COMFYUI_URL?.replace(/\/$/, '');
const workflowPath = () => process.env.COMFYUI_WORKFLOW_PATH;
const imageWorkflowPath = () => process.env.COMFYUI_IMG2IMG_WORKFLOW_PATH;
const imageEnabled = () => !!imageWorkflowPath();
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
    return NextResponse.json({ configured: text.available, reason: text.reason, img2img: reference.available });
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
    if (length > 11 * 1024 * 1024) return json('Request exceeds 11 MB.', 413);
    const form = await req.formData();
    const prompt = form.get('prompt');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) return json('Enter a prompt of up to 4000 characters.', 400);
    const file = form.get('image');
    if (file && (!(file instanceof File) || !imageEnabled())) return json('Base images are not enabled.', 400);
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
