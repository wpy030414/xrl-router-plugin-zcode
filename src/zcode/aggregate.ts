/**
 * zcode/aggregate.ts — 把 Anthropic Messages 的 SSE 流聚合成单条 message JSON。
 *
 * 上游我们始终以 `stream: true` 请求（沿用 zcode2api 的成熟做法），因此当客户端
 * 要非流式响应时，需要把 SSE 事件重组成一个完整的 Messages 响应对象。
 *
 * 支持的事件：message_start / content_block_start / content_block_delta /
 * content_block_stop / message_delta / message_stop / error / ping。
 */

/** SSE 帧结束标记 */
const FRAME_SEP = '\n\n';

interface StreamState {
  message: any;
  blocks: any[];
  /** tool_use / server_tool_use 的 partial_json 累积缓冲，按 content block index 存 */
  jsonBuffers: Map<number, string>;
  stopReason: string | null;
  stopSequence: string | null;
  usage: Record<string, number>;
}

function applyDelta(state: StreamState, index: number, delta: any): void {
  const block = state.blocks[index];
  if (!block || !delta) return;

  switch (delta.type) {
    case 'text_delta':
      block.text = (block.text || '') + (delta.text || '');
      break;
    case 'thinking_delta':
      block.thinking = (block.thinking || '') + (delta.thinking || '');
      break;
    case 'signature_delta':
      block.signature = (block.signature || '') + (delta.signature || '');
      break;
    case 'input_json_delta':
      state.jsonBuffers.set(index, (state.jsonBuffers.get(index) || '') + (delta.partial_json || ''));
      break;
    case 'citations_delta':
      if (delta.citation) (block.citations ||= []).push(delta.citation);
      break;
    default:
      // 未知 delta 类型：把标量字段并进 block，保证不丢内容
      for (const [k, v] of Object.entries(delta)) {
        if (k !== 'type' && (typeof v === 'string' || typeof v === 'number')) block[k] = v;
      }
  }
}

function applyEvent(state: StreamState, event: any): void {
  switch (event?.type) {
    case 'message_start':
      if (event.message) Object.assign(state.message, event.message);
      // message_start 里的 content 通常是空数组，以实际 content_block_* 为准
      if (event.message?.usage) Object.assign(state.usage, event.message.usage);
      break;

    case 'content_block_start':
      state.blocks[event.index] = { ...(event.content_block || {}) };
      break;

    case 'content_block_delta':
      applyDelta(state, event.index, event.delta);
      break;

    case 'content_block_stop': {
      const buffered = state.jsonBuffers.get(event.index);
      if (buffered) {
        const block = state.blocks[event.index];
        if (block) {
          try {
            block.input = JSON.parse(buffered);
          } catch {
            // 上游给了半截 JSON：原样保留，便于排查而不是吞掉
            block.input = buffered;
          }
        }
        state.jsonBuffers.delete(event.index);
      }
      break;
    }

    case 'message_delta':
      if (event.delta?.stop_reason !== undefined) state.stopReason = event.delta.stop_reason;
      if (event.delta?.stop_sequence !== undefined) state.stopSequence = event.delta.stop_sequence;
      if (event.usage) Object.assign(state.usage, event.usage);
      break;

    case 'error': {
      const message = event.error?.message || '上游返回 error 事件';
      throw new Error(message);
    }

    case 'ping':
    case 'message_stop':
      break;

    default:
      break;
  }
}

/**
 * 读取 SSE 字节流并聚合。上游返回非 SSE 的 JSON 时直接返回该 JSON。
 */
export async function aggregateAnthropicStream(
  stream: ReadableStream<Uint8Array>,
): Promise<any> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const state: StreamState = {
    message: { id: '', type: 'message', role: 'assistant', content: [], model: '' },
    blocks: [],
    jsonBuffers: new Map(),
    stopReason: null,
    stopSequence: null,
    usage: {},
  };

  let buffer = '';
  let sawSseFrame = false;

  const handleFrame = (frame: string): void => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return;

    const raw = dataLines.join('\n');
    if (!raw || raw === '[DONE]') return;

    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return; // 非 JSON 帧（保活注释等）忽略
    }
    sawSseFrame = true;
    applyEvent(state, event);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf(FRAME_SEP)) >= 0) {
        handleFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + FRAME_SEP.length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer);
  } finally {
    reader.releaseLock();
  }

  // 上游压根没发 SSE：把整个响应体当 JSON 解一次
  if (!sawSseFrame) {
    try {
      return JSON.parse(buffer.trim());
    } catch {
      /* 落到下面的兜底 */
    }
  }

  return {
    id: state.message.id || 'msg_aggregated',
    type: 'message',
    role: state.message.role || 'assistant',
    model: state.message.model || '',
    content: state.blocks.filter(Boolean),
    stop_reason: state.stopReason ?? state.message.stop_reason ?? 'end_turn',
    stop_sequence: state.stopSequence ?? state.message.stop_sequence ?? null,
    usage: Object.keys(state.usage).length ? state.usage : state.message.usage,
  };
}
