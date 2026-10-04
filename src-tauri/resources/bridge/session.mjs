// Own one app-server thread; unrelated desktop tasks are never controlled.
export class PassportSession {
  constructor(app, changed = () => {}) {
    this.app = app; this.changed = changed;
    this.threadId = null; this.threadTitle = ''; this.turnId = null; this.state = 'idle'; this.busy = false;
  }
  snapshot() { return { type: 'status', state: this.state, threadId: this.threadId, threadTitle: this.threadTitle, turnId: this.turnId }; }
  async start(cwd) {
    if (this.busy || this.turnId) throw new Error('Task active');
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('Absolute cwd required');
    this.busy = true;
    try {
      const result = await this.app.rpc('thread/start', { cwd, sandbox: 'read-only',
        approvalPolicy: 'untrusted', approvalsReviewer: 'user', ephemeral: true });
      this.threadId = result.thread.id; this.model = result.model;
      this.cwd = result.thread.cwd ?? cwd; this.state = 'idle'; this.changed();
      return this.snapshot();
    } finally { this.busy = false; }
  }
  async run(text, mode = 'default') {
    if (!this.threadId || this.busy || this.turnId) throw new Error('Thread unavailable or task active');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Invalid prompt');
    if (!['default', 'plan'].includes(mode) || (mode === 'plan' && !this.model)) throw new Error('Invalid collaboration mode');
    this.busy = true; this.state = 'running'; this.changed();
    try {
      const result = await this.app.rpc('turn/start', { threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(this.model ? { collaborationMode: { mode, settings: { model: this.model,
          reasoning_effort: null, developer_instructions: null } } } : {}) });
      // Completion may arrive before the RPC response.
      if (this.state === 'running' || this.state === 'waitingApproval') this.turnId = result.turn.id;
      return this.snapshot();
    } catch (error) { this.state = 'failed'; this.changed(); throw error; }
    finally { this.busy = false; }
  }
  async interrupt() {
    if (!this.turnId) throw new Error('No active turn');
    await this.app.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }
  notification(message) {
    const p = message.params;
    if (!p || p.threadId !== this.threadId) return;
    if (message.method === 'turn/started') {
      this.turnId = p.turn.id; this.state = 'running';
    } else if (message.method === 'turn/completed' && p.turn.id === this.turnId) {
      this.turnId = null;
      this.state = p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'cancelled' : 'failed';
    } else return;
    this.changed();
  }
}
