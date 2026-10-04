import { Worker } from 'node:worker_threads';
import { createHash, createDiffieHellman, getDiffieHellman, randomBytes, hkdfSync } from 'node:crypto';

// ESP-IDF security2's RFC 5054 group and SHA-512 proof encoding.
export const PRIME = getDiffieHellman('modp15').getPrime();
export const N = BigInt('0x' + PRIME.toString('hex'));
export const IDENTITY = 'codex-passport';
const hash = (...parts) => createHash('sha512').update(Buffer.concat(parts)).digest();
export const integer = bytes => BigInt('0x' + bytes.toString('hex'));
export function bytes(value) {
  let hex = value.toString(16); if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}
const pad = value => { const input = bytes(value), output = Buffer.alloc(PRIME.length); input.copy(output, output.length - input.length); return output; };
export function power(base, exponent) {
  if (base <= 1n || base >= N - 1n || exponent <= 0n) throw new Error('Invalid SRP exponentiation');
  const dh = createDiffieHellman(PRIME, bytes(base));
  dh.setPrivateKey(bytes(exponent));
  return integer(dh.generateKeys());
}
export function clientExchange(code, saltHex, publicHex, secret = randomBytes(32)) {
  if (!/^[0-9]{4}$/.test(code) || !/^[a-f0-9]{32}$/.test(saltHex) || !/^(?:[a-f0-9]{2}){1,384}$/.test(publicHex)) throw new Error('Invalid SRP input');
  const salt = Buffer.from(saltHex, 'hex'), peer = Buffer.from(publicHex, 'hex'), B = integer(peer), a = integer(secret);
  if (B <= 0n || B >= N || a <= 0n) throw new Error('Invalid SRP public value');
  const A = pad(power(5n, a)), k = integer(hash(PRIME, pad(5n))), u = integer(hash(A, pad(B)));
  if (!u) throw new Error('Invalid SRP scramble');
  const x = integer(hash(salt, hash(Buffer.from(IDENTITY + ':' + code))));
  const base = (B - k * power(5n, x) % N + N) % N;
  const key = hash(bytes(power(base, a + u * x)));
  const ng = hash(PRIME), hg = hash(pad(5n)); for (let i = 0; i < ng.length; i++) ng[i] ^= hg[i];
  const proof = hash(ng, hash(Buffer.from(IDENTITY)), salt, A, peer, key);
  return { publicKey: A.toString('hex'), proof: proof.toString('hex'), expectedProof: hash(A, proof, key), key };
}
export function bindingKey(shared, challenge) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(challenge), 'codex-passport-enroll-v3', 32));
}

export function clientExchangeAsync(code, salt, publicKey, signal) {
  if (signal.aborted) return Promise.reject(new Error('Binding service closed'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./srp-worker.mjs', import.meta.url), { workerData: { code, salt, publicKey } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', aborted);
      void worker.terminate();
      if (error) reject(error);
      else resolve({ ...result, key: Buffer.from(result.key), expectedProof: Buffer.from(result.expectedProof) });
    };
    const aborted = () => finish(new Error('Binding service closed'));
    signal.addEventListener('abort', aborted, { once: true });
    worker.once('message', result => finish(null, result));
    worker.once('error', () => finish(new Error('Binding exchange failed')));
    worker.once('exit', () => finish(new Error('Binding exchange stopped')));
  });
}
