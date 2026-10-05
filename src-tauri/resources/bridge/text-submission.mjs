import { randomBytes } from 'node:crypto';

// One preview owns its original target. Repeated confirmation only reads its status.
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
  invalidate() {
    if (this.current?.state === 'preview') { this.current.text = ''; this.current.state = 'cancelled'; }
  }
}
