import { createEnrollment } from './enrollment.mjs';
import { networkConfig, createBridgeServer, isLoopback } from './network.mjs';
import { WebSocketServer } from 'ws';
import { ApprovalQueue } from './protocol.mjs';
import { AppServer } from './app-server.mjs';
import { PassportSession } from './session.mjs';
import { DesktopIpc, desktopStatus } from './desktop-ipc.mjs';
import { desktopControl, readDesktopChats } from './desktop-control.mjs';
import { randomUUID } from 'node:crypto';
import { AccountQuota } from './quota.mjs';
import { encodeDeviceMessage } from './device-message.mjs';
import { DeviceChats, loadChatTarget, saveChatTarget } from './device-chats.mjs';
import { ChatContent, chatContent, chatMessages } from './chat-content.mjs';
import { TextSubmission } from './text-submission.mjs';
import { VoiceSession } from './voice-session.mjs';
import { funAsrConfig, transcribePcm } from './funasr.mjs';

const demo = process.argv.includes('--demo');
const simulator = process.argv.includes('--simulator');
const lan = process.argv.includes('--lan');
const desktop = process.argv.includes('--desktop');
if (desktop && demo) throw new Error('Desktop and demo modes are incompatible');
const config = networkConfig(process.env, { demo, simulator, lan });
const { host, port, token, deviceToken } = config;
const asrConfig = funAsrConfig(process.env);
let enrollment;
let device;
let app;
let session;
let quota;
let deviceChats;
let textSubmission;
let voice;
let selectedChatTitle = null;
let selectingChat = false;
let contentReader, contentText = '', contentReadAt = 0, contentVersion = 0;
let contentLive = false;
let contentMessages = [];
async function refreshContent() {
  if (!desktop || !contentReader || contentReader.busy || contentLive || device?.readyState !== 1 || !app?.threadId) return;
  const threadId = app.threadId, generation = app.generation;
  const version = contentVersion, deviceVersion = deviceGeneration;
  contentReadAt = Date.now();
  const content = await contentReader.read(threadId);
  if (content !== null && !contentLive && generation === app.generation && threadId === app.threadId && version === contentVersion &&
      deviceVersion === deviceGeneration && device?.readyState === 1 && content.text !== contentText) {
    contentText = content.text; contentMessages = content.messages; publish();
  }
}
let demoId = 0;
let handleDesktopControl;
let assistantQuestion;
let deviceGeneration = 0;
const items = new Map();
const queue = new ApprovalQueue(reply => {
  if (assistantQuestion?.id === String(reply.id)) {
    if (questionState(assistantQuestion.id).state !== 'pending') throw new Error('Stale assistant question');
    assistantQuestion.state = Object.keys(reply.result.answers ?? {}).length ? 'answered' : 'cancelled';
    assistantQuestion.result = reply.result;
    return;
  }
  if (desktop && reply.asyncQuestion) {
    const entry = app?.requests.get(String(reply.id));
    if (!entry || reply.answer === undefined) return;
    app.submitAsyncQuestion(entry, reply.answer).catch(() => {
      session.state = 'failed'; publish();
      device?.send(JSON.stringify({ type: 'error', message: '回传未确认，请在电脑处理提问' }));
    });
    return;
  }
  if (demo) console.log(JSON.stringify({ event: 'decision', ...reply }));
  else if (desktop) {
    const generation = app.generation;
    app.reply(reply).catch(() => {
      if (generation !== app.generation) return;
      session.state = 'failed'; publish();
      device?.send(JSON.stringify({ type: 'error', message: '回传未确认，请在桌面处理审批' }));
      console.log(JSON.stringify({ event: 'desktopReplyFailed' }));
    });
  } else { app.send(reply); console.log(JSON.stringify({ event: reply.result.answers ? 'answer' : 'decision', decision: reply.result.decision })); }
}, Date.now, { replyOnExpiry: !desktop });
function questionState(id) {
  if (!assistantQuestion || id !== assistantQuestion.id) throw Object.assign(new Error('Unknown question'), { statusCode: 404 });
  if (assistantQuestion.generation !== app.generation || assistantQuestion.deviceGeneration !== deviceGeneration) {
    queue.invalidate(assistantQuestion.id); assistantQuestion.state = 'cancelled'; delete assistantQuestion.result;
  } else if (assistantQuestion.state === 'pending' && !queue.requests.has(assistantQuestion.id)) assistantQuestion.state = 'expired';
  return assistantQuestion;
}
function askAssistantQuestion(questions) {
  if (!app.threadId || app.closed || !device || device.readyState !== 1 || queue.current()) throw new Error('Device unavailable or busy');
  if (!Array.isArray(questions) || questions.length !== 1 || questions[0]?.options?.length < 2) throw new Error('A single choice question required');
  const id = `assistant-question-${randomUUID()}`;
  voice?.invalidate(); textSubmission?.invalidate();
  const request = queue.add({ id, method: 'item/tool/requestUserInput', params: {
    threadId: app.threadId, turnId: 'assistant-question', questions
  } });
  if (Buffer.byteLength(JSON.stringify(request)) > 3500) { queue.invalidate(id); throw new Error('Question too large'); }
  assistantQuestion = { id, threadId: app.threadId, state: 'pending', generation: app.generation, deviceGeneration };
  publish(); return questionState(id);
}
function publish() {
  const limits = quota?.snapshot() ?? null;
  const lineFor = window => {
    if (!window) return '额度：待更新';
    const duration = window.durationMins === 300 ? '5h' : window.durationMins === 10080 ? '7d' : `${window.durationMins}m`;
    const date = new Date(window.resetsAt * 1000);
    let reset;
    try {
      const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.PASSPORT_TIMEZONE || undefined,
        ...(window.durationMins < 1440 ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: '2-digit', day: '2-digit' }) });
      if (window.durationMins < 1440) reset = formatter.format(date);
      else {
        const parts = formatter.formatToParts(date);
        reset = `${parts.find(part => part.type === 'month').value}-${parts.find(part => part.type === 'day').value}`;
      }
    } catch { return '额度：待更新'; }
    return `${duration} 余${window.remainingPercent}% @${reset}`;
  };
  if (device?.readyState === 1) device.send(encodeDeviceMessage({
    ...(queue.current() ?? { ...(session?.snapshot() ?? { type: 'status', state: 'idle' }), clearApproval: true }),
    threadId: session?.threadId ?? null, threadTitle: session?.threadTitle ?? '',
    synced: desktop ? !app?.closed && app?.state !== undefined : true,
    voiceAvailable: !!voice?.transcribe,
    ...(queue.current() ? {} : { content: contentText, messages: contentMessages }),
    quota: limits ? { ...limits, lines: [lineFor(limits.primary), lineFor(limits.secondary)] } : null
  }) ?? JSON.stringify({ type: 'error', message: '请求过长，请在电脑处理' }));
}
function demoRequest() {
  if (!queue.current()) queue.add({ id: ++demoId, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'demo', turnId: 'demo', command: 'git reset --hard HEAD', cwd: '/demo/project', reason: '模拟请求，不执行命令'
  } });
  publish();
}
const server = createBridgeServer(config, async (req, res) => {
  if (handleDesktopControl && await handleDesktopControl(req, res)) return;
  if (!demo && req.url === '/control' && req.method === 'POST') {
    if (!isLoopback(req.socket.remoteAddress) || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      res.writeHead(403); res.end(); return;
    }
    try {
      if (desktop) throw new Error('Desktop chat is controlled in Desktop');
      req.setEncoding('utf8');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 20000) throw new Error('Request too large');
      }
      const input = JSON.parse(body);
      if (input.action === 'start') await session.start(input.cwd);
      else if (input.action === 'run') await session.run(input.text, input.mode);
      else if (input.action === 'interrupt') await session.interrupt();
      else throw new Error('Unsupported action');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(session.snapshot()));
    } catch { res.writeHead(400); res.end('Invalid control request or app-server unavailable'); }
  } else if (req.url === '/passport-check' && req.method === 'GET') {
    res.writeHead(!req.headers.origin && req.headers.authorization === `Bearer ${deviceToken}` ? 200 : 401); res.end();
  } else if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode: demo ? 'demo' : desktop ? 'desktop' : 'app-server', connected: !!device,
      pending: queue.requests.size, state: queue.current() ? 'waitingApproval' : session?.state ?? 'idle' }));
  } else if (demo && req.url === '/demo' && req.method === 'POST') {
    demoRequest(); res.writeHead(204); res.end();
  } else if (demo && req.url === '/demo/question' && req.method === 'POST') {
    queue.cancelAll();
    queue.add({ id: ++demoId, method: 'item/tool/requestUserInput', params: {
      threadId: 'demo', turnId: 'demo', questions: [{ id: 'route', question: '下一步优先开发哪个功能？', options: [
        { label: '本地语音输入', description: '电脑离线识别，设备确认后发送' },
        { label: '状态副屏', description: '显示当前任务和完成提示' }
      ] }]
    } });
    publish(); res.writeHead(204); res.end();
  } else { res.writeHead(404); res.end(); }
});
const ws = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/passport' || (req.headers.origin && !demo) ||
      (!demo && !simulator && req.headers.authorization !== `Bearer ${deviceToken}`) || device) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client));
});
ws.on('connection', client => {
  enrollment?.finish();
  device = client; deviceGeneration++;
  client.alive = true;
  client.on('pong', () => { client.alive = true; });
  if (demo) demoRequest(); else { if (desktop) replayDesktop(); publish(); }
  void refreshContent();
  client.on('message', async (raw, binary) => {
    let chatRequestId;
    let historyThreadId;
    try {
      if (binary) {
        if (!voice || queue.current() || selectingChat) throw new Error('Audio unavailable');
        voice.receive(raw); return;
      }
      const m = JSON.parse(raw.toString());
      if (m.type === 'ready') { if (desktop) replayDesktop(); publish(); return; }
      if (['voiceStart', 'voiceStop', 'voiceCancel', 'voicePage', 'voiceConfirm'].includes(m.type)) {
        if (!voice || queue.current() || selectingChat) throw new Error('Voice unavailable');
        const generation = deviceGeneration;
        let result;
        if (m.type === 'voiceStart') result = voice.start(m.threadId);
        else {
          if (m.id !== voice.current?.id) throw new Error('Stale recording');
          if (m.type === 'voiceStop') result = await voice.stop(m.id);
          else if (m.type === 'voiceCancel') result = voice.cancel(m.id);
          else if (m.type === 'voicePage') result = voice.snapshot(m.page);
          else result = await voice.confirm(m.id, m.submissionId);
        }
        if (result && device === client && generation === deviceGeneration) client.send(JSON.stringify(result));
        return;
      }
      if (['textPrepare', 'textConfirm', 'textCancel'].includes(m.type)) {
        if (!textSubmission || selectingChat || queue.current()) throw new Error('Submission unavailable');
        const generation = deviceGeneration;
        const result = m.type === 'textPrepare' ? textSubmission.prepare(m.text) :
          m.type === 'textCancel' ? textSubmission.cancel(m.id) : await textSubmission.confirm(m.id);
        if (result && device === client && generation === deviceGeneration) client.send(JSON.stringify(result));
        return;
      }
      if (m.type === 'history') {
        if (!Number.isInteger(m.requestId) || m.requestId < 0 || m.requestId > 0xffffffff) throw new Error('Invalid history request');
        chatRequestId = m.requestId;
        historyThreadId = typeof m.threadId === 'string' && m.threadId.length < 64 ? m.threadId : '';
        if (!desktop || !contentReader || app.closed || selectingChat || queue.current() ||
            !historyThreadId || historyThreadId !== app.threadId) throw new Error('History unavailable');
        const generation = app.generation, deviceVersion = deviceGeneration;
        const page = await contentReader.history(historyThreadId, m.page, m.revision ?? '');
        if (device !== client || deviceVersion !== deviceGeneration || generation !== app.generation || historyThreadId !== app.threadId) return;
        if (queue.current()) throw new Error('Device busy');
        const wire = encodeDeviceMessage({ type: 'history', threadId: historyThreadId, requestId: chatRequestId, ...page });
        if (!wire) throw new Error('History frame too large');
        client.send(wire); return;
      }
      if (m.type === 'chats' && desktop && deviceChats) {
        if (!Number.isInteger(m.requestId) || m.requestId < 0 || m.requestId > 0xffffffff) throw new Error('Invalid chat request');
        chatRequestId = m.requestId;
        if (selectingChat || queue.current()) throw new Error('Device busy');
        selectingChat = true;
        const generation = deviceGeneration;
        try {
          const page = await deviceChats.list(m.page);
          if (device !== client || generation !== deviceGeneration) return;
          if (queue.current() || assistantQuestion?.state === 'pending') { deviceChats.invalidate(); publish(); return; }
          client.send(JSON.stringify({ ...page, requestId: chatRequestId }));
        } finally { selectingChat = false; }
        return;
      }
      if (m.type === 'selectChat' && desktop && deviceChats) {
        if (selectingChat || queue.current() || app.closed) throw new Error('Device busy');
        const chat = deviceChats.target(m.revision, m.threadId);
        saveChatTarget(process.env.PASSPORT_SELECTED_CHAT_FILE, chat);
        selectedChatTitle = chat.title;
        app.select(chat.id); selectedChatTitle = null;
        session.threadTitle = chat.title;
        publish(); return;
      }
      if (m.type === 'answer') queue.answer(m);
      else if (m.type === 'decision') queue.decide(m);
      else throw new Error('Unsupported message');
      publish();
    } catch { if (device === client && client.readyState === 1) { client.send(JSON.stringify({ type: 'error', message: '无效或已过期的请求', ...(chatRequestId === undefined ? {} : { requestId: chatRequestId }), ...(historyThreadId === undefined ? {} : { threadId: historyThreadId }) })); publish(); } }
  });
  client.on('error', () => client.terminate());
  client.on('close', () => { if (device === client) { device = undefined; voice?.invalidate(); textSubmission?.invalidate(); deviceChats?.invalidate(); contentReader?.invalidateHistory(); if (desktop) queue.requests.clear(); else queue.cancelAll(); } });
});
let stopping = false;
let reconnectTimer;
async function connectDesktop() {
  try { await app.initialize(); }
  catch { app.close(); if (!stopping) scheduleDesktopReconnect(); }
}
function scheduleDesktopReconnect() {
  if (reconnectTimer || stopping) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connectDesktop(); }, 1000);
}
function forwardDesktop(request, state) {
  if (!device || queue.requests.has(String(request.id))) return;
  try {
    voice?.invalidate(); textSubmission?.invalidate();
    const item = (state.turns ?? []).flatMap(turn => turn.items ?? []).find(item => item.id === request.params.itemId);
    const normalized = queue.add(request, item, session.cwd);
    if (Buffer.byteLength(JSON.stringify(normalized)) > 3500) queue.invalidate(normalized.requestId);
    else if (assistantQuestion?.state === 'pending') {
      queue.invalidate(assistantQuestion.id); assistantQuestion.state = 'cancelled';
    }
    publish();
  } catch { console.log(JSON.stringify({ event: 'desktopRequestUnsupported' })); }
}
function replayDesktop() {
  for (const entry of app?.requests.values() ?? []) {
    if (!entry.inFlight) forwardDesktop(entry.request, app.state ?? {});
  }
}
if (desktop) {
  deviceChats = new DeviceChats(() => new AppServer(process.env.PASSPORT_QUOTA_CLI || process.env.CODEX_BIN || 'codex'));
  contentReader = new ChatContent(() => new AppServer(process.env.PASSPORT_QUOTA_CLI || process.env.CODEX_BIN || 'codex'));
  const savedChat = loadChatTarget(process.env.PASSPORT_SELECTED_CHAT_FILE);
  app = new DesktopIpc(savedChat?.id ?? process.env.PASSPORT_DESKTOP_THREAD, { socketPath: process.env.CODEX_DESKTOP_IPC_PATH });
  const chats = readDesktopChats(process.env.PASSPORT_DESKTOP_CHATS);
  const titleFor = id => Array.from(chats.find(chat => chat.id === id)?.title ?? '').slice(0, 64).join('').replace(/[\p{Cc}\u2028\u2029]/gu, ' ');
  handleDesktopControl = desktopControl({ config, app, chats,
    askQuestion: askAssistantQuestion, getQuestion: questionState, getQuota: () => quota?.snapshot() ?? null });
  session = new PassportSession(app, publish);
  textSubmission = new TextSubmission(app);
  voice = new VoiceSession({ app, submission: textSubmission,
    transcribe: asrConfig ? (pcm, options) => transcribePcm(asrConfig, pcm, options) : null,
    emit: message => { if (device?.readyState === 1) device.send(JSON.stringify(message)); } });
  session.threadId = app.threadId;
  session.threadTitle = savedChat?.title ?? titleFor(app.threadId);
  app.on('selected', threadId => {
    voice.invalidate(); textSubmission.invalidate();
    contentReader.invalidateHistory();
    contentText = ''; contentMessages = []; contentReadAt = 0; contentVersion++; contentLive = false;
    queue.requests.clear(); session.threadId = threadId; session.turnId = null;
    session.threadTitle = selectedChatTitle ?? titleFor(threadId);
    selectedChatTitle = null;
    session.cwd = ''; session.state = 'idle'; publish();
    void refreshContent();
  });
  app.on('resolved', id => { queue.invalidate(id); publish(); });
  app.on('state', state => {
    if (voice.current && !voice.targetValid(voice.current)) voice.invalidate();
    const content = chatContent(state);
    contentLive = !!content;
    if (content) { contentText = content; contentMessages = chatMessages(state); contentVersion++; }
    session.cwd = state.cwd ?? '';
    const turns = state.turns ?? [];
    const turn = turns.at(-1);
    session.turnId = turn?.id ?? null;
    session.state = desktopStatus(state);
    publish();
  });
  app.on('request', (request, state) => forwardDesktop(request, state));
  app.on('closed', () => {
    voice.invalidate(); textSubmission.invalidate();
    queue.requests.clear(); session.state = 'failed'; publish();
    if (!stopping) scheduleDesktopReconnect();
  });
  await connectDesktop();
  if (process.env.PASSPORT_QUOTA_CLI) {
    quota = new AccountQuota(() => new AppServer(process.env.PASSPORT_QUOTA_CLI), publish);
    quota.start().catch(() => {});
  }
  console.log('desktop IPC connection attempted');
} else if (!demo) {
  app = new AppServer(process.env.CODEX_BIN ?? 'codex');
  session = new PassportSession(app, publish);
  app.on('message', m => {
    if (m.method === 'turn/completed' && m.params.threadId === session.threadId && m.params.turn.id === session.turnId) { queue.cancelAll(); items.clear(); }
    session.notification(m);
    if (m.method === 'turn/completed' && m.params.threadId === session.threadId) console.log(JSON.stringify({ event: 'turn', state: session.state }));
    if (m.method === 'item/completed' && m.params.threadId === session.threadId && m.params.item.type === 'commandExecution') console.log(JSON.stringify({ event: 'commandCompleted', status: m.params.item.status, exitCode: m.params.item.exitCode }));
    if (m.method === 'item/started' && m.params.threadId === session.threadId) items.set(m.params.item.id, m.params.item);
    if (m.method === 'item/completed' && m.params.threadId === session.threadId) items.delete(m.params.item.id);
    if (m.method === 'serverRequest/resolved') { queue.invalidate(m.params.requestId); publish(); }
    if ((m.method?.endsWith('/requestApproval') || m.method === 'item/tool/requestUserInput') && m.id !== undefined) {
      const cancellation = m.method === 'item/tool/requestUserInput' ? { answers: {} } : { decision: 'cancel' };
      try {
        if (m.params.threadId !== session.threadId || m.params.turnId !== session.turnId || !device) {
          app.send({ id: m.id, result: cancellation }); return;
        }
        const r = queue.add(m, items.get(m.params.itemId), session.cwd);
        if (Buffer.byteLength(JSON.stringify(r)) > 3500) {
          queue.invalidate(r.requestId); app.send({ id: m.id, result: cancellation });
        }
        console.log(JSON.stringify({ event: 'approval', kind: r.kind }));
        publish();
      } catch { app.send({ id: m.id, error: { code: -32601, message: 'Unsupported approval' } }); }
    }
  });
  app.on('closed', () => { queue.requests.clear(); session.state = 'failed'; publish(); });
  await app.initialize();
  console.log('app-server initialized');
}
if (lan && process.env.PASSPORT_ENROLLMENT_FILE) enrollment = await createEnrollment({ file: process.env.PASSPORT_ENROLLMENT_FILE, ...(process.env.PASSPORT_ENROLLMENT_DISCOVERY_PORT !== undefined ? { discoveryPort: Number(process.env.PASSPORT_ENROLLMENT_DISCOVERY_PORT) } : {}) });
server.on('error', () => { enrollment?.close(); shutdown(); });
server.listen(port, host, () => console.log(`Passport Bridge ${demo ? 'demo' : desktop ? 'desktop' : 'app-server'}: ${host}:${port}`));
const heartbeat = setInterval(() => {
  if (!device) return;
  if (!device.alive) { device.terminate(); return; }
  device.alive = false; device.ping();
}, config.heartbeatMs);
heartbeat.unref();
const expiry = setInterval(() => {
  if (desktop && Date.now() - contentReadAt >= 10000) void refreshContent();
  if (desktop) {
    let expired = false;
    for (const [id, entry] of queue.requests) if (Date.now() >= entry.expires) { queue.invalidate(id); expired = true; }
    if (expired) publish(); // Expiry leaves Desktop's native request unanswered.
  } else if (queue.expire()) publish();
}, 1000);
expiry.unref();
function shutdown() { contentReader?.close(); deviceChats?.close(); enrollment?.close(); stopping = true; quota?.stop(); clearTimeout(reconnectTimer); clearInterval(heartbeat); clearInterval(expiry); if (desktop) queue.requests.clear(); else queue.cancelAll(); device?.close(); ws.close(); server.close(); app?.close(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
