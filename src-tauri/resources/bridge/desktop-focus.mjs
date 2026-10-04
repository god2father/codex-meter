const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localId(value) {
  if (typeof value !== 'string') return null;
  const id = value.startsWith('local:') ? value.slice(6) : value;
  return uuid.test(id) ? id.toLowerCase() : null;
}

// Parse the bounded Micro snapshot contract, without reading UI, evaluating
// renderer code, or enabling a debugger. The snapshot provider is separate.
export function desktopFocusId(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.activeThreadKey && !localId(snapshot.activeThreadKey)) return null;
  if (!Array.isArray(snapshot.slots ?? [])) return null;
  const composer = localId(snapshot.activeSideChatThreadId ?? snapshot.activeThreadKey);
  if (snapshot.activeSideChatThreadId) return composer;
  const selected = (snapshot.slots ?? []).filter(slot => slot.selected === true);
  if (selected.length > 1) return null;
  const slot = selected.length ? localId(selected[0].threadKey ?? selected[0].threadId) : null;
  if (composer && slot && composer !== slot) return null;
  return composer ?? slot;
}

export class DesktopFocus {
  constructor(readSnapshot, select, { intervalMs = 500 } = {}) {
    this.readSnapshot = readSnapshot; this.select = select; this.intervalMs = intervalMs;
    this.stopped = true; this.generation = 0;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false; this.poll();
  }
  async poll() {
    const generation = this.generation;
    let target = null;
    try { target = desktopFocusId(await this.readSnapshot()); } catch { /* Unknown focus disables decisions. */ }
    if (this.stopped || generation !== this.generation) return;
    this.select(target);
    this.timer = setTimeout(() => this.poll(), this.intervalMs);
    this.timer.unref();
  }
  stop() { this.stopped = true; this.generation++; clearTimeout(this.timer); }
}
