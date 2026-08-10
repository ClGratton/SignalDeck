// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: live model catalogs for the sidebar's model menu.
//
// Lists are pulled from each provider's own models API (so the menu never goes
// stale), cached in memory and persisted to data/assistant-models.json as a
// restart fallback, with a small static list as the last resort.
//
// Price multipliers (the Copilot-style "1x / 4x" badge) are NOT in either
// models API, so they are derived the way the owner asked: a cheap background
// AI request per provider estimates them once, the result is cached on disk,
// and anything the model was not confident about simply has no badge ("–x").
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@/lib/atomic-write';
import type {
  AssistantProvider,
  AttachmentKind,
  ModelOption,
  ReasoningEffort,
} from '@/lib/assistant/types';
import { getProviderKey, getProviderBaseUrl, providerDef, PROVIDERS } from '@/lib/assistant/keys';
import { cfg } from '@/lib/service-config';

const FILE = path.join(process.cwd(), 'data', 'assistant-models.json');
const LIST_TTL_MS = 6 * 60 * 60 * 1000; // model lists: refresh every 6h
const MULT_TTL_MS = 24 * 60 * 60 * 1000; // multipliers: daily — fresh but not chatty
const FETCH_TIMEOUT_MS = 10_000;
const OPENAI_OFFICIAL_BASE = 'https://api.openai.com/v1';
const GPT_5_6_CONTEXT_WINDOW = 1_050_000;
const GPT_5_6_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** The owner-chosen model that estimates multipliers, as {provider, model}.
 *  Stored "provider:model" in the config; null when unset or its provider has
 *  no key (then we fall back to each provider pricing its own list). */
function multiplierEstimator(): { provider: AssistantProvider; model: string } | null {
  const raw = cfg('ASSISTANT_MULTIPLIER_MODEL');
  if (!raw) return null;
  const i = raw.indexOf(':');
  if (i < 0) return null;
  const provider = raw.slice(0, i) as AssistantProvider;
  const model = raw.slice(i + 1).trim();
  if (!model || !PROVIDERS.some((p) => p.id === provider) || !getProviderKey(provider)) return null;
  return { provider, model };
}

/** A model in the catalog. `contextWindow` is the provider's real token window
 *  where its API exposes it (Gemini `inputTokenLimit`, some OpenAI-compatible
 *  `/models` `context_length`); undefined ⇒ the client falls back to its
 *  heuristic. */
interface CatalogModel {
  id: string;
  label: string;
  contextWindow?: number;
}

interface CatalogEntry {
  fetchedAt: number;
  models: CatalogModel[];
}
type CatalogFile = Partial<Record<AssistantProvider, CatalogEntry>> & {
  multipliers?: { fetchedAt: number; values: Record<string, number>; by?: string };
};

const FALLBACK: Record<AssistantProvider, CatalogModel[]> = {
  anthropic: [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  ],
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: GPT_5_6_CONTEXT_WINDOW },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: GPT_5_6_CONTEXT_WINDOW },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: GPT_5_6_CONTEXT_WINDOW },
    { id: 'gpt-5.1', label: 'gpt-5.1' },
    { id: 'gpt-5', label: 'gpt-5' },
    { id: 'gpt-5-mini', label: 'gpt-5-mini' },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
    { id: 'gpt-4o', label: 'gpt-4o' },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'deepseek-chat' },
    { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
  ],
  glm: [
    { id: 'glm-4.6', label: 'glm-4.6' },
    { id: 'glm-4.5', label: 'glm-4.5' },
    { id: 'glm-4.5-air', label: 'glm-4.5-air' },
  ],
};

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

function usesOfficialOpenAiApi(provider: AssistantProvider): boolean {
  return (
    provider === 'openai' &&
    stripTrailingSlash(getProviderBaseUrl(provider) ?? '') === OPENAI_OFFICIAL_BASE
  );
}

function fallbackFor(provider: AssistantProvider): CatalogModel[] {
  return provider === 'openai' && !usesOfficialOpenAiApi(provider)
    ? FALLBACK.openai.slice(3)
    : FALLBACK[provider];
}

function isGpt56(model: string): boolean {
  return /^gpt-5\.6(?:$|-)/i.test(model);
}

/** Hosted Responses API tools are not reported by `/models`, so keep this
 * allow-list tied to families whose current OpenAI model pages explicitly
 * document the capability. Unknown and older models stay on our own tool
 * implementations instead of receiving an API tool they may reject. */
export function supportsOpenAiHostedWebSearch(model: string): boolean {
  return isGpt56(model);
}

/** GPT-5.6's model pages also document the GA built-in computer tool. The
 * actual browser remains app-owned and isolated; this only controls whether
 * the Responses request may ask for computer actions. */
export function supportsOpenAiComputerUse(model: string): boolean {
  return isGpt56(model);
}

/** Provider paths advertise only formats they actually translate. OpenAI file
 * inputs are limited to the official Responses API; compatible chat endpoints
 * must not inherit capabilities merely because their model id resembles GPT. */
export function attachmentKindsFor(
  provider: AssistantProvider,
  _model: string,
): AttachmentKind[] {
  if (provider === 'openai' && usesOfficialOpenAiApi(provider)) {
    return ['image', 'pdf', 'text', 'document', 'spreadsheet'];
  }
  if (provider === 'anthropic' || provider === 'gemini') {
    return ['image', 'pdf', 'text'];
  }
  return [];
}

/** The verified effort contract for the current OpenAI GPT-5.6 family. */
export function reasoningEffortsFor(
  provider: AssistantProvider,
  model: string,
): ReasoningEffort[] {
  return provider === 'openai' && isGpt56(model) ? [...GPT_5_6_EFFORTS] : [];
}

/** Validate an untrusted client value and represent GPT-5.6's documented
 * default explicitly. Unsupported providers/models receive no effort field. */
export function resolveReasoningEffort(
  provider: AssistantProvider,
  model: string,
  requested: unknown,
): ReasoningEffort | undefined {
  const supported = reasoningEffortsFor(provider, model);
  if (supported.length === 0) return undefined;
  if (typeof requested === 'string' && supported.includes(requested as ReasoningEffort)) {
    return requested as ReasoningEffort;
  }
  return 'medium';
}

/** The official model endpoint can be temporarily unavailable or an on-disk
 * catalog can predate a release. Keep the documented GPT-5.6 family available
 * on the official base without injecting those ids into custom-compatible APIs. */
function withDocumentedOpenAiModels(
  provider: AssistantProvider,
  models: CatalogModel[],
): CatalogModel[] {
  if (!usesOfficialOpenAiApi(provider)) return models;
  const merged = new Map<string, CatalogModel>();
  for (const model of [...FALLBACK.openai.slice(0, 3), ...models]) merged.set(model.id, model);
  return [...merged.values()];
}

let catalog: CatalogFile | null = null;
let catalogMtime = -1; // re-read on mtime change (multi-instance — see chat-store.ts)

function fileMtimeMs(): number {
  try {
    return fs.statSync(FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function readCatalog(): CatalogFile {
  const mtime = fileMtimeMs();
  if (catalog && mtime === catalogMtime) return catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(FILE, 'utf8')) as CatalogFile;
  } catch {
    catalog = {};
  }
  catalogMtime = mtime;
  return catalog;
}

function writeCatalog(next: CatalogFile): void {
  try {
    writeFileAtomic(FILE, JSON.stringify(next, null, 2));
    catalogMtime = fileMtimeMs();
  } catch {
    /* disk write is best-effort; memory cache still holds it */
  }
  catalog = next;
}

// ── Live list fetchers ───────────────────────────────────────────────────────

async function fetchAnthropicModels(key: string): Promise<CatalogModel[] | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string; display_name?: string }[] };
    const models = (body.data ?? [])
      .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
      .filter((m) => m.id.startsWith('claude'))
      .map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function fetchGeminiModels(key: string): Promise<CatalogModel[] | null> {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      models?: {
        name?: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
      }[];
    };
    const models = (body.models ?? [])
      .filter(
        (
          m,
        ): m is {
          name: string;
          displayName?: string;
          supportedGenerationMethods?: string[];
          inputTokenLimit?: number;
        } => typeof m.name === 'string',
      )
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({
        id: m.name.replace(/^models\//, ''),
        label: m.displayName ?? m.name,
        // Gemini reports the real input-token window; use it for the context wheel.
        ...(typeof m.inputTokenLimit === 'number' ? { contextWindow: m.inputTokenLimit } : {}),
      }))
      // chat models only — image/video/audio/embedding/robotics variants all
      // advertise generateContent too, so exclude them by id
      .filter(
        (m) =>
          /^gemini/.test(m.id) &&
          !/(embedding|imagen|veo|tts|aqa|image|audio|live|dialog|robotics|computer-use|thinking-exp)/.test(
            m.id,
          ),
      );
    // The registry repeats ids across aliases; keep the first of each, and drop
    // "-001"-style pins when the unpinned alias is also present (same model).
    const seen = new Set<string>();
    const unique = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    const ids = new Set(unique.map((m) => m.id));
    const deduped = unique.filter((m) => {
      const pinned = m.id.match(/^(.*)-\d{3}$/);
      return !(pinned && ids.has(pinned[1]));
    });
    return deduped.length > 0 ? deduped : null;
  } catch {
    return null;
  }
}

/** OpenAI-compatible /models listing (OpenAI, DeepSeek, GLM). Filters out
 *  non-chat models (embeddings, audio, image, moderation) by id. */
async function fetchOpenAiModels(
  provider: AssistantProvider,
  key: string,
): Promise<CatalogModel[] | null> {
  const base = getProviderBaseUrl(provider);
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string; context_length?: number }[] };
    const models = (body.data ?? [])
      .filter((m): m is { id: string; context_length?: number } => typeof m.id === 'string')
      .filter(
        (m) =>
          !/(embedding|whisper|tts|audio|image|dall-e|moderation|realtime|transcribe|search|rerank)/i.test(
            m.id,
          ),
      )
      // Some OpenAI-compatible providers (e.g. OpenRouter, a few self-hosts)
      // include `context_length`; raw OpenAI/DeepSeek/GLM usually don't (→ heuristic).
      .map((m) => ({
        id: m.id,
        label: m.id,
        ...(typeof m.context_length === 'number' ? { contextWindow: m.context_length } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/** The model list for one provider: live (cached 6h) → disk → static fallback. */
export async function listProviderModels(
  provider: AssistantProvider,
): Promise<CatalogModel[]> {
  const cat = readCatalog();
  const entry = cat[provider];
  if (entry && Date.now() - entry.fetchedAt < LIST_TTL_MS && entry.models.length > 0) {
    return withDocumentedOpenAiModels(provider, entry.models);
  }
  const key = getProviderKey(provider);
  const kind = providerDef(provider)?.kind;
  if (key) {
    const live =
      kind === 'anthropic'
        ? await fetchAnthropicModels(key)
        : kind === 'gemini'
          ? await fetchGeminiModels(key)
          : await fetchOpenAiModels(provider, key);
    if (live) {
      writeCatalog({ ...readCatalog(), [provider]: { fetchedAt: Date.now(), models: live } });
      return withDocumentedOpenAiModels(provider, live);
    }
  }
  return withDocumentedOpenAiModels(
    provider,
    entry?.models?.length ? entry.models : fallbackFor(provider),
  );
}

/** Synchronous membership check for request validation — uses whatever list is
 *  already cached (never blocks the chat request on a catalog fetch). */
export function isKnownModel(provider: AssistantProvider, model: string): boolean {
  const entry = readCatalog()[provider];
  const list = entry?.models?.length ? entry.models : fallbackFor(provider);
  return withDocumentedOpenAiModels(provider, list).some((m) => m.id === model);
}

/** Default model per provider; env overrides still win. */
export function defaultModel(provider: AssistantProvider): string {
  switch (provider) {
    case 'anthropic':
      return process.env.ASSISTANT_MODEL || 'claude-opus-4-8';
    case 'gemini':
      return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    case 'openai':
      return process.env.OPENAI_MODEL || fallbackFor(provider)[0].id;
    case 'deepseek':
      return process.env.DEEPSEEK_MODEL || FALLBACK.deepseek[0].id;
    case 'glm':
      return process.env.GLM_MODEL || FALLBACK.glm[0].id;
  }
}

// ── Price multipliers (AI-derived, cached, "–x" when unknown) ────────────────

export function getMultipliers(): Record<string, number> {
  return readCatalog().multipliers?.values ?? {};
}

let multiplierRefreshInflight = false;
let multiplierLastAttempt = 0;
const MULT_RETRY_MS = 5 * 60 * 1000; // failed attempts retry after 5 min, not weekly

/** Fire-and-forget: ask a cheap model of each configured provider to map its
 *  OWN family's ids to price multipliers (1x = Gemini 2.5 Flash pricing).
 *  Unknown ids stay absent → the menu shows "–x". Successful runs persist for
 *  a week; failed ones (rate limit, parse miss) retry on a short backoff. */
export function refreshMultipliersInBackground(): void {
  const cat = readCatalog();
  const current = cat.multipliers;
  const estimator = multiplierEstimator();
  const estimatorId = estimator ? `${estimator.provider}:${estimator.model}` : 'per-provider';
  if (multiplierRefreshInflight) return;
  // Stale if: never run, TTL expired, OR the chosen estimator changed (so a new
  // pick re-prices everything immediately instead of waiting out the day).
  const fresh =
    current &&
    Object.keys(current.values).length > 0 &&
    Date.now() - current.fetchedAt < MULT_TTL_MS &&
    (current.by ?? 'per-provider') === estimatorId;
  if (fresh) return;
  if (Date.now() - multiplierLastAttempt < MULT_RETRY_MS) return;
  multiplierLastAttempt = Date.now();
  multiplierRefreshInflight = true;

  void (async () => {
    // A chosen estimator re-prices from scratch (its view of every model). The
    // per-provider fallback merges onto whatever's there.
    const values: Record<string, number> = estimator ? {} : { ...(current?.values ?? {}) };
    let gotAny = false;
    const take = (estimated: Record<string, unknown>, validIds: Set<string>) => {
      for (const [id, mult] of Object.entries(estimated)) {
        if (validIds.has(id) && typeof mult === 'number' && mult >= 0.05 && mult <= 100) {
          values[id] = Math.round(mult * 100) / 100;
          gotAny = true;
        }
      }
    };

    try {
      if (estimator) {
        // One capable model prices EVERY provider's models in one shot — far
        // better than asking each model about its own (unknown) pricing.
        const allIds: string[] = [];
        for (const provider of PROVIDERS.map((p) => p.id)) {
          if (getProviderKey(provider)) allIds.push(...(await listProviderModels(provider)).map((m) => m.id));
        }
        const key = getProviderKey(estimator.provider)!;
        take(await estimateMultipliers(estimator.provider, key, allIds, estimator.model), new Set(allIds));
      } else {
        for (const provider of PROVIDERS.map((p) => p.id)) {
          const key = getProviderKey(provider);
          if (!key) continue;
          const ids = (await listProviderModels(provider)).map((m) => m.id);
          take(await estimateMultipliers(provider, key, ids), new Set(ids));
        }
      }
    } catch (err) {
      console.warn('[assistant] multiplier estimate failed:', (err as Error)?.message ?? err);
    }

    // Only stamp a fresh fetchedAt when something came back — otherwise the next
    // catalog fetch retries (after MULT_RETRY_MS) instead of waiting out the TTL.
    if (gotAny) {
      writeCatalog({
        ...readCatalog(),
        multipliers: { fetchedAt: Date.now(), values, by: estimatorId },
      });
    }
    multiplierRefreshInflight = false;
  })();
}

const MULT_PROMPT = (ids: string[]) =>
  `Below is a list of AI model IDs from several providers. Return ONLY a JSON object (no prose, no code fences) mapping EVERY id to its approximate API price multiplier relative to a 1x baseline, where 1x = Gemini 2.5 Flash per-token API pricing. Blend input and output pricing. Use values like 0.25, 0.5, 1, 2, 4, 10, 30. Give your BEST estimate from the model family and size even across providers — only omit an id if you genuinely have no idea what model it is.\n\n${ids.join('\n')}`;

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function estimateMultipliers(
  provider: AssistantProvider,
  key: string,
  ids: string[],
  modelOverride?: string,
): Promise<Record<string, unknown>> {
  if (ids.length === 0) return {};
  // Cheapest sibling does the pricing lookup — never the expensive models —
  // unless the owner picked a specific estimator model (modelOverride).
  if (provider === 'anthropic') {
    const model = modelOverride ?? ids.find((id) => id.includes('haiku')) ?? ids[ids.length - 1];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1000,
        messages: [{ role: 'user', content: MULT_PROMPT(ids) }],
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[assistant] anthropic multiplier request returned HTTP ${res.status}`);
      return {};
    }
    const body = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = (body.content ?? []).map((b) => b.text ?? '').join('');
    return parseJsonObject(text) ?? {};
  }
  if (providerDef(provider)?.kind === 'gemini') {
    const model =
      modelOverride ?? ids.find((id) => id.includes('flash-lite')) ?? ids.find((id) => id.includes('flash')) ?? ids[0];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: MULT_PROMPT(ids) }] }] }),
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      console.warn(`[assistant] gemini multiplier request returned HTTP ${res.status}`);
      return {};
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    return parseJsonObject(text) ?? {};
  }
  // OpenAI-compatible (OpenAI / DeepSeek / GLM): cheapest sibling answers.
  const base = getProviderBaseUrl(provider);
  if (!base) return {};
  const model =
    modelOverride ?? ids.find((id) => /mini|lite|air|flash|haiku|small|chat/.test(id)) ?? ids[ids.length - 1];
  const res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: MULT_PROMPT(ids) }],
      stream: false,
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.warn(`[assistant] ${provider} multiplier request returned HTTP ${res.status}`);
    return {};
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return parseJsonObject(body.choices?.[0]?.message?.content ?? '') ?? {};
}

// ── Featured picks (newest model per tier, no hardcoded names) ──────────────
// The raw registries are huge and full of aliases and old generations. The menu
// leads with the newest model of each capability tier; everything else sits
// behind "More models". Purely id-derived, so new releases surface themselves.

// Most specific first so "flash-lite" wins over "flash", "mini" over the base.
const TIERS = [
  'opus', 'sonnet', 'haiku', 'fable', // Anthropic
  'flash-lite', 'flash', 'pro', // Gemini
  'sol', 'terra', 'luna', 'mini', 'nano', 'gpt', // OpenAI
  'reasoner', 'chat', // DeepSeek
  'air', 'glm', // GLM
] as const;

function tierOf(id: string): string {
  for (const t of TIERS) if (id.includes(t)) return t;
  return 'other';
}

/** First "major[.minor]" number in the id, e.g. claude-opus-4-8 → 4.8,
 *  gemini-3.1-pro-preview → 3.1. Aliases without numbers rank lowest. */
function versionOf(id: string): number {
  const m = id.match(/(\d+)(?:[.-](\d+))?/);
  return m ? Number.parseFloat(`${m[1]}.${m[2] ?? '0'}`) : 0;
}

function featuredIds(models: { id: string }[]): Set<string> {
  const best = new Map<string, { id: string; ver: number; preview: boolean }>();
  for (const { id } of models) {
    if (/latest/.test(id)) continue; // floating aliases stay in "More"
    const tier = tierOf(id);
    if (tier === 'other') continue;
    const ver = versionOf(id);
    const preview = /preview|exp/.test(id);
    const cur = best.get(tier);
    // Highest version wins; at the same version a stable id beats a preview.
    if (!cur || ver > cur.ver || (ver === cur.ver && cur.preview && !preview)) {
      best.set(tier, { id, ver, preview });
    }
  }
  return new Set([...best.values()].map((b) => b.id));
}

/** Menu payload for one provider: models with multiplier + featured flags. */
export async function modelOptions(provider: AssistantProvider): Promise<ModelOption[]> {
  const models = await listProviderModels(provider);
  const mult = getMultipliers();
  const featured = featuredIds(models);
  return models.map((m) => {
    const reasoningEfforts = reasoningEffortsFor(provider, m.id);
    return {
      id: m.id,
      label: m.label,
      multiplier: mult[m.id] ?? null,
      featured: featured.has(m.id),
      contextWindow:
        m.contextWindow ?? (provider === 'openai' && isGpt56(m.id) ? GPT_5_6_CONTEXT_WINDOW : null),
      ...(reasoningEfforts.length > 0
        ? { reasoningEfforts, reasoningDefault: 'medium' as const }
        : {}),
      attachmentKinds: attachmentKindsFor(provider, m.id),
    };
  });
}
