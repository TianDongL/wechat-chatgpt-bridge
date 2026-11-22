#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {setTimeout as delay} from 'node:timers/promises';
import qr from 'qrcode-terminal';
import {chromium} from 'playwright';
import {StateStore, defaultDataDir} from './state.js';
import {WeChatClient, validateConfirmedLogin} from './wechat.js';
import {ChatGPTBrowser} from './chatgpt-browser.js';
import {Bridge, initialState, digest} from './bridge.js';
import {conversationUrl} from './commands.js';

const args = process.argv.slice(2);
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error('需要 Node.js 22.13 或更新版本。'); process.exit(2);
}
const command = args.shift() || 'help';
let dataDir = defaultDataDir();
if (args.length) {
  if (args.length !== 2 || args[0] !== '--data-dir' || !args[1]) {
    console.error('用法：node src/cli.js setup|start|doctor|unlock [--data-dir 独立数据目录]'); process.exit(2);
  }
  dataDir = path.resolve(args[1]);
}
const log = text => console.log(text);
const hints = {
  bridge_already_running_or_stale_lock: '已有实例在运行，或上次没有正常退出。先关闭旧终端；确认已退出后运行 npm run unlock。',
  state_file_invalid: '本地状态无法读取；请先备份数据目录，不要删除账本后直接重发。',
  state_directory_not_dedicated: '请选择一个新的空目录作为 --data-dir，不要使用主目录或现有项目目录。',
  credentials_missing: '尚未扫码配对。请先运行 npm run setup。',
  browser_missing: '缺少浏览器。请运行 npm run browser:install。',
  browser_not_ready: '浏览器尚未就绪。完成 ChatGPT 登录、进入普通会话、清空草稿并等待回复结束后再试。',
  owner_changed: '当前微信配对与账本不匹配。请使用新的独立 --data-dir 为新账号配对。',
  login_expired: '微信二维码已过期。请重新运行 npm run setup。',
  wechat_login_redirect_unsupported: '当前账号登录需要重定向，本 alpha 版尚不支持。请不要手动复制令牌。',
  qr_login_timeout: '扫码登录超时，请重新运行 npm run setup。',
  wechat_session_expired: '微信登录已过期。重新运行 npm run setup，在已有配对提示中输入 relogin 后扫码。',
  wechat_invalid_pin: '校验码格式不正确。请重新运行 setup，按手机显示的数字输入。',
};
let store, provider, prompt;
const abort = new AbortController();
let shuttingDown = false;
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true; abort.abort();
  prompt?.close();
  try { await provider?.close(); } finally { store?.release(); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  log('\n正在停止微信桥和专用浏览器……');
  abort.abort(); prompt?.close();
  // Keep the lock until the in-flight task has recorded its uncertain outcome.
  provider?.close().catch(() => {});
});
function browserInstalled() { return fs.existsSync(chromium.executablePath()); }
async function ask(question) {
  prompt ??= readline.createInterface({input: process.stdin, output: process.stdout});
  return prompt.question(question, {signal: abort.signal});
}
async function openBrowser(url) {
  if (!browserInstalled()) throw new Error('browser_missing');
  provider = new ChatGPTBrowser({profileDir: path.join(dataDir, 'browser-profile')});
  await provider.open(url);
}
async function setup() {
  log('WeChat ChatGPT Bridge · 首次设置\n登录状态只保存在这台电脑的独立目录，不需要 API Key。');
  const saved = store.read('credentials.json', null);
  const state = store.read('state.json', initialState());
  await openBrowser(state.selected);
  log('1/2 请在打开的专用浏览器里登录 ChatGPT。可打开已有普通会话，或停留在新对话页。');
  await ask('完成登录、清空输入框并等页面加载完成后，在这里按回车：');
  const status = await provider.inspect();
  if (!status.ready || status.busy) throw new Error('browser_not_ready');
  state.selected = conversationUrl(status.url, {allowHome: true});
  store.write('state.json', state);
  const reuse = saved && (await ask('已有微信配对，按回车继续使用；若已失效，输入 relogin 重新扫码：')).trim() !== 'relogin';
  if (reuse) {
    log('2/2 继续使用现有微信配对。');
  } else {
    log('2/2 使用你本人微信扫描下面的二维码并确认。不要扫描正在由另一套桥使用的同一个机器人。');
    const client = new WeChatClient({});
    const code = await client.getQr();
    qr.generate(code.qrcode_img_content, {small: true});
    log('二维码仅供这次配对，请勿截图发到公开 Issue。');
    let verifyCode, previousStatus = '', credentials;
    const deadline = Date.now() + 240000;
    while (!abort.signal.aborted && Date.now() < deadline) {
      const response = await client.pollQr(code.qrcode, verifyCode);
      if (response.status === 'confirmed') { credentials = validateConfirmedLogin(response); break; }
      if (response.status === 'expired') throw new Error('login_expired');
      if (['need_verifycode', 'confirmed_but_need_verifycode'].includes(response.status)) {
        verifyCode = (await ask('请输入微信登录页面显示的校验码：')).trim();
      }
      if (response.status !== previousStatus) {
        log(response.status === 'scaned' ? '已扫码，请在手机确认。' : '等待微信确认……');
        previousStatus = response.status;
      }
      await delay(1000, undefined, {signal: abort.signal});
    }
    if (!credentials) throw new Error('qr_login_timeout');
    const binding = digest(`${credentials.botId}\0${credentials.ownerId}`);
    if (state.binding && state.binding !== binding) throw new Error('owner_changed');
    store.write('credentials.json', {...credentials, pairedAt: Date.now()});
  }
  log('设置完成。运行 npm start，然后在微信里发送 /help，再发送一句普通文字。\nCtrl+C 停止桥；电脑离线时无法转发。');
}
async function start() {
  const credentials = store.read('credentials.json', null);
  if (!credentials) throw new Error('credentials_missing');
  const client = new WeChatClient({credentials});
  const since = Date.now();
  const bridge = new Bridge({store, wechat: client, provider: null, credentials, log, since, signal: abort.signal});
  await openBrowser(bridge.state.selected); bridge.provider = provider;
  const status = await provider.inspect();
  if (!status.ready || status.busy) throw new Error('browser_not_ready');
  log('微信桥运行中。请保持这个终端和专用浏览器打开；Ctrl+C 停止。\n微信发送 /help 查看命令。启动前的消息不会补发；无需公网隧道。');
  let failures = 0;
  while (!abort.signal.aborted) {
    await bridge.drain();
    let batch;
    try {
      batch = await client.getUpdates(bridge.state.cursor, {signal: abort.signal});
    } catch (error) {
      if (abort.signal.aborted) break;
      if (error.code === 'wechat_session_expired') throw error;
      failures += 1;
      if (failures === 1 || failures % 10 === 0) log('微信接收暂不可用；检查网络和微信登录。已退避等待，不会重发网页消息。');
      await delay(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), undefined, {signal: abort.signal});
      continue;
    }
    if (abort.signal.aborted) break;
    // Persistence failures must terminate, not be mistaken for network retries.
    await bridge.ingest(batch); failures = 0;
    if (!batch.msgs.length) await delay(1000, undefined, {signal: abort.signal});
  }
}
async function doctor() {
  log(`Node ${process.version} · ${process.platform}/${process.arch}`);
  log(`浏览器安装：${browserInstalled() ? '正常' : '缺失 → npm run browser:install'}`);
  const credentials = store.read('credentials.json', null);
  log(`微信本地配对：${credentials ? '存在（不输出令牌）' : '未配置 → npm run setup'}`);
  const state = store.read('state.json', initialState());
  log(`上次提交待确认：${state.blocked ? '是 → 查看网页后在微信发 /ack' : '否'}`);
  log(`未确认微信投递：${Object.values(state.records || {}).filter(x => ['replying', 'delivery_uncertain'].includes(x.status)).length} 条`);
  if (credentials) new WeChatClient({credentials});
  if (browserInstalled()) {
    await openBrowser(state.selected);
    const status = await provider.inspect();
    log(`ChatGPT 页面：${status.ready && !status.busy ? '就绪' : '需要登录、等待加载或结束生成'}`);
    if (!status.ready || status.busy) process.exitCode = 1;
  } else process.exitCode = 1;
  if (!credentials) process.exitCode = 1;
  log('doctor 不发送消息；本地配对文件存在不代表服务端登录仍有效。');
}
function unlock() {
  const file = path.join(dataDir, 'running.lock');
  if (!fs.existsSync(file)) { log('没有运行锁。'); return; }
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error('state_file_invalid');
  try { process.kill(lock.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') { fs.unlinkSync(file); log('已清除失效运行锁，聊天账本和登录状态保持不变。'); return; }
    throw error;
  }
  throw new Error('bridge_already_running_or_stale_lock');
}
try {
  if (command === 'unlock') unlock();
  else if (['setup', 'start', 'doctor'].includes(command)) {
    store = new StateStore(dataDir); store.acquire();
    await ({setup, start, doctor}[command])();
  } else {
    log('WeChat ChatGPT Bridge · 0.1.0-alpha.1\nnpm run setup   首次登录与扫码\nnpm start       运行桥（Ctrl+C 停止）\nnpm run doctor  诊断，不发送消息\nnpm run unlock  清除已退出进程的运行锁\n可追加 -- --data-dir 独立目录');
    if (command !== 'help') process.exitCode = 2;
  }
} catch (error) {
  if (!abort.signal.aborted) {
    log(`未能完成：${hints[error.code] || hints[error.message] || '请检查网络、登录和本地目录权限。运行 npm run doctor，按 README 的排错步骤检查。'}`);
    process.exitCode = 1;
  }
} finally { await cleanup(); }
