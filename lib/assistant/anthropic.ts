// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: Anthropic provider — the preferred one when ANTHROPIC_API_KEY is
// set. Manual agentic loop (not the SDK tool runner) so action dispatch goes
// through executeTool, which streams confirm/action events and (in agent mode)
// can pause mid-turn for the operator's Run/Skip, then resume.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from '@/lib/assistant/prompt';
import { listTools, executeTool, toolLabel, type ToolContext } from '@/lib/assistant/tools';
import { maxAgentSteps } from '@/lib/assistant/config';
import type { ChatTurn } from '@/lib/assistant/types';

// Adaptive thinking only exists on the newest models; sending it to older ones
// is a 400. Anything else just runs without a thinking block.
const supportsAdaptiveThinking = (model: string) => /fable|opus-4-[89]/.test(model);

export async function runAnthropicTurn(
  apiKey: string,
  model: string,
  turns: ChatTurn[],
  ctx: ToolContext,
): Promise<void> {
  const client = new Anthropic({ apiKey });
  const emit = ctx.emit;
  const tools: Anthropic.Tool[] = (ctx.utility ? [] : listTools()).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool['input_schema'],
  }));

  const messages: Anthropic.MessageParam[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));
  // Keep the prefix byte-stable throughout this tool loop. Workspace/memory
  // tools return their changes in-band, so rebuilding the system prompt here
  // would only invalidate Anthropic's prompt cache.
  const instructions = systemPrompt(ctx.mode, ctx.approval, ctx.chatId);

  const maxIterations = maxAgentSteps();
  for (let i = 0; i < maxIterations; i++) {
    const stream = client.messages.stream({
      model,
      max_tokens: 16000,
      system: instructions,
      // Anthropic automatic caching is supported by every active Claude model
      // and advances the breakpoint as the conversation/tool history grows.
      cache_control: { type: 'ephemeral' },
      ...(supportsAdaptiveThinking(model) ? { thinking: { type: 'adaptive' as const } } : {}),
      tools: tools.length > 0 ? tools : undefined,
      messages,
    });
    stream.on('text', (delta) => emit({ type: 'text', text: delta }));
    stream.on('thinking', (delta) => emit({ type: 'reasoning', text: delta }));
    const message = await stream.finalMessage();
    console.info('[assistant] Anthropic token usage', {
      model,
      request: i + 1,
      inputTokens: message.usage.input_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      outputTokens: message.usage.output_tokens,
    });

    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason === 'pause_turn') continue;

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (message.stop_reason !== 'tool_use' || toolUses.length === 0) return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      emit({ type: 'tool', name: use.name, label: toolLabel(use.name) });
      const outcome = await executeTool(use.name, use.input, ctx);
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: outcome.content,
        is_error: outcome.isError === true,
      });
    }
    messages.push({ role: 'user', content: results });
    // start_timer asked to end the turn and hand the wait to the task runner.
    if (ctx.sleep) return;
  }
  emit({
    type: 'error',
    message: 'Stopped after too many steps in one turn. Ask again to continue.',
  });
}
