import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');

function number(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!['true', 'false'].includes(raw.toLowerCase())) throw new Error(`${name} must be true or false.`);
  return raw.toLowerCase() === 'true';
}
export function loadConfig() {
  const engine = process.env.REPLY_ENGINE || 'auto';
  if (!['auto', 'ai', 'rules'].includes(engine)) throw new Error('REPLY_ENGINE must be auto, ai, or rules.');
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (engine === 'ai' && !key) throw new Error('REPLY_ENGINE=ai requires OPENAI_API_KEY in your local .env.');
  return {
    selfName: (process.env.SELF_NAME || '').trim(),
    selfProfile: (process.env.SELF_PROFILE_URL || '').trim(),
    dryRun: bool('DRY_RUN', true),
    headless: bool('HEADLESS', false),
    acceptConnections: bool('ACCEPT_CONNECTIONS', true),
    allowedNames: (process.env.ALLOWED_NAMES || '').split(';').map(s => s.trim()).filter(Boolean),
    engine: engine as 'auto' | 'ai' | 'rules',
    key,
    model: (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim(),
    ownerContext: (process.env.OWNER_CONTEXT || '').trim().slice(0, 2000),
    pollMs: number('POLL_MS', 5000, 3000, 60000),
    invitesMs: number('INVITES_POLL_MS', 30000, 15000, 300000),
    refreshMs: number('REFRESH_MS', 120000, 60000, 600000),
    settleMs: number('SETTLE_MS', 2500, 1000, 15000),
    maxThreads: number('MAX_VISIBLE_THREADS', 20, 1, 50),
    maxReplies: number('MAX_REPLIES_PER_HOUR', 120, 1, 500),
    maxAccepts: number('MAX_ACCEPTS_PER_HOUR', 20, 1, 100),
    maxReplyChars: number('MAX_REPLY_CHARS', 500, 100, 1000),
    dataDir: resolve('.local'),
  };
}
export type Config = ReturnType<typeof loadConfig>;
export function requireIdentity(config: Config): void {
  if (!config.selfName || config.selfName.startsWith('REPLACE_')) {
    throw new Error('Edit SELF_NAME in .env to match your exact LinkedIn display name, then rerun.');
  }
}
