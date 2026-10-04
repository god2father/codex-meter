import http from 'node:http';
import dgram from 'node:dgram';
import { readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { createCipheriv, createHash, createECDH, hkdfSync, randomBytes } from 'node:crypto';

export const DISCOVERY_PORT = 8799;
export const PENDING_TTL_MS = 120000;
export function normalizeCode(code) {
  const value = typeof code === 'string' ? code.trim() : '';
  if (!/^[0-9]{4}$/.test(value)) throw new Error('Invalid binding code');
  return value;
}
export function exchangeKey(shared, challenge) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(challenge), 'codex-passport-enroll-v2', 32));
}
export function exchangeFingerprint(client, server, challenge) {
  return createHash('sha256').update(client).update(server).update(challenge).digest('hex').slice(0, 16).toUpperCase();
}
export function encryptBinding(key, challenge, pairing, now = Date.now()) {
  if (!/^[a-f0-9]{32}$/.test(challenge) || key.length !== 32) throw new Error('Invalid exchange');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(challenge));
  const plaintext = Buffer.from(JSON.stringify({ ...pairing, unixTime: Math.floor(now / 1000) }));
  if (plaintext.length > 4096) throw new Error('Binding exceeds device capacity');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function privateAddress(address) {
  const ip = address?.replace(/^::ffff:/, '').split('.').map(Number);
  return ip?.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168));
}
export async function createEnrollment({ file, discoveryPort = DISCOVERY_PORT, host = '0.0.0.0', now = Date.now }) {
  if (!Number.isInteger(discoveryPort) || discoveryPort < 0 || discoveryPort > 65535) throw new Error('Invalid discovery port');
  const pendingFile = file.replace(/[^/\\]+$/, 'pending-enrollment.json');
  let session, attempts = 0, pending;
  const clearPending = () => { pending?.key.fill(0); pending = undefined; try { unlinkSync(pendingFile); } catch {} };
  const active = () => {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      normalizeCode(value.code);
      if (!/^[a-f0-9]{64}$/.test(value.sessionId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now() || value.expiresAt > now() + 301000) { clearPending(); return null; }
      if (session !== value.sessionId) { clearPending(); session = value.sessionId; attempts = 0; }
      if (pending && pending.expiresAt <= now()) clearPending();
      if (pending && value.rejectedRequestId === pending.requestId) { attempts = 5; clearPending(); }
      return attempts < 5 ? value : null;
    } catch { clearPending(); return null; }
  };
  let count = 0, window = 0;
  const allow = () => { const second = Math.floor(now() / 1000); if (second !== window) { window = second; count = 0; } return ++count <= 12; };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let entry = active();
    if (!entry || req.url !== '/enroll' || req.method !== 'POST' || req.headers.origin || !privateAddress(req.socket.remoteAddress) || !allow()) { res.writeHead(403); res.end(); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 384) throw new Error('Oversize request'); }
      entry = active(); if (!entry) { res.writeHead(403); res.end(); return; }
      const input = JSON.parse(body), challenge = input.challenge, publicKey = input.publicKey;
      if (normalizeCode(input.code) !== entry.code) { attempts++; if (attempts >= 5) clearPending(); res.writeHead(403); res.end(); return; }
      if (!/^[a-f0-9]{32}$/.test(challenge) || !/^04[a-f0-9]{128}$/.test(publicKey)) throw new Error('Invalid exchange');
      const address = req.socket.localAddress?.replace(/^::ffff:/, '');
      if (!entry.addresses?.includes(address)) throw new Error('Uncovered interface');
      const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (pending && (pending.challenge !== challenge || pending.client !== publicKey || pending.remote !== remote)) { res.writeHead(409); res.end(); return; }
      if (!pending) {
        const exchange = createECDH('prime256v1'); const serverPublic = exchange.generateKeys();
        const client = Buffer.from(publicKey, 'hex'), key = exchangeKey(exchange.computeSecret(client), challenge);
        const fingerprint = exchangeFingerprint(client, serverPublic, challenge), requestId = randomBytes(16).toString('hex');
        const expiresAt = Math.min(entry.expiresAt, now() + PENDING_TTL_MS);
        const wire = JSON.stringify({ sessionId: session, requestId, fingerprint, address: remote, expiresAt });
        const staged = pendingFile + '.' + requestId;
        writeFileSync(staged, wire, { mode: 0o600, flag: 'wx' }); renameSync(staged, pendingFile);
        pending = { key, publicKey: serverPublic.toString('hex'), client: publicKey, challenge, fingerprint, remote, requestId, expiresAt };
      }
      if (entry.rejectedRequestId === pending.requestId) { attempts = 5; clearPending(); res.writeHead(403); res.end(); return; }
      const approved = entry.approvedRequestId === pending.requestId;
      const pairing = { ...entry.pairing, bridgeUri: entry.pairing.bridgeUri.replace(/wss:\/\/[^/]+/, `wss://${address}:${entry.port}`) };
      const response = { publicKey: pending.publicKey, fingerprint: pending.fingerprint,
        ...(approved ? encryptBinding(pending.key, challenge, pairing, now()) : {}) };
      res.writeHead(approved ? 200 : 202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
    } catch { attempts++; if (attempts >= 5) clearPending(); if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.requestTimeout = 3000; server.headersTimeout = 3000; server.maxConnections = 3;
  const udp = dgram.createSocket('udp4');
  const close = () => { clearPending(); try { udp.close(); } catch {} server.closeAllConnections(); server.close(); };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(discoveryPort, host, resolve); });
  } catch { close(); throw new Error('Cannot start local binding service'); }
  udp.on('error', () => {});
  udp.on('message', (message, peer) => {
    const challenge = /^PASSPORT_ENROLL_V2 ([a-f0-9]{32})$/.exec(message.toString())?.[1];
    if (!challenge || !privateAddress(peer.address) || !active() || !allow()) return;
    udp.send(`PASSPORT_ENROLL_V2 ${server.address().port} ${challenge}`, peer.port, peer.address);
  });
  return { close, finish() { clearPending(); try { unlinkSync(file); } catch {} }, port: server.address().port, discoveryPort: udp.address().port };
}
