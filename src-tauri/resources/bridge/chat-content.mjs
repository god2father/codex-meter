import { randomUUID } from 'node:crypto';

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

export function historyMessages(state) {
  const turns = Array.isArray(state?.turns) ? state.turns : [];
  const messages = turns.flatMap(turn => Array.isArray(turn?.items) ? turn.items : []).filter(item =>
    ['userMessage', 'steeringUserMessage', 'agentMessage'].includes(item?.type)).map(item => {
      const text = item.type === 'agentMessage' ? item.text :
        (Array.isArray(item.content) ? item.content : []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
      return { ...item, body: typeof text === 'string' ? text.trim() : '' };
    }).filter(item => item.body && !/^<(environment_context|heartbeat|external_codex_apps_open_page)>/.test(item.body));
  return messages.map(item => ({ role: item.type === 'agentMessage' ? 'assistant' : 'user', text: boundedText(item.body, 450) }));
}

export function chatMessages(state) {
  return historyMessages(state).slice(-2);
}

export function historyPage(state, page) {
  return messagePage(historyMessages(state), page);
}

function messagePage(all, page) {
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) throw new Error('Invalid history page');
  const pages = Math.max(1, Math.ceil(all.length / 2));
  page = Math.min(page, pages - 1);
  const end = all.length - page * 2;
  const messages = all.slice(Math.max(0, end - 2), end);
  return { page, hasOlder: page + 1 < pages, hasNewer: page > 0, messages,
    content: messages.map(message => `${message.role === 'assistant' ? '助手' : '你'}\n${message.text}`).join('\n\n') };
}

export function chatContent(state) {
  return chatMessages(state).map(message => `${message.role === 'assistant' ? '助手' : '你'}\n${message.text}`).join('\n\n');
}

// Metadata reads supplement desktop snapshots which can omit turn history.
export class ChatContent {
  constructor(factory) { this.factory = factory; this.busy = false; this.closed = false; }
  async read(threadId) {
    if (this.busy || this.closed || !threadId) return null;
    try {
      const state = await this.readState(threadId);
      return this.closed ? null : { text: chatContent(state), messages: chatMessages(state) };
    } catch { return null; }
  }
  async history(threadId, page, revision = '') {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000 || typeof revision !== 'string') throw new Error('Invalid history page');
    if (this.closed) throw new Error('History reader closed');
    if (revision) {
      if (!this.historySnapshot || this.historySnapshot.threadId !== threadId || this.historySnapshot.revision !== revision)
        throw new Error('History revision expired');
    } else {
      const epoch = this.historyEpoch;
      const state = await this.readState(threadId);
      if (epoch !== this.historyEpoch) throw new Error('History invalidated');
      this.historySnapshot = { threadId, revision: randomUUID(), messages: historyMessages(state).slice(-200002) };
    }
    return { ...messagePage(this.historySnapshot.messages, page), revision: this.historySnapshot.revision };
  }
  invalidateHistory() { this.historySnapshot = null; this.historyEpoch = (this.historyEpoch ?? 0) + 1; }
  async readState(threadId) {
    if (this.busy || this.closed || !threadId) throw new Error('History reader unavailable');
    this.busy = true;
    try {
      if (!this.client) { this.client = this.factory(); await this.client.initialize(); }
      const result = await this.client.rpc('thread/read', { threadId, includeTurns: true });
      if (this.closed) throw new Error('History reader closed');
      if (!result?.thread || typeof result.thread !== 'object') throw new Error('Invalid history');
      return result.thread;
    } catch {
      this.client?.close(); this.client = null; throw new Error('History unavailable');
    } finally { this.busy = false; }
  }
  close() { this.closed = true; this.invalidateHistory(); this.client?.close(); this.client = null; }
}
