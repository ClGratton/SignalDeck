import { NextResponse } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { PROVIDERS, getProviderKey, keySource, getProviderBaseUrl } from '@/lib/assistant/keys';
import { defaultModel, modelOptions, refreshMultipliersInBackground } from '@/lib/assistant/models';
import type { AssistantProvider, ModelOption, ModelsResponse } from '@/lib/assistant/types';

export const runtime = 'nodejs';

/** PRIVILEGED: the model menu's data — configured providers (status only,
 *  never key values), live model lists for those providers, and cached price
 *  multipliers. Also kicks the background multiplier refresh when stale. */
export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const providers = PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    source: keySource(p.id),
    customBaseUrl: p.kind === 'openai',
    baseUrl: getProviderBaseUrl(p.id) ?? undefined,
  }));
  const models: Partial<Record<AssistantProvider, ModelOption[]>> = {};
  for (const p of providers) {
    if (p.source) models[p.id] = await modelOptions(p.id);
  }

  const provider: AssistantProvider | null =
    PROVIDERS.map((p) => p.id).find((id) => getProviderKey(id)) ?? null;
  const payload: ModelsResponse = {
    providers,
    models,
    defaults: { provider, model: provider ? defaultModel(provider) : null },
  };

  refreshMultipliersInBackground();

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store' } });
}
