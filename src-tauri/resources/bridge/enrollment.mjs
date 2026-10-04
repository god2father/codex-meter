import http from 'node:http';
import dgram from 'node:dgram';
import { readFileSync, unlinkSync } from 'node:fs';
import { createCipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { clientExchangeAsync, bindingKey } from './srp.mjs';

export const DISCOVERY_PORT = 8799;
export const PENDING_TTL_MS = 30000;
export function normalizeCode(code) {
  const value = typeof code === 'string' ? code.trim() : '';
  if (!/^[0-9]{4}$/.test(value)) throw new Error('Invalid binding code');
  return value;
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
  const controller = new AbortController();
  let session, attempts = 0;
  const exchanges = new Map();
  const remove = id => { const value = exchanges.get(id); value?.key.fill(0); value?.expectedProof.fill(0); exchanges.delete(id); };
  const clear = () => { for (const id of exchanges.keys()) remove(id); };
  const active = () => {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      normalizeCode(value.code);
      if (!/^[a-f0-9]{64}$/.test(value.sessionId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now() || value.expiresAt > now() + 301000) { clear(); return null; }
      if (session !== value.sessionId) { clear(); session = value.sessionId; attempts = 0; }
      for (const [id, pending] of exchanges) if (pending.expiresAt <= now()) remove(id);
      return value;
    } catch { clear(); return null; }
  };
  let count = 0, window = 0;
  const allow = () => { const second = Math.floor(now() / 1000); if (second !== window) { window = second; count = 0; } return ++count <= 12; };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let entry = active();
    if (!entry || req.url !== '/enroll' || req.method !== 'POST' || req.headers.origin || !privateAddress(req.socket.remoteAddress) || !allow()) { res.writeHead(403); res.end(); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1280) throw new Error('Oversize request'); }
      entry = active(); if (!entry) { res.writeHead(403); res.end(); return; }
      const input = JSON.parse(body), challenge = input.challenge;
      if (!/^[a-f0-9]{32}$/.test(challenge)) throw new Error('Invalid challenge');
      const address = req.socket.localAddress?.replace(/^::ffff:/, '');
      if (!entry.addresses?.includes(address)) throw new Error('Uncovered interface');
      const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (input.step === 'start') {
        let pending = [...exchanges.values()].find(p => p.challenge === challenge && p.remote === remote && p.salt === input.salt && p.peer === input.publicKey);
        if (!pending) {
          if (attempts >= 5) { res.writeHead(403); res.end(); return; }
          // Reserve a guess before returning a proof, including abandoned/wrong-code exchanges.
          attempts++;
          const sessionId = entry.sessionId;
          const exchange = await clientExchangeAsync(entry.code, input.salt, input.publicKey, controller.signal);
          entry = active();
          if (!entry || entry.sessionId !== sessionId || res.destroyed) {
            exchange.key.fill(0); exchange.expectedProof.fill(0); if (!res.destroyed) { res.writeHead(403); res.end(); } return;
          }
          const requestId = randomBytes(16).toString('hex');
          pending = { ...exchange, requestId, challenge, remote, salt: input.salt, peer: input.publicKey, expiresAt: Math.min(entry.expiresAt, now() + PENDING_TTL_MS) };
          exchanges.set(requestId, pending);
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ requestId: pending.requestId, publicKey: pending.publicKey, proof: pending.proof }));
      } else if (input.step === 'finish') {
        const pending = exchanges.get(input.requestId);
        if (!pending || pending.remote !== remote || pending.challenge !== challenge) { res.writeHead(403); res.end(); return; }
        const valid = /^[a-f0-9]{128}$/.test(input.proof) && timingSafeEqual(pending.expectedProof, Buffer.from(input.proof, 'hex'));
        if (!valid) { remove(pending.requestId); res.writeHead(403); res.end(); return; }
        const pairing = { ...entry.pairing, bridgeUri: entry.pairing.bridgeUri.replace(/wss:\/\/[^/]+/, `wss://${address}:${entry.port}`) };
        const key = bindingKey(pending.key, challenge);
        let response; try { response = encryptBinding(key, challenge, pairing, now()); } finally { key.fill(0); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
      } else { res.writeHead(400); res.end(); }
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }

  });
  server.requestTimeout = 3000; server.headersTimeout = 3000; server.maxConnections = 3;
  const udp = dgram.createSocket('udp4');
  const close = () => { controller.abort(); clear(); try { udp.close(); } catch {} server.closeAllConnections(); server.close(); };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(discoveryPort, host, resolve); });
  } catch { close(); throw new Error('Cannot start local binding service'); }
  udp.on('error', () => {});
  udp.on('message', (message, peer) => {
    const challenge = /^PASSPORT_ENROLL_V3 ([a-f0-9]{32})$/.exec(message.toString())?.[1];
    if (!challenge || !privateAddress(peer.address) || !active() || !allow()) return;
    udp.send(`PASSPORT_ENROLL_V3 ${server.address().port} ${challenge}`, peer.port, peer.address);
  });
  return { close, finish() { clear(); try { unlinkSync(file); } catch {} }, port: server.address().port, discoveryPort: udp.address().port };
}
