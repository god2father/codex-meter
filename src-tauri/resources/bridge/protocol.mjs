export const decisions = ['accept', 'acceptForSession', 'decline', 'cancel'];
const methods = new Map([
  ['item/commandExecution/requestApproval', 'command'],
  ['item/fileChange/requestApproval', 'file'],
]);
export function normalizeQuestion(message) {
  const p = message.params;
  if (message.id === undefined || !Array.isArray(p?.questions) || !p.questions.length || p.questions.length > 3)
    throw new Error('Unsupported questions');
  const ids = new Set();
  for (const q of p.questions) {
    if (typeof q.id !== 'string' || !q.id || q.id.length > 63 || ids.has(q.id) || q.isSecret ||
        typeof q.question !== 'string' || !q.question || Buffer.byteLength(JSON.stringify(q)) > 2800 || !Array.isArray(q.options) ||
        !q.options.length || q.options.length > 3 || q.options.some(o =>
          typeof o.label !== 'string' || !o.label || Buffer.byteLength(o.label) > 90 ||
          typeof o.description !== 'string') || new Set(q.options.map(o => o.label)).size !== q.options.length)
      throw new Error('Unsupported question');
    ids.add(q.id);
  }
  return { type: 'question', requestId: String(message.id), threadId: p.threadId, turnId: p.turnId,
    questionId: p.questions[0].id, question: p.questions[0].question, options: p.questions[0].options,
    index: 1, total: p.questions.length };
}

function cancellation(entry) {
  return entry.request.type === 'question' ? { answers: {} } : { decision: 'cancel' };
}
export function normalizeApproval(message, item = {}, threadCwd = '') {
  const kind = methods.get(message.method);
  if (!kind || message.id === undefined) throw new Error('Unsupported approval');
  const p = message.params;
  const command = p.command ?? item.command ?? '';
  const cwd = p.cwd ?? item.cwd ?? threadCwd;
  const changes = kind === 'file' ? item.changes ?? [] : [];
  if (kind === 'file' && (!Array.isArray(changes) || !changes.length ||
      changes.some(change => typeof change.path !== 'string' || typeof change.diff !== 'string'))) {
    throw new Error('File details unavailable');
  }
  const detail = kind === 'command' ? command : changes.map(change =>
    `${change.path}\n${({ add: '新增', update: '修改', delete: '删除' })[change.kind?.type] ?? '文件'}\n${change.diff}`).join('\n\n');
  // Unknown shell semantics are treated conservatively; this is not a sandbox.
  const risk = 'high';
  const allowed = p.availableDecisions === undefined ? decisions :
    p.availableDecisions.filter(d => typeof d === 'string' && decisions.includes(d));
  if (!allowed.length) throw new Error('No supported decisions');
  return { type: 'approval', requestId: String(message.id), kind, command: detail, cwd,
    reason: [p.reason, p.grantRoot ? `授权目录: ${p.grantRoot}` : null].filter(Boolean).join('\n'), risk, riskHint: '可能修改文件或执行命令，请查看全部详情',
    threadId: p.threadId, turnId: p.turnId, allowed };
}

export class ApprovalQueue {
  constructor(sendReply, now = Date.now, { replyOnExpiry = true } = {}) {
    this.requests = new Map(); this.sendReply = sendReply; this.now = now; this.replyOnExpiry = replyOnExpiry;
  }
  add(message, item, threadCwd) {
    const request = message.method === 'item/tool/requestUserInput' ? normalizeQuestion(message) : normalizeApproval(message, item, threadCwd);
    if (this.requests.has(request.requestId)) throw new Error('Duplicate request');
    if (this.requests.size >= 8) throw new Error('Approval queue full');
    this.requests.set(request.requestId, { message, request, answers: {}, expires: this.now() + 120000 });
    return request;
  }
  current() { return this.requests.values().next().value?.request; }
  expire() {
    let expired = false;
    for (const [id, entry] of this.requests) {
      if (this.now() >= entry.expires) {
        if (this.replyOnExpiry) this.sendReply({ id: entry.message.id, result: cancellation(entry) });
        this.requests.delete(id); expired = true;
      }
    }
    return expired;
  }
  decide(input) {
    this.expire();
    const entry = this.requests.get(input.requestId);
    if (!entry || this.current()?.requestId !== input.requestId) throw new Error('Stale request');
    if (entry.request.type !== 'approval') throw new Error('Wrong request type');
    if (!entry.request.allowed.includes(input.decision)) throw new Error('Unsupported decision');
    if (entry.request.risk === 'high' && input.decision.startsWith('accept') &&
        (!Number.isInteger(input.heldMs) || input.heldMs < 1500)) throw new Error('Hold required');
    this.sendReply({ id: entry.message.id, result: { decision: input.decision } });
    this.requests.delete(input.requestId);
  }
  answer(input) {
    this.expire();
    const entry = this.requests.get(input.requestId);
    if (!entry || this.current()?.requestId !== input.requestId || entry.request.type !== 'question' ||
        entry.request.questionId !== input.questionId) throw new Error('Stale question');
    if (input.cancel === true) {
      this.sendReply({ id: entry.message.id, ...(entry.message.asyncQuestion ? { asyncQuestion: true, questionItemId: entry.message.questionItemId, question: entry.request.question } : {}), result: { answers: {} } });
      this.requests.delete(input.requestId); return;
    }
    if (!Number.isInteger(input.choice) || input.choice < 0 || input.choice >= entry.request.options.length)
      throw new Error('Invalid choice');
    Object.defineProperty(entry.answers, entry.request.questionId, { enumerable: true,
      value: { answers: [entry.request.options[input.choice].label] } });
    const next = entry.message.params.questions[entry.request.index];
    if (next) {
      Object.assign(entry.request, { questionId: next.id, question: next.question, options: next.options, index: entry.request.index + 1 });
    } else {
      this.sendReply({ id: entry.message.id, ...(entry.message.asyncQuestion ? { asyncQuestion: true, questionItemId: entry.message.questionItemId, question: entry.request.question, answer: entry.request.options[input.choice].label } : {}), result: { answers: entry.answers } });
      this.requests.delete(input.requestId);
    }
  }
  invalidate(requestId) { this.requests.delete(String(requestId)); }
  cancelAll() {
    for (const entry of this.requests.values()) this.sendReply({ id: entry.message.id, result: cancellation(entry) });
    this.requests.clear();
  }
}
