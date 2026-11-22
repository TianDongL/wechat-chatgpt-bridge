import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {HtmlPreview} from '../src/html-preview.js';

let browser;
before(async () => { browser = await chromium.launch({headless: true}); });
after(async () => { await browser?.close(); });
async function harness(t, source) {
  const preview = new HtmlPreview(); await preview.start({localOnly: true});
  t.after(() => preview.stop());
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(preview.localOrigin + '/') ? route.continue() : route.abort());
  const original = '原来的说明文字🙂  \r\n```html\r\n' + source + '\r\n```\r\n组件之后的原文  ';
  const output = preview.transform('browser-demo', original);
  const url = /http:\/\/127\.0\.0\.1:\d+\/p\/[^\s]+/.exec(output)[0];
  const page = await context.newPage(); await page.goto(url);
  return {preview, original, output, url, page};
}

test('mobile preview renders original styling and interaction with exact source download', async t => {
  const source = '<!doctype html><html><head><style>body{margin:0;padding:24px;background:#eef5ff;font-family:system-ui;color:#12345a}h2{margin-top:0}button{border:0;background:#2463eb;color:white;border-radius:10px;padding:12px 20px}</style></head><body><h2>本周阅读计划</h2><p>这是用于验收的合成 HTML 组件。</p><button onclick="this.textContent=\'已完成\'">标记完成</button></body></html>';
  const {page, original, url} = await harness(t, source);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', {name: '标记完成'}).click();
  assert.equal(await frame.getByRole('button').innerText(), '已完成');
  assert.equal(await frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(238, 245, 255)');
  assert.equal(await page.locator('pre').textContent(), original);
  assert.equal(await (await fetch(url.split('#')[0] + '/source.txt')).text(), original);
  await page.waitForFunction(() => document.querySelector('iframe').clientHeight !== 560);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('output/playwright', {recursive: true});
  await page.screenshot({path: 'output/playwright/html-preview-mobile.png', fullPage: true});
});

test('component scripts run inside the frame but cannot read the parent or fetch other routes', async t => {
  const source = '<section><p>隔离测试</p><script>try{parent.document.title="changed"}catch{window.parentBlocked=true}fetch("/credentials.json").catch(()=>{window.fetchBlocked=true})</script></section>';
  const {page} = await harness(t, source);
  const frame = page.frames().find(value => /\/c\/0$/.test(value.url()));
  await frame.waitForFunction(() => window.parentBlocked && window.fetchBlocked);
  assert.equal(await page.title(), 'GPT 组件预览');
});
