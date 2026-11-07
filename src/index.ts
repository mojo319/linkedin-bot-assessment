import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, requireIdentity } from './config.js';
import { acquireLock } from './store.js';
import { sleep } from './core.js';
import { Bot, log } from './bot.js';
import { generateReply } from './responder.js';
import { S } from './selectors.js';
import { ActionRequired, launch, signedIn, guard, openPage, MESSAGES_URL, INVITES_URL, listThreads, openThread, readMessages, invitationCards, selectorReport } from './linkedin.js';

async function main(): Promise<void> {
  const command = process.argv[2] || 'run';
  if (!['run', 'login', 'check', 'ai-check'].includes(command)) throw new Error('Use npm start, npm run login, npm run check, or npm run ai-check.');
  const config = loadConfig();
  if (command === 'ai-check') {
    const sample = { id: 'synthetic', from: 'other' as const, text: 'Hi! What can you help with?', attachment: false };
    const reply = await generateReply(config, [], [sample]);
    console.log(`Engine: ${reply.source}; synthetic test reply: ${reply.text}`);
    if (reply.degraded) throw new Error('AI test failed. Check your key, API billing/access, model name, and internet connection. No private messages were used.');
    if (reply.source === 'rules') console.log('No AI engine is active. Basic local rules only; limited language and question handling.');
    return;
  }
  if (command !== 'login') requireIdentity(config);
  const release = acquireLock(config.dataDir);
  const context = await launch(config).catch(error => { release(); throw error; });
  let bot: Bot | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    bot?.stop();
    await context.close().catch(() => undefined);
    release();
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  try {
    if (command === 'login') {
      const page = context.pages()[0] || await context.newPage();
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
      console.log('Sign in MANUALLY in the new browser. Complete any verification yourself.');
      console.log('Use LinkedIn in English for the current selectors. Keep this profile separate from everyday Chrome.');
      const reader = createInterface({ input: stdin, output: stdout });
      try { await reader.question('When the LinkedIn feed is visible, return here and press Enter: '); }
      finally { reader.close(); }
      await guard(page);
      if (!await signedIn(context)) throw new Error('No authenticated session detected. Run npm run login again.');
      console.log('LOGIN SAVED locally in .local/profile. No password, cookie, or account access is sent to the recruiter.');
      return;
    }
    if (!await signedIn(context)) throw new ActionRequired('No saved LinkedIn login. Run npm run login first.');
    if (command === 'check') {
      const page = await openPage(context, MESSAGES_URL);
      await page.locator(S.conversationList).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => undefined);
      await sleep(1500);
      const threads = await listThreads(page, config.maxThreads);
      console.log('LOGIN: present');
      console.log('DRY_RUN:', config.dryRun);
      console.log('INBOX SELECTOR COUNTS:', JSON.stringify(await selectorReport(page)));
      console.log('VISIBLE THREADS:', threads.length);
      console.log('MESSAGING DETECTOR: row-v1 (sponsored entries excluded; nested rows deduplicated)');
      let validated = false;
      const candidates = threads.filter(thread => !thread.group && thread.name);
      for (const direct of candidates.slice(0, 6)) {
        try {
          await openThread(page, direct);
          const messages = await readMessages(page, { ...config, contactName: direct.name });
          const root = page.locator(S.thread).filter({ visible: true }).first();
          const editors = await root.locator(S.composer).filter({ visible: true }).count();
          const sends = await root.locator(S.sendButton).filter({ visible: true }).count();
          const directEvidence = !direct.rowKey || await root.locator('a.msg-thread__link-to-profile[href*="/in/"], .msg-s-profile-card-one-to-one').count() > 0;
          if (!messages.length || !editors || !sends || !directEvidence || messages.at(-1)?.from === 'unknown') continue;
          console.log('SAMPLE THREAD MESSAGES:', messages.length);
          console.log('SENDER COUNTS:', JSON.stringify({ self: messages.filter(m => m.from === 'self').length, other: messages.filter(m => m.from === 'other').length, unknown: messages.filter(m => m.from === 'unknown').length }));
          console.log('THREAD SELECTOR COUNTS:', JSON.stringify(await selectorReport(page)));
          console.log('MESSAGE EDITOR:', editors);
          console.log('SEND BUTTON:', sends);
          console.log('MESSAGING CHECK: PASS (read-only; actual sending has not been tested)');
          validated = true;
          break;
        } catch (error) {
          if (error instanceof ActionRequired) throw error;
          console.log('Sample conversation could not be verified; trying the next visible direct conversation.');
        }
      }
      if (!validated) console.log('MESSAGING CHECK: NEEDS REPAIR (no verified direct conversation with message history and editor). Do not submit yet.');
      const invites = await openPage(context, INVITES_URL);
      // Wait for rendered controls, not only the initial HTML response.
      await invites.getByRole('button', { name: /^Accept\b/i }).first()
        .waitFor({ state: 'visible', timeout: 12000 }).catch(() => undefined);
      await sleep(700);
      const detectedInvitations = await invitationCards(invites);
      console.log('INVITATION DETECTOR: semantic-v1 (connection invitations only)');
      console.log('INVITATION SELECTOR COUNTS:', JSON.stringify(await selectorReport(invites)));
      console.log('VISIBLE ACCEPT BUTTONS:', await invites.getByRole('button', { name: /^Accept\b/i }).filter({ visible: true }).count());
      console.log('ACCEPTABLE INVITATIONS:', detectedInvitations.length);
      console.log('INVITATION TYPES: newsletters, subscriptions, page/group/event invitations and ambiguous cards are skipped.');
      console.log('CHECK COMPLETE: no messages sent and no invitations accepted. Viewing a conversation may mark it read.');
      return;
    }
    console.log('LinkedIn prohibits unauthorized automation and may restrict accounts. No evasion or challenge bypass is included.');
    console.log(config.dryRun ? 'DRY RUN: will not send or accept. Reading can mark messages read.' : 'LIVE: will accept incoming connections and reply to new incoming direct messages in scope.');
    console.log(config.allowedNames.length ? 'SCOPE: exact-name allowlist enabled.' : 'SCOPE: all incoming people; restrict ALLOWED_NAMES in .env for a tester-only run.');
    if (config.key && config.engine !== 'rules') {
      console.log('AI ENABLED: limited message text is sent to OpenAI to generate replies, with store:false. Files are not uploaded.');
      const sample = { id: 'preflight', from: 'other' as const, text: 'Hello!', attachment: false };
      const result = await generateReply(config, [], [sample]);
      if (result.degraded) throw new Error('AI preflight failed. Fix with npm run ai-check, or explicitly set REPLY_ENGINE=rules to use basic replies.');
      log('AI preflight passed with a synthetic message.');
    } else {
      console.log('BASIC RULES ONLY: multilingual/general-question quality is limited. Configure an API key for stronger replies.');
    }
    bot = new Bot(context, config);
    await bot.run();
  } finally {
    bot?.stop();
    await context.close().catch(() => undefined);
    release();
  }
}
main().catch(error => {
  // Known local configuration errors are safe; Playwright exceptions can contain page text.
  const safe = error instanceof ActionRequired || (error instanceof Error && !/Timeout|locator\.|page\.|browser|TargetClosed/i.test(error.message));
  console.error('STOPPED:', safe && error instanceof Error ? error.message : 'Browser or page operation failed. Check login, connectivity, and npm run check; no private page details are logged.');
  process.exitCode = 1;
});
