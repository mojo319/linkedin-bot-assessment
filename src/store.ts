import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadState } from './core.js';
export type State = { version: 1; initialized: boolean; threads: Record<string, ThreadState>; replyTimes: number[]; acceptTimes: number[] };
export class Store {
  readonly file: string;
  state: State;
  constructor(dir: string, dryRun: boolean) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, dryRun ? 'state-dry.json' : 'state-live.json');
    this.state = { version: 1, initialized: false, threads: {}, replyTimes: [], acceptTimes: [] };
    if (existsSync(this.file)) {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || (data as State).version !== 1 || !(data as State).threads || !Array.isArray((data as State).replyTimes) || !Array.isArray((data as State).acceptTimes)) {
        throw new Error('State file is invalid. Stopping rather than losing duplicate protection.');
      }
      this.state = data as State;
    }
  }
  save(): void {
    // Same-directory rename keeps the old complete file intact if writing is interrupted.
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
}
export function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'process.lock');
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid .local/process.lock; check for an existing bot before removing it.');
    let alive = true;
    try { process.kill(pid, 0); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('A login/check/bot process is already running. Close it before starting another.');
    unlinkSync(file);
  }
  const fd = openSync(file, 'wx', 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => { if (existsSync(file) && readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file); };
}
