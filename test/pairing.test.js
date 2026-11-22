import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {waitForPairing} from '../src/pairing.js';
import {WeChatClient} from '../src/wechat.js';

const failure = code => Object.assign(new Error(code), {code});
const confirmed = {status: 'confirmed', bot_token: 'SYNTHETIC-TEST-TOKEN',
  ilink_bot_id: 'test-bot', ilink_user_id: 'test-owner'};

function harness(sequence, overrides = {}) {
  let clock = 0;
  const calls = [], waits = [], statuses = [];
  const options = {
    client: {pollQr: async (...args) => {
      calls.push(args);
      const response = sequence.shift();
      if (response instanceof Error) throw response;
      return response;
    }},
    qrcode: 'SYNTHETIC-QR', now: () => clock,
    wait: async (ms, {signal}) => {assert.equal(signal.aborted, false); waits.push(ms); clock += ms;},
    onStatus: status => statuses.push(status), ...overrides,
  };
  return {options, calls, waits, statuses};
}

test('read timeout and network failure are retried once per delay until confirmed', async () => {
  const h = harness([failure('wechat_timeout'), failure('wechat_network_error'), confirmed]);
  assert.equal(await waitForPairing(h.options), confirmed);
  assert.equal(h.calls.length, 3); assert.deepEqual(h.waits, [1000, 1000]);
  assert.deepEqual(h.statuses, ['confirmed']);
  assert.ok(h.calls.every(([qr, pin, options]) => qr === 'SYNTHETIC-QR' && pin === undefined && options.signal instanceof AbortSignal));
});

test('authentication, HTTP, malformed response and unknown errors are not retried', async () => {
  for (const code of ['wechat_session_expired', 'wechat_api_rejected', 'wechat_http_error',
    'wechat_invalid_response', 'wechat_invalid_json', 'wechat_login_redirect_unsupported', 'unknown']) {
    const error = failure(code), h = harness([error, confirmed]);
    await assert.rejects(waitForPairing(h.options), candidate => candidate === error);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.waits, []);
  }
});

test('expired and verification blocked QR statuses stop with named errors', async () => {
  for (const [status, code] of [['expired', 'login_expired'], ['verify_code_blocked', 'wechat_verify_code_blocked']]) {
    const h = harness([{status}, confirmed]);
    await assert.rejects(waitForPairing(h.options), {code});
    assert.equal(h.calls.length, 1); assert.deepEqual(h.waits, []);
  }
});

test('malformed successful poll values are not retried', async () => {
  for (const response of [undefined, null, {}, {status: 'unexpected'}]) {
    const h = harness([response, confirmed]);
    await assert.rejects(waitForPairing(h.options), {code: 'wechat_invalid_login_status'});
    assert.equal(h.calls.length, 1); assert.deepEqual(h.waits, []);
  }
});

test('both verification statuses request one PIN per response and pass it into the next poll', async () => {
  const prompted = [];
  const h = harness([{status: 'need_verifycode'}, {status: 'need_verifycode'},
    {status: 'confirmed_but_need_verifycode'}, confirmed], {
    askVerify: async ({status, signal}) => {prompted.push(status); assert.equal(signal.aborted, false); return String(123450 + prompted.length);},
  });
  assert.equal(await waitForPairing(h.options), confirmed);
  assert.deepEqual(prompted, ['need_verifycode', 'need_verifycode', 'confirmed_but_need_verifycode']);
  assert.deepEqual(h.calls.map(call => call[1]), [undefined, '123451', '123452', '123453']);
  assert.deepEqual(h.statuses, ['need_verifycode', 'confirmed_but_need_verifycode', 'confirmed']);
});

test('verification without an interactive callback stops instead of polling forever', async () => {
  const h = harness([{status: 'need_verifycode'}]);
  await assert.rejects(waitForPairing(h.options), {code: 'wechat_verification_required'});
  assert.equal(h.calls.length, 1);
});

test('PIN validation remains in the client and happens before dispatch', async () => {
  let calls = 0;
  const client = new WeChatClient({fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({status: 'need_verifycode'}));
  }});
  await assert.rejects(waitForPairing({client, qrcode: 'SYNTHETIC-QR', askVerify: () => 'bad&PIN', wait: async () => {}}),
    {code: 'wechat_invalid_pin'});
  assert.equal(calls, 1);
});

test('cancellation before the first call never touches the network', async () => {
  const abort = new AbortController(); abort.abort();
  const h = harness([confirmed], {signal: abort.signal});
  await assert.rejects(waitForPairing(h.options), {code: 'wechat_cancelled'});
  assert.equal(h.calls.length, 0);
});

test('cancellation between polls prevents the next call', async () => {
  const abort = new AbortController();
  const h = harness([{status: 'wait'}, confirmed], {signal: abort.signal, wait: async () => abort.abort()});
  await assert.rejects(waitForPairing(h.options), {code: 'wechat_cancelled'});
  assert.equal(h.calls.length, 1);
});

test('cancellation aborts an active poll and never retries it', async () => {
  const abort = new AbortController(); let calls = 0;
  const client = {pollQr: async (_, __, {signal}) => {
    calls++; abort.abort(); assert.equal(signal.aborted, true); throw failure('wechat_network_error');
  }};
  await assert.rejects(waitForPairing({client, qrcode: 'SYNTHETIC-QR', signal: abort.signal}), {code: 'wechat_cancelled'});
  assert.equal(calls, 1);
});

test('total deadline bounds retries and the final wait even with an injected clock', async () => {
  const h = harness([failure('wechat_timeout'), failure('wechat_timeout'), confirmed], {timeoutMs: 1500});
  await assert.rejects(waitForPairing(h.options), {code: 'qr_login_timeout'});
  assert.deepEqual(h.waits, [1000, 500]); assert.equal(h.calls.length, 2);
});

test('real total deadline also aborts a hanging poll', async () => {
  let receivedSignal, calls = 0;
  const client = {pollQr: async (_, __, {signal}) => {
    receivedSignal = signal; calls++;
    await delay(1000, undefined, {signal});
    return confirmed;
  }};
  await assert.rejects(waitForPairing({client, qrcode: 'SYNTHETIC-QR', timeoutMs: 25}), {code: 'qr_login_timeout'});
  assert.equal(calls, 1); assert.equal(receivedSignal.aborted, true);
});

test('status callback failures are not mistaken for retryable network errors', async () => {
  const error = failure('wechat_network_error');
  const h = harness([{status: 'wait'}, confirmed], {onStatus: () => {throw error;}});
  await assert.rejects(waitForPairing(h.options), candidate => candidate === error);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.waits, []);
});

test('pollQr forwards caller cancellation to the HTTP request', async () => {
  const abort = new AbortController(); let calls = 0, receivedSignal;
  const client = new WeChatClient({fetchImpl: async (_, {signal}) => {
    calls++; receivedSignal = signal; abort.abort(); throw new Error('synthetic network abort');
  }});
  await assert.rejects(client.pollQr('SYNTHETIC-QR', undefined, {signal: abort.signal}), {code: 'wechat_cancelled'});
  assert.equal(calls, 1); assert.equal(receivedSignal.aborted, true);
  await assert.rejects(client.pollQr('SYNTHETIC-QR', undefined, {signal: abort.signal}), {code: 'wechat_cancelled'});
  assert.equal(calls, 1);
});
