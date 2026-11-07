import type { BrowserContext, Page } from 'playwright';
import type { Config } from './config.js';
import { hash, incomingTail, mergeSeen, pendingConfirmed, replyHash, sleep, normalize, WindowLimit } from './core.js';
import type { Message, Thread, ThreadState } from './core.js';
import { Store } from './store.js';
import { generateReply } from './responder.js';
import { S } from './selectors.js';
import { ActionRequired, LayoutChanged, MESSAGES_URL, INVITES_URL, openPage, guard, listThreads, openThread, isCurrentThread, currentThread, readMessages, isGroupThread, composer, sendButton, invitationCards, invitationName, acceptButton } from './linkedin.js';

export const log = (message: string): void => { console.log(`[${new Date().toISOString()}] ${message}`); };
export class Bot {
  private stopped = false;
  private store: Store;
  private replyLimit: WindowLimit;
  private acceptLimit: WindowLimit;
  private warned = new Set<string>();
  private dryInvites = new Set<string>();
  private cursor = 0;
  private sent = 0;
  private accepted = 0;
  private baselineReady = false;
  constructor(private context: BrowserContext, private config: Config) {
    this.store = new Store(config.dataDir, config.dryRun);
    this.replyLimit = new WindowLimit(config.maxReplies, this.store.state.replyTimes);
    this.acceptLimit = new WindowLimit(config.maxAccepts, this.store.state.acceptTimes);
  }
  stop(): void { this.stopped = true; }
  private save(): void {
    this.store.state.replyTimes = this.replyLimit.snapshot();
    this.store.state.acceptTimes = this.acceptLimit.snapshot();
    this.store.save();
  }
  private allowed(name: string): boolean {
    return !this.config.allowedNames.length || this.config.allowedNames.some(n => normalize(n).toLowerCase() === normalize(name).toLowerCase());
  }
  private warnOnce(code: string, message: string): void {
    if (!this.warned.has(code)) { this.warned.add(code); log(message); }
  }
  // Public for isolated browser tests; production calls it from the serialized loop.
  async inspect(page: Page, thread: Thread, baseline = false): Promise<void> {
    if (this.stopped || thread.group || !thread.name || !this.allowed(thread.name)) return;
    const key = hash(thread.url);
    await openThread(page, thread);
    if (await isGroupThread(page)) return;
    if (thread.rowKey && !await page.locator(S.thread).first().locator('a.msg-thread__link-to-profile[href*="/in/"], .msg-s-profile-card-one-to-one').count()) {
      this.warnOnce('not-direct:' + key, 'SKIPPED: one-to-one conversation could not be verified.');
      return;
    }
    let messages = await readMessages(page, { ...this.config, contactName: thread.name });
    if (!messages.length) {
      this.warnOnce('empty:' + key, `CHECK NEEDED thread=${key.slice(0, 8)}: no supported message bubbles found.`);
      return;
    }
    if (!this.store.state.threads[key]) {
      this.store.state.threads[key] = { seen: [], signature: thread.signature };
    }
    const record = this.store.state.threads[key]!;
    if (baseline) {
      record.seen = mergeSeen(record.seen, messages);
      record.signature = thread.signature;
      this.save();
      return;
    }
    if (record.pending) {
      if (pendingConfirmed(messages, record.pending)) {
        record.seen = mergeSeen(record.seen, record.pending.ids);
        delete record.pending;
        this.save();
        log(`Recovered confirmed send thread=${key.slice(0, 8)}.`);
      } else {
        this.warnOnce('pending:' + key, `ACTION NEEDED thread=${key.slice(0, 8)}: previous send is unconfirmed; automatic resend is blocked. Check the conversation manually.`);
        return;
      }
    }
    let incoming = incomingTail(messages, record.seen);
    if (!incoming.length) {
      if (messages.at(-1)?.from === 'unknown') this.warnOnce('owner:' + key, `CHECK NEEDED thread=${key.slice(0, 8)}: latest sender is unknown. Verify SELF_NAME and selectors; not replying.`);
      // A manual outgoing reply supersedes preceding incoming messages.
      if (messages.at(-1)?.from === 'self') record.seen = mergeSeen(record.seen, messages);
      record.signature = thread.signature;
      this.save();
      return;
    }
    // Wait for a short quiet period, extending it for a burst up to a fixed ceiling.
    let signature = incoming.map(m => m.id).join(',');
    const deadline = Date.now() + 10000;
    do {
      await sleep(this.config.settleMs);
      if (this.stopped) return;
      messages = await readMessages(page, { ...this.config, contactName: thread.name });
      incoming = incomingTail(messages, record.seen);
      const next = incoming.map(m => m.id).join(',');
      if (next === signature) break;
      signature = next;
    } while (Date.now() < deadline);
    if (!incoming.length) return;
    if (!this.replyLimit.available()) {
      this.warnOnce('reply-limit', 'Hourly reply cap reached. Waiting for capacity; this cap is not a LinkedIn-approved safe limit.');
      return;
    }
    const reply = await generateReply(this.config, messages, incoming);
    if (reply.degraded) this.warnOnce('ai-fallback', 'AI request failed; using basic local fallback replies. Check API access with npm run ai-check later.');
    if (!reply.text.trim() || this.stopped) return;
    await guard(page);
    if (!await isCurrentThread(page, thread)) return;
    const latest = await readMessages(page, { ...this.config, contactName: thread.name });
    const latestIncoming = incomingTail(latest, record.seen);
    if (latestIncoming.map(m => m.id).join(',') !== incoming.map(m => m.id).join(',')) return;
    if (this.config.dryRun) {
      record.seen = mergeSeen(record.seen, incoming);
      record.signature = thread.signature;
      this.save();
      log(`DRY RUN would reply thread=${key.slice(0, 8)} messages=${incoming.length} chars=${reply.text.length} engine=${reply.source}. Nothing sent.`);
      return;
    }
    const box = await composer(page);
    if ((await box.innerText()).trim()) {
      this.warnOnce('draft:' + key, `SKIPPED thread=${key.slice(0, 8)}: an existing draft is present. Not overwriting it.`);
      return;
    }
    await box.fill(reply.text);
    const button = await sendButton(page);
    // LinkedIn may keep Send disabled briefly, or until it receives a keyboard-like
    // editor event even though the contenteditable already contains text. Wait first,
    // then use a harmless space/backspace nudge before failing closed.
    const waitEnabled = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !this.stopped) {
        if (await button.isEnabled().catch(() => false)) return true;
        await sleep(100);
      }
      return await button.isEnabled().catch(() => false);
    };
    if (!await waitEnabled(1200)) {
      await box.focus();
      await box.press('End').catch(() => undefined);
      await box.pressSequentially(' ', { delay: 5 });
      await box.press('Backspace');
    }
    if (!await waitEnabled(1500)) {
      // Last fallback: re-enter the same text through keyboard events. This is slower
      // than fill(), but exercises the input path LinkedIn's editor expects.
      await box.fill('');
      await box.focus();
      await box.pressSequentially(reply.text, { delay: 2 });
    }
    if (!await waitEnabled(2000)) {
      await box.fill('');
      throw new LayoutChanged('Send button stayed disabled after editor input.');
    }
    // Final race check: do not send a stale reply after another inbound message or manual reply.
    const finalMessages = await readMessages(page, { ...this.config, contactName: thread.name });
    if (!await isCurrentThread(page, thread) || incomingTail(finalMessages, record.seen).map(m => m.id).join(',') !== incoming.map(m => m.id).join(',')) {
      await box.fill('');
      return;
    }
    // Write intent BEFORE clicking. Ambiguous delivery must never cause a blind retry.
    record.pending = { ids: incoming.map(m => m.id), replyHash: replyHash(reply.text), attemptedAt: Date.now() };
    this.replyLimit.take();
    this.save();
    await button.click();
    for (let attempt = 0; attempt < 12 && !this.stopped; attempt++) {
      await sleep(500);
      const after = await readMessages(page, { ...this.config, contactName: thread.name });
      if (pendingConfirmed(after, record.pending)) {
        record.seen = mergeSeen(record.seen, incoming);
        delete record.pending;
        this.save();
        this.sent++;
        log(`SENT thread=${key.slice(0, 8)} messages=${incoming.length} engine=${reply.source}.`);
        return;
      }
    }
    this.warnOnce('pending:' + key, `ACTION NEEDED thread=${key.slice(0, 8)}: could not verify delivery; automatic resend blocked.`);
  }

  private async messageLoop(page: Page): Promise<void> {
    await page.locator(S.conversationList).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => undefined);
    const initial = await listThreads(page, this.config.maxThreads);
    if (!this.store.state.initialized) {
      log(`BASELINE: inspecting ${initial.length} visible conversations without replying to existing messages.`);
      for (const thread of initial) {
        if (this.stopped) return;
        await this.inspect(page, thread, true);
      }
      this.store.state.initialized = true;
      this.save();
    }
    this.baselineReady = true;
    log(`READY mode=${this.config.dryRun ? 'DRY RUN' : 'LIVE'}: waiting for NEW incoming messages. Existing baseline messages are not answered.`);
    if (!initial.length) this.warnOnce('no-threads', 'CHECK NEEDED: no supported conversations found. This may be an empty inbox or a changed LinkedIn layout. Run npm run check before submitting.');
    let lastRefresh = Date.now();
    let lastBeat = 0;
    let errors = 0;
    while (!this.stopped) {
      try {
        await guard(page);
        if (Date.now() - lastRefresh >= this.config.refreshMs) {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await sleep(1500);
          lastRefresh = Date.now();
        }
        const threads = await listThreads(page, this.config.maxThreads);
        const candidates = threads.filter(thread => {
          const record = this.store.state.threads[hash(thread.url)];
          // Same-day rows stay eligible because LinkedIn may clear unread when the
          // bot opens them before inspection finishes.
          return !record || record.signature !== thread.signature || !!record.pending || thread.unread || thread.fresh;
        });
        // Always inspect the currently opened chat; reading removes its unread flag.
        const current = await currentThread(page, threads);
        if (current && !candidates.includes(current)) candidates.push(current);
        // Round-robin catches repeated identical previews in other visible chats.
        if (threads.length) {
          const rotating = threads[this.cursor++ % threads.length]!;
          if (!candidates.includes(rotating)) candidates.push(rotating);
        }
        // Handle fresh evaluator messages before rotating through old chats.
        candidates.sort((a, b) => Number(!!(b.unread || b.fresh)) - Number(!!(a.unread || a.fresh)));
        for (const thread of candidates.slice(0, 12)) {
          if (this.stopped) return;
          const unknown = !this.store.state.threads[hash(thread.url)];
          // Old newly-virtualized rows are baselined. A same-day row is fresh even
          // if LinkedIn cleared its unread marker while the bot opened it.
          const baseline = unknown && !thread.unread && !thread.fresh;
          try {
            await this.inspect(page, thread, baseline);
          } catch (error) {
            if (error instanceof ActionRequired) throw error;
            const reason = error instanceof LayoutChanged ? error.message : 'transient thread error';
            log(`Thread scan retry name=${thread.name.slice(0, 40)}: ${reason}`);
            await sleep(700);
            const rescanned = await listThreads(page, this.config.maxThreads);
            const same = rescanned.find(item => normalize(item.name).toLowerCase() === normalize(thread.name).toLowerCase());
            if (!same) continue;
            const retryUnknown = !this.store.state.threads[hash(same.url)];
            const retryBaseline = retryUnknown && !same.unread && !same.fresh;
            try {
              await this.inspect(page, same, retryBaseline);
            } catch (retryError) {
              if (retryError instanceof ActionRequired) throw retryError;
              log(`Thread scan skipped name=${same.name.slice(0, 40)} after retry; continuing with other chats.`);
            }
          }
        }
        errors = 0;
        if (Date.now() - lastBeat >= 30000) {
          log(`HEARTBEAT mode=${this.config.dryRun ? 'DRY' : 'LIVE'} visible_threads=${threads.length} sent=${this.sent} accepted=${this.accepted}.`);
          lastBeat = Date.now();
        }
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof ActionRequired) throw error;
        errors++;
        log(`Message scan failed (${errors}); backing off. ${error instanceof LayoutChanged ? error.message : 'Run npm run check if repeated; private page details are not logged.'}`);
        if (errors >= 5) throw new ActionRequired('Repeated message scan failures. Run npm run check and repair the layout or connection before submitting.');
        await sleep(Math.min(60000, 5000 * 2 ** (errors - 1)));
      }
      await sleep(this.config.pollMs);
    }
  }

  private async invitationLoop(page: Page): Promise<void> {
    let errors = 0;
    while (!this.baselineReady && !this.stopped) await sleep(500);
    while (!this.stopped) {
      try {
        await guard(page);
        if (this.config.acceptConnections) {
          const cards = await invitationCards(page);
          for (const card of cards.slice(0, 3)) {
            if (this.stopped || !this.acceptLimit.available()) break;
            const name = await invitationName(card);
            if (!name || !this.allowed(name)) continue;
            if (this.config.dryRun) {
              const key = hash(name);
              if (!this.dryInvites.has(key)) { log('DRY RUN would accept an incoming connection. Nothing clicked.'); this.dryInvites.add(key); }
              continue;
            }
            const button = await acceptButton(card);
            // Reserve capacity before attempting an action; failures do not loosen the cap.
            this.acceptLimit.take();
            this.save();
            await button.click();
            await button.waitFor({ state: 'hidden', timeout: 8000 });
            this.accepted++;
            log('ACCEPTED an incoming connection request. No initial message sent.');
          }
        }
        errors = 0;
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof ActionRequired) throw error;
        errors++;
        log(`Invitation scan failed (${errors}); no outgoing invitations are ever sent.`);
        if (errors >= 5) throw new ActionRequired('Repeated invitation failures. Check the invitation page manually.');
      }
      await sleep(this.config.invitesMs * Math.min(4, 2 ** errors));
      if (this.stopped) return;
      try { await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(1000); }
      catch { log('Invitation refresh failed; retrying on the next interval.'); }
    }
  }
  async run(): Promise<void> {
    const messages = await openPage(this.context, MESSAGES_URL);
    const invitations = await openPage(this.context, INVITES_URL);
    log('Two browser tabs opened. Do not navigate or type in bot tabs while it runs. Ctrl+C stops it.');
    try { await Promise.all([this.messageLoop(messages), this.invitationLoop(invitations)]); }
    finally { this.stopped = true; this.save(); }
  }
}
