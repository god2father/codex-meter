function boundedText(text, bytes) {
  let result = '';
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    const printable = char === '\n' || code >= 0x20 && code <= 0x7e ||
      code >= 0x3000 && code <= 0x303f || code >= 0x4e00 && code <= 0x9fff || code >= 0xff00 && code <= 0xffef;
    const next = printable ? char : '?';
    if (Buffer.byteLength(result + next) > bytes - 3) return result + '...';
    result += next;
  }
  return result;
}

export function chatMessages(state) {
  const turns = Array.isArray(state?.turns) ? state.turns : [];
  const messages = turns.flatMap(turn => Array.isArray(turn?.items) ? turn.items : []).filter(item =>
    ['userMessage', 'steeringUserMessage', 'agentMessage'].includes(item?.type)).map(item => {
      const text = item.type === 'agentMessage' ? item.text :
        (Array.isArray(item.content) ? item.content : []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
      return { ...item, body: typeof text === 'string' ? text.trim() : '' };
    }).filter(item => item.body && !/^<(environment_context|heartbeat|external_codex_apps_open_page)>/.test(item.body));
  const latest = [];
  for (const item of messages.toReversed()) {
    const role = item.type === 'agentMessage' ? 'assistant' : 'user';
    if (!latest.some(entry => entry.role === role)) latest.push({ role, item });
    if (latest.length === 2) break;
  }
  return latest.reverse().map(({ role, item }) => ({ role, text: boundedText(item.body, 450) }));
}

export function chatContent(state) {
  return chatMessages(state).map(message => `${message.role === 'assistant' ? '助手' : '你'}\n${message.text}`).join('\n\n');
}

// Metadata reads supplement desktop snapshots which can omit turn history.
export class ChatContent {
  constructor(factory) { this.factory = factory; this.busy = false; this.closed = false; }
  async read(threadId) {
    if (this.busy || this.closed || !threadId) return null;
    this.busy = true;
    try {
      if (!this.client) { this.client = this.factory(); await this.client.initialize(); }
      const result = await this.client.rpc('thread/read', { threadId, includeTurns: true });
      return this.closed ? null : { text: chatContent(result.thread), messages: chatMessages(result.thread) };
    } catch {
      this.client?.close(); this.client = null; return null;
    } finally { this.busy = false; }
  }
  close() { this.closed = true; this.client?.close(); }
}
