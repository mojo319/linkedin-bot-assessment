import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { listThreads, openThread, readMessages, composer, sendButton, isCurrentThread, currentThread } from '../src/linkedin.js';
import { incomingTail, pendingConfirmed, replyHash } from '../src/core.js';

// Invented names/text only. Structure follows the supplied redacted diagnostic.
// These in-memory fixtures never navigate to LinkedIn or use a real account.
const row = (name: string, id: string, extra = '') => `<li class="msg-conversation-listitem msg-conversations-container__convo-item"><div class="msg-conversation-card"><div class="msg-conversation-listitem__link msg-conversations-container__convo-item-link ${extra}" tabindex="0" onclick="selectChat('${id}', '${name}')"><input type="checkbox" /><div class="msg-conversation-card__content--selectable"><h3 class="msg-conversation-listitem__participant-names msg-conversation-card__participant-names">${name}</h3><span class="preview">Hello</span></div></div></div></li>`;
const event = (id: string, who: string, text: string, other = true) => `<li class="msg-s-message-list__event"><div class="msg-s-event-listitem msg-s-event-listitem--last-in-group ${other ? 'msg-s-event-listitem--other' : ''}" data-event-urn="${id}"><div class="msg-s-message-group__meta"><a href="/in/${other ? 'sample-contact' : 'sample-owner'}/"><span class="msg-s-message-group__name msg-s-message-group__profile-link">${who}</span></a></div><div class="msg-s-event-listitem__message-bubble"><div class="msg-s-event-listitem__actions-container"><button>Reply</button><button>Forward</button><div role="menu">More actions</div></div><div class="msg-s-event-with-indicator"><div class="msg-s-event__content"><p class="msg-s-event-listitem__body">${text}</p></div></div></div></div></li>`;
const identity = { selfName: 'Sample Owner', selfProfile: 'https://www.linkedin.com/in/sample-owner/', contactName: 'Sample Contact' };
const fixture = `<!doctype html><html><body><main>
<ul class="msg-conversations-container__conversations-list">
${row('Sample Advertiser', 'advert', '') .replace('<span class="preview">Hello</span>', '<span>Sponsored</span>')}
${row('Sample Contact', 'contact', 'msg-conversation-card--unread')}
${row('Second Contact', 'second')}
</ul>
<div class="msg-thread"><div class="msg-title-bar"><a class="msg-thread__link-to-profile" href="/in/sample-contact/"><span id="title">Sample Contact</span></a></div><div class="msg-s-profile-card-one-to-one"></div><ol id="events">${event('old-other', 'Sample Contact', 'Earlier incoming')}${event('old-self', 'Sample Owner', 'Earlier answer', false)}${event('last-other', 'Sample Contact', 'Latest incoming')}</ol><form class="msg-form"><div class="msg-form__contenteditable" role="textbox" contenteditable="true" aria-label="Write a message..."></div><button type="button" class="msg-form__send-button" onclick="sendReply()">Send</button></form></div>
</main><script>
window.sent=0;
window.selectChat=(id,name)=>{
 document.getElementById('title').textContent=name;
 document.querySelectorAll('.msg-conversations-container__convo-item-link--active').forEach(e=>e.classList.remove('msg-conversations-container__convo-item-link--active'));
 [...document.querySelectorAll('.msg-conversation-listitem__link')].find(e=>e.querySelector('h3').textContent===name).classList.add('msg-conversations-container__convo-item-link--active');
 history.pushState({},'', '#'+id);
};
window.sendReply=()=>{
 const box=document.querySelector('[contenteditable]');
 const item=document.createElement('li');
 item.className='msg-s-message-list__event';
 const node=document.createElement('div');
 node.className='msg-s-event-listitem msg-s-event-listitem--self';
 node.dataset.eventUrn='sent-'+(++window.sent);
 const body=document.createElement('p');
 body.className='msg-s-event-listitem__body';body.textContent=box.innerText;
 node.append(body);item.append(node);document.getElementById('events').append(item);box.textContent='';
};
</script></body></html>`;

async function withPage(run: (page: Page) => Promise<void>, html = fixture) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.route('**/*', request => request.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(2000);
    await page.setContent(html);
    await run(page);
  } finally { await browser.close(); }
}

test('messaging repair: href-less rows are deduplicated and sponsored entries skipped without clicking', async () => {
  await withPage(async page => {
    const threads = await listThreads(page, 20);
    assert.deepEqual(threads.map(t => t.name), ['Sample Contact', 'Second Contact']);
    assert.equal(threads[0]?.unread, true, 'unread marker on the nested card is recognized');
    assert.match(threads[0]!.rowKey!, /^[a-f0-9]{64}$/);
    assert.equal(page.url(), 'about:blank', 'discovery must not open any chat');
  });
});

test('messaging repair: actual conversation is selected by its row, not a fabricated thread URL', async () => {
  await withPage(async page => {
    const threads = await listThreads(page, 20);
    await openThread(page, threads[0]!);
    assert.equal(new URL(page.url()).hash, '#contact');
    assert.equal(await isCurrentThread(page, threads[0]!), true);
    assert.equal(await isCurrentThread(page, threads[1]!), false);
    assert.equal((await currentThread(page, threads))?.name, 'Sample Contact');
    assert.equal(await (await composer(page)).count(), 1);
    assert.equal(await (await sendButton(page)).count(), 1);
    assert.equal(await page.locator('input:checked').count(), 0, 'must not click conversation selection checkboxes');
    assert.equal(await page.evaluate(() => (window as unknown as { sent: number }).sent), 0);
  });
});

test('messaging repair: real message bodies exclude action-menu labels; sender directions are correct', async () => {
  await withPage(async page => {
    const messages = await readMessages(page, identity);
    assert.deepEqual(messages.map(m => m.text), ['Earlier incoming', 'Earlier answer', 'Latest incoming']);
    assert.deepEqual(messages.map(m => m.from), ['other', 'self', 'other']);
    assert.equal(new Set(messages.map(m => m.id)).size, 3);
  });
});

test('messaging repair: row identity survives reordered rows and changing previews', async () => {
  await withPage(async page => {
    const before = (await listThreads(page, 20))[0]!;
    await page.evaluate(() => {
      const list = document.querySelector('.msg-conversations-container__conversations-list')!;
      list.prepend(list.lastElementChild!);
      document.querySelectorAll('.preview').forEach(e => { e.textContent = 'Updated preview'; });
    });
    const after = (await listThreads(page, 20)).find(t => t.name === before.name)!;
    assert.equal(before.url, after.url);
    assert.notEqual(before.signature, after.signature);
    await openThread(page, before);
    assert.equal(await isCurrentThread(page, before), true);
  });
});

test('messaging repair: duplicate names without thread links are not guessed', async () => {
  await withPage(async page => {
    await page.locator('.msg-conversations-container__conversations-list').evaluate(list => {
      const contact = Array.from(list.children).find(e => e.textContent?.includes('Sample Contact'))!;
      list.append(contact.cloneNode(true));
    });
    const threads = await listThreads(page, 20);
    assert.deepEqual(threads.map(t => t.name), ['Second Contact']);
  });
});

test('messaging repair: a row removed after discovery is rejected rather than selecting another contact', async () => {
  await withPage(async page => {
    const thread = (await listThreads(page, 20))[0]!;
    await page.getByText('Sample Contact', { exact: true }).first().evaluate(e => e.closest('li')!.remove());
    await assert.rejects(() => openThread(page, thread), /changed or is ambiguous/);
  });
});

test('messaging repair: switching conversations invalidates the previous recipient guard', async () => {
  await withPage(async page => {
    const threads = await listThreads(page, 20);
    await openThread(page, threads[0]!);
    await openThread(page, threads[1]!);
    assert.equal(await isCurrentThread(page, threads[0]!), false);
    assert.equal(await isCurrentThread(page, threads[1]!), true);
  });
});

test('messaging repair: an explicit incoming continuation is recognized only inside a direct chat', async () => {
  await withPage(async page => {
    await page.locator('#events').evaluate(list => {
      list.insertAdjacentHTML('beforeend', '<li class="msg-s-message-list__event"><div class="msg-s-event-listitem msg-s-event-listitem--other" data-event-urn="continuation"><p class="msg-s-event-listitem__body">More detail</p></div></li>');
    });
    assert.equal((await readMessages(page, identity)).at(-1)?.from, 'other');
    await page.locator('.msg-s-profile-card-one-to-one').evaluate(e => e.remove());
    assert.equal((await readMessages(page, identity)).at(-1)?.from, 'unknown');
  });
});

test('messaging repair: a conflicting author is not inherited from an earlier sender', async () => {
  await withPage(async page => {
    await page.locator('#events').evaluate(list => {
      list.insertAdjacentHTML('beforeend', '<li class="msg-s-message-list__event"><div class="msg-s-event-listitem msg-s-event-listitem--grouped msg-s-event-listitem--other" data-event-urn="conflict"><span class="msg-s-message-group__name">Unexpected Author</span><p class="msg-s-event-listitem__body">Unknown author</p></div></li>');
    });
    assert.equal((await readMessages(page, identity)).at(-1)?.from, 'unknown');
  });
});

test('messaging repair: one newly received message produces one confirmed reply, not a backlog or duplicate', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Bot } = await import('../src/bot.js');
  const { loadConfig } = await import('../src/config.js');
  const dir = mkdtempSync(join(tmpdir(), 'row-transaction-'));
  try {
    await withPage(async page => {
      const bot = new Bot(page.context(), { ...loadConfig(), ...identity, dataDir: dir, dryRun: false, engine: 'rules', key: '', settleMs: 10, allowedNames: [] });
      try {
        const thread = (await listThreads(page, 20))[0]!;
        await bot.inspect(page, thread, true);
        assert.equal(await page.evaluate(() => (window as unknown as { sent: number }).sent), 0);
        await page.locator('#events').evaluate((list, html) => list.insertAdjacentHTML('beforeend', html), event('new-message', 'Sample Contact', 'Hello'));
        const before = await readMessages(page, identity);
        const incoming = incomingTail(before, []);
        await bot.inspect(page, thread);
        await bot.inspect(page, thread);
        assert.equal(await page.evaluate(() => (window as unknown as { sent: number }).sent), 1);
        const after = await readMessages(page, identity);
        assert.equal(pendingConfirmed(after, { ids: incoming.map(m => m.id), replyHash: replyHash(after.at(-1)!.text), attemptedAt: Date.now() }), true);
        const state = JSON.parse(readFileSync(join(dir, 'state-live.json'), 'utf8'));
        assert.equal(Object.values(state.threads).some(r => (r as { pending?: unknown }).pending), false);
      } finally { bot.stop(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
