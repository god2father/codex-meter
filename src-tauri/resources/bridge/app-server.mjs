import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class AppServer extends EventEmitter {
  constructor(command = 'codex') {
    super();
    this.closed = false;
    this.sequence = 0;
    this.pending = new Map();
    this.child = spawn(command, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume(); // Never log auth/config output.
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const m = JSON.parse(line);
        if (m.method) this.emit('message', m);
        else {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer); this.pending.delete(m.id);
            if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
          }
        }
      } catch { this.emit('protocolError'); }
    });
    const closed = () => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('app-server closed')); }
      this.pending.clear(); this.emit('closed');
    };
    this.child.stdin.on('error', closed);
    this.child.on('error', closed);
    this.child.on('exit', closed);
  }
  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error('app-server closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  rpc(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RPC timeout')); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const result = await this.rpc('initialize', { clientInfo: { name: 'codex_passport', title: 'Codex Passport', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    return result;
  }
  close() { this.child.kill(); }
}
