import { chromium } from 'playwright';
import type { BrowserContext, Locator, Page } from 'playwright';
import { join } from 'node:path';
import type { Config } from './config.js';
import { hash, normalize, sleep } from './core.js';
import type { Message, Thread } from './core.js';
import { S } from './selectors.js';

export class ActionRequired extends Error {}
export class LayoutChanged extends Error {}
export const MESSAGES_URL = 'https://www.linkedin.com/messaging/';
export const INVITES_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/received/';

export async function launch(config: Config): Promise<BrowserContext> {
  return chromium.launchPersistentContext(join(config.dataDir, 'profile'), {
    headless: config.headless,
    viewport: { width: 1360, height: 900 },
    acceptDownloads: false,
    // No stealth plugins, fingerprint changes, proxy rotation, or CAPTCHA bypasses.
  });
}
export async function guard(page: Page): Promise<void> {
  if (page.isClosed()) throw new ActionRequired('Browser closed. Restart the program to resume.');
  const url = page.url();
  if (/\/(login|checkpoint|challenge|authwall)(\/|\?|$)/i.test(url)) {
    throw new ActionRequired('Login or a security check is required. Stop, then run npm run login and resolve it manually.');
  }
  if (await page.locator('iframe[src*="captcha"]').first().isVisible().catch(() => false)) {
    throw new ActionRequired('Security challenge detected. Resolve it manually; no bypass is attempted.');
  }
  if (await page.getByText(/your account (is|has been) (temporarily )?restricted/i).first().isVisible().catch(() => false)) {
    throw new ActionRequired('Account restriction detected. Stop automation and follow LinkedIn instructions.');
  }
}
export async function signedIn(context: BrowserContext): Promise<boolean> {
  return (await context.cookies('https://www.linkedin.com')).some(c => c.name === 'li_at' && c.value.length > 0);
}
export async function openPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(30000);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await guard(page);
  return page;
}

// MESSAGING REPAIR V1
// A row key is an internal identity, not a URL to navigate to. Duplicate names
// without real thread links are skipped rather than choosing an arbitrary row.
const openedRows = new WeakMap<Page, { key: string; route: string }>();
const route = (url: string): string => {
  const value = new URL(url);
  return value.origin + value.pathname.replace(/\/$/, '');
};

async function conversationRows(page: Page) {
  return page.evaluate(selectors => {
    const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const root = document.querySelector(selectors.conversationList) || document.querySelector('main') || document;
    const all = Array.from(root.querySelectorAll(selectors.conversationRow));
    const rows = all.filter(row => !all.some(parent => parent !== row && parent.contains(row)));
    const sources = rows.length ? rows : Array.from(root.querySelectorAll(selectors.conversationLink));
    return sources.filter(visible).map(row => {
      const anchor = row.matches(selectors.conversationLink) ? row : row.querySelector(selectors.conversationLink);
      let url = '';
      try {
        const href = anchor?.getAttribute('href');
        if (href) {
          const target = new URL(href, 'https://www.linkedin.com');
          if (target.origin === 'https://www.linkedin.com' && /^\/messaging\/thread\/[^/]+\/?$/.test(target.pathname)) {
            url = target.origin + target.pathname.replace(/\/?$/, '/');
          }
        }
      } catch { /* Malformed or external links are not navigation targets. */ }
      const name = clean(row.querySelector(selectors.participantName)?.textContent || '');
      const signature = clean((row as HTMLElement).innerText || row.textContent || '');
      const classes = [row, ...Array.from(row.querySelectorAll('[class]'))].map(e => e.className).join(' ');
      const unread = /--unread(?:\s|$)/.test(classes) || !!row.querySelector('[class*="unread"], [aria-label*="unread" i]');
      const group = !!row.querySelector('.msg-conversation-listitem__group-icon, .msg-conversation-card__group-icon, [aria-label*="group conversation" i]');
      const sponsored = /\bSponsored\b/i.test(signature) || /sponsored|spinmail/.test(classes);
      return { url, name, signature, unread, group, sponsored };
    });
  }, S);
}

export async function listThreads(page: Page, max: number): Promise<Thread[]> {
  await guard(page);
  const rows = await conversationRows(page);
  const nameCounts = new Map<string, number>();
  for (const row of rows) {
    const name = normalize(row.name).toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const seen = new Set<string>();
  const result: Thread[] = [];
  for (const row of rows) {
    if (!row.name || row.sponsored) continue;
    const name = normalize(row.name).toLowerCase();
    if (!row.url && nameCounts.get(name) !== 1) continue;
    const rowKey = row.url ? undefined : hash('conversation-row:' + name);
    const url = row.url || MESSAGES_URL + '#local-row-' + rowKey;
    if (seen.has(url)) continue;
    seen.add(url);
    result.push({ url, name: row.name, signature: hash(row.signature), unread: row.unread, group: row.group, ...(rowKey ? { rowKey } : {}) });
    if (result.length >= max) break;
  }
  return result;
}

async function titleMatches(page: Page, thread: Thread): Promise<boolean> {
  const root = page.locator(S.thread).filter({ visible: true }).first();
  if (!await root.count()) return false;
  const title = root.locator('.msg-title-bar').filter({ visible: true }).first();
  // The observed row layout has a dedicated title bar. Do not match an old
  // sender name in message history and mistake it for the current recipient.
  if (thread.rowKey && !await title.count()) return false;
  const scope = await title.count() ? title : root;
  return scope.getByText(thread.name, { exact: true }).first().isVisible().catch(() => false);
}

export async function isCurrentThread(page: Page, thread: Thread): Promise<boolean> {
  if (page.isClosed()) return false;
  if (thread.rowKey) {
    const selected = openedRows.get(page);
    if (!selected || selected.key !== thread.rowKey || selected.route !== route(page.url())) return false;
  } else if (route(page.url()) !== route(thread.url)) return false;
  return !thread.name || await titleMatches(page, thread);
}

export async function currentThread(page: Page, threads: Thread[]): Promise<Thread | undefined> {
  const selected = openedRows.get(page);
  const candidate = threads.find(thread => thread.rowKey
    ? !!selected && thread.rowKey === selected.key && selected.route === route(page.url())
    : route(thread.url) === route(page.url()));
  return candidate && await isCurrentThread(page, candidate) ? candidate : undefined;
}

async function rowTarget(page: Page, thread: Thread): Promise<Locator> {
  if (!thread.rowKey || !/^[a-f0-9]{64}$/.test(thread.rowKey)) throw new LayoutChanged('Invalid local conversation key.');
  const found = await page.evaluate(({ selectors, name, key }) => {
    const clean = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    const root = document.querySelector(selectors.conversationList) || document.querySelector('main') || document;
    const all = Array.from(root.querySelectorAll(selectors.conversationRow));
    const matches = all.filter(row => !all.some(parent => parent !== row && parent.contains(row)))
      .filter(row => row.getClientRects().length && getComputedStyle(row).visibility !== 'hidden')
      .filter(row => clean(row.querySelector(selectors.participantName)?.textContent || '') === clean(name));
    for (const old of document.querySelectorAll('[data-local-conversation-target]')) old.removeAttribute('data-local-conversation-target');
    if (matches.length !== 1) return false;
    const row = matches[0]!;
    if (/\bSponsored\b/i.test((row as HTMLElement).innerText || row.textContent || '')) return false;
    const target = row.querySelector('.msg-conversation-listitem__link, .msg-conversations-container__convo-item-link') ||
      row.querySelector(selectors.conversationLink) || row.querySelector(selectors.participantName);
    if (!target) return false;
    target.setAttribute('data-local-conversation-target', key);
    return true;
  }, { selectors: S, name: thread.name, key: thread.rowKey });
  if (!found) throw new LayoutChanged('Conversation row changed or is ambiguous; rescan instead of guessing.');
  return page.locator(`[data-local-conversation-target="${thread.rowKey}"]`);
}

export async function openThread(page: Page, thread: Thread): Promise<void> {
  await guard(page);
  if (await isCurrentThread(page, thread)) return;
  if (thread.rowKey) {
    const target = await rowTarget(page, thread);
    await target.click();
  } else {
    const path = new URL(thread.url).pathname.replace(/\/$/, '');
    const links = page.locator(S.conversationLink);
    let selected: Locator | undefined;
    for (let i = 0; i < await links.count(); i++) {
      const item = links.nth(i);
      const href = await item.getAttribute('href');
      if (href && new URL(href, MESSAGES_URL).pathname.replace(/\/$/, '') === path) { selected = item; break; }
    }
    if (selected) {
      await selected.click();
      await page.waitForURL(url => url.pathname.replace(/\/$/, '') === path, { timeout: 10000 });
    } else if (route(page.url()) !== route(thread.url)) {
      await page.goto(thread.url, { waitUntil: 'domcontentloaded' });
    }
  }
  const root = page.locator(S.thread).filter({ visible: true }).first();
  await root.waitFor({ state: 'visible', timeout: 10000 });
  if (thread.name) {
    const title = thread.rowKey ? root.locator('.msg-title-bar').first() : root;
    await title.getByText(thread.name, { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
  }
  await sleep(600);
  await guard(page);
  if (thread.rowKey) openedRows.set(page, { key: thread.rowKey, route: route(page.url()) });
  if (!await isCurrentThread(page, thread)) throw new LayoutChanged('Selected conversation could not be verified.');
}
// END MESSAGING REPAIR V1

export async function readMessages(page: Page, config: Pick<Config, 'selfName' | 'selfProfile'> & { contactName?: string }): Promise<Message[]> {
  const raw = await page.evaluate(({ selectors, selfName, selfProfile, contactName }) => {
    const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const profilePath = (url: string) => {
      try { return new URL(url, 'https://www.linkedin.com').pathname.replace(/\/$/, '').toLowerCase(); } catch { return ''; }
    };
    const self = clean(selfName).toLowerCase();
    const contact = clean(contactName || '').toLowerCase();
    const selfPath = selfProfile ? profilePath(selfProfile) : '';
    const root = document.querySelector(selectors.thread) || document.querySelector('main') || document;
    let nodes = Array.from(root.querySelectorAll(selectors.event));
    if (!nodes.length) nodes = Array.from(root.querySelectorAll(selectors.eventFallback));
    let previousAuthor = '';
    let previousDirection: 'self' | 'other' | 'unknown' = 'unknown';
    const occurrences = new Map<string, number>();
    const result: { rawId: string; from: 'self' | 'other' | 'unknown'; text: string; attachment: boolean }[] = [];
    for (const node of nodes) {
      const outer = node.closest('.msg-s-message-list__event') || node;
      // Prefer the actual message body over wrappers containing action-menu text.
      const body = node.querySelector('.msg-s-event-listitem__body') || node.querySelector('.msg-s-event__content');
      const attachment = !!node.querySelector('[class*="attachment"], .msg-s-event-listitem__image-container, video, audio, a[download]');
      // Do not mistake sender avatars, timestamps, reactions, or system notices for messages.
      if (!body && !attachment) continue;
      const content = body?.cloneNode(true) as Element | undefined;
      content?.querySelectorAll('.msg-s-event-listitem__actions-container, [role="menu"], button, script, style, [aria-hidden="true"]').forEach(e => e.remove());
      const text = (content?.textContent || '').trim();
      const authorElement = node.querySelector(selectors.sender) || outer.querySelector(selectors.sender);
      const author = clean(authorElement?.textContent || '');
      const authorAnchor = authorElement?.closest('a') || node.querySelector('a[href*="/in/"]');
      const authorPath = authorAnchor?.getAttribute('href') ? profilePath(authorAnchor.getAttribute('href')!) : '';
      const classes = node.className + ' ' + outer.className;
      const ownClass = /(?:--from-me|--self|--outbound|--from-self)(?:\s|$)/.test(classes);
      const otherClass = /(?:^|\s)msg-s-event-listitem--other(?:\s|$)/.test(classes);
      const oneToOne = !!root.querySelector('.msg-s-profile-card-one-to-one, a.msg-thread__link-to-profile[href*="/in/"]');
      let from: 'self' | 'other' | 'unknown' = 'unknown';
      if (ownClass || (selfPath && authorPath === selfPath) || (author && (author.toLowerCase() === self || author === 'You'))) from = 'self';
      // LinkedIn marks inbound direct-message events with --other. In a verified
      // one-to-one thread this direction marker is more reliable than rendered
      // sender-name text, which may contain wrappers/badges or be absent in bursts.
      else if (otherClass && oneToOne) from = 'other';
      else if (author && contact && author.toLowerCase() === contact) from = 'other';
      else if (/--grouped|--continuation/.test(classes) && !author && !authorPath) from = previousDirection;
      // A continuation without a known grouping marker remains unknown (fail closed).
      if (author || from !== 'unknown') {
        previousAuthor = author || previousAuthor;
        previousDirection = from;
      }
      const eventHolder = node.closest('[data-event-urn], [data-event-id]');
      const explicit = node.getAttribute('data-event-urn') || node.getAttribute('data-event-id') || eventHolder?.getAttribute('data-event-urn') || eventHolder?.getAttribute('data-event-id') || '';
      const time = outer.querySelector('time')?.getAttribute('datetime') || outer.querySelector('time')?.textContent || '';
      const date = outer.getAttribute('data-date') || '';
      const basis = JSON.stringify([author || previousAuthor, from, text, attachment, time, date]);
      const ordinal = (occurrences.get(basis) || 0) + 1;
      occurrences.set(basis, ordinal);
      const rawId = explicit ? 'id:' + explicit : 'fallback:' + basis + ':' + ordinal;
      result.push({ rawId, from, text, attachment });
    }
    return result;
  }, { selectors: S, selfName: config.selfName, selfProfile: config.selfProfile, contactName: config.contactName || '' });
  return raw.map(m => ({ id: hash(m.rawId), from: m.from, text: m.text, attachment: m.attachment }));
}

export async function isGroupThread(page: Page): Promise<boolean> {
  return page.locator(S.thread).first().locator('.msg-thread__topcard-title-group, .msg-thread__group-name, .msg-s-profile-card-group, [aria-label*="group conversation" i]').first().isVisible().catch(() => false);
}
export async function composer(page: Page): Promise<Locator> {
  const root = page.locator(S.thread).first();
  const box = root.locator(S.composer).filter({ visible: true }).first();
  if (!await box.count()) throw new LayoutChanged('Message editor not found; run npm run check.');
  return box;
}
export async function sendButton(page: Page): Promise<Locator> {
  const root = page.locator(S.thread).first();
  const candidate = root.locator(S.sendButton).filter({ visible: true }).first();
  if (await candidate.count()) return candidate;
  const byRole = root.getByRole('button', { name: /^Send$/i }).filter({ visible: true });
  if (await byRole.count() !== 1) throw new LayoutChanged('Cannot identify a unique Send button.');
  return byRole;
}

// INVITATION REPAIR V1
/**
 * Identify incoming people by their rendered controls, not LinkedIn CSS classes.
 * This function reads the DOM and adds local marker attributes only. It never clicks.
 * Unknown, non-person, newsletter, event, page, and group invitations are skipped.
 */
export async function invitationCards(page: Page): Promise<Locator[]> {
  await guard(page);
  // Restrict production detection to the received-invitations screen.
  // about:blank is used exclusively by the repository's synthetic browser tests.
  const url = page.url();
  if (url !== 'about:blank') {
    const current = new URL(url);
    if (current.origin !== 'https://www.linkedin.com' ||
        !/^\/mynetwork\/invitation-manager\/(?:received\/?)?$/.test(current.pathname)) {
      throw new LayoutChanged('Open the received-invitations page before detecting requests.');
    }
  }
  const buttons = page.getByRole('button', { name: /^Accept\b/i }).filter({ visible: true });
  const ids = await buttons.evaluateAll((accepts) => {
    const clean = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const label = (element: Element) => {
      const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '').join(' ');
      return clean(labelledBy || element.getAttribute('aria-label') || (element as HTMLElement).innerText || element.textContent || '');
    };
    const text = (element: Element) => clean((element as HTMLElement).innerText || element.textContent || '');
    const profilePath = (anchor: HTMLAnchorElement) => {
      try {
        const url = new URL(anchor.getAttribute('href') || '', 'https://www.linkedin.com');
        return ['www.linkedin.com', 'linkedin.com'].includes(url.hostname) && /^\/in\/[^/]+\/?$/.test(url.pathname)
          ? url.pathname.replace(/\/$/, '').toLowerCase() : '';
      } catch { return ''; }
    };
    const nonConnection = /\b(?:newsletter|subscribe|subscription)\b|\binvit(?:ed|es) you to (?:follow|join|attend)\b|\b(?:event|group|page) invitation\b/i;
    const legacyCard = '.invitation-card, .invitation-card-container, [data-view-name="invitation-card"]';
    const attrs = ['data-local-invite-card', 'data-local-invite-name', 'data-local-invite-profile', 'data-local-invite-accept', 'data-local-invite-person'];
    for (const attr of attrs) for (const element of document.querySelectorAll(`[${attr}]`)) element.removeAttribute(attr);
    const marked = new Set<Element>();
    const result: string[] = [];
    for (const accept of accepts) {
      if ((accept as HTMLButtonElement).disabled || accept.getAttribute('aria-disabled') === 'true') continue;
      let card: Element | undefined;
      let person: HTMLAnchorElement | undefined;
      let ancestor = accept.parentElement;
      for (let depth = 0; ancestor && depth < 14; depth++, ancestor = ancestor.parentElement) {
        if (ancestor.matches('main, body, html, [role="main"]')) break;
        const inside = accepts.filter(button => ancestor!.contains(button));
        if (inside.length !== 1) break;
        const controls = Array.from(ancestor.querySelectorAll('button, [role="button"]')).filter(visible);
        if (controls.some(button => /^Connect\b/i.test(label(button)))) break;
        const ignores = controls.filter(button => /^Ignore\b/i.test(label(button)));
        if (ignores.length > 1 || text(ancestor).length > 12000) break;
        const people = Array.from(ancestor.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .filter(anchor => visible(anchor) && profilePath(anchor) && text(anchor) && text(anchor).length < 200);
        // An Ignore/Accept pair is required on unknown layouts. Legacy fixture cards
        // also remain supported, but receive the same non-connection exclusion.
        if (people.length && (ignores.length === 1 || ancestor.matches(legacyCard))) {
          card = ancestor;
          person = people[0];
        }
        // Continue through single-card wrappers so category labels outside an inner
        // action row (for example Newsletter) are included in classification.
      }
      if (!card || !person || marked.has(card)) continue;
      const content = text(card);
      if (nonConnection.test(content) || card.querySelector('a[href*="/newsletters/"], a[href*="/newsletter/"], a[href*="/events/"], a[href*="/groups/"]')) continue;
      const id = Date.now().toString(36) + '-' + result.length;
      card.setAttribute('data-local-invite-card', id);
      card.setAttribute('data-local-invite-name', text(person));
      card.setAttribute('data-local-invite-profile', profilePath(person));
      person.setAttribute('data-local-invite-person', id);
      accept.setAttribute('data-local-invite-accept', id);
      marked.add(card);
      result.push(id);
    }
    return result;
  });
  return ids.map(id => page.locator(`[data-local-invite-card="${id}"]`));
}
export async function invitationName(card: Locator): Promise<string> {
  return normalize(await card.getAttribute('data-local-invite-name') || '');
}
export async function acceptButton(card: Locator): Promise<Locator> {
  const id = await card.getAttribute('data-local-invite-card');
  if (!id || !/^[a-z0-9]+-\d+$/.test(id)) throw new LayoutChanged('Invitation changed; rescan before accepting.');
  // Recheck identity before returning an actionable locator. A rerender must not
  // silently redirect a previously allowlisted action to another person.
  const stillSamePerson = await card.evaluate(element => {
    const clean = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const name = element.getAttribute('data-local-invite-name') || '';
    const profile = element.getAttribute('data-local-invite-profile') || '';
    const link = element.querySelector<HTMLAnchorElement>('[data-local-invite-person]');
    const content = (element as HTMLElement).innerText || element.textContent || '';
    if (!link || /\b(?:newsletter|subscribe|subscription)\b|\binvit(?:ed|es) you to (?:follow|join|attend)\b|\b(?:event|group|page) invitation\b/i.test(content) ||
        element.querySelector('a[href*="/newsletters/"], a[href*="/newsletter/"], a[href*="/events/"], a[href*="/groups/"]')) return false;
    try {
      const url = new URL(link.getAttribute('href') || '', 'https://www.linkedin.com');
      return ['www.linkedin.com', 'linkedin.com'].includes(url.hostname) &&
        url.pathname.replace(/\/$/, '').toLowerCase() === profile &&
        clean(link.innerText || link.textContent || '') === name;
    } catch { return false; }
  });
  if (!stillSamePerson) throw new LayoutChanged('Invitation identity or type changed; refusing to click.');
  const button = card.getByRole('button', { name: /^Accept\b/i }).and(card.locator(`[data-local-invite-accept="${id}"]`));
  if (await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) {
    throw new LayoutChanged('Cannot identify a unique enabled Accept button.');
  }
  return button;
}

export async function selectorReport(page: Page): Promise<Record<string, number>> {
  const report: Record<string, number> = {};
  for (const [name, selector] of Object.entries(S)) report[name] = await page.locator(selector).count();
  return report;
}
