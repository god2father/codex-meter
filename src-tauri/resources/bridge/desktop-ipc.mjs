import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { extractDesktopQuestions, asyncQuestionReply } from './desktop-questions.mjs';

const MAX_FRAME = 16 * 1024 * 1024;
const responseMethods = new Map([
  ['item/commandExecution/requestApproval', 'thread-follower-command-approval-decision'],
  ['item/fileChange/requestApproval', 'thread-follower-file-approval-decision'],
  ['item/tool/requestUserInput', 'thread-follower-submit-user-input'],
]);

export function desktopStatus(state) {
  // Desktop may omit turn history from the initial snapshot of a running chat.
  if (state.threadRuntimeStatus?.type === 'active') return 'running';
  const turn = (state.turns ?? []).at(-1);
  return { inProgress: 'running', completed: 'completed', interrupted: 'cancelled', failed: 'failed' }[turn?.status] ?? 'idle';
}

function nativeRequestKey(threadId, owner, request) {
  return JSON.stringify([threadId, owner, request.method, typeof request.id, request.id]);
}

function requestFingerprint(owner, request, state) {
  const item = (state.turns ?? []).flatMap(turn => turn.items ?? []).find(item => item.id === request.params?.itemId) ?? {};
  const params = request.params ?? {};
  const details = request.method === 'item/tool/requestUserInput' ? null : {
    command: params.command ?? item.command ?? '',
    cwd: params.cwd ?? item.cwd ?? state.cwd ?? '',
    changes: request.method === 'item/fileChange/requestApproval' ? item.changes ?? [] : null,
  };
  return JSON.stringify({ owner, request, details });
}

export function patchState(state, patches) {
  const result = structuredClone(state);
  for (const patch of patches) {
    const keys = patch.path;
    if (!Array.isArray(keys) || !keys.length || keys.some(k =>
      !['string', 'number'].includes(typeof k) || ['__proto__', 'constructor', 'prototype'].includes(k)))
      throw new Error('Invalid desktop patch');
    let parent = result;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('Missing patch parent');
      parent = parent[key];
    }
    const key = keys.at(-1);
    if (!parent || typeof parent !== 'object' || !['add', 'replace', 'remove'].includes(patch.op)) throw new Error('Invalid patch');
    if (Array.isArray(parent)) {
      if (!Number.isInteger(key) || key < 0 || key > parent.length || (patch.op !== 'add' && key === parent.length)) throw new Error('Invalid array index');
      if (patch.op === 'remove') parent.splice(key, 1);
      else if (patch.op === 'add') parent.splice(key, 0, structuredClone(patch.value));
      else parent[key] = structuredClone(patch.value);
    } else if (patch.op === 'remove') delete parent[key];
    else parent[key] = structuredClone(patch.value);
  }
  return result;
}

// Same-user Desktop follower protocol. Never starts a competing app-server.
export class DesktopIpc extends EventEmitter {
  constructor(threadId = null, options = {}) {
    super();
    if (threadId !== null && (typeof threadId !== 'string' || !threadId)) throw new Error('Invalid desktop target');
    this.threadId = threadId;
    this.generation = 0; this.revision = 0;
    const current = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock');
    this.socketPath = options.socketPath ?? (existsSync(current) ? current : path.join(os.tmpdir(), 'codex-ipc', `ipc-${process.getuid()}.sock`));
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.submitted = new Map(); this.pending = new Map(); this.requests = new Map(); this.asyncAnswered = new Set(); this.buffer = Buffer.alloc(0);
    this.clientId = 'initializing-client'; this.closed = true;
  }
  select(threadId) {
    if (threadId !== null && (typeof threadId !== 'string' || !threadId)) throw new Error('Invalid desktop target');
    if (threadId === this.threadId) return;
    const previous = this.threadId;
    this.generation++;
    this.threadId = threadId;
    this.requests.clear(); this.state = undefined; this.owner = undefined;
    this.emit('selected', threadId);
    if (!this.closed && this.clientId !== 'initializing-client') {
      this.follow(previous, false); this.follow(threadId, true);
    }
  }
  follow(threadId, following) {
    if (!threadId) return;
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this.clientId, params: { conversationId: threadId, hostId: 'local', following } });
  }
  async initialize() {
    this.closed = false;
    await new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error('Desktop connect timeout')); }, this.timeoutMs);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', () => { clearTimeout(timer); reject(new Error('Desktop unavailable')); });
      this.socket.on('data', chunk => this.read(chunk));
      this.socket.on('close', () => this.disconnected());
      this.socket.on('error', () => this.disconnected());
    });
    const result = await this.rpc('initialize', { clientType: 'codex-passport' }, 0);
    if (typeof result?.clientId !== 'string') { this.close(); throw new Error('Desktop protocol incompatible'); }
    this.clientId = result.clientId;
    this.follow(this.threadId, true);
  }
  write(message) {
    if (this.closed || !this.socket?.writable) throw new Error('Desktop disconnected');
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME) throw new Error('Desktop frame too large');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  rpc(method, params, version = 1, targetClientId) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Desktop RPC timeout')); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params,
        ...(targetClientId ? { targetClientId } : {}) }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE();
        if (!size || size > MAX_FRAME) throw new Error('Invalid frame size');
        if (this.buffer.length < size + 4) return;
        const frame = JSON.parse(this.buffer.subarray(4, size + 4));
        this.buffer = this.buffer.subarray(size + 4); this.frame(frame);
      }
    } catch { this.emit('protocolError'); this.close(); }
  }
  frame(frame) {
    if (frame.type === 'response') {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(frame.requestId);
      if (frame.resultType === 'success') pending.resolve(frame.result);
      else pending.reject(new Error('Desktop rejected request')); // Do not expose private payloads.
    } else if (frame.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: frame.requestId, response: { canHandle: false } });
    } else if (this.threadId !== null && frame.type === 'broadcast' && frame.method === 'thread-stream-state-changed' && frame.params?.conversationId === this.threadId) {
      const change = frame.params.change;
      if (change?.type === 'snapshot') this.state = structuredClone(change.conversationState);
      else if (change?.type === 'patches' && this.state && frame.sourceClientId === this.owner) this.state = patchState(this.state, change.patches);
      else return;
      if (typeof frame.sourceClientId !== 'string' || !this.state || typeof this.state !== 'object') return;
      this.owner = frame.sourceClientId;
      const extracted = extractDesktopQuestions({ ...this.state, id: this.threadId });
      const currentAsyncIds = new Set(extracted.requests.map(request => request.questionItemId));
      for (const id of this.asyncAnswered) if (!currentAsyncIds.has(id)) this.asyncAnswered.delete(id);
      const synthetic = extracted.requests.filter(request => !this.asyncAnswered.has(request.questionItemId)).map(request => ({ ...request, asyncQuestion: true }));
      this.state = { ...this.state, requests: [...(this.state.requests ?? []), ...synthetic] };
      const nativeKeys = new Set((this.state.requests ?? []).filter(request => !request.asyncQuestion).map(request => nativeRequestKey(this.threadId, this.owner, request)));
      for (const [key, submission] of this.submitted) {
        if (submission.settled && submission.threadId === this.threadId && submission.owner === this.owner &&
            !nativeKeys.has(key)) this.submitted.delete(key);
      }
      const next = new Map();
      for (const request of this.state.requests ?? []) {
        if (!responseMethods.has(request.method) || !['string', 'number'].includes(typeof request.id)) continue;
        const nativeKey = nativeRequestKey(this.threadId, this.owner, request);
        if (this.submitted.has(nativeKey)) continue;
        const fingerprint = requestFingerprint(this.owner, request, this.state);
        const existing = [...this.requests.values()].find(entry =>
          entry.nativeId === request.id && entry.fingerprint === fingerprint);
        // Changed content/owner is a new physical approval, even if native id is reused.
        const id = existing?.request.id ?? (this.generation || this.revision ?
          `${this.generation}:${++this.revision}:${request.id}` : request.id);
        const normalized = { ...request, id, params: { ...request.params, threadId: this.threadId } };
        next.set(String(id), existing ?? { request: normalized, nativeId: request.id, owner: this.owner, fingerprint, nativeKey });
        if (!existing) this.revision++;
      }
      for (const [id] of this.requests) if (!next.has(id)) this.emit('resolved', id);
      const previous = this.requests; this.requests = next;
      this.emit('state', this.state);
      for (const [id, entry] of next) if (!previous.has(id)) this.emit('request', entry.request, this.state);
    }
  }
  async reply(reply) {
    const entry = this.requests.get(String(reply.id));
    if (!entry) throw new Error('Desktop request expired');
    const nativeKey = entry.nativeKey ?? nativeRequestKey(this.threadId, entry.owner, { ...entry.request, id: entry.nativeId ?? entry.request.id });
    if (this.submitted.has(nativeKey)) throw new Error('Desktop request expired');
    const submission = { settled: false, threadId: this.threadId, owner: entry.owner };
    this.submitted.set(nativeKey, submission);
    entry.inFlight = true;
    const method = responseMethods.get(entry.request.method);
    const params = { conversationId: this.threadId, requestId: entry.nativeId ?? entry.request.id };
    if (entry.request.method === 'item/tool/requestUserInput') params.response = reply.result;
    else params.decision = reply.result.decision;
    try { await this.rpc(method, params, 1, entry.owner); }
    finally {
      // A timeout may mean the owner accepted the decision but its ack was lost.
      // Leave uncertain requests to Desktop rather than submitting them twice.
      if (this.submitted.get(nativeKey) === submission) submission.settled = true;
      if (this.requests.get(String(reply.id)) === entry) this.requests.delete(String(reply.id));
    }
  }
  async submitAsyncQuestion(entry, answer) {
    if (!entry?.asyncQuestion || !entry.request?.questionItemId) throw new Error('Not an async question');
    const question = entry.request.params.questions[0];
    const text = asyncQuestionReply(entry.request.questionItemId, question.question, answer);
    const result = await this.rpc('thread-follower-start-turn', {
      conversationId: this.threadId,
      turnStart: { request: { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }] }, context: {} },
    }, 1, entry.owner);
    this.asyncAnswered.add(entry.request.questionItemId);
    this.requests.delete(String(entry.request.id));
    return result;
  }
  disconnected() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.clientId = 'initializing-client'; this.owner = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Desktop disconnected')); }
    this.pending.clear(); this.requests.clear(); this.state = undefined; this.buffer = Buffer.alloc(0);
    this.emit('closed');
  }
  close() { this.socket?.destroy(); this.disconnected(); }
}
