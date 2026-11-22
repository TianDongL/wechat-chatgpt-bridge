import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const COMPOSER = '#prompt-textarea';
const SEND = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"]';
const STOP = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]';
const CONVERSATION = /^\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

function bridgeError(code, uncertain = false) {
  const error = new Error(code);
  error.code = code;
  error.uncertain = uncertain;
  return error;
}

function checkedUrl(value, allowHome = true) {
  let url;
  try { url = new URL(value); } catch { throw bridgeError('invalid_url'); }
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash ||
      !(CONVERSATION.test(url.pathname) || (allowHome && url.pathname === '/'))) {
    throw bridgeError('invalid_url');
  }
  return url.href.replace(/\/$/, url.pathname === '/' ? '/' : '');
}

const normalize = value => value.replace(/\r\n?/g, '\n').trim();

// This function executes in the page. It reads rendered DOM only: no cookies,
// application stores, network interception, backend APIs or hidden model output.
function readRenderedPage() {
  const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length) &&
    getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const stopSelector = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]';
  const busy = [...document.querySelectorAll(stopSelector)].some(visible);
  const composer = document.querySelector('#prompt-textarea');
  const loggedOut = [...document.querySelectorAll('button, a')].some(element => visible(element) &&
    !element.closest('[data-message-author-role]') && /^(?:Log in|Login|登录|登入)$/i.test(element.innerText.trim()));
  const thoughtSelector = '[data-testid*="reasoning"], [data-testid*="thinking"], [data-message-content-type="reasoning"], [data-message-content-type="thoughts"], [data-is-thought="true"], details';
  const protectedText = [];
  const protectedPrefix = '\u0000wechat-code-' + crypto.randomUUID() + '-';
  const protect = text => { const index = protectedText.push(text) - 1; return protectedPrefix + index + '\u0000'; };
  const restore = text => protectedText.reduce((value, code, index) => value.replaceAll(protectedPrefix + index + '\u0000', code), text);

  function markdown(node, depth = 0) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'button', 'svg', 'noscript'].includes(tag) || node.matches(thoughtSelector) ||
        node.getAttribute('aria-hidden') === 'true' || node.hidden || getComputedStyle(node).display === 'none') return '';
    if (node.classList.contains('katex')) {
      const formula = node.querySelector('annotation[encoding="application/x-tex"]');
      if (formula) return (node.closest('.katex-display') ? '$$\n' : '$') + formula.textContent + (node.closest('.katex-display') ? '\n$$' : '$');
    }
    if (tag === 'pre') {
      const code = node.querySelector('code') || node;
      const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || '';
      const text = code.textContent;
      const runs = text.match(/`+/g) || [];
      const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
      return '\n\n' + protect(fence + language + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence) + '\n\n';
    }
    const children = () => [...node.childNodes].map(child => markdown(child, depth)).join('');
    if (tag === 'br') return '\n';
    if (tag === 'code') {
      const text = node.textContent;
      const ticks = '`'.repeat(Math.max(1, ...(text.match(/`+/g) || []).map(run => run.length + 1)));
      return protect(ticks + text + ticks);
    }
    if (tag === 'strong' || tag === 'b') return '**' + children() + '**';
    if (tag === 'em' || tag === 'i') return '*' + children() + '*';
    if (tag === 'del' || tag === 's') return '~~' + children() + '~~';
    if (tag === 'a') {
      const label = children();
      const href = node.getAttribute('href');
      return href && /^(https?:|\/)/.test(href) ? '[' + label + '](' + new URL(href, location.href).href + ')' : label;
    }
    if (tag === 'img') {
      const src = node.getAttribute('src');
      return src && /^https?:/.test(src) ? '![' + (node.getAttribute('alt') || '') + '](' + src + ')' : (node.getAttribute('alt') || '');
    }
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children().trim() + '\n\n';
    if (tag === 'blockquote') return '\n\n' + children().trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    if (tag === 'ul' || tag === 'ol') {
      let number = Number(node.getAttribute('start') || 1);
      const rows = [...node.children].filter(child => child.tagName === 'LI').map(li => {
        const prefix = tag === 'ol' ? `${number++}. ` : '- ';
        const content = [...li.childNodes].map(child => markdown(child, depth + 1)).join('').trim();
        return '  '.repeat(depth) + prefix + content.replace(/\n/g, '\n' + '  '.repeat(depth + 1));
      });
      return '\n\n' + rows.join('\n') + '\n\n';
    }
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].map(row => [...row.children]
        .filter(cell => ['TD', 'TH'].includes(cell.tagName)).map(cell => markdown(cell).trim().replace(/\n/g, '<br>').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      return '\n\n| ' + rows[0].join(' | ') + ' |\n| ' + rows[0].map(() => '---').join(' | ') + ' |\n' +
        rows.slice(1).map(row => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n';
    }
    if (tag === 'hr') return '\n\n---\n\n';
    if (['p', 'div', 'section'].includes(tag)) return '\n\n' + children() + '\n\n';
    return children();
  }

  const messages = [...document.querySelectorAll('[data-message-author-role]')].filter(visible).map(element => {
    const role = element.getAttribute('data-message-author-role');
    const article = element.closest('article[data-testid^="conversation-turn-"], article') || element;
    const id = element.getAttribute('data-message-id') || element.closest('[data-message-id]')?.getAttribute('data-message-id') || '';
    const contentCandidates = [...element.querySelectorAll('.markdown')].filter(item => visible(item) && !item.closest(thoughtSelector));
    const content = contentCandidates.length === 1 ? contentCandidates[0] : null;
    const actions = [...article.querySelectorAll('button[data-testid="copy-turn-action-button"], button[aria-label="Copy"], button[aria-label="Copy response"], button[aria-label="复制"], button[aria-label="复制回复"]')];
    const copyReady = actions.some(button => visible(button) && !button.disabled && !button.closest('pre, .markdown'));
    const status = element.getAttribute('data-message-status') || article.getAttribute('data-message-status') || '';
    const stopped = /cancelled|stopped|incomplete|error/i.test(status) || !!article.querySelector('[data-testid*="stopped"], [data-testid*="error"]') ||
      /(?:^|\n)(?:You stopped this response|Stopped generating|你停止了此回复|已停止生成)(?:\n|$)/i.test(article.innerText);
    return { id, role, text: role === 'user' ? element.innerText : (content ? restore(markdown(content).replace(/\n{3,}/g, '\n\n').trim()) : ''),
      final: role === 'assistant' && !!content && copyReady && !stopped && !element.closest(thoughtSelector), stopped };
  });
  return { title: document.title, busy, messages, loggedOut,
    ready: !loggedOut && visible(composer) && composer.getAttribute('contenteditable') !== 'false' && !composer.disabled,
    draft: composer ? (composer.value ?? composer.innerText ?? '') : '' };
}

export class ChatGPTBrowser {
  constructor({ profileDir, timeoutMs = 180000 } = {}) {
    if (typeof profileDir !== 'string' || !profileDir.trim()) throw bridgeError('profile_required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100) throw bridgeError('invalid_timeout');
    this.profileDir = resolve(profileDir);
    this.timeoutMs = timeoutMs;
    this._opening = false;
    this._generation = 0;
    this.context = null;
    this.page = null;
    this._pending = false;
  }

  async open(url = 'https://chatgpt.com/') {
    url = checkedUrl(url);
    if (this._pending || this._opening) throw bridgeError('busy');
    this._opening = true;
    const generation = this._generation;
    try {
      if (!this.context) {
        await mkdir(this.profileDir, { recursive: true });
        const context = await chromium.launchPersistentContext(this.profileDir, { headless: false });
        if (generation !== this._generation) {
          await context.close();
          throw bridgeError('browser_closed');
        }
        this.context = context;
      }
      if (!this.page || this.page.isClosed()) {
        this.page = this.context.pages()[0] || await this.context.newPage();
      }
      if (generation !== this._generation) throw bridgeError('browser_closed');
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Initial login may redirect to an authentication page. Keep this visible
      // browser open for the user; send/select retain the strict origin guard.
      await this._waitForUi();
      return await this.inspect();
    } finally {
      this._opening = false;
    }
  }

  async _waitForUi() {
    await this.page.waitForFunction(() => {
      const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      if (visible(document.querySelector('#prompt-textarea'))) return true;
      return [...document.querySelectorAll('button, a')].some(element => visible(element) && /^(?:Log in|Login|登录|登入)$/i.test(element.innerText.trim()));
    }, null, { timeout: Math.min(this.timeoutMs, 30000) }).catch(error => {
      if (error.name !== 'TimeoutError') throw error;
    });
  }

  _url() {
    if (!this.page || this.page.isClosed()) throw bridgeError('browser_closed');
    return checkedUrl(this.page.url());
  }

  async inspect() {
    let url;
    try { url = this._url(); } catch (error) { return { url: this.page?.url() || '', title: '', ready: false, busy: false, reason: error.code }; }
    const snapshot = await this.page.evaluate(readRenderedPage);
    const draft = !!snapshot.draft.trim();
    return { url, title: snapshot.title, ready: snapshot.ready && !draft, busy: snapshot.busy || this._pending,
      ...(snapshot.loggedOut ? { reason: 'login_required' } : draft ? { reason: 'draft_present' } : !snapshot.ready ? { reason: 'login_or_page_not_ready' } : {}) };
  }

  async list() {
    this._url();
    const links = await this.page.locator('nav a[href], aside a[href], [data-testid="history"] a[href]').evaluateAll(elements =>
      elements.filter(element => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length))
        .map(element => ({ url: element.href, title: (element.innerText || element.getAttribute('title') || '').trim() })));
    const unique = new Map();
    for (const item of links) {
      try { const url = checkedUrl(item.url, false); if (item.title) unique.set(url, { url, title: item.title }); } catch { /* Sidebar links are untrusted input. */ }
    }
    return [...unique.values()];
  }

  async select(url) {
    url = checkedUrl(url, false);
    if (this._pending) throw bridgeError('busy');
    this._url();
    const current = await this.page.evaluate(readRenderedPage);
    if (current.busy) throw bridgeError('busy');
    if (current.draft.trim()) throw bridgeError('draft_present');
    if (this._url() !== url) await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (this._url() !== url) throw bridgeError('navigation_changed');
    await this._waitForUi();
    return this.inspect();
  }

  async send(text, { onSubmitted, expectedUrl } = {}) {
    if (this._pending) throw bridgeError('busy');
    if (typeof text !== 'string' || !text.trim()) throw bridgeError('empty_message');
    const boundUrl = checkedUrl(this._url(), false);
    if (expectedUrl !== undefined && checkedUrl(expectedUrl, false) !== boundUrl) throw bridgeError('navigation_changed');
    let attempted = false;
    let navigationError = false;
    let submitted = false;
    const page = this.page;
    const marker = '__wechatBridgePending';
    this._pending = true;
    const onNavigation = frame => {
      if (frame !== page.mainFrame()) return;
      try {
        if (checkedUrl(frame.url(), false) !== boundUrl) navigationError = true;
      } catch { navigationError = true; }
    };
    page.on('framenavigated', onNavigation);
    try {
      const before = await page.evaluate(readRenderedPage);
      if (!before.ready) throw bridgeError('not_ready');
      if (before.busy) throw bridgeError('busy');
      if (before.draft.trim()) throw bridgeError('draft_present');
      const existingIds = new Set(before.messages.map(message => message.id).filter(Boolean));
      await page.evaluate(({ marker, stop }) => {
        const state = { stopped: false };
        state.listener = event => { if (event.target instanceof Element && event.target.closest(stop)) state.stopped = true; };
        document.addEventListener('click', state.listener, true);
        window[marker] = state;
      }, { marker, stop: STOP });
      if (navigationError || this._url() !== boundUrl || this.page !== page) throw bridgeError('navigation_changed');
      await page.locator(COMPOSER).fill(text, { timeout: Math.min(this.timeoutMs, 10000) });
      if (navigationError || this._url() !== boundUrl || this.page !== page) throw bridgeError('navigation_changed');
      const send = page.locator(SEND).filter({ visible: true });
      if (await send.count() !== 1 || !await send.isEnabled()) throw bridgeError('send_control_unavailable');
      // A click timeout may mean the write succeeded. Never repeat this click.
      attempted = true;
      await send.click({ timeout: Math.min(this.timeoutMs, 10000), noWaitAfter: true });
      const deadline = Date.now() + this.timeoutMs;
      let userId = null;
      let stable = null;
      let stableSince = 0;
      while (Date.now() < deadline) {
        if (this.page !== page || page.isClosed() || navigationError) throw bridgeError('navigation_changed', true);
        const currentUrl = this._url();
        if (currentUrl !== boundUrl) throw bridgeError('navigation_changed', true);
        const documentState = await page.evaluate(marker => window[marker] ? { stopped: window[marker].stopped } : null, marker);
        if (!documentState) throw bridgeError('navigation_changed', true);
        if (documentState.stopped) throw bridgeError('response_incomplete', true);
        const snapshot = await page.evaluate(readRenderedPage);
        const freshUsers = snapshot.messages.filter(message => message.role === 'user' && message.id && !existingIds.has(message.id));
        if (freshUsers.length > 1 || (freshUsers.length === 1 && normalize(freshUsers[0].text) !== normalize(text))) {
          throw bridgeError('submission_uncertain', true);
        }
        if (!userId && freshUsers.length === 1) userId = freshUsers[0].id;
        if (userId && !snapshot.messages.some(message => message.id === userId && message.role === 'user')) throw bridgeError('submission_uncertain', true);
        if (userId && !submitted && CONVERSATION.test(new URL(boundUrl).pathname)) {
          submitted = true;
          if (onSubmitted) await onSubmitted({ url: boundUrl, messageId: userId });
        }
        const userIndex = snapshot.messages.findIndex(message => message.id === userId);
        const responses = userId ? snapshot.messages.slice(userIndex + 1).filter(message => message.role === 'assistant' && message.id && !existingIds.has(message.id)) : [];
        if (responses.some(message => message.stopped)) throw bridgeError('response_incomplete', true);
        const final = responses.filter(message => message.final && message.text);
        if (final.length > 1) throw bridgeError('response_ambiguous', true);
        if (submitted && !snapshot.busy && final.length === 1 && responses.at(-1)?.id === final[0].id) {
          const signature = final[0].id + '\n' + final[0].text;
          if (stable !== signature) { stable = signature; stableSince = Date.now(); }
          // Copy controls plus stopped-state checks are the completion marker;
          // stability merely guards delayed DOM updates, never proves completion.
          if (Date.now() - stableSince >= 500) return { text: final[0].text, url: boundUrl };
        } else { stable = null; stableSince = 0; }
        await page.waitForTimeout(100);
      }
      throw bridgeError(userId ? 'response_timeout' : 'submission_uncertain', true);
    } catch (error) {
      if (error?.code && typeof error.uncertain === 'boolean') {
        if (attempted) error.uncertain = true;
        throw error;
      }
      throw bridgeError(attempted ? 'submission_uncertain' : 'browser_unavailable', attempted);
    } finally {
      page.off('framenavigated', onNavigation);
      if (!page.isClosed()) {
        await page.evaluate(marker => {
          const state = window[marker];
          if (state?.listener) document.removeEventListener('click', state.listener, true);
          delete window[marker];
        }, marker).catch(() => {});
      }
      this._pending = false;
    }
  }

  async close() {
    this._generation++;
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close();
  }
}
