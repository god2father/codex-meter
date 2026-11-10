import { randomBytes } from 'node:crypto';

// One preview owns its original target. Repeated confirmation only reads its status.
// An uncertain result is never retried. It resolves either from evidence (Desktop shows the
// same text in a new turn) or when the user explicitly releases it after checking the chat.
export class TextSubmission {
  constructor(app) { this.app = app; this.current = null; }
  prepare(text, target) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16000) throw new Error('Invalid transcript');
    if (['preview', 'sending', 'uncertain'].includes(this.current?.state)) throw new Error('Submission unresolved');
    target ??= this.app.textTarget();
    this.current = { id: randomBytes(16).toString('hex'), target: { ...target }, text, state: 'preview' };
    return this.snapshot();
  }
  snapshot() {
    const item = this.current;
    return item ? { type: 'textSubmission', id: item.id, threadId: item.target.threadId, state: item.state } : null;
  }
  async confirm(id) {
    const item = this.current;
    if (!item || id !== item.id) throw new Error('Expired confirmation');
    if (item.state !== 'preview') return this.snapshot();
    item.state = 'sending';
    item.lastTurnId = (this.app.state?.turns ?? []).at(-1)?.id;
    try { await this.app.submitText(item.target, item.text); item.state = 'accepted'; }
    catch (error) { item.state = ['DESKTOP_TARGET', 'DESKTOP_REJECTED'].includes(error.code) ? 'failed' : 'uncertain'; }
    if (item.state === 'accepted') item.text = '';
    return this.current === item ? this.snapshot() : null;
  }
  cancel(id) {
    if (!this.current || this.current.id !== id || this.current.state !== 'preview') throw new Error('Cannot cancel submission');
    this.current.text = ''; this.current.state = 'cancelled';
    return this.snapshot();
  }
  // Called with each Desktop snapshot of the selected chat. Returns true when the state changed.
  observe(state) {
    const item = this.current;
    if (item?.state !== 'uncertain' || this.app.threadId !== item.target.threadId) return false;
    const turns = Array.isArray(state?.turns) ? state.turns : [];
    const start = item.lastTurnId === undefined ? 0 : turns.findIndex(turn => turn?.id === item.lastTurnId) + 1;
    if (start === 0 && item.lastTurnId !== undefined) return false;
    const expected = item.text.trim();
    const landed = turns.slice(start).some(turn => (turn?.items ?? []).some(entry =>
      ['userMessage', 'steeringUserMessage'].includes(entry?.type) && (Array.isArray(entry.content) ? entry.content : [])
        .filter(part => part?.type === 'text').map(part => part.text).join('\n').trim() === expected));
    if (!landed) return false;
    item.state = 'accepted'; item.text = '';
    this.app.textPending?.delete(item.target.threadId);
    return true;
  }
  // The user checked the chat on the computer and chose to unblock new input. Never resends.
  release(id) {
    const item = this.current;
    if (!item || (id !== undefined && id !== item.id) || item.state !== 'uncertain') throw new Error('Nothing to release');
    item.state = 'released'; item.text = '';
    this.app.textPending?.delete(item.target.threadId);
    return this.snapshot();
  }
  invalidate() {
    if (this.current?.state === 'preview') { this.current.text = ''; this.current.state = 'cancelled'; }
  }
}
