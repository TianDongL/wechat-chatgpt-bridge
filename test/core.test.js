import test from 'node:test';
import assert from 'node:assert/strict';
import {Bridge, initialState} from '../src/bridge.js';
import {parseCommand, conversationUrl, splitText} from '../src/commands.js';

const URL = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const credentials = {botId: 'test-bot', ownerId: 'test-owner', token: 'SYNTHETIC-TEST-TOKEN'};
function msg(text = 'hello', id = '1', patch = {}) {
  return {message_id: id, from_user_id: 'test-owner', to_user_id: 'test-bot', message_type: 1, message_state: 2,
    create_time_ms: 1800000000000, context_token: 'SYNTHETIC-CONTEXT', item_list: [{type: 1, text_item: {text}}], ...patch};
}
const batch = (...msgs) => ({msgs, get_updates_buf: 'synthetic-cursor'});
function fixture(initial = initialState()) {
  const disk = {value: structuredClone(initial), replies: new Map()};
  const store = {read: () => structuredClone(disk.value), write: (_, value) => {disk.value = structuredClone(value);}, saveReply: (id, text) => disk.replies.set(id, text)};
  const sends = [], posts = [], selected = [];
  const wechat = {sendText: async item => {sends.push(item);}};
  const provider = {
    send: async (text, options) => {posts.push(text); await options.onSubmitted({url: URL, messageId: 'user1'}); return {text: '原样\n\n**回答**', url: URL};},
    select: async url => {selected.push(url);}, list: async () => [{title: '示例', url: URL}],
  };
  const make = (extra = {}) => new Bridge({store, wechat, provider, credentials, since: 1700000000000, ...extra});
  return {disk, store, sends, posts, selected, wechat, provider, make, bridge: make()};
}

test('only entire standalone commands are control input', () => {
  for (const text of ['正文 /switch 7', '/switch 7\n再说一句', '```\n/switch 7\n```', '"/switch 7"', '/help extra', '/switcher 1', '/HELP', '/new\n']) assert.equal(parseCommand(text), null, text);
  assert.deepEqual(parseCommand(' \\switch 7\t'), {name: 'switch', argument: '7'});
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
test('uncertain submit is not retried, including after restart; /ack never resends', async () => {
  const f = fixture(); f.provider.send = async () => {f.posts.push('attempt'); throw Object.assign(new Error('timeout'), {uncertain: true});};
  await f.bridge.ingest(batch(msg())); await f.bridge.drain();
  assert.ok(f.disk.value.blocked); const next = f.make();
  await next.ingest(batch(msg('next', '2'), msg('/switch ' + URL, '3'))); await next.drain();
  assert.equal(f.posts.length, 1); assert.equal(f.selected.length, 0);
  await next.ingest(batch(msg('/ack', '4'))); await next.drain();
  assert.equal(f.posts.length, 1); assert.equal(f.disk.value.blocked, null);
});
test('crash with a reserved or accepted submission blocks instead of replaying', async () => {
  for (const status of ['submitting', 'accepted']) {
    const state = initialState(); state.records['f'.repeat(64)] = {status, text: 'do not replay'};
    const f = fixture(state); await f.bridge.drain(); assert.ok(f.disk.value.blocked); assert.equal(f.posts.length, 0);
  }
});
test('known failure before click does not leave the route blocked', async () => {
  const f = fixture(); f.provider.send = async () => {throw Object.assign(new Error('not_ready'), {uncertain: false});};
  await f.bridge.ingest(batch(msg())); await f.bridge.drain();
  assert.equal(f.disk.value.blocked, null); assert.match(f.sends[0].text, /尚未提交/);
});
test('WeChat send uncertainty is never replayed; full reply remains locally available', async () => {
  const f = fixture(); f.wechat.sendText = async x => {f.sends.push(x); throw new Error('timeout');};
  await f.bridge.ingest(batch(msg())); await f.bridge.drain();
  assert.equal(Object.values(f.disk.value.records)[0].status, 'delivery_uncertain');
  assert.equal([...f.disk.replies.values()][0], '原样\n\n**回答**');
  await f.make().drain(); assert.equal(f.sends.length, 1); assert.equal(f.posts.length, 1);
});
test('commands stay local; numeric list and /new route predictably', async () => {
  const f = fixture(); await f.bridge.ingest(batch(msg('/help', '1'), msg('/list', '2'), msg('/switch 1', '3'), msg('/switch 1', '4'), msg('/new', '5')));
  await f.bridge.drain(); assert.equal(f.posts.length, 0); assert.deepEqual(f.selected, [URL, 'https://chatgpt.com/']);
});
test('selected target is passed to provider so manual navigation cannot silently reroute', async () => {
  const f = fixture(); f.provider.send = async (_, options) => {
    assert.equal(options.expectedUrl, 'https://chatgpt.com/'); throw Object.assign(new Error('navigation_changed'), {uncertain: false});
  };
  await f.bridge.ingest(batch(msg())); await f.bridge.drain(); assert.equal(f.disk.value.blocked, null);
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
