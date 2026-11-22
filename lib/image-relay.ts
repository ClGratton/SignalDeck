import { readFile } from 'node:fs/promises';

/** Fetch against the image relay with the server-side bearer token (never exposed to the browser). Server-only. */
export async function relayFetch(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  const url = process.env.COMFYUI_URL?.replace(/\/$/, '');
  if (!url) throw new Error('Image service is not configured.');
  const headers = new Headers(init.headers);
  const tokenFile = process.env.COMFYUI_TOKEN_FILE;
  const token = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : process.env.COMFYUI_TOKEN;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${url}${path}`, { ...init, headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
}
