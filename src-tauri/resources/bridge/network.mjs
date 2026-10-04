import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';

export const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);
export const isLoopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
export function networkConfig(env, { demo, simulator, lan }) {
  const host = env.PASSPORT_HOST ?? (lan ? '0.0.0.0' : '127.0.0.1');
  const port = Number(env.PASSPORT_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PASSPORT_PORT');
  if ((demo || simulator) && (lan || host !== '127.0.0.1')) throw new Error('Development modes are loopback-only');
  if (!lan && host !== '127.0.0.1') throw new Error('LAN mode requires TLS');
  const heartbeatMs = Number(env.PASSPORT_HEARTBEAT_MS ?? 10000);
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs > 30000) throw new Error('Invalid heartbeat interval');
  const token = env.PASSPORT_TOKEN;
  if (!demo && !validToken(token)) throw new Error('Set PASSPORT_TOKEN through the environment (32-128 URL-safe characters)');
  const deviceToken = env.PASSPORT_DEVICE_TOKEN ?? (lan ? undefined : token);
  if (lan && (!validToken(deviceToken) || deviceToken === token)) throw new Error('Set a separate PASSPORT_DEVICE_TOKEN');
  if (lan && (!env.PASSPORT_TLS_CERT || !env.PASSPORT_TLS_KEY)) throw new Error('Set PASSPORT_TLS_CERT and PASSPORT_TLS_KEY paths');
  return { host, port, token, deviceToken, lan, heartbeatMs, cert: env.PASSPORT_TLS_CERT, key: env.PASSPORT_TLS_KEY };
}
export function createBridgeServer(config, handler) {
  return config.lan ? https.createServer({ cert: readFileSync(config.cert), key: readFileSync(config.key), minVersion: 'TLSv1.2' }, handler) : http.createServer(handler);
}
