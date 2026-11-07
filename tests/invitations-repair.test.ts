import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { invitationCards, invitationName, acceptButton } from '../src/linkedin.js';

// Synthetic fixtures only: these do not establish support for a live account.
const person = `<div id="person" class="random-a"><a href="/in/test-person/"><img alt="" /></a><a href="/in/test-person/">Test Person</a><p>Computer systems student</p><div><button>Ignore</button><button onclick="document.getElementById('person').remove()">Accept</button></div></div>`;
const newsletter = `<div id="newsletter" class="random-b"><p>Newsletter &middot; Biweekly</p><div><a href="/in/test-publisher/">Test Publisher</a> invited you to subscribe to <a href="/newsletters/synthetic/">Sample newsletter</a><button>Ignore</button><button>Accept</button></div></div>`;
const withPage = async (html: string, run: (page: import('playwright').Page) => Promise<void>) => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await run(page);
  } finally { await browser.close(); }
};

test('invitation repair: class-independent person detection excludes a profile-linked newsletter and suggestions', async () => {
  await withPage(`<main><h1>Manage invitations</h1><div>${person}${newsletter}</div><div><a href="/in/suggested/">Suggested Person</a><button>Connect</button></div></main>`, async page => {
    const cards = await invitationCards(page);
    assert.equal(cards.length, 1);
    assert.equal(await invitationName(cards[0]!), 'Test Person');
    assert.equal(await page.locator('#person').count(), 1, 'detection must not click Accept');
    await (await acceptButton(cards[0]!)).click();
    assert.equal(await page.locator('#person').count(), 0);
    assert.equal(await page.locator('#newsletter').count(), 1);
    assert.equal((await invitationCards(page)).length, 0);
  });
});

test('invitation repair: role buttons and accessible Accept names are supported', async () => {
  await withPage('<main><article><a href="/in/test-role/">Role Person</a><span role="button" tabindex="0" aria-label="Ignore invitation from Role Person">Ignore</span><span role="button" tabindex="0" aria-label="Accept invitation from Role Person">Accept</span></article></main>', async page => {
    const cards = await invitationCards(page);
    assert.equal(cards.length, 1);
    assert.equal(await invitationName(cards[0]!), 'Role Person');
    assert.equal(await (await acceptButton(cards[0]!)).getAttribute('role'), 'button');
  });
});

test('invitation repair: category outside an inner row still excludes newsletters', async () => {
  await withPage('<main><article><p>Newsletter</p><div><a href="/in/test-author/">Test Author</a><button>Ignore</button><button>Accept</button></div></article></main>', async page => {
    assert.equal((await invitationCards(page)).length, 0);
  });
});

test('invitation repair: unknown generic Accept controls and non-person profiles are ignored', async () => {
  await withPage('<main><div><a href="/in/test-person/">Test Person</a><button>Accept</button></div><div><a href="/company/example/">Example</a><button>Ignore</button><button>Accept</button></div></main>', async page => {
    assert.equal((await invitationCards(page)).length, 0);
  });
});

test('invitation repair: disabled and hidden requests are not offered', async () => {
  await withPage('<main><div><a href="/in/one/">One</a><button>Ignore</button><button disabled>Accept</button></div><div style="display:none"><a href="/in/two/">Two</a><button>Ignore</button><button>Accept</button></div></main>', async page => {
    assert.equal((await invitationCards(page)).length, 0);
  });
});

test('invitation repair: a scan stays correct after first row disappears', async () => {
  await withPage(`<main><div>${person}${person.replaceAll('id="person"', 'id="second"').replaceAll('/in/test-person/', '/in/second/').replaceAll('Test Person', 'Second Person').replaceAll("getElementById('person')", "getElementById('second')")}</div></main>`, async page => {
    const cards = await invitationCards(page);
    assert.equal(cards.length, 2);
    await (await acceptButton(cards[0]!)).click();
    assert.equal(await invitationName(cards[1]!), 'Second Person');
    await (await acceptButton(cards[1]!)).click();
    assert.equal((await invitationCards(page)).length, 0);
  });
});

test('invitation repair: changed person is rejected before accepting', async () => {
  await withPage(`<main>${person}</main>`, async page => {
    const cards = await invitationCards(page);
    await page.locator('[data-local-invite-person]').evaluate(element => element.setAttribute('href', '/in/someone-else/'));
    await assert.rejects(() => acceptButton(cards[0]!), /identity or type changed/);
  });
});

test('invitation repair: page, group, and event invitations with person links are excluded', async () => {
  for (const phrase of ['invited you to follow Example Company', 'invites you to join Example Group', 'invited you to attend Example Event']) {
    await withPage(`<main><div><a href="/in/test-inviter/">Test Inviter</a><p>${phrase}</p><button>Ignore</button><button>Accept</button></div></main>`, async page => {
      assert.equal((await invitationCards(page)).length, 0);
    });
  }
});
