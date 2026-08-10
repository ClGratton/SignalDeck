import { readSseData } from './sse';

export interface OpenAiStreamEvent {
  type?: string;
  sequence_number?: number;
  response?: { id?: string };
  [key: string]: unknown;
}

export type OpenAiStreamResult =
  | { status: 'terminal'; responseId?: string; lastSequence?: number }
  | { status: 'aborted'; responseId?: string; lastSequence?: number }
  | {
      status: 'http_error';
      response: Response;
      responseId?: string;
      lastSequence?: number;
    }
  | {
      status: 'disconnected';
      responseId?: string;
      lastSequence?: number;
      cause?: unknown;
    };

interface ReadOpenAiStreamOpts {
  initialResponse: Response;
  responsesUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  onEvent: (event: OpenAiStreamEvent) => void;
  fetcher?: typeof fetch;
  maxResumes?: number;
}

const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'error',
]);

/**
 * Read a background Responses API stream, resuming the same OpenAI response
 * after a dropped HTTP connection. `starting_after` prevents duplicate events,
 * so already surfaced output and already completed tool calls are not replayed.
 */
export async function readOpenAiResponseStream({
  initialResponse,
  responsesUrl,
  apiKey,
  signal,
  onEvent,
  fetcher = fetch,
  maxResumes = 8,
}: ReadOpenAiStreamOpts): Promise<OpenAiStreamResult> {
  let current = initialResponse;
  let responseId: string | undefined;
  let lastSequence: number | undefined;
  let resumeCount = 0;
  let lastCause: unknown;

  for (;;) {
    if (signal?.aborted) return { status: 'aborted', responseId, lastSequence };
    if (!current.ok || !current.body) {
      return { status: 'http_error', response: current, responseId, lastSequence };
    }

    let terminal = false;
    try {
      await readSseData(current.body, (payload) => {
        if (payload === '[DONE]') return;
        let event: OpenAiStreamEvent;
        try {
          event = JSON.parse(payload) as OpenAiStreamEvent;
        } catch {
          return;
        }
        if (typeof event.sequence_number === 'number') lastSequence = event.sequence_number;
        if (typeof event.response?.id === 'string') responseId = event.response.id;
        onEvent(event);
        if (event.type && TERMINAL_EVENTS.has(event.type)) terminal = true;
      });
    } catch (cause) {
      if (signal?.aborted) return { status: 'aborted', responseId, lastSequence };
      lastCause = cause;
    }

    if (terminal) return { status: 'terminal', responseId, lastSequence };
    if (!responseId || resumeCount >= maxResumes) {
      return { status: 'disconnected', responseId, lastSequence, cause: lastCause };
    }

    let resumed: Response | undefined;
    while (!resumed && resumeCount < maxResumes) {
      resumeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * resumeCount, 1_500)));
      if (signal?.aborted) return { status: 'aborted', responseId, lastSequence };

      const query = new URLSearchParams({ stream: 'true' });
      if (lastSequence !== undefined) query.set('starting_after', String(lastSequence));
      try {
        resumed = await fetcher(`${responsesUrl}/${encodeURIComponent(responseId)}?${query}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          cache: 'no-store',
          signal,
        });
      } catch (cause) {
        if (signal?.aborted) return { status: 'aborted', responseId, lastSequence };
        lastCause = cause;
      }
    }
    if (!resumed) {
      return { status: 'disconnected', responseId, lastSequence, cause: lastCause };
    }
    current = resumed;
  }
}
