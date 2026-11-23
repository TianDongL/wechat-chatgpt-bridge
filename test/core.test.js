import test from 'node:test';
import assert from 'node:assert/strict';
import {Bridge, initialState} from '../src/bridge.js';
import {parseCommand, conversationUrl, splitText} from '../src/commands.js';

const URL = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const OTHER_URL = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const credentials = {botId: 'test-bot', ownerId: 'test-owner', token: 'SYNTHETIC-TEST-TOKEN'};
function msg(text = 'hello', id = '1', patch = {}) {
  return {message_id: id, from_user_id: 'test-owner', to_user_id: 'test-bot', message_type: 1, message_state: 2,
    create_time_ms: 1800000000000, context_token: 'SYNTHETIC-CONTEXT', item_list: [{type: 1, text_item: {text}}], ...patch};
}
const batch = (...msgs) => ({msgs, get_updates_buf: 'synthetic-cursor'});
function fixture(initial = {...initialState(), selected: URL}) {
  const disk = {value: structuredClone(initial), replies: new Map()};
  const store = {read: () => structuredClone(disk.value), write: (_, value) => {disk.value = structuredClone(value);}, saveReply: (id, text) => disk.replies.set(id, text)};
  const sends = [], posts = [], selected = [];
  const wechat = {sendText: async item => {sends.push(item);}};
  const provider = {
    send: async (text, options) => {posts.push(text); await options.onSubmitted({url: URL, messageId: 'user1'}); return {text: '原样\n\n**回答**', url: URL};},
    select: async url => {selected.push(url);}, list: async () => [{title: '示例', url: URL}],
  };
  const make = (extra = {}) => new Bridge({store, wechat, provider, credentials, since: 1700000000000, now:()=>1800000000000, ...extra});
  return {disk, store, sends, posts, selected, wechat, provider, make, bridge: make()};
}

test('only entire standalone commands are control input', () => {
  for (const text of ['正文 /switch 7', '/switch 7\n再说一句', '```\n/switch 7\n```', '"/switch 7"', '/help extra', '/switcher 1', '/HELP', '/new', '/ack', '\\new', '\\ack']) assert.equal(parseCommand(text), null, text);
  assert.deepEqual(parseCommand(' \\switch 7\t'), {name: 'switch', argument: '7'});
  for (const text of ['/cd 7', ' \\cd 7\t', '/switch 7']) assert.deepEqual(parseCommand(text), {name: 'switch', argument: '7'});
  for (const text of ['正文 /cd 7', '/cd 7\n继续', '```\n/cd 7\n```', '"/cd 7"', '/cd 7 extra', '/cdrom 7', 'cd 7', '/cd 7\n']) assert.equal(parseCommand(text), null, text);
  assert.deepEqual(parseCommand('/help'), {name: 'help', argument: undefined});
});
test('conversation target rejects external hosts, credentials and query tricks', () => {
  assert.equal(conversationUrl(URL), URL);
  assert.equal(conversationUrl(URL.split('/').at(-1)), URL);
  for (const value of ['https://chatgpt.com.evil.test/c/id', 'https://x@chatgpt.com/c/id', URL + '?x=1', URL + '#id', 'https://chatgpt.com/']) assert.throws(() => conversationUrl(value));
});
test('UTF8 chunks preserve every codepoint and whitespace', () => {
  const text = '\n你好🙂'.repeat(2500) + '\n  END';
  const chunks = splitText(text);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(x => Buffer.byteLength(x) <= 3800 && !x.includes('\uFFFD')));
});
test('durable inbox and cursor precede ChatGPT send; duplicate deliveries never repeat', async () => {
  const f = fixture();
  await f.bridge.ingest(batch(msg('a very long text with /switch 7')));
  assert.equal(f.posts.length, 0); assert.equal(f.disk.value.cursor, 'synthetic-cursor');
  const original = f.provider.send;
  f.provider.send = async (...args) => {
    assert.equal(Object.values(f.disk.value.records)[0].status, 'submitting'); return original(...args);
  };
  await f.bridge.drain(); await f.bridge.ingest(batch(msg())); await f.bridge.drain();
  assert.equal(f.posts.length, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].text, '原样\n\n**回答**');
  const record = Object.values(f.disk.value.records)[0];
  assert.equal(record.text, undefined); assert.equal(record.contextToken, undefined);
  await f.make().drain(); assert.equal(f.posts.length, 1);
});
test('identical text with distinct source IDs means two separate messages', async () => {
  const f = fixture(); await f.bridge.ingest(batch(msg('same', '1'), msg('same', '2'))); await f.bridge.drain();
  assert.equal(f.posts.length, 2);
});
test('foreign, group, old, partial and bot echo inputs never route', async () => {
  const f = fixture(); await f.bridge.ingest(batch(msg('x', '1', {from_user_id: 'someone-else'}), msg('x', '2', {group_id: 'group'}),
    msg('x', '3', {create_time_ms: 1600000000000}), msg('x', '4', {message_state: 1}), msg('x', '5', {message_type: 2})));
  await f.bridge.drain(); assert.equal(f.posts.length, 0); assert.equal(f.sends.length, 0);
});
test('uncertain submit is never replayed after restart; fresh messages need no manual unlock', async () => {
  const f = fixture(); const normalSend = f.provider.send;
  f.provider.send = async () => {f.posts.push('attempt'); throw Object.assign(new Error('timeout'), {uncertain: true});};
  await f.bridge.ingest(batch(msg())); await f.bridge.drain();
  assert.equal(Object.values(f.disk.value.records)[0].status, 'uncertain');
  assert.doesNotMatch(f.sends[0].text, /\/ack/);
  const next = f.make(); f.provider.send = normalSend;
  await next.ingest(batch(msg(), msg('next', '2'))); await next.drain();
  assert.deepEqual(f.posts, ['attempt', 'next']);
  assert.equal(Object.values(f.disk.value.records)[0].status, 'uncertain');
  assert.equal(Object.hasOwn(f.disk.value, 'blocked'), false);
});
test('crash or legacy pause preserves the original reservation without replaying', async () => {
  for (const status of ['submitting', 'accepted']) {
    const state = {...initialState(), selected: URL, blocked: 'f'.repeat(64)};
    state.records['f'.repeat(64)] = {status, text: 'do not replay'};
    const f = fixture(state); await f.bridge.drain(); assert.equal(f.posts.length, 0);
    assert.equal(f.disk.value.records['f'.repeat(64)].status, 'uncertain');
    assert.equal(Object.hasOwn(f.disk.value, 'blocked'), false);
    await f.bridge.ingest(batch(msg('fresh', '2'))); await f.bridge.drain();
    assert.deepEqual(f.posts, ['fresh']);
  }
});
test('known failure before click leaves no uncertain submission', async () => {
  const f = fixture(); f.provider.send = async () => {throw Object.assign(new Error('not_ready'), {uncertain: false});};
  await f.bridge.ingest(batch(msg())); await f.bridge.drain();
  assert.equal(Object.values(f.disk.value.records)[0].status, 'done'); assert.match(f.sends[0].text, /尚未提交/);
});
test('WeChat send uncertainty is never replayed; full reply remains locally available', async () => {
  const f = fixture(); f.wechat.sendText = async x => {f.sends.push(x); throw new Error('timeout');};
  await f.bridge.ingest(batch(msg())); await f.bridge.drain();
  assert.equal(Object.values(f.disk.value.records)[0].status, 'delivery_uncertain');
  assert.equal([...f.disk.replies.values()][0], '原样\n\n**回答**');
  await f.make().drain(); assert.equal(f.sends.length, 1); assert.equal(f.posts.length, 1);
});
test('commands stay local; selecting the same conversation does not navigate again', async () => {
  const f = fixture({...initialState(), selected: OTHER_URL});
  await f.bridge.ingest(batch(msg('/help', '1'), msg('/list', '2'), msg('/cd 1', '3'), msg('/switch 1', '4')));
  await f.bridge.drain(); assert.equal(f.posts.length, 0); assert.deepEqual(f.selected, []);
  assert.match(f.sends[0].text, /^\/cd 1 /m);
  assert.match(f.sends[0].text, /^\/help /m);
  assert.match(f.sends[1].text, /\/cd 编号.*\/help/);
  assert.match(f.sends[2].text, /\/help/);
  assert.doesNotMatch(f.sends[0].text, /\/(?:new|ack)\b/);
  await f.bridge.ingest(batch(msg('first in selected chat', '5')));
  await f.bridge.drain();
  assert.deepEqual(f.selected, [URL]);
  assert.deepEqual(f.posts, ['first in selected chat']);
});

test('removed command names remain ordinary text in the selected conversation', async () => {
  const f = fixture();
  await f.bridge.ingest(batch(msg('/new', '1'), msg('/ack', '2'))); await f.bridge.drain();
  assert.deepEqual(f.posts, ['/new', '/ack']); assert.deepEqual(f.selected, []);
  assert.equal(f.disk.value.selected, URL);
});

test('unbound and legacy homepage states never create a conversation implicitly', async () => {
  for (const selected of [null, 'https://chatgpt.com/']) {
    const f = fixture({...initialState(), selected});
    await f.bridge.ingest(batch(msg())); await f.bridge.drain();
    assert.equal(f.posts.length, 0); assert.equal(f.disk.value.selected, null);
    assert.match(f.sends[0].text, /尚未选择已有网页会话/);
    await f.bridge.ingest(batch(msg('/cd ' + URL, '2'), msg('fresh', '3'))); await f.bridge.drain();
    assert.deepEqual(f.posts, ['fresh']); assert.deepEqual(f.selected, [URL]);
  }
});
test('cd inside multiline prose remains one ordinary prompt', async () => {
  const f = fixture(); const text = '解释以下命令\n/cd 7\n请继续正文';
  await f.bridge.ingest(batch(msg(text))); await f.bridge.drain();
  assert.deepEqual(f.posts, [text]); assert.deepEqual(f.selected, []);
});
test('selected target is passed to provider so manual navigation cannot silently reroute', async () => {
  const f = fixture(); f.provider.send = async (_, options) => {
    assert.equal(options.expectedUrl, URL); throw Object.assign(new Error('navigation_changed'), {uncertain: false});
  };
  await f.bridge.ingest(batch(msg())); await f.bridge.drain(); assert.equal(Object.values(f.disk.value.records)[0].status, 'done');
});
test('wrong credential binding refuses reuse of another account ledger', () => {
  const f = fixture(); assert.throws(() => f.make({credentials: {...credentials, ownerId: 'different-owner'}}), /owner_changed/);
});
test('shutdown prevents new sends and leaves queued inbox recoverable', async () => {
  const f = fixture(); const abort = new AbortController();
  const bridge = f.make({signal: abort.signal}); await bridge.ingest(batch(msg())); abort.abort(); await bridge.drain();
  assert.equal(f.posts.length, 0); assert.equal(f.sends.length, 0); assert.equal(Object.values(f.disk.value.records)[0].status, 'queued');
});
test('persistence failure during ingest propagates before any side effect', async () => {
  const f = fixture(); f.store.write = () => {throw new Error('disk full');};
  await assert.rejects(f.bridge.ingest(batch(msg())), /disk full/); assert.equal(f.posts.length, 0); assert.equal(f.sends.length, 0);
});

test('preview failures preserve the original reply and never retry the ChatGPT submission', async () => {
  const f = fixture(); const original = '**说明**\r\n<div>原始组件</div>\n末尾  ';
  f.provider.send = async () => {f.posts.push('once'); return {text: original, url: URL};};
  f.bridge.preview = {transform: () => {throw new Error('preview unavailable');}};
  await f.bridge.ingest(batch(msg())); await f.bridge.drain();
  assert.equal(f.sends[0].text, original); assert.equal([...f.disk.replies.values()][0], original);
  assert.deepEqual(f.posts, ['once']);
});
