import { randomBytes } from 'node:crypto';

export const PCM_FRAME_BYTES = 640;
export function pcmFrame(id, sequence, pcm) {
  const frame = Buffer.alloc(24 + pcm.length);
  frame.write('PV01'); Buffer.from(id, 'hex').copy(frame, 4); frame.writeUInt32BE(sequence, 20); pcm.copy(frame, 24);
  return frame;
}
function chunks(text) {
  const parts = []; let current = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 450) { parts.push(current); current = ''; bytes = 0; }
    current += char; bytes += size;
  }
  if (current) parts.push(current);
  return parts;
}
export class VoiceSession {
  constructor({ app, submission, transcribe, emit }) {
    this.app = app; this.submission = submission; this.transcribe = transcribe; this.emit = emit; this.current = null;
  }
  targetValid(item) {
    try {
      const target = this.app.textTarget();
      return target.threadId === item.target.threadId && target.generation === item.target.generation && target.owner === item.target.owner;
    } catch { return false; }
  }
  snapshot(page = 0) {
    const item = this.current;
    if (!item) throw new Error('Voice unavailable');
    const pages = item.parts?.length ?? 0;
    if (!Number.isInteger(page) || page < 0 || (pages && page >= pages) || (!pages && page)) throw new Error('Invalid voice page');
    return { type: 'voice', id: item.id, threadId: item.target.threadId, state: item.state,
      ...(item.submissionId ? { submissionId: item.submissionId } : {}),
      ...(pages ? { page, pages, text: item.parts[page] } : {}) };
  }
  publish() { this.emit(this.snapshot()); }
  start(threadId) {
    if (!this.transcribe || ['recording', 'transcribing', 'preview', 'sending', 'uncertain'].includes(this.current?.state) ||
        ['preview', 'sending', 'uncertain'].includes(this.submission.current?.state)) throw new Error('Voice unavailable or busy');
    const target = this.app.textTarget();
    if (threadId !== target.threadId) throw new Error('Stale voice target');
    this.current = { id: randomBytes(16).toString('hex'), target, state: 'recording', sequence: 0, bytes: 0, buffers: [] };
    this.timer = setTimeout(() => this.cancel(this.current?.id), 32000);
    return this.snapshot();
  }
  receive(frame) {
    const item = this.current;
    if (!item || item.state !== 'recording') throw new Error('Not recording');
    if (!Buffer.isBuffer(frame) || frame.length <= 24 || frame.length > 24 + PCM_FRAME_BYTES || (frame.length - 24) % 2 ||
        frame.toString('ascii', 0, 4) !== 'PV01' || frame.subarray(4, 20).toString('hex') !== item.id ||
        frame.readUInt32BE(20) !== item.sequence || item.bytes + frame.length - 24 > 960000 || !this.targetValid(item)) {
      this.cancel(item.id); throw new Error('Invalid audio or stale target');
    }
    item.sequence++; item.bytes += frame.length - 24; item.buffers.push(Buffer.from(frame.subarray(24)));
  }
  async stop(id) {
    const item = this.current;
    if (!item || item.id !== id) throw new Error('Stale recording');
    if (item.state !== 'recording') return this.snapshot();
    clearTimeout(this.timer);
    if (!item.bytes || !this.targetValid(item)) { this.cancel(id); return this.snapshot(); }
    item.state = 'transcribing'; item.controller = new AbortController(); this.publish();
    const pcm = Buffer.concat(item.buffers, item.bytes); item.buffers = [];
    try {
      const text = await this.transcribe(pcm, { sessionId: item.id, signal: item.controller.signal });
      if (this.current !== item || item.state !== 'transcribing') return null;
      if (!this.targetValid(item)) { this.cancel(id); return this.snapshot(); }
      const preview = this.submission.prepare(text, item.target);
      item.submissionId = preview.id; item.parts = chunks(text); item.state = 'preview';
    } catch {
      if (this.current !== item || item.state !== 'transcribing') return null;
      item.state = 'failed';
    }
    return this.snapshot();
  }
  cancel(id) {
    const item = this.current;
    if (!item || item.id !== id || ['sending', 'accepted', 'uncertain'].includes(item.state)) throw new Error('Cannot cancel voice');
    clearTimeout(this.timer); item.controller?.abort(); item.buffers = []; item.parts = [];
    if (item.submissionId && this.submission.current?.state === 'preview') this.submission.cancel(item.submissionId);
    item.state = 'cancelled'; this.publish(); return this.snapshot();
  }
  async confirm(id, submissionId) {
    const item = this.current;
    if (!item || item.id !== id || item.submissionId !== submissionId) throw new Error('Expired voice confirmation');
    if (item.state !== 'preview') return this.snapshot();
    item.state = 'sending'; this.publish();
    const result = await this.submission.confirm(submissionId);
    if (this.current !== item) return null;
    item.state = result?.state ?? 'uncertain';
    if (item.state === 'accepted') item.parts = [];
    return this.snapshot();
  }
  invalidate() {
    const item = this.current;
    if (item && ['recording', 'transcribing', 'preview'].includes(item.state)) this.cancel(item.id);
  }
}
