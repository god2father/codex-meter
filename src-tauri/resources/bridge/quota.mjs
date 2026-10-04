function windowQuota(window) {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) ||
      typeof window.windowDurationMins !== 'number' || !Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0 ||
      typeof window.resetsAt !== 'number' || !Number.isFinite(window.resetsAt) || window.resetsAt <= 0 ||
      !Number.isFinite(new Date(window.resetsAt * 1000).getTime())) return null;
  return { durationMins: window.windowDurationMins,
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)), resetsAt: window.resetsAt };
}

export class AccountQuota {
  constructor(factory, changed = () => {}, { now = Date.now, intervalMs = 60000 } = {}) {
    this.factory = factory; this.changed = changed; this.now = now; this.intervalMs = intervalMs;
    this.running = false; this.busy = null; this.generation = 0; this.revision = 0; this.value = null; this.client = null;
  }
  snapshot() {
    if (!this.value || this.now() / 1000 - this.value.updatedAt > 300) return null;
    const current = { ...this.value };
    for (const key of ['primary', 'secondary']) {
      current[key] = current[key] && current[key].resetsAt > this.now() / 1000 ? { ...current[key] } : null;
    }
    return current.primary || current.secondary ? current : null;
  }
  publish(value) {
    this.value = value;
    try { this.changed(); } catch { /* Consumer callbacks must not reject background polls. */ }
  }
  update(result) {
    const candidate = result?.rateLimitsByLimitId == null ? result?.rateLimits : result.rateLimitsByLimitId.codex;
    const bucket = candidate?.limitId != null && candidate.limitId !== 'codex' ? null : candidate;
    const primary = windowQuota(bucket?.primary), secondary = windowQuota(bucket?.secondary);
    this.revision++;
    this.publish(primary || secondary ? { updatedAt: Math.floor(this.now() / 1000), primary, secondary } : null);
  }
  detach(client) {
    if (!client) return;
    if (this.onMessage) client.off?.('message', this.onMessage);
    if (this.onClosed) client.off?.('closed', this.onClosed);
    try { client.close(); } catch { /* Closing must not expose client errors. */ }
  }
  fail(client) {
    if (client && this.client !== client) return;
    const old = this.client; this.client = null; this.generation++; this.busy = null;
    this.detach(old); this.publish(null);
  }
  async start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    this.timer.unref?.();
    await this.refresh();
  }
  async refresh() {
    if (!this.running || this.busy) return;
    const attempt = {}; this.busy = attempt;
    const generation = this.generation;
    let client = this.client;
    try {
      if (!client) {
        client = await this.factory();
        if (!this.running || generation !== this.generation) { this.detach(client); return; }
        this.client = client;
        this.onMessage = message => {
          if (this.running && this.client === client && message.method === 'account/rateLimits/updated') this.update(message.params);
        };
        this.onClosed = () => { if (this.running && this.client === client) this.fail(client); };
        client.on('message', this.onMessage); client.on('closed', this.onClosed);
        if (client.closed) throw new Error('Quota client closed');
        await client.initialize();
      }
      if (!this.running || generation !== this.generation || this.client !== client) return;
      const revision = this.revision;
      const result = await client.rpc('account/rateLimits/read');
      if (this.running && generation === this.generation && this.client === client && revision === this.revision) this.update(result);
    } catch {
      if (this.running && generation === this.generation) this.fail(client);
    } finally { if (this.busy === attempt) this.busy = null; }
  }
  stop() {
    this.running = false; this.generation++; this.busy = null; clearInterval(this.timer); this.timer = null;
    const old = this.client; this.client = null; this.detach(old); this.publish(null);
  }
}
