import { createHash } from 'node:crypto';
export type Message = {
  id: string;
  from: 'self' | 'other' | 'unknown';
  text: string;
  attachment: boolean;
};
export type Thread = { url: string; name: string; signature: string; unread: boolean; group: boolean; rowKey?: string };
export type Pending = { ids: string[]; replyHash: string; attemptedAt: number };
export type ThreadState = {
  seen: string[];
  signature: string;
  pending?: Pending;
};
export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}
export function replyHash(value: string): string { return hash(normalize(value)); }
export function incomingTail(messages: Message[], seen: readonly string[]): Message[] {
  const result: Message[] = [];
  const known = new Set(seen);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    // Unknown ownership is a hard boundary; never guess or answer our own output.
    if (message.from !== 'other' || known.has(message.id)) break;
    result.unshift(message);
  }
  return result;
}
export function mergeSeen(current: string[], messages: Message[] | string[]): string[] {
  const ids = messages.map(m => typeof m === 'string' ? m : m.id);
  return [...new Set([...current, ...ids])].slice(-400);
}
export function limitText(text: string, max: number): string {
  const clean = text.trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return chars.slice(0, max - 3).join('').trimEnd() + '...';
}
export function budgetText(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 34) / 2);
  return text.slice(0, half) + '\n[Middle omitted for length]\n' + text.slice(-half);
}
export function pendingConfirmed(messages: Message[], pending: Pending): boolean {
  // Confirm only outgoing messages that occur after at least one targeted inbound event.
  const lastTarget = messages.findLastIndex(m => pending.ids.includes(m.id));
  if (lastTarget < 0) return false;
  return messages.slice(lastTarget + 1).some(m => m.from === 'self' && replyHash(m.text) === pending.replyHash);
}
export class WindowLimit {
  private times: number[];
  constructor(public readonly max: number, times: number[] = []) { this.times = times; }
  available(now = Date.now()): boolean { this.times = this.times.filter(t => t > now - 3600000); return this.times.length < this.max; }
  take(now = Date.now()): void { this.times.push(now); }
  snapshot(): number[] { this.available(); return [...this.times]; }
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
