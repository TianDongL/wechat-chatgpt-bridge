import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { ChatGPTBrowser } from '../src/chatgpt-browser.js';

const URL = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
let browser;
const fixture = await readFile(new globalThis.URL('./fixtures/chatgpt.html', import.meta.url), 'utf8');
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function harness(t, { mode = 'normal', url = URL, timeoutMs = 1800 } = {}) {
  // Offline is a second barrier: redirects must never escape the fixture route.
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  await context.route('**/*', route => route.request().isNavigationRequest() && new globalThis.URL(route.request().url()).origin === 'https://chatgpt.com'
    ? route.fulfill({ contentType: 'text/html', body: fixture }) : route.abort());
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(mode => { window.fixtureMode = mode; }, mode);
  const provider = new ChatGPTBrowser({ profileDir: '/unused-fixture-profile', timeoutMs });
  provider.context = context;
  provider.page = page;
  t.after(() => provider.close());
  return { provider, page };
}

test('renders only a new completed answer and preserves HTML code fences', async t => {
  const { provider, page } = await harness(t);
  const submitted = [];
  const result = await provider.send('Hello\nsecond line', { onSubmitted: receipt => submitted.push(receipt) });
  assert.equal(result.url, URL);
  assert.equal(result.text, 'Final **answer**.\n\n```html\n<div>Original component</div>\n```\n\nAfter code.');
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
  assert.deepEqual(submitted, [{ url: URL, messageId: 'new-user-1' }]);
});

test('inspect and list use visible rendered UI only', async t => {
  const { provider } = await harness(t);
  assert.deepEqual(await provider.inspect(), { url: URL, title: 'Fixture conversation - ChatGPT', ready: true, busy: false });
  assert.deepEqual(await provider.list(), [{ url: URL, title: 'Fixture conversation' }]);
});

test('refuses an existing draft without clicking or overwriting it', async t => {
  const { provider, page } = await harness(t);
  await page.locator('#prompt-textarea').fill('My unfinished draft');
  await assert.rejects(provider.send('Hello'), error => error.code === 'draft_present' && !error.uncertain);
  assert.equal(await page.locator('#prompt-textarea').innerText(), 'My unfinished draft');
  assert.equal(await page.evaluate(() => window.sendClicks), 0);
});

test('single flight refuses concurrent sends and switches', async t => {
  const { provider, page } = await harness(t, { mode: 'slow' });
  const pending = provider.send('Hello');
  await assert.rejects(provider.send('Second'), error => error.code === 'busy' && !error.uncertain);
  await assert.rejects(provider.select(URL), error => error.code === 'busy');
  await pending;
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test('never returns a streaming partial answer on timeout', async t => {
  const { provider, page } = await harness(t, { mode: 'partial', timeoutMs: 350 });
  await assert.rejects(provider.send('Hello'), error => error.code === 'response_timeout' && error.uncertain);
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test('no exact new user marker is uncertain and never retried', async t => {
  const { provider, page } = await harness(t, { mode: 'no-user', timeoutMs: 350 });
  await assert.rejects(provider.send('Hello'), error => error.code === 'submission_uncertain' && error.uncertain);
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test('duplicate exact new user turns remain uncertain', async t => {
  const { provider, page } = await harness(t, { mode: 'duplicate' });
  await assert.rejects(provider.send('Hello'), error => error.code === 'submission_uncertain' && error.uncertain);
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test('navigation during the response cannot return another conversation', async t => {
  const { provider } = await harness(t, { mode: 'navigate' });
  await assert.rejects(provider.send('Hello'), error => error.code === 'navigation_changed' && error.uncertain);
});

test('a new homepage conversation binds its assigned URL before receipt', async t => {
  const { provider } = await harness(t, { url: 'https://chatgpt.com/' });
  const receipts = [];
  const result = await provider.send('Hello', { onSubmitted: receipt => receipts.push(receipt) });
  assert.equal(result.url, URL);
  assert.deepEqual(receipts, [{ url: URL, messageId: 'new-user-1' }]);
});

test('stopped response with copy controls is not a completed answer', async t => {
  const { provider } = await harness(t, { mode: 'stopped' });
  await assert.rejects(provider.send('Hello'), error => error.code === 'response_incomplete' && error.uncertain);
});

test('reasoning markup is not returned even when copy controls appear', async t => {
  const { provider } = await harness(t, { mode: 'reasoning', timeoutMs: 350 });
  await assert.rejects(provider.send('Hello'), error => error.code === 'response_timeout' && error.uncertain);
});

test('user stop action fails closed even without a stopped status attribute', async t => {
  const { provider, page } = await harness(t, { mode: 'partial' });
  const pending = provider.send('Hello');
  const rejection = assert.rejects(pending, error => error.code === 'response_incomplete' && error.uncertain);
  await page.locator('[data-testid="stop-button"]').click();
  await rejection;
});

test('external destinations are refused before navigation', async t => {
  const { provider } = await harness(t);
  await assert.rejects(provider.select('https://example.com/c/11111111-1111-4111-8111-111111111111'), error => error.code === 'invalid_url');
  await assert.rejects(provider.select('https://chatgpt.com.evil.example/c/11111111-1111-4111-8111-111111111111'), error => error.code === 'invalid_url');
  await assert.rejects(provider.select(URL + '?redirect=elsewhere'), error => error.code === 'invalid_url');
  assert.equal(provider.page.url(), URL);
});

test('explicit new-chat selection allows homepage', async t => {
  const { provider } = await harness(t);
  await provider.select('https://chatgpt.com/');
  assert.equal(provider.page.url(), 'https://chatgpt.com/');
});

test('manual drafts and active generation block navigation', async t => {
  const { provider, page } = await harness(t);
  await page.locator('#prompt-textarea').fill('Draft');
  await assert.rejects(provider.select('https://chatgpt.com/'), error => error.code === 'draft_present');
  await page.locator('#prompt-textarea').fill('');
  await page.evaluate(() => { const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; stop.textContent = 'Stop'; document.body.append(stop); });
  await assert.rejects(provider.select('https://chatgpt.com/'), error => error.code === 'busy');
  assert.equal(page.url(), URL);
});

test('expected URL prevents manual tab switch from rerouting a message', async t => {
  const { provider, page } = await harness(t);
  await assert.rejects(provider.send('Hello', { expectedUrl: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222' }), error => error.code === 'navigation_changed' && !error.uncertain);
  assert.equal(await page.evaluate(() => window.sendClicks), 0);
  assert.equal(await page.locator('#prompt-textarea').innerText(), '');
});

test('literal repeated and trailing blank lines within code remain intact', async t => {
  const { provider } = await harness(t, { mode: 'code-whitespace' });
  const result = await provider.send('Hello');
  assert.equal(result.text, 'Final **answer**.\n\n```html\n<div>One</div>\n\n\n<div>Two</div>\n\n```\n\nAfter code.');
});

test('setup keeps the browser open after an authentication redirect', async t => {
  const { provider, page } = await harness(t);
  await provider.context.route('https://chatgpt.com/', route => route.fulfill({ contentType: 'text/html', body: '<html><script>location.replace("https://auth.openai.com/log-in")</script></html>' }));
  await provider.context.route('https://auth.openai.com/log-in', route => route.fulfill({ contentType: 'text/html', body: '<html><body><button>Log in</button></body></html>' }));
  const state = await provider.open();
  assert.equal(state.ready, false);
  assert.equal(state.reason, 'invalid_url');
  assert.equal(page.isClosed(), false);
  assert.equal(page.url(), 'https://auth.openai.com/log-in');
  await assert.rejects(provider.send('Do not fill login page'), error => error.code === 'invalid_url');
});

test('inspect reports existing draft as not ready', async t => {
  const { provider, page } = await harness(t);
  await page.locator('#prompt-textarea').fill('Draft');
  const state = await provider.inspect();
  assert.equal(state.ready, false);
  assert.equal(state.reason, 'draft_present');
});

test('same-URL page reload during a send becomes uncertain', async t => {
  const { provider, page } = await harness(t, { mode: 'partial' });
  const pending = provider.send('Hello');
  const rejection = assert.rejects(pending, error => error.uncertain && error.code === 'navigation_changed');
  await page.locator('[data-testid="stop-button"]').waitFor();
  await page.reload();
  await rejection;
});

test('logged-out composer is not accepted as a signed-in ready page', async t => {
  const { provider, page } = await harness(t);
  await page.evaluate(() => { const header = document.createElement('header'); header.innerHTML = '<button>Log in</button>'; document.body.prepend(header); });
  const state = await provider.inspect();
  assert.equal(state.ready, false);
  assert.equal(state.reason, 'login_required');
  await assert.rejects(provider.send('Do not send as guest'), error => error.code === 'not_ready' && !error.uncertain);
  assert.equal(await page.evaluate(() => window.sendClicks), 0);
});

function attachedChromeFixture({ failAt } = {}) {
  const calls = { connect: [], newPage: 0, contextClose: 0, disconnect: 0, foreignGoto: 0, foreignClose: 0 };
  const foreign = {
    goto: async () => { calls.foreignGoto++; }, close: async () => { calls.foreignClose++; },
  };
  const created = [];
  const context = {
    pages: () => [foreign, ...created],
    close: async () => { calls.contextClose++; },
    newPage: async () => {
      calls.newPage++;
      if (failAt === 'newPage') throw new Error('private endpoint detail');
      let currentUrl = 'about:blank', closed = false;
      const page = {
        closes: 0, navigations: [],
        url: () => currentUrl, isClosed: () => closed,
        goto: async url => {
          page.navigations.push(url);
          if (failAt === 'goto') throw new Error('private endpoint detail');
          currentUrl = url;
        },
        close: async () => {
          page.closes++; closed = true;
          if (failAt === 'closePage') throw new Error('page already disconnected');
        },
        waitForFunction: async () => {},
        evaluate: async () => ({ title: 'Synthetic Chrome page', ready: true, busy: false, draft: '', messages: [], loggedOut: false }),
      };
      created.push(page); return page;
    },
  };
  const attached = {
    contexts: () => failAt === 'context' ? [] : [context],
    close: async () => { calls.disconnect++; },
  };
  const connectOverCDP = async (...args) => {
    calls.connect.push(args);
    if (failAt === 'connect') throw new Error('ws://localhost:12345/private-endpoint');
    return attached;
  };
  return { calls, foreign, created, context, attached, connectOverCDP };
}

test('browser mode is explicit; managed remains default and Chrome needs no profile copy', () => {
  assert.throws(() => new ChatGPTBrowser(), error => error.code === 'profile_required');
  assert.equal(new ChatGPTBrowser({ profileDir: '/unused' }).browserMode, 'managed');
  assert.equal(new ChatGPTBrowser({ browserMode: 'chrome' }).profileDir, null);
  assert.throws(() => new ChatGPTBrowser({ browserMode: 'unknown' }), error => error.code === 'invalid_browser_mode');
});

test('Chrome attachment creates an owned tab and disconnects without touching existing tabs', async () => {
  const f = attachedChromeFixture();
  const provider = new ChatGPTBrowser({ browserMode: 'chrome', connectOverCDP: f.connectOverCDP });
  const state = await provider.open(URL);
  assert.equal(state.ready, true);
  assert.deepEqual(f.calls.connect, [['chrome', { noDefaults: true, timeout: 30000 }]]);
  assert.equal(provider.page, f.created[0]);
  await provider.open('https://chatgpt.com/');
  assert.equal(f.calls.newPage, 1);
  assert.deepEqual(f.created[0].navigations, [URL, 'https://chatgpt.com/']);
  await provider.close(); await provider.close();
  assert.equal(f.created[0].closes, 1);
  assert.equal(f.calls.disconnect, 1);
  assert.equal(f.calls.contextClose, 0);
  assert.equal(f.calls.foreignGoto, 0);
  assert.equal(f.calls.foreignClose, 0);
  assert.equal(provider.page, null); assert.equal(provider.context, null);
});

test('Chrome attach failures are sanitized and disconnect every acquired connection', async () => {
  for (const failAt of ['connect', 'context', 'newPage', 'goto']) {
    const f = attachedChromeFixture({ failAt });
    const provider = new ChatGPTBrowser({ browserMode: 'chrome', connectOverCDP: f.connectOverCDP });
    await assert.rejects(provider.open(URL), error => error.code === 'chrome_debugging_unavailable' &&
      error.message === 'chrome_debugging_unavailable' && !error.uncertain);
    assert.equal(f.calls.disconnect, failAt === 'connect' ? 0 : 1, failAt);
    assert.equal(f.calls.contextClose, 0, failAt);
    assert.equal(f.calls.foreignGoto, 0, failAt);
    assert.equal(f.calls.foreignClose, 0, failAt);
    assert.equal(provider.attachedBrowser, null, failAt);
    if (failAt === 'goto') assert.equal(f.created[0].closes, 1);
  }
});

test('Chrome disconnect still happens if closing the owned tab fails', async () => {
  const f = attachedChromeFixture({ failAt: 'closePage' });
  const provider = new ChatGPTBrowser({ browserMode: 'chrome', connectOverCDP: f.connectOverCDP });
  await provider.open(URL);
  await assert.rejects(provider.close(), /page already disconnected/);
  assert.equal(f.calls.disconnect, 1); assert.equal(f.calls.contextClose, 0); assert.equal(f.calls.foreignClose, 0);
});

test('manually closing the owned Chrome tab creates a fresh owned tab on reopen', async () => {
  const f = attachedChromeFixture();
  const provider = new ChatGPTBrowser({ browserMode: 'chrome', connectOverCDP: f.connectOverCDP });
  await provider.open(URL); await provider.page.close(); await provider.open(URL);
  assert.equal(f.calls.newPage, 2); assert.equal(f.calls.connect.length, 1);
  assert.equal(provider.page, f.created[1]); await provider.close();
  assert.equal(f.created[1].closes, 1); assert.equal(f.calls.contextClose, 0); assert.equal(f.calls.foreignClose, 0);
});

test('shutdown during Chrome connection waits cannot leave a new attachment running', async () => {
  const f = attachedChromeFixture(); let release;
  const connected = new Promise(resolve => { release = resolve; });
  const provider = new ChatGPTBrowser({ browserMode: 'chrome', connectOverCDP: async () => connected });
  const opening = provider.open(URL);
  await provider.close(); release(f.attached);
  await assert.rejects(opening, error => error.code === 'chrome_debugging_unavailable');
  assert.equal(f.calls.disconnect, 1); assert.equal(f.calls.newPage, 0); assert.equal(f.calls.contextClose, 0);
});

test('invalid Chrome target is rejected before connecting', async () => {
  const f = attachedChromeFixture();
  const provider = new ChatGPTBrowser({ browserMode: 'chrome', connectOverCDP: f.connectOverCDP });
  await assert.rejects(provider.open('https://example.invalid'), error => error.code === 'invalid_url');
  assert.equal(f.calls.connect.length, 0);
});
