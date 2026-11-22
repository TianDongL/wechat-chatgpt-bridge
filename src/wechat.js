import { randomBytes } from 'node:crypto';

export const WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CHANNEL_VERSION = '3.0.0/wechat-chatgpt-bridge-0.1.0';
const RESPONSE_LIMIT = 1024 * 1024;
const TEXT_LIMIT = 4000;

export class WeChatError extends Error {
  constructor(code, { uncertain = false, status, upstreamCode } = {}) {
    super(code);
    this.name = 'WeChatError';
    this.code = code;
    this.uncertain = uncertain;
    if (status !== undefined) this.status = status;
    if (upstreamCode !== undefined) this.upstreamCode = upstreamCode;
  }
}

function requiredString(value, code, maxBytes = 16384) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maxBytes || /[\u0000\r\n]/.test(value)) {
    throw new WeChatError(code);
  }
  return value;
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validBaseUrl(value) {
  if (value !== WECHAT_BASE_URL && value !== WECHAT_BASE_URL + '/') {
    throw new WeChatError('wechat_untrusted_host');
  }
  return WECHAT_BASE_URL;
}

function validateCredentials(credentials) {
  if (!object(credentials)) throw new WeChatError('wechat_login_required');
  const token = requiredString(credentials.token, 'wechat_invalid_credentials');
  if (!/^[\x21-\x7e]+$/.test(token)) throw new WeChatError('wechat_invalid_credentials');
  return Object.freeze({
    token,
    botId: requiredString(credentials.botId, 'wechat_invalid_credentials', 512),
    ownerId: requiredString(credentials.ownerId, 'wechat_invalid_credentials', 512),
    baseUrl: validBaseUrl(credentials.baseUrl ?? WECHAT_BASE_URL),
  });
}

function checkResult(data) {
  if (!object(data)) throw new WeChatError('wechat_invalid_response');
  for (const field of ['ret', 'errcode']) {
    if (data[field] === undefined) continue;
    if (!Number.isSafeInteger(data[field])) throw new WeChatError('wechat_invalid_response');
    if (data[field] !== 0) {
      throw new WeChatError(data[field] === -14 ? 'wechat_session_expired' : 'wechat_api_rejected', {
        upstreamCode: data[field],
      });
    }
  }
  return data;
}

/** Only call with the result of this client's trusted QR-status request. */
export function validateConfirmedLogin(response) {
  checkResult(response);
  if (response.status !== 'confirmed') throw new WeChatError('wechat_login_unconfirmed');
  return validateCredentials({ token: response.bot_token, botId: response.ilink_bot_id,
    ownerId: response.ilink_user_id, baseUrl: response.baseurl ?? WECHAT_BASE_URL });
}

/** Preserve numeric uint64 IDs before JSON.parse can round them. String contents are untouched. */
export function parseProtocolJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > RESPONSE_LIMIT) {
    throw new WeChatError('wechat_response_too_large');
  }
  let protectedJson = '', i = 0;
  try {
    // Validate the original grammar first, so quoting an unsafe integer can
    // never turn an invalid unquoted object key into accepted JSON.
    JSON.parse(raw);
    while (i < raw.length) {
      if (raw[i] === '"') {
        const start = i++;
        while (i < raw.length) {
          const char = raw[i++];
          if (char === '\\') i++;
          else if (char === '"') break;
        }
        protectedJson += raw.slice(start, i);
      } else if (raw[i] === '-' || /[0-9]/.test(raw[i])) {
        const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(raw.slice(i));
        if (!match) throw new Error();
        const literal = match[0];
        protectedJson += /^-?[0-9]+$/.test(literal) && !Number.isSafeInteger(Number(literal))
          ? JSON.stringify(literal) : literal;
        i += literal.length;
      } else protectedJson += raw[i++];
    }
    return JSON.parse(protectedJson);
  } catch {
    throw new WeChatError('wechat_invalid_json');
  }
}

async function boundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > RESPONSE_LIMIT) {
    await response.body?.cancel().catch(() => {});
    throw new WeChatError('wechat_response_too_large');
  }
  if (!response.body) throw new WeChatError('wechat_invalid_response');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) throw new WeChatError('wechat_response_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return parseProtocolJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export class WeChatClient {
  #credentials;
  #fetch;
  constructor({ credentials, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new WeChatError('wechat_fetch_unavailable');
    this.#credentials = credentials === undefined ? undefined : validateCredentials(credentials);
    this.#fetch = fetchImpl;
  }

  async #request(path, { payload, authenticated = false, signal, timeout = 15000, sending = false } = {}) {
    if (authenticated && !this.#credentials) throw new WeChatError('wechat_login_required');
    if (signal?.aborted) throw new WeChatError('wechat_cancelled');
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(3 << 16) };
    const isGet = payload === undefined;
    if (!isGet) Object.assign(headers, {
      'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
    });
    if (authenticated) {
      headers.Authorization = 'Bearer ' + this.#credentials.token;
      payload = { ...payload, base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'WeChatChatGPTBridge/0.1.0' } };
    }
    const timeoutSignal = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.#fetch(WECHAT_BASE_URL + path, {
        method: isGet ? 'GET' : 'POST', headers, redirect: 'error', signal: combined,
        ...(isGet ? {} : { body: JSON.stringify(payload) }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new WeChatError('wechat_http_error', { status: response.status, uncertain: sending });
      }
      let data;
      try { data = await boundedJson(response); }
      catch (error) {
        if (error instanceof WeChatError) {
          error.uncertain = sending;
          throw error;
        }
        throw new WeChatError('wechat_invalid_response', { uncertain: sending });
      }
      return checkResult(data);
    } catch (error) {
      if (error instanceof WeChatError) {
        if (sending && error.code === 'wechat_invalid_response') error.uncertain = true;
        throw error;
      }
      throw new WeChatError(signal?.aborted ? 'wechat_cancelled'
        : timeoutSignal.aborted ? 'wechat_timeout' : 'wechat_network_error', { uncertain: sending });
    }
  }

  async getQr() {
    const data = await this.#request('/ilink/bot/get_bot_qrcode?bot_type=3', { payload: { local_token_list: [] } });
    return {
      qrcode: requiredString(data.qrcode, 'wechat_invalid_qr', 4096),
      qrcode_img_content: requiredString(data.qrcode_img_content, 'wechat_invalid_qr', 8192),
    };
  }

  async pollQr(qrcode, verifyCode, { signal } = {}) {
    const query = new URLSearchParams({ qrcode: requiredString(qrcode, 'wechat_invalid_qr', 4096) });
    if (verifyCode !== undefined) {
      if (typeof verifyCode !== 'string' || !/^[0-9]{4,10}$/.test(verifyCode)) throw new WeChatError('wechat_invalid_pin');
      query.set('verify_code', verifyCode);
    }
    const data = await this.#request('/ilink/bot/get_qrcode_status?' + query, { timeout: 40000, signal });
    if (data.status === 'scaned_but_redirect' || data.status === 'binded_redirect') {
      throw new WeChatError('wechat_login_redirect_unsupported');
    }
    if (!['wait', 'scaned', 'scanned', 'confirmed', 'expired', 'need_verifycode',
      'confirmed_but_need_verifycode', 'verify_code_blocked'].includes(data.status)) {
      throw new WeChatError('wechat_invalid_login_status');
    }
    if (data.status === 'confirmed') validateConfirmedLogin(data);
    return data;
  }

  async getUpdates(cursor = '', { signal } = {}) {
    if (typeof cursor !== 'string' || Buffer.byteLength(cursor) > 65536) throw new WeChatError('wechat_invalid_cursor');
    const data = await this.#request('/ilink/bot/getupdates', {
      payload: { get_updates_buf: cursor }, authenticated: true, signal, timeout: 40000,
    });
    if (data.msgs !== undefined && (!Array.isArray(data.msgs) || data.msgs.length > 1000)) {
      throw new WeChatError('wechat_invalid_batch');
    }
    if (data.get_updates_buf !== undefined && (typeof data.get_updates_buf !== 'string'
      || Buffer.byteLength(data.get_updates_buf) > 65536)) throw new WeChatError('wechat_invalid_batch');
    return { ...data, msgs: data.msgs ?? [], get_updates_buf: data.get_updates_buf ?? cursor };
  }

  async sendText({ text, contextToken, clientId }, { signal } = {}) {
    if (typeof text !== 'string' || !text || Buffer.byteLength(text) > TEXT_LIMIT || text.includes('\u0000')) {
      throw new WeChatError('wechat_invalid_text');
    }
    requiredString(contextToken, 'wechat_context_required', 65536);
    requiredString(clientId, 'wechat_invalid_client_id', 128);
    if (!this.#credentials) throw new WeChatError('wechat_login_required');
    return this.#request('/ilink/bot/sendmessage', { authenticated: true, signal, sending: true,
      payload: { msg: { from_user_id: '', to_user_id: this.#credentials.ownerId,
        client_id: clientId, message_type: 2, message_state: 2, context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }] } },
    });
  }
}

/** Strict V1: the QR owner's complete plain-text direct messages only. */
export function extractOwnerText(msg, credentials) {
  const binding = validateCredentials(credentials);
  if (!object(msg) || msg.from_user_id !== binding.ownerId
    || (msg.to_user_id !== undefined && msg.to_user_id !== '' && msg.to_user_id !== binding.botId)
    || msg.group_id || msg.delete_time_ms || msg.message_type !== 1 || msg.message_state !== 2) return null;
  const items = msg.item_list;
  if (!Array.isArray(items) || items.length !== 1 || !object(items[0]) || items[0].type !== 1
    || items[0].ref_msg || !object(items[0].text_item)) return null;
  const text = items[0].text_item.text;
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 256000 || text.includes('\u0000')) return null;
  let id = msg.message_id;
  if (typeof id === 'number') {
    if (!Number.isSafeInteger(id) || id < 0) throw new WeChatError('wechat_unsafe_message_id');
    id = String(id);
  }
  requiredString(id, 'wechat_missing_message_id', 128);
  const contextToken = requiredString(msg.context_token, 'wechat_context_required', 65536);
  if (typeof msg.create_time_ms !== 'number' || !Number.isSafeInteger(msg.create_time_ms)
    || msg.create_time_ms <= 0) throw new WeChatError('wechat_invalid_timestamp');
  return { id, text, contextToken, createdAt: msg.create_time_ms };
}
