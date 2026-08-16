/**
 * The model roster.
 *
 * The spec wants a frontier model, a mid-tier one and a small fast one, plus at
 * least one non-Anthropic model, because a benchmark that only tests the vendor
 * whose harness it runs in is not credible to a stranger.
 *
 * Model IDs are FULL, never aliases. The bare alias `haiku` on this CLI resolves
 * to claude-sonnet-4-6, so a run configured with aliases would have silently
 * measured Sonnet twice and labelled one of them Haiku. Every result records the
 * model the provider says actually served it, and the harness flags a mismatch.
 */
export type Provider = 'claude' | 'ollama';

export interface ModelSpec {
  /** Short label used in the report. */
  id: string;
  provider: Provider;
  /** Exact identifier passed to the provider. */
  model: string;
  tier: 'frontier' | 'mid' | 'small';
  vendor: string;
}

export const MODELS: ModelSpec[] = [
  { id: 'opus-5', provider: 'claude', model: 'claude-opus-5', tier: 'frontier', vendor: 'Anthropic' },
  { id: 'sonnet-5', provider: 'claude', model: 'claude-sonnet-5', tier: 'mid', vendor: 'Anthropic' },
  { id: 'haiku-4-5', provider: 'claude', model: 'claude-haiku-4-5', tier: 'small', vendor: 'Anthropic' },
  { id: 'qwen3.5-4b', provider: 'ollama', model: 'qwen3.5:4b', tier: 'small', vendor: 'Alibaba (local)' },
  { id: 'qwen3.5-2b', provider: 'ollama', model: 'qwen3.5:2b', tier: 'small', vendor: 'Alibaba (local)' },
  { id: 'gemma4-e4b', provider: 'ollama', model: 'gemma4:e4b', tier: 'small', vendor: 'Google (local)' },
];

/** Smoke default: one hosted mid-tier and one local, so both transports and
 *  both tool paths (CLI MCP and the hand-rolled loop) are exercised cheaply. */
export const SMOKE_MODEL_IDS = ['haiku-4-5', 'qwen3.5-4b'];

export function selectModels(ids?: string[]): ModelSpec[] {
  if (!ids || ids.length === 0) return MODELS;
  const set = new Set(ids);
  const picked = MODELS.filter((m) => set.has(m.id));
  const missing = [...set].filter((id) => !MODELS.some((m) => m.id === id));
  if (missing.length) throw new Error(`unknown model id(s): ${missing.join(', ')}`);
  return picked;
}
