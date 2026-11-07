import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { listThreads, readMessages, composer, sendButton, invitationCards, acceptButton, invitationName, isGroupThread } from '../src/linkedin.js';
import { incomingTail, pendingConfirmed, replyHash } from '../src/core.js';

// Synthetic fixture only. This is NOT a live LinkedIn validation.
const fixture = `<!doctype html><html><body>
<main>
<ul class="msg-conversations-container__conversations-list">
  <li class="msg-conversation-listitem msg-conversation-listitem--unread">
    <a href="https://www.linkedin.com/messaging/thread/test-one/"><span class="msg-conversation-listitem__participant-names">Test Contact</span><span>Hi</span></a>
  </li>
  <li class="msg-conversation-listitem"><a href="https://www.linkedin.com/messaging/thread/group/"><span class="msg-conversation-listitem__participant-names">A group</span><span aria-label="group conversation"></span></a></li>
</ul>
<section class="msg-thread">
 <h2>Test Contact</h2>
 <ol id="events">
  <li class="msg-s-message-list__event" data-event-urn="event-1"><div class="msg-s-event-listitem"><a class="msg-s-event-listitem__profile-link" href="/in/test-owner/">Test Owner</a><p class="msg-s-event-listitem__body">Earlier reply</p></div></li>
  <li class="msg-s-message-list__event" data-event-urn="event-2"><div class="msg-s-event-listitem"><a class="msg-s-event-listitem__profile-link" href="/in/test-contact/">Test Contact</a><p class="msg-s-event-listitem__body">Hi</p></div></li>
  <li class="msg-s-message-list__event" data-event-urn="event-3"><div class="msg-s-event-listitem msg-s-event-listitem--grouped"><p class="msg-s-event-listitem__body">One more question</p></div></li>
 </ol>
 <div class="msg-form__contenteditable" contenteditable="true" role="textbox"></div>
 <button class="msg-form__send-button" onclick="const text=document.querySelector('[contenteditable]').innerText; const li=document.createElement('li'); li.className='msg-s-message-list__event'; li.dataset.eventUrn='event-sent'; const div=document.createElement('div'); div.className='msg-s-event-listitem msg-s-event-listitem--self'; const p=document.createElement('p'); p.className='msg-s-event-listitem__body'; p.textContent=text; div.appendChild(p); li.appendChild(div); document.getElementById('events').appendChild(li); document.querySelector('[contenteditable]').textContent='';">Send</button>
</section>
<div class="invitation-card-container"><div class="invitation-card"><a class="invitation-card__title" href="/in/test-inviter/">Test Inviter</a><button onclick="this.closest('.invitation-card-container').remove()">Accept</button></div></div>
</main></body></html>`;
const identity = { selfName: 'Test Owner', selfProfile: 'https://www.linkedin.com/in/test-owner/', contactName: 'Test Contact' };

test('synthetic DOM: read threads, identify senders, group a burst, send once, and accept only the incoming card', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture);
    const threads = await listThreads(page, 20);
    assert.equal(threads.length, 2);
    assert.equal(threads[0]?.name, 'Test Contact');
    assert.equal(threads[0]?.unread, true);
    assert.equal(threads[1]?.group, true);
    // A group in the sidebar must not classify the active direct thread as a group.
    assert.equal(await isGroupThread(page), false);
    const before = await readMessages(page, identity);
    assert.deepEqual(before.map(m => m.from), ['self', 'other', 'other']);
    const incoming = incomingTail(before, []);
    assert.equal(incoming.length, 2);
    const box = await composer(page);
    await box.fill('A concise test reply.');
    await (await sendButton(page)).click();
    const after = await readMessages(page, identity);
    assert.equal(after.at(-1)?.from, 'self');
    assert.equal(pendingConfirmed(after, { ids: incoming.map(m => m.id), replyHash: replyHash('A concise test reply.'), attemptedAt: Date.now() }), true);
    assert.deepEqual(incomingTail(after, []), []);
    const cards = await invitationCards(page);
    assert.equal(cards.length, 1, 'nested invitation wrappers must not create duplicate actions');
    assert.equal(await invitationName(cards[0]!), 'Test Inviter');
    await (await acceptButton(cards[0]!)).click();
    assert.equal((await invitationCards(page)).length, 0);
  } finally { await browser.close(); }
});

test('synthetic DOM: missing sender fails closed; attachments are recognized', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<section class="msg-thread"><div class="msg-s-event-listitem" data-event-urn="unknown"><p class="msg-s-event-listitem__body">Who sent this?</p></div><div class="msg-s-event-listitem" data-event-urn="file"><a class="msg-s-event-listitem__profile-link">Test Contact</a><div class="message-attachment">file.pdf</div></div></section>');
    const messages = await readMessages(page, identity);
    assert.equal(messages[0]?.from, 'unknown');
    assert.equal(messages[1]?.attachment, true);
    assert.equal(messages[1]?.from, 'other');
  } finally { await browser.close(); }
});

test('synthetic DOM: a wrong SELF_NAME cannot turn an unrelated author into the recipient', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<section class="msg-thread"><div class="msg-s-event-listitem"><a class="msg-s-event-listitem__profile-link">Unexpected Author</a><p class="msg-s-event-listitem__body">Do not treat me as the recipient.</p></div></section>');
    assert.equal((await readMessages(page, identity))[0]?.from, 'unknown');
  } finally { await browser.close(); }
});

test('synthetic reply transaction: baseline is skipped, a new burst gets one reply, and rescan does not duplicate it', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Bot } = await import('../src/bot.js');
  const { loadConfig } = await import('../src/config.js');
  const dir = mkdtempSync(join(tmpdir(), 'bot-loop-'));
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext();
  const bot = new Bot(context, { ...loadConfig(), selfName: identity.selfName, selfProfile: identity.selfProfile, dataDir: dir, dryRun: false, engine: 'rules', key: '', acceptConnections: false, pollMs: 100, settleMs: 50, invitesMs: 100 });
  try {
    const page = await context.newPage();
    await page.setContent(fixture);
    // Use an already open about:blank fixture. No external navigation or account.
    const thread = { url: 'about:blank', name: 'Test Contact', signature: 'synthetic', unread: true, group: false };
    await bot.inspect(page, thread, true);
    assert.equal(await page.locator('[data-event-urn="event-sent"]').count(), 0, 'old messages must not be answered');
    await page.evaluate(() => {
      for (const [id, text] of [['new-1', 'Hi'], ['new-2', 'Hello']]) {
        const li = document.createElement('li');
        li.className = 'msg-s-message-list__event';
        li.setAttribute('data-event-urn', id!);
        const item = document.createElement('div');
        item.className = 'msg-s-event-listitem';
        const author = document.createElement('a');
        author.className = 'msg-s-event-listitem__profile-link';
        author.textContent = 'Test Contact';
        const body = document.createElement('p');
        body.className = 'msg-s-event-listitem__body';
        body.textContent = text!;
        item.append(author, body);
        li.append(item);
        document.getElementById('events')!.append(li);
      }
    });
    await bot.inspect(page, thread);
    await bot.inspect(page, thread);
    assert.equal(await page.locator('[data-event-urn="event-sent"]').count(), 1);
    const state = JSON.parse(readFileSync(join(dir, 'state-live.json'), 'utf8'));
    assert.equal(Object.values(state.threads).filter((r: unknown) => !!(r as { pending?: unknown }).pending).length, 0, 'confirmed send is persisted');
  } finally {
    bot.stop();
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
