import { WebSocket } from 'ws';

export function funAsrConfig(env) {
  if (!env.PASSPORT_ASR_URL) return null;
  const url = new URL(env.PASSPORT_ASR_URL);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid ASR endpoint');
  const token = env.PASSPORT_ASR_TOKEN;
  if (token && !/^[A-Za-z0-9_.-]{16,512}$/.test(token)) throw new Error('Invalid ASR token');
  return { url: url.href, token, timeoutMs: 45000 };
}

// The pinned offline protocol returns one result per connection. Do not mix 2pass results.
export function transcribePcm(config, pcm, { sessionId, signal } = {}) {
  if (!config || !Buffer.isBuffer(pcm) || !pcm.length || pcm.length > 960000 || pcm.length % 2 ||
      !/^[a-f0-9]{32}$/.test(sessionId ?? '')) return Promise.reject(new Error('Invalid ASR input'));
  if (signal?.aborted) return Promise.reject(new Error('ASR cancelled'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.url, { handshakeTimeout: 5000, maxPayload: 65536,
      ...(config.token ? { headers: { authorization: `Bearer ${config.token}` } } : {}) });
    let settled = false, ended = false;
    const finish = (error, text) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      ws.terminate();
      error ? reject(error) : resolve(text);
    };
    const abort = () => finish(new Error('ASR cancelled'));
    const timer = setTimeout(() => finish(new Error('ASR timeout')), config.timeoutMs ?? 45000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    const send = value => new Promise((yes, no) => {
      if (settled) { no(new Error('ASR cancelled')); return; }
      ws.send(value, error => error ? no(error) : yes());
    });
    ws.on('error', () => finish(new Error('ASR unavailable')));
    ws.on('close', () => finish(new Error('ASR closed before result')));
    ws.on('message', (raw, binary) => {
      try {
        if (binary || !ended) throw new Error('Invalid ASR response');
        const result = JSON.parse(raw.toString());
        if (result.wav_name !== sessionId || result.mode !== 'offline' || typeof result.text !== 'string' ||
            Buffer.byteLength(result.text) > 16000) throw new Error('Invalid ASR response');
        const text = result.text.replace(/<\|[^|]*\|>/g, '').trim();
        if (!text) throw new Error('No speech recognized');
        finish(null, text);
      } catch { finish(new Error('Invalid or empty ASR result')); }
    });
    ws.on('open', async () => {
      try {
        await send(JSON.stringify({ mode: 'offline', wav_name: sessionId, wav_format: 'pcm', audio_fs: 16000,
          is_speaking: true, itn: true, svs_lang: 'auto', svs_itn: true }));
        for (let offset = 0; offset < pcm.length; offset += 16384) await send(pcm.subarray(offset, offset + 16384));
        ended = true; await send(JSON.stringify({ is_speaking: false }));
      } catch { finish(new Error('ASR transport failed')); }
    });
  });
}
