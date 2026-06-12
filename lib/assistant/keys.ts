// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: provider API key store for the assistant.
//
// WRITE-ONLY by default: keys come in via the session-gated /api/assistant/keys
// route and persist to data/assistant-keys.json (gitignored). They never appear
// in /api/assistant/keys responses or logs. The owner CAN reveal a value via
// /api/assistant/reveal, but only after a fresh password + TOTP re-auth (see
// that route) — that is the single, deliberate read path.
//
// Environment variables always win over stored keys. OpenAI-compatible providers
// (OpenAI, DeepSeek, GLM) also accept a custom base URL, stored alongside.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { AssistantProvider } from '@/lib/assistant/types';

export interface ProviderDef {
  id: AssistantProvider;
  label: string;
  envVar: string;
  /** OpenAI-compatible providers share one adapter + a configurable base URL. */
  kind: 'anthropic' | 'gemini' | 'openai';
  /** Default API base for the openai-compatible kind. */
  defaultBaseUrl?: string;
  /** Env var that overrides the base URL (optional). */
  baseUrlEnvVar?: string;
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', kind: 'anthropic' },
  { id: 'gemini', label: 'Google Gemini', envVar: 'GEMINI_API_KEY', kind: 'gemini' },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    kind: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    envVar: 'DEEPSEEK_API_KEY',
    kind: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    baseUrlEnvVar: 'DEEPSEEK_BASE_URL',
  },
  {
    id: 'glm',
    label: 'Zhipu GLM',
    envVar: 'GLM_API_KEY',
    kind: 'openai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    baseUrlEnvVar: 'GLM_BASE_URL',
  },
];

export const providerDef = (id: AssistantProvider): ProviderDef | undefined =>
  PROVIDERS.find((p) => p.id === id);

const FILE = path.join(process.cwd(), 'data', 'assistant-keys.json');

interface StoredEntry {
  key?: string;
  baseUrl?: string;
}

let stored: Partial<Record<AssistantProvider, StoredEntry>> | null = null;

function readStored(): Partial<Record<AssistantProvider, StoredEntry>> {
  if (stored) return stored;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, unknown>;
    stored = {};
    for (const { id } of PROVIDERS) {
      const v = raw[id];
      // Legacy shape: a bare string key. New shape: { key, baseUrl }.
      if (typeof v === 'string' && v) stored[id] = { key: v };
      else if (v && typeof v === 'object') {
        const e = v as StoredEntry;
        stored[id] = {
          ...(typeof e.key === 'string' && e.key ? { key: e.key } : {}),
          ...(typeof e.baseUrl === 'string' && e.baseUrl ? { baseUrl: e.baseUrl } : {}),
        };
      }
    }
  } catch {
    stored = {};
  }
  return stored;
}

function writeStored(next: Partial<Record<AssistantProvider, StoredEntry>>): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  stored = next;
}

function envKey(provider: AssistantProvider): string | null {
  const def = providerDef(provider);
  const v = def ? process.env[def.envVar] : undefined;
  return v && v.trim() ? v.trim() : null;
}

/** The usable key for a provider — env first, then the stored file. */
export function getProviderKey(provider: AssistantProvider): string | null {
  return envKey(provider) ?? readStored()[provider]?.key ?? null;
}

/** Where the active key comes from, for the (value-free) status UI. */
export function keySource(provider: AssistantProvider): 'env' | 'stored' | null {
  if (envKey(provider)) return 'env';
  if (readStored()[provider]?.key) return 'stored';
  return null;
}

/** The effective API base URL for an openai-compatible provider. */
export function getProviderBaseUrl(provider: AssistantProvider): string | null {
  const def = providerDef(provider);
  if (!def || def.kind !== 'openai') return null;
  const envUrl = def.baseUrlEnvVar ? process.env[def.baseUrlEnvVar] : undefined;
  return (envUrl && envUrl.trim()) || readStored()[provider]?.baseUrl || def.defaultBaseUrl || null;
}

/** Validate + persist a key (and optional base URL). Returns a problem, or null. */
export function setStoredKey(
  provider: AssistantProvider,
  key: string,
  baseUrl?: string,
): string | null {
  const trimmed = key.trim();
  if (trimmed.length < 16 || trimmed.length > 400 || /\s/.test(trimmed)) {
    return 'That does not look like an API key.';
  }
  const entry: StoredEntry = { key: trimmed };
  if (baseUrl && baseUrl.trim()) {
    try {
      const u = new URL(baseUrl.trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      entry.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    } catch {
      return 'Base URL must be a valid http(s) URL.';
    }
  }
  writeStored({ ...readStored(), [provider]: entry });
  console.warn(`[assistant] stored API key updated for provider "${provider}"`);
  return null;
}

/** Remove a stored key. Env keys cannot be removed from here. */
export function clearStoredKey(provider: AssistantProvider): void {
  const next = { ...readStored() };
  delete next[provider];
  writeStored(next);
  console.warn(`[assistant] stored API key removed for provider "${provider}"`);
}
