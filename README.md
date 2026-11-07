# LinkedIn inbox assessment assistant

A local TypeScript/Playwright starter for a reply-only assessment. It uses a separate, manually authenticated Chromium profile. It never sends an initial message or an outgoing connection request. Live mode accepts incoming connections in scope and attempts short replies to newly observed incoming direct messages.

**Status:** TypeScript and synthetic tests pass. The current LinkedIn UI, your Windows environment, real message delivery, and a real AI request still require local verification. Do not describe this as live-validated until those checks pass.

## Account-risk boundary

LinkedIn prohibits unauthorized browser automation and can restrict accounts. Low activity, a real browser, or use for a hiring assessment does not constitute permission. There is no stealth mode, CAPTCHA solver, proxy rotation, cookie extraction workflow, or security-control bypass. Login and challenges are handled manually; detected restrictions stop the program. Choose whether to accept that account risk before using it.

## Windows installation into the existing project

Copy the ZIP contents into `C:\Users\Mojo\linkedin-bot`, replacing the old smoke-test `src/index.ts`, `tsconfig.json`, and `.gitignore`. Do not create an extra nested project directory. The ZIP intentionally does not replace your existing `package.json` or lockfile. `setup.cjs` updates the scripts while preserving installed dependency version declarations. In a fresh directory it creates `package.json`.

In Command Prompt, in that directory:

```cmd
node setup.cjs
npm install
npm run typecheck
npm test
npm run test:browser
```

On a fresh machine, also run `npx playwright install chromium`. This was already done in the assessment setup.

`setup.cjs` creates `.env` from `.env.example` only when `.env` does not exist. Edit the local `.env`:

```dotenv
SELF_NAME=Your exact LinkedIn display name
SELF_PROFILE_URL=https://www.linkedin.com/in/your-profile-slug/
DRY_RUN=true
REPLY_ENGINE=auto
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
```

Use your own exact name/profile URL. Do not use the example values. Do not put your LinkedIn password in this file. Keep the LinkedIn interface in English for the current action labels.

## Reply engine and data handling

With `REPLY_ENGINE=auto`, a nonempty `OPENAI_API_KEY` enables the OpenAI Responses API; without a key, basic local rules are used. `REPLY_ENGINE=ai` requires a key. `REPLY_ENGINE=rules` disables API requests even when a key exists.

Basic rules are a resilience fallback, not a strong solution for arbitrary questions or languages. They handle a small set of greetings, empty messages, emoji, links, attachments, rude messages, and uncertainty, with limited English/French/Arabic/Spanish templates. Natural, context-specific answers need a working AI provider.

AI mode sends bounded recent message text plus optional `OWNER_CONTEXT` to OpenAI. It does not upload attached files, send browser cookies to the provider, or give the model tools. Requests use `store:false`, which is not a guarantee of zero provider retention. Enable it only when authorized to process those messages with that provider. Do not put credentials, private third-party data, or irrelevant personal facts in `OWNER_CONTEXT`.

Check API connectivity using synthetic input, not a private conversation:

```cmd
npm run ai-check
```

The selected model is configurable. Use a model available to your API account. A failed AI preflight stops startup; a later transient AI failure uses the local fallback and logs a warning without logging the message.

## Login and read-only diagnostics

```cmd
npm run login
```

A separate browser opens. Sign in manually, complete verification, wait until the LinkedIn feed is visible, then return to the terminal and press Enter. The local profile is stored under `.local/profile`. Never share that directory.

```cmd
npm run check
```

This reports selector counts, visible thread counts, recognized sender counts, and pending invitation counts. It does not click Accept or Send. **Viewing a conversation may mark it read.** Counts contain no message text, display names, profile URLs, passwords, or cookies.

Zero detected conversations may mean an empty inbox, a filtered view, or incompatible selectors. Unknown ownership of the latest message is a stop condition for that thread. Repair `src/selectors.ts` and, when needed, the extraction logic in `src/linkedin.ts` before relying on the bot. A successful check is not a substitute for an actual controlled message-delivery test.

## Dry run

Keep `DRY_RUN=true` and run:

```cmd
npm start
```

The first run establishes a baseline of supported visible conversations without replying to their existing messages. Wait for `READY`. Then have a consenting contact send a **new** message; expect `DRY RUN would reply ... Nothing sent.` Pending invitations produce `DRY RUN would accept ... Nothing clicked.` Stop with Ctrl+C.

The baseline avoids automatically answering old personal conversations. Dry and live state files are separate. The baseline is limited to rendered conversations, so unread conversations that appear later may be treated as new. An exact-name allowlist is the strongest scope control available here.

## Live verification and assessment operation

Only after the read-only checks succeed, set `DRY_RUN=false` in `.env` and restart `npm start`. Wait for the LIVE `READY` line before sending the controlled test message. The first live startup has its own baseline and intentionally does not answer messages already present then.

Confirm one incoming connection is accepted and a new message receives exactly one sensible reply. Do not use the evaluator's submission as the first live validation. After verification, push the final code before pressing Submit, then keep the program running until the assessment page says it is finished. Keep the computer plugged in, awake, and online; preserve the terminal and both bot browser tabs. Do not navigate or type in those tabs while the bot runs.

By default the scope is **all incoming people**. Set `ALLOWED_NAMES=Exact Tester Name;Exact Second Name` to narrow both invitation acceptance and replies. Do not invent a tester name: an incorrect allowlist will exclude the evaluator. Known group conversations are skipped; unfamiliar author names fail closed.

Defaults are a 5-second message scan, a 30-second invitation refresh, a 2.5-second burst-settling interval, and periodic inbox reloads. These are application settings, not safe or permitted LinkedIn limits. No response-time guarantee is possible: UI rendering, provider response time, connection quality, and queued conversations add latency.

## Reliability controls

- A serialized message worker avoids simultaneous sends in the same UI; invitations use a separate page.
- Recent incoming IDs, thread identifiers, and preview signatures are persisted as hashes. Raw message bodies are not written to the bot's state file or normal logs. Browser profile/cache data still remains local and private.
- Existing messages are baselined, own outgoing messages are ignored, and unrecognized ownership is not guessed.
- A short quiet period combines bursts; the incoming tail is checked again after generation and immediately before clicking Send.
- Existing unsent drafts are not overwritten.
- A send intent is persisted before clicking. If a matching outgoing message cannot be confirmed, automatic retries for that thread are blocked. This prefers avoiding duplicates over pretending delivery succeeded. Check that thread manually; do not blindly delete state and restart.
- A process lock prevents two bot/login/check instances sharing the profile.
- Hourly action caps persist across restarts. Repeated errors cause backoff and eventually stop with an operator-visible message. Heartbeats show that the loops are running, not that the website has accepted any particular action.
- Login expiry, detected restrictions, and detected security challenges require manual intervention.

## Known limitations

Selectors are best-effort and can break when LinkedIn changes its UI. Only the currently selected inbox view and first `MAX_VISIBLE_THREADS` rendered conversations are scanned; this does not enumerate all message requests, archived threads, or every Focused/Other view. Unsupported grouping markup or unknown sender identity is skipped rather than guessed.

Stable DOM event identifiers are preferred. When none are exposed, a content/time/occurrence fingerprint is used; this is less reliable when the site changes rendered history or timestamps. Delivery confirmation is a UI observation, not a server-side exactly-once guarantee.

Images, documents, and audio are acknowledged when detected but not interpreted. Links are not visited. Long input is bounded before sending it to the model, so some details may be omitted. AI instructions reduce but do not eliminate hallucination or prompt-injection risk. The assistant must not be relied on for commitments, private facts, or sensitive decisions. It is not a Windows service and cannot keep working while the computer sleeps or is disconnected.

## Repository hygiene and submission

Never commit `.env`, `.local`, `.auth`, browser profiles, screenshots of messages, downloaded attachments, or real conversations. `.gitignore` excludes these locations. Keep `.env.example`, source code, synthetic tests, and the generated dependency lockfile public.

Before the final push, inspect what is staged:

```cmd
git init
git add .gitignore .env.example setup.cjs package.json package-lock.json tsconfig.json src tests README.md VERIFICATION.md
git status --short
git diff --cached
```

Check that none of the private paths were already tracked:

```cmd
git ls-files .env .local/ .auth/ user-data/
```

That command should print nothing. `.gitignore` does not untrack previously committed files. A leaked credential must be revoked/rotated; deleting it from the latest commit is not sufficient.

The assessment note should state the actual implemented behavior, commands, and limitations. Do not claim that AI replies, real delivery, or 24-hour operation were tested unless they were actually verified.

## Source layout

`src/config.ts` validates local settings; `src/linkedin.ts` handles the browser and DOM; `src/selectors.ts` isolates selectors; `src/bot.ts` coordinates polling and send transactions; `src/core.ts` contains pure duplicate/burst logic; `src/store.ts` manages local state and the process lock; `src/responder.ts` contains AI and fallback reply logic; `src/index.ts` exposes commands.

## Official technical references

- Playwright persistent contexts: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- Playwright input actions: https://playwright.dev/docs/input
- TypeScript NodeNext module handling: https://www.typescriptlang.org/docs/handbook/modules/reference
- Node environment loading: https://nodejs.org/api/process.html#processloadenvfilepath
- OpenAI text generation: https://developers.openai.com/api/docs/guides/text
- OpenAI data controls: https://developers.openai.com/api/docs/guides/your-data
- LinkedIn prohibited software: https://www.linkedin.com/help/linkedin/answer/a1341387
