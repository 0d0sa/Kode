import type { ContentBlock, ToolUseBlock } from '../llm/types.js';
import { isAbortError } from '../llm/types.js';
import { trimMessages } from './context.js';
import type { AgentEvent, AgentRunOptions } from './types.js';

/**
 * The minimal agent loop: stream LLM → collect tool_use → dispatch → append
 * results → repeat, until no tool_use / maxSteps / abort. Contains no business
 * logic; fully replayable against a mock provider.
 */
export async function* agentLoop(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
  const { provider, registry, ctx } = opts;
  const history = opts.messages;

  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal?.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return;
    }
    yield { type: 'step', index: step };

    const view = trimMessages(history, opts.contextMessages);
    const blocks: ContentBlock[] = [];
    const toolUses: ToolUseBlock[] = [];
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';

    try {
      for await (const ev of provider.complete(view, {
        model: opts.model,
        system: opts.system,
        tools: registry.specs(),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) {
        if (ev.type === 'text') {
          yield { type: 'text', delta: ev.delta };
          pushText(blocks, ev.delta);
        } else if (ev.type === 'tool_use') {
          const b: ToolUseBlock = { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input };
          blocks.push(b);
          toolUses.push(b);
        } else if (ev.type === 'stop') {
          stopReason = ev.reason;
        }
      }
    } catch (e) {
      if (opts.signal?.aborted || isAbortError(e)) {
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      throw e;
    }

    if (opts.signal?.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return;
    }
    history.push({ role: 'assistant', content: blocks });

    if (toolUses.length === 0) {
      yield { type: 'done', reason: stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn' };
      return;
    }

    // Sequential dispatch (parallel scheduling arrives in Phase 5).
    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      yield { type: 'tool_call', name: tu.name, input: tu.input };
      const result = await registry.dispatch(tu.name, tu.input, ctx, tu.id);
      yield { type: 'tool_result', name: tu.name, result };
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.output,
        is_error: !result.ok,
      });
    }
    history.push({ role: 'user', content: results });
  }
  yield { type: 'done', reason: 'max_steps' };
}

/** Merge consecutive text deltas into a single trailing TextBlock. */
function pushText(blocks: ContentBlock[], delta: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') last.text += delta;
  else blocks.push({ type: 'text', text: delta });
}
