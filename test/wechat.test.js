import test from 'node:test';
import assert from 'node:assert/strict';
import { WeChatClient, WeChatError, validateConfirmedLogin, extractOwnerText, parseProtocolJson,
  WECHAT_BASE_URL, CHANNEL_VERSION } from '../src/wechat.js';

const credentials = { token: 'SYNTHETIC-TEST-TOKEN', botId: 'test-bot', ownerId: 'test-owner', baseUrl: WECHAT_BASE_URL };
const confirmed = { status: 'confirmed', bot_token: credentials.token, ilink_bot_id: credentials.botId,
  ilink_user_id: credentials.ownerId, baseurl: credentials.baseUrl };
function incoming(patch = {}) {
  return { from_user_id: credentials.ownerId, to_user_id: credentials.botId, message_type: 1,
    message_state: 2, message_id: '18446744073709551615', create_time_ms: 1800000000000,
    context_token: 'SYNTHETIC-CONTEXT', item_list: [{ type: 1, text_item: { text: '原文\n /switch 7' } }], ...patch };
}
function clientFor(body, options = {}) {
  const calls = [];
  const client = new WeChatClient({ credentials, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), options);
  } });
  return { client, calls };
}

test('QR confirmation binds only the verified owner and approved host', () => {
  assert.deepEqual(validateConfirmedLogin(confirmed), credentials);
  assert.throws(() => validateConfirmedLogin({ ...confirmed, status: 'scaned' }), /unconfirmed/);
  for (const baseurl of ['https://evil.invalid', WECHAT_BASE_URL + '.evil.invalid', WECHAT_BASE_URL + '/path']) {
    assert.throws(() => validateConfirmedLogin({ ...confirmed, baseurl }), /untrusted_host/);
  }
  for (const patch of [{ ilink_user_id: '' }, { bot_token: 'bad\r\nTOKEN' }, { ret: true }, { ret: -1 }]) {
    assert.throws(() => validateConfirmedLogin({ ...confirmed, ...patch }), WeChatError);
  }
});

test('QR requests are unauthenticated and preserve the exact QR content', async () => {
  const { client, calls } = clientFor({ qrcode: 'A?&B', qrcode_img_content: 'weixin://test?key=foo' });
  assert.equal((await client.getQr()).qrcode, 'A?&B');
  const { url, init } = calls[0];
  assert.equal(url, WECHAT_BASE_URL + '/ilink/bot/get_bot_qrcode?bot_type=3');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(init.body), { local_token_list: [] });
  assert.equal(init.headers['iLink-App-ClientVersion'], '196608');
});

test('QR polling escapes challenge and supports phone PIN without auth headers', async () => {
  const { client, calls } = clientFor({ status: 'confirmed_but_need_verifycode' });
  assert.equal((await client.pollQr('A?&B', '123456')).status, 'confirmed_but_need_verifycode');
  const { url, init } = calls[0];
  assert.equal(new URL(url).searchParams.get('qrcode'), 'A?&B');
  assert.equal(new URL(url).searchParams.get('verify_code'), '123456');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(init.headers.AuthorizationType, undefined);
  await assert.rejects(client.pollQr('Q', '123&evil'), /invalid_pin/);
  assert.equal(calls.length, 1);
});

test('QR redirection is not followed and unknown status is rejected', async () => {
  for (const status of ['scaned_but_redirect', 'binded_redirect']) {
    const { client, calls } = clientFor({ status, redirect_host: 'evil.invalid' });
    await assert.rejects(client.pollQr('Q'), /redirect_unsupported/);
    assert.equal(calls.length, 1);
  }
  await assert.rejects(clientFor({ status: 'unknown' }).client.pollQr('Q'), /invalid_login_status/);
});

test('protocol JSON preserves uint64 IDs and leaves strings and decimals unchanged', () => {
  const raw = '{"message_id":18446744073709551615,"text":"x 18446744073709551615 \\\"y\\\"", "safe":42,"float":1.25,"exp":1e3}';
  const parsed = parseProtocolJson(raw);
  assert.equal(parsed.message_id, '18446744073709551615');
  assert.equal(parsed.text, 'x 18446744073709551615 "y"');
  assert.equal(parsed.safe, 42);
  assert.equal(parsed.float, 1.25);
  assert.equal(parsed.exp, 1000);
  for (const rawInvalid of ['{"x":01}', '{"x":-}', '"unterminated', '{"x":NaN}', '{18446744073709551615:1}']) {
    assert.throws(() => parseProtocolJson(rawInvalid), /invalid_json/);
  }
});

test('long polling includes cursor, auth and documented version metadata', async () => {
  const { client, calls } = clientFor('{"msgs":[{"message_id":18446744073709551615}],"get_updates_buf":"next"}');
  const response = await client.getUpdates('cursor');
  assert.equal(response.msgs[0].message_id, '18446744073709551615');
  assert.equal(response.get_updates_buf, 'next');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.get_updates_buf, 'cursor');
  assert.equal(body.base_info.channel_version, CHANNEL_VERSION);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + credentials.token);
  assert.equal(JSON.stringify(client), '{}');
});

test('owner-only filter rejects another person, group, echo, unfinished, quotes and media', () => {
  assert.deepEqual(extractOwnerText(incoming(), credentials), {
    id: '18446744073709551615', text: '原文\n /switch 7', contextToken: 'SYNTHETIC-CONTEXT', createdAt: 1800000000000,
  });
  for (const patch of [{ from_user_id: 'stranger' }, { to_user_id: 'another-bot' }, { group_id: 'g' },
    { message_type: 2 }, { message_state: 1 }, { delete_time_ms: 1 }, { item_list: [] },
    { item_list: [{ type: 2, image_item: {} }] }, { item_list: [{ type: 1, ref_msg: {}, text_item: { text: 'quote' } }] },
    { item_list: [{ type: 1, text_item: { text: 'a' } }, { type: 1, text_item: { text: 'b' } }] }]) {
    assert.equal(extractOwnerText(incoming(patch), credentials), null);
  }
  assert.throws(() => extractOwnerText(incoming({ message_id: 18446744073709551615 }), credentials), /unsafe_message_id/);
  assert.throws(() => extractOwnerText(incoming({ context_token: '' }), credentials), /context_required/);
  assert.equal(extractOwnerText(incoming({ message_id: 42 }), credentials).id, '42');
});

test('send is owner-bound, preserves text and accepts the documented absent-ret acknowledgement', async () => {
  const { client, calls } = clientFor({});
  const text = ' 你好\n原文\n';
  assert.deepEqual(await client.sendText({ text, contextToken: 'CTX', clientId: 'turn-1', toUserId: 'stranger' }), {});
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.msg.to_user_id, credentials.ownerId);
  assert.equal(body.msg.from_user_id, '');
  assert.equal(body.msg.message_type, 2);
  assert.equal(body.msg.message_state, 2);
  assert.equal(body.msg.item_list[0].text_item.text, text);
  assert.equal(body.msg.context_token, 'CTX');
  assert.equal(body.msg.client_id, 'turn-1');
  await assert.rejects(client.sendText({ text: '中'.repeat(1400), contextToken: 'CTX', clientId: 'id' }), /invalid_text/);
  assert.equal(calls.length, 1);
});

test('ambiguous send failures are marked uncertain, redacted and never retried', async () => {
  let calls = 0;
  const client = new WeChatClient({ credentials, fetchImpl: async () => {
    calls++; throw new Error('SYNTHETIC-TEST-TOKEN private context');
  } });
  await assert.rejects(client.sendText({ text: 'hello', contextToken: 'CTX', clientId: 'id' }), error => {
    assert.equal(error.code, 'wechat_network_error');
    assert.equal(error.uncertain, true);
    assert.equal(error.message.includes('TOKEN'), false);
    return true;
  });
  assert.equal(calls, 1);
  for (const body of ['<html>bad</html>', '{"ret":true}']) {
    await assert.rejects(clientFor(body).client.sendText({ text: 'hi', contextToken: 'CTX', clientId: 'id' }),
      error => error.uncertain === true);
  }
});

test('explicit upstream rejection and expired login are distinguishable', async () => {
  await assert.rejects(clientFor({ ret: -2 }).client.sendText({ text: 'hi', contextToken: 'CTX', clientId: 'id' }), error => {
    assert.equal(error.code, 'wechat_api_rejected');
    assert.equal(error.upstreamCode, -2);
    assert.equal(error.uncertain, false);
    return true;
  });
  await assert.rejects(clientFor({ errcode: -14 }).client.getUpdates(), /session_expired/);
});

test('abort before dispatch performs no network call', async () => {
  const { client, calls } = clientFor({});
  await assert.rejects(client.sendText({ text: 'hi', contextToken: 'CTX', clientId: 'id' },
    { signal: AbortSignal.abort() }), error => error.code === 'wechat_cancelled' && error.uncertain === false);
  assert.equal(calls.length, 0);
});

test('response byte cap applies even without Content-Length', async () => {
  const { client } = clientFor('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(client.getUpdates(), /response_too_large/);
});

test('malformed batches do not produce an advanceable cursor', async () => {
  for (const data of [{ msgs: 'bad', get_updates_buf: 'next' }, { msgs: [], get_updates_buf: 123 },
    { msgs: null }, { get_updates_buf: null }]) {
    await assert.rejects(clientFor(data).client.getUpdates(), /invalid_batch/);
  }
});

test('successful empty long polls normalize absent fields without resetting the cursor', async () => {
  assert.deepEqual(await clientFor({ ret: 0 }).client.getUpdates('previous'),
    { ret: 0, msgs: [], get_updates_buf: 'previous' });
  assert.deepEqual(await clientFor({ get_updates_buf: 'next' }).client.getUpdates('previous'),
    { msgs: [], get_updates_buf: 'next' });
  assert.deepEqual(await clientFor({ msgs: [], get_updates_buf: '' }).client.getUpdates('previous'),
    { msgs: [], get_updates_buf: '' });
});
