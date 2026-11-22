import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {findComponents, frameDocument, MAX_TEXT_BYTES} from '../src/html-components.js';
import {HtmlPreview, splitPreviewText} from '../src/html-preview.js';
import {installTunnel, tunnelAsset} from '../src/preview-tunnel.js';

const HTML = '<section><h2>计划</h2><button onclick="this.textContent=\'已点击\'">点击</button></section>';
const URL = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
function preview(options) { const value = new HtmlPreview(options); value.ready = true; value.origin = 'https://synthetic.trycloudflare.com'; return value; }
const pagePath = text => /https?:\/\/[^/]+(\/p\/[A-Za-z0-9_-]{43})/.exec(text)[1];

test('ordinary text, inline examples, citations and incomplete HTML stay byte identical', () => {
  const value = preview();
  for (const sample of ['普通文字\r\n**粗体**\n|A|B|\n|---|---|\n|1|2|  ',
    '请解释 `<div>hello</div>` 标签。', '```python\nprint("<div>hello</div>")\n```',
    '这里包含 /cd 7，不是命令。', '比较 1 < 2 > 0 和 example@example.com。',
    '<div>没有结束标签', '```html\n<div>未结束代码块</div>', '<script>alert(1)</script>',
    '正文<Cite id="1"/>继续<Link href="https://example.com">资料</Link>。']) {
    assert.deepEqual(findComponents(sample), [], sample);
    assert.deepEqual(Buffer.from(value.transform('plain', sample)), Buffer.from(sample));
  }
  assert.equal(value.pages.size, 0);
});

test('HTML fence offsets preserve CRLF, emoji, surrounding prose and exact source', () => {
  const source = '<!doctype html><html><head><style>p{color:red}</style></head><body><p>正文</p></body></html>\r\n';
  const original = '前文🙂\r\n```html\r\n' + source + '```\r\n后文  ';
  const spans = findComponents(original);
  assert.equal(spans.length, 1); assert.equal(spans[0].source, source);
  assert.equal(original.slice(0, spans[0].start), '前文🙂\r\n');
  assert.equal(original.slice(spans[0].end), '\r\n后文  ');
  const value = preview(), output = value.transform('fenced', original, {sourceUrl: URL});
  assert.ok(output.startsWith('前文🙂\r\n')); assert.ok(output.endsWith('\r\n后文  '));
  const base = pagePath(output);
  assert.deepEqual(value.response(base + '/source.txt').body, Buffer.from(original));
  assert.ok(value.response(base).body.toString().includes(URL));
});

test('style and script remain with the visual fragment; JS markup strings are untouched', () => {
  const source = '<style>button{color:red}</style>\n' + HTML + '\n<script>const source="<head><AsyncImage /></body>";</script>';
  const spans = findComponents('前\n' + source + '\n后');
  assert.equal(spans.length, 1); assert.equal(spans[0].source, source);
  assert.ok(frameDocument(source).includes(source));
});

test('multiple components and GPT-specific tags preserve the intervening text', () => {
  const original = '第一段\n' + HTML + '\n中间说明\n<AsyncImage query="相机" aspectRatio="16:9" />\n末尾';
  const spans = findComponents(original); assert.equal(spans.length, 2);
  assert.ok(frameDocument(spans[1].source).includes('</AsyncImage>'));
  const value = preview(), output = value.transform('multiple', original), base = pagePath(output);
  assert.ok(output.includes('\n中间说明\n')); assert.ok(output.endsWith('\n末尾'));
  assert.ok(value.response(base).body.toString().includes('GPT 专用组件'));
  assert.equal(value.response(base + '/c/1').status, 200);
});

test('non-HTML fences do not hide later components or alter inline code inside HTML', () => {
  const source = '<section>示例 `code`<p>保留原样</p></section>';
  assert.equal(findComponents('```js\n"<div>代码</div>"\n```\n之后\n' + source)[0].source, source);
});

test('oversized replies and excessive components fall back to the original', () => {
  assert.deepEqual(findComponents(HTML + 'x'.repeat(MAX_TEXT_BYTES)), []);
  assert.deepEqual(findComponents(Array(65).fill(HTML).join('\n文字\n')), []);
  const value = preview({maxBytes: 100}); assert.equal(value.transform('large', HTML), HTML);
  assert.equal(value.pages.size, 0);
});

test('generated URLs stay intact across UTF8 message boundaries', () => {
  const url = 'https://synthetic.trycloudflare.com/p/' + 'a'.repeat(43) + '#component-1';
  const original = '中'.repeat(1260) + '【组件】\n' + url + '\n' + '文'.repeat(1400);
  const parts = splitPreviewText(original);
  assert.equal(parts.join(''), original); assert.ok(parts.some(part => part.includes(url)));
  assert.ok(parts.every(part => Buffer.byteLength(part) <= 3800));
});

test('duplicate decisions are stable, including the unavailable fallback', () => {
  const value = preview(); const first = value.transform('fixed', HTML);
  value.ready = false; assert.equal(value.transform('fixed', HTML), first);
  assert.equal(value.transform('offline', HTML), HTML);
  value.ready = true; assert.equal(value.transform('offline', HTML), HTML);
  assert.equal(value.pages.size, 1);
});

test('known runtime credentials cannot be published inside a component', () => {
  const value = preview(); const original = HTML + '<p>SYNTHETIC-PRIVATE-CONTEXT</p>';
  assert.equal(value.transform('private', original, {protectedValues: ['SYNTHETIC-PRIVATE-CONTEXT']}), original);
  assert.equal(value.pages.size, 0);
});

test('outer page escapes source; frame is sandboxed and private files have no route', () => {
  const value = preview(); const original = '<section><script>parent.pwned=true</script></section>';
  const base = pagePath(value.transform('malicious', original, {sourceUrl: 'https://example.com/'}));
  const outer = value.response(base), frame = value.response(base + '/c/0');
  assert.ok(!outer.body.toString().includes('<script>parent.pwned=true</script>'));
  assert.ok(outer.body.toString().includes('&lt;script&gt;parent.pwned=true&lt;/script&gt;'));
  assert.match(outer.body.toString(), /sandbox="allow-scripts"/); assert.doesNotMatch(outer.body.toString(), /allow-same-origin/);
  assert.match(frame.headers['Content-Security-Policy'], /connect-src 'none'/);
  assert.equal(outer.headers['Cache-Control'], 'no-store');
  for (const invalid of ['/', '/health', '/credentials.json', '/../state.json', base + '/c/999', base + '?raw=true']) assert.equal(value.response(invalid).status, 404);
  assert.equal(value.response(base, 'POST').status, 405);
});

test('bounded pages evict old links; stopping removes every preview', async () => {
  const value = preview({maxPages: 2}); const first = pagePath(value.transform('first', HTML));
  for (let i = 0; i < 5; i++) value.transform(String(i), HTML);
  assert.equal(value.pages.size, 2); assert.equal(value.decisions.size, 2);
  assert.equal(value.response(first).status, 404);
  await value.stop(); assert.equal(value.pages.size, 0); assert.equal(value.ready, false);
});

test('real loopback HTTP serves exact original, rejects writes and closes on stop', async t => {
  const value = new HtmlPreview(); await value.start({localOnly: true});
  t.after(() => value.stop());
  const base = pagePath(value.transform('local', HTML)), url = value.localOrigin + base;
  try {
    assert.equal(await (await fetch(url + '/source.txt')).text(), HTML);
    assert.equal((await fetch(url, {method: 'POST', body: 'no'})).status, 405);
  } finally { await value.stop(); }
  await assert.rejects(fetch(url));
});

function fakeProcess() {
  const child = new EventEmitter(); Object.assign(child, {pid: 1, exitCode: null, signalCode: null, stderr: new PassThrough(), kills: 0});
  child.kill = () => { child.kills++; queueMicrotask(() => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); }); return true; };
  return child;
}
test('tunnel needs an origin and registered connection; stop kills only its child', async () => {
  const value = new HtmlPreview(), child = fakeProcess(); let options;
  const starting = value.start({executable: 'synthetic', configPath: 'isolated.yml', spawnImpl: (...args) => {
    options = args; setImmediate(() => { child.stderr.write('https://synthetic.trycloudflare.com\n'); assert.equal(value.ready, false); child.stderr.write('Registered tunnel connection\n'); }); return child;
  }});
  assert.equal(await starting, true); assert.equal(options[2].windowsHide, true);
  assert.ok(options[1].includes('127.0.0.1:0')); assert.equal(options[2].env.TUNNEL_TOKEN, undefined);
  await value.stop(); assert.equal(child.kills, 1); assert.equal(value.ready, false);
});

test('tunnel timeout and startup cancellation leave no listener behind', {timeout: 3000}, async () => {
  const value = new HtmlPreview(), child = fakeProcess();
  assert.equal(await value.start({executable: 'synthetic', configPath: 'isolated.yml', timeoutMs: 10, spawnImpl: () => child}), false);
  await value.stop(); assert.ok(child.kills >= 1);
  const second = new HtmlPreview(); const starting = second.start({localOnly: true});
  await second.stop(); assert.equal(await starting, false); assert.equal(second.server, null);
});

test('missing tunnel executable falls back and still allows clean shutdown', {timeout: 3000}, async () => {
  const value = new HtmlPreview();
  assert.equal(await value.start({executable: path.join(os.tmpdir(), 'missing-preview-program', 'cloudflared'), configPath: 'unused.yml'}), false);
  assert.equal(value.transform('fallback', HTML), HTML);
  await value.stop(); assert.equal(value.server, null);
});

test('installer rejects unsupported systems and checksum mismatch without leaving a binary', async () => {
  assert.throws(() => tunnelAsset('unknown', 'x64'), /preview_platform_unsupported/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-install-test-'));
  try {
    await assert.rejects(installTunnel(root, {fetchImpl: async () => new Response('not an executable')}), /preview_checksum_failed/);
    assert.deepEqual(await readdir(path.join(root, 'tools')), []);
  } finally { await rm(root, {recursive: true, force: true}); }
});
