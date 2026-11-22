import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {StateStore} from '../src/state.js';
import {WeChatClient} from '../src/wechat.js';
import {ChatGPTBrowser} from '../src/chatgpt-browser.js';
import {Bridge} from '../src/bridge.js';

test('complete synthetic journey: channel, durable store, browser, reply and restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-journey-test-'));
  const store = new StateStore(path.join(root, 'data'));
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({offline: true});
  const html = fs.readFileSync(new URL('./fixtures/chatgpt.html', import.meta.url), 'utf8');
  await context.route('**/*', route => route.request().isNavigationRequest() && new URL(route.request().url()).origin === 'https://chatgpt.com'
    ? route.fulfill({contentType: 'text/html', body: html}) : route.abort());
  const page = await context.newPage(); await page.goto('https://chatgpt.com/');
  const provider = new ChatGPTBrowser({profileDir: path.join(root, 'unused'), timeoutMs: 3000});
  provider.context = context; provider.page = page;
  const credentials = {token: 'SYNTHETIC-INTEGRATION', botId: 'test-bot', ownerId: 'test-owner'};
  let messages = [], cursor = 0; const outbound = [];
  const client = new WeChatClient({credentials, fetchImpl: async (url, options) => {
    if (url.endsWith('/getupdates')) return new Response(JSON.stringify({msgs: messages, get_updates_buf: String(++cursor)}));
    assert.ok(url.endsWith('/sendmessage')); outbound.push(JSON.parse(options.body).msg);
    return new Response('{}');
  }});
  const incoming = (id, text) => ({message_id: id, from_user_id: 'test-owner', to_user_id: 'test-bot',
    message_type: 1, message_state: 2, create_time_ms: Date.now(), context_token: 'SYNTHETIC-CONTEXT',
    item_list: [{type: 1, text_item: {text}}]});
  try {
    store.acquire();
    let bridge = new Bridge({store, wechat: client, provider, credentials, since: Date.now() - 1000});
    messages = [incoming('1', '/help'), incoming('2', '/list'), incoming('3', '/cd 1'),
      incoming('4', '解释这段文字\n/cd 7\n不要误切换')];
    await bridge.ingest(await client.getUpdates(bridge.state.cursor)); await bridge.drain();
    assert.equal(outbound.length, 4);
    assert.match(outbound[0].item_list[0].text_item.text, /^\/cd 1 /m);
    assert.match(outbound[2].item_list[0].text_item.text, /\/help/);
    assert.ok(outbound.every(msg => msg.to_user_id === 'test-owner'));
    assert.equal(await page.evaluate(() => window.sendClicks), 1);
    assert.equal(await page.locator('[data-message-id="new-user-1"]').innerText(), messages[3].item_list[0].text_item.text);
    assert.match(outbound.at(-1).item_list[0].text_item.text, /Final \*\*answer\*\*/);
    assert.equal(bridge.state.selected, 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111');
    store.release(); store.acquire();
    bridge = new Bridge({store, wechat: client, provider, credentials, since: Date.now() - 1000});
    await bridge.ingest(await client.getUpdates(bridge.state.cursor)); await bridge.drain();
    assert.equal(outbound.length, 4); assert.equal(await page.evaluate(() => window.sendClicks), 1);
    messages = [incoming('5', '第二句')];
    await bridge.ingest(await client.getUpdates(bridge.state.cursor)); await bridge.drain();
    assert.equal(outbound.length, 5); assert.equal(await page.evaluate(() => window.sendClicks), 2);
    assert.equal(Object.keys(store.read('state.json').records).length, 5);
  } finally { await provider.close(); await browser.close(); store.release(); fs.rmSync(root, {recursive: true, force: true}); }
});
