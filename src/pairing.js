import {setTimeout as delay} from 'node:timers/promises';

const RETRYABLE_READ_ERRORS = new Set(['wechat_timeout', 'wechat_network_error']);
const VERIFY_STATUSES = new Set(['need_verifycode', 'confirmed_but_need_verifycode']);
const WAIT_STATUSES = new Set(['wait', 'scaned', 'scanned']);

function pairingError(code) {
  return Object.assign(new Error(code), {code});
}

export function abortableDelay(ms, {signal} = {}) {
  return delay(ms, undefined, {signal});
}

// Also bound injected callbacks, so a slow verification prompt cannot keep the
// pairing operation alive past its deadline. The caller can use the provided
// signal to close its own prompt when this happens.
function boundedCall(callback, signal) {
  if (signal.aborted) return Promise.reject(pairingError('wechat_cancelled'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(pairingError('wechat_cancelled'));
    signal.addEventListener('abort', aborted, {once: true});
    Promise.resolve().then(() => {
      if (signal.aborted) throw pairingError('wechat_cancelled');
      return callback();
    }).then(
      value => {signal.removeEventListener('abort', aborted); resolve(value);},
      error => {signal.removeEventListener('abort', aborted); reject(error);},
    );
  });
}

/** Poll an existing QR challenge. Never creates a new QR or retries a write. */
export async function waitForPairing({client, qrcode, signal, onStatus = () => {}, askVerify,
  timeoutMs = 240000, now = Date.now, wait = abortableDelay} = {}) {
  if (!client || typeof client.pollQr !== 'function' || typeof qrcode !== 'string' || !qrcode ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
      typeof now !== 'function' || typeof wait !== 'function' || typeof onStatus !== 'function') {
    throw pairingError('invalid_pairing_options');
  }
  const deadline = now() + timeoutMs;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const check = () => {
    if (signal?.aborted) throw pairingError('wechat_cancelled');
    if (timeout.signal.aborted || now() >= deadline) throw pairingError('qr_login_timeout');
  };
  let verifyCode, previousStatus;
  try {
    while (true) {
      check();
      let response, retryRead = false;
      try {
        response = await boundedCall(() => client.pollQr(qrcode, verifyCode, {signal: combined}), combined);
      } catch (error) {
        check();
        if (!RETRYABLE_READ_ERRORS.has(error?.code)) throw error;
        retryRead = true;
        // get_qrcode_status is a read-only GET: a transport failure is safe to
        // poll again. Authentication, HTTP, validation and write errors are not.
      }
      check();
      if (!retryRead) {
        const status = response?.status;
        if (!WAIT_STATUSES.has(status) && !VERIFY_STATUSES.has(status) &&
            !['confirmed', 'expired', 'verify_code_blocked'].includes(status)) {
          throw pairingError('wechat_invalid_login_status');
        }
        if (status !== previousStatus) {
          await boundedCall(() => onStatus(status), combined);
          previousStatus = status;
        }
        check();
        if (status === 'confirmed') return response;
        if (status === 'expired') throw pairingError('login_expired');
        if (status === 'verify_code_blocked') throw pairingError('wechat_verify_code_blocked');
        if (VERIFY_STATUSES.has(status)) {
          if (typeof askVerify !== 'function') throw pairingError('wechat_verification_required');
          verifyCode = await boundedCall(() => askVerify({status, signal: combined}), combined);
          check();
          if (typeof verifyCode !== 'string') throw pairingError('wechat_invalid_pin');
          // The transport retains validation of the PIN before network dispatch.
        }
      }
      await boundedCall(() => wait(Math.min(1000, deadline - now()), {signal: combined}), combined);
    }
  } catch (error) {
    check();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
