import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The device font covers ASCII, CJK and full-width punctuation, not emoji.
export const chatTitle = text => Array.from(String(text ?? '').replace(/[\p{Cc}\u2028\u2029]/gu, ' '))
  .slice(0, 28).map(char => {
    const code = char.codePointAt(0);
    return code >= 0x20 && code <= 0x7e || code >= 0x3000 && code <= 0x303f ||
      code >= 0x4e00 && code <= 0x9fff || code >= 0xff00 && code <= 0xffef ? char : '?';
  }).join('');

// Read metadata only. This client never starts/resumes a turn or owns approvals.
export class DeviceChats {
  constructor(factory, { now = Date.now } = {}) {
    this.factory = factory; this.now = now; this.pages = []; this.revision = null;
    this.closed = false; this.busy = false;
  }
  invalidate() { this.pages = []; this.revision = null; }
  async list(page) {
    if (this.closed || this.busy || !Number.isInteger(page) || page < 0 || page > 24) throw new Error('Invalid chat page');
    this.busy = true;
    let client;
    try {
      if (page === 0) this.invalidate();
      const previous = this.pages[page - 1];
      if (page && !previous?.next) throw new Error('Expired chat page');
      client = this.factory();
      await client.initialize();
      const result = await client.rpc('thread/list', { cursor: page ? previous.next : null,
        limit: 4, archived: false, modelProviders: [], sortKey: 'updated_at', useStateDbOnly: true });
      if (this.closed || !Array.isArray(result?.data) || result.data.length > 4 ||
          result.data.some(t => !t || !idPattern.test(t.id)) ||
          result.nextCursor != null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048)) throw new Error('Invalid chat list');
      const chats = result.data.map(t => ({ id: t.id, title: chatTitle(t.name || t.preview) || '未命名聊天' }));
      if (new Set(chats.map(t => t.id)).size !== chats.length) throw new Error('Duplicate chat');
      this.revision = randomUUID();
      this.pages[page] = { chats, next: result.nextCursor ?? null, at: this.now() };
      this.pages.length = page + 1;
      return { type: 'chats', page, revision: this.revision, chats, previous: page > 0,
        next: !!result.nextCursor && page < 24 };
    } finally { client?.close(); this.busy = false; }
  }
  target(revision, id) {
    const page = this.pages.at(-1);
    if (this.closed || revision !== this.revision || !page || this.now() - page.at > 120000) throw new Error('Expired chat selection');
    const chat = page.chats.find(t => t.id === id);
    if (!chat) throw new Error('Unknown chat');
    this.invalidate(); return chat;
  }
  close() { this.closed = true; this.invalidate(); }
}

export function loadChatTarget(filename) {
  if (!filename) return null;
  try {
    const raw = readFileSync(filename);
    if (raw.length > 1024) return null;
    const chat = JSON.parse(raw);
    return idPattern.test(chat.id) && typeof chat.title === 'string' ? { id: chat.id, title: chatTitle(chat.title) } : null;
  } catch { return null; }
}
export function saveChatTarget(filename, chat) {
  if (!filename) return;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ id: chat.id, title: chatTitle(chat.title) }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, filename);
  } finally { try { unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
}
