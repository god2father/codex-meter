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

const demo = process.argv.includes('--demo');
const simulator = process.argv.includes('--simulator');
const lan = process.argv.includes('--lan');
const desktop = process.argv.includes('--desktop');
if (desktop && demo) throw new Error('Desktop and demo modes are incompatible');
const config = networkConfig(process.env, { demo, simulator, lan });
const { host, port, token, deviceToken } = config;
let enrollment;
let device;
let app;
let session;
let quota;
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
  client.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'ready') { if (desktop) replayDesktop(); publish(); return; }
      if (m.type === 'answer') queue.answer(m);
      else if (m.type === 'decision') queue.decide(m);
      else throw new Error('Unsupported message');
      publish();
    } catch { client.send(JSON.stringify({ type: 'error', message: '无效或已过期的请求' })); publish(); }
  });
  client.on('error', () => client.terminate());
  client.on('close', () => { if (device === client) { device = undefined; if (desktop) queue.requests.clear(); else queue.cancelAll(); } });
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
  app = new DesktopIpc(process.env.PASSPORT_DESKTOP_THREAD, { socketPath: process.env.CODEX_DESKTOP_IPC_PATH });
  const chats = readDesktopChats(process.env.PASSPORT_DESKTOP_CHATS);
  const titleFor = id => Array.from(chats.find(chat => chat.id === id)?.title ?? '').slice(0, 64).join('').replace(/[\p{Cc}\u2028\u2029]/gu, ' ');
  handleDesktopControl = desktopControl({ config, app, chats,
    askQuestion: askAssistantQuestion, getQuestion: questionState, getQuota: () => quota?.snapshot() ?? null });
  session = new PassportSession(app, publish);
  session.threadId = app.threadId;
  session.threadTitle = titleFor(app.threadId);
  app.on('selected', threadId => {
    queue.requests.clear(); session.threadId = threadId; session.turnId = null;
    session.threadTitle = titleFor(threadId);
    session.cwd = ''; session.state = 'idle'; publish();
  });
  app.on('resolved', id => { queue.invalidate(id); publish(); });
  app.on('state', state => {
    session.cwd = state.cwd ?? '';
    const turns = state.turns ?? [];
    const turn = turns.at(-1);
    session.turnId = turn?.id ?? null;
    session.state = desktopStatus(state);
    publish();
  });
  app.on('request', (request, state) => forwardDesktop(request, state));
  app.on('closed', () => {
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
  if (desktop) {
    let expired = false;
    for (const [id, entry] of queue.requests) if (Date.now() >= entry.expires) { queue.invalidate(id); expired = true; }
    if (expired) publish(); // Expiry leaves Desktop's native request unanswered.
  } else if (queue.expire()) publish();
}, 1000);
expiry.unref();
function shutdown() { enrollment?.close(); stopping = true; quota?.stop(); clearTimeout(reconnectTimer); clearInterval(heartbeat); clearInterval(expiry); if (desktop) queue.requests.clear(); else queue.cancelAll(); device?.close(); ws.close(); server.close(); app?.close(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
