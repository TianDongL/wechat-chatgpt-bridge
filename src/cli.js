#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import qr from "qrcode-terminal";
import { chromium } from "playwright";
import { StateStore, defaultDataDir } from "./state.js";
import { WeChatClient, validateConfirmedLogin } from "./wechat.js";
import { waitForPairing } from "./pairing.js";
import { ChatGPTBrowser } from "./chatgpt-browser.js";
import { Bridge, initialState, digest } from "./bridge.js";
import { conversationUrl } from "./commands.js";
import { HtmlPreview } from "./html-preview.js";
import { installedTunnel, installTunnel } from "./preview-tunnel.js";
import { NativeProvider, discoverNative } from "./native-provider.js";
import {
  LocalControl,
  controlRequest,
  readNotification,
} from "./local-control.js";
import { runBridge } from "./runtime.js";

const args = process.argv.slice(2);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error("需要 Node.js 22.13 或更新版本。");
  process.exit(2);
}
const command = args.shift() || "help";
let dataDir = defaultDataDir(),
  stdinNotification = false;
while (args.length) {
  const flag = args.shift();
  if (flag === "--stdin" && command === "notify") {
    stdinNotification = true;
    continue;
  }
  const value = args.shift();
  if (flag === "--data-dir" && value) dataDir = path.resolve(value);
  else {
    console.error(
      "用法：node src/cli.js setup|setup-native|start|doctor|unlock|status|stop|notify [--data-dir 独立数据目录] [notify 的 --stdin]",
    );
    process.exit(2);
  }
}
const log = (text) => console.log(text);
const hints = {
  bridge_already_running_or_stale_lock:
    "已有实例在运行，或上次没有正常退出。先关闭旧终端；确认已退出后运行 npm run unlock。",
  state_file_invalid:
    "本地状态无法读取；请先备份数据目录，不要删除账本后直接重发。",
  state_directory_not_dedicated:
    "请选择一个新的空目录作为 --data-dir，不要使用主目录或现有项目目录。",
  credentials_missing: "尚未扫码配对。请先运行 npm run setup。",
  browser_missing: "缺少浏览器。请运行 npm run browser:install。",
  browser_not_ready:
    "浏览器尚未就绪。完成 ChatGPT 登录、进入普通会话、清空草稿并等待回复结束后再试。",
  conversation_required:
    "请运行 npm run setup，登录后打开一个已有的普通 ChatGPT 会话，再回到终端按回车。",
  owner_changed:
    "当前微信配对与账本不匹配。请使用新的独立 --data-dir 为新账号配对。",
  login_expired: "微信二维码已过期。请重新运行 npm run setup。",
  wechat_login_redirect_unsupported:
    "当前账号登录需要重定向，本 alpha 版尚不支持。请不要手动复制令牌。",
  qr_login_timeout: "扫码登录超时，请重新运行 npm run setup。",
  wechat_session_expired:
    "微信登录已过期。重新运行 npm run setup，在已有配对提示中输入 relogin 后扫码。",
  wechat_invalid_pin:
    "校验码格式不正确。请重新运行 setup，按手机显示的数字输入。",
  native_requires_windows:
    "可选本机接入目前仅支持 Windows。其他平台请使用普通 setup。",
  native_conversation_unavailable:
    "本机接入无法读取此普通 GPT 会话。请确认 Codex 正在运行、登录同一 ChatGPT 账号，且会话链接正确。",
  native_account_changed:
    "本机 ChatGPT 登录账号已变化，已停止转发。请用独立数据目录重新设置。",
  ledger_capacity_reached:
    "本地去重账本达到容量上限，已停止接收。请先归档数据，不要删除账本后重发旧消息。",
  dot_not_configured:
    "Dot 未绑定。请运行 setup-native 选择自己的 Dot，或回到普通网页模式重新设置。",
};
let store, provider, preview, prompt, control;
const abort = new AbortController();
let shuttingDown = false;
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  abort.abort();
  prompt?.close();
  await control?.close();
  try {
    await preview?.stop();
  } finally {
    try {
      await provider?.close();
    } finally {
      store?.release();
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    log("\n正在停止微信桥并关闭本次浏览器页面……");
    abort.abort();
    prompt?.close();
    // Keep the lock until the in-flight task has recorded its uncertain outcome.
    provider?.close().catch(() => {});
    preview?.stop().catch(() => {});
  });
function browserInstalled() {
  return fs.existsSync(chromium.executablePath());
}
async function ask(question, signal = abort.signal) {
  prompt ??= readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return prompt.question(question, { signal });
}
async function openBrowser(url) {
  if (!browserInstalled()) throw new Error("browser_missing");
  provider = new ChatGPTBrowser({
    profileDir: path.join(dataDir, "browser-profile"),
  });
  await provider.open(url || "https://chatgpt.com/");
}
async function setup() {
  const native = command === "setup-native";
  log(
    native
      ? "WeChat ChatGPT Bridge · 可选 Windows 本机接入\n使用本机 Codex 的已登录账号；不复制 Cookie，不开启浏览器调试。"
      : "WeChat ChatGPT Bridge · 首次设置\n不需要 API Key。在本机专用浏览器登录即可，无需开启浏览器调试。",
  );
  const saved = store.read("credentials.json", null);
  const state = store.read("state.json", initialState());
  log(
    "HTML 组件将通过本机临时网页链接查看；普通文字原样转发。链接持有者可查看该条原文，请勿随意转发。",
  );
  try {
    await installTunnel(dataDir, { signal: abort.signal, log });
  } catch {
    if (!abort.signal.aborted)
      log(
        "HTML 预览程序准备失败，普通聊天仍可设置。网络恢复后重新运行 setup 重试。",
      );
  }
  if (abort.signal.aborted) return;
  let settings = { mode: "browser" };
  if (native) {
    settings = await discoverNative();
    const existing =
      state.defaultSelected ||
      (state.selected !== "dot" ? state.selected : null);
    const input = (
      await ask(
        `1/2 粘贴同一账号已有的 ChatGPT 网页会话链接${existing ? "（回车沿用原默认会话）" : ""}：`,
      )
    ).trim();
    settings.defaultUrl = conversationUrl(input || existing);
    if (settings.dot) {
      const enabled =
        (
          await ask(
            "已验证当前账号的个人 Dot。回车启用 /cd dot 和主动提醒，输入 skip 仅接 GPT：",
          )
        ).trim() !== "skip";
      if (!enabled) delete settings.dot;
    } else log("当前账号未发现可验证的个人 Dot，将仅接入 GPT 网页会话。");
    provider = new NativeProvider({ settings });
    await provider.open(settings.defaultUrl);
  } else {
    await openBrowser(
      state.selected === "dot" ? state.defaultSelected : state.selected,
    );
    log(
      "1/2 请在打开的专用浏览器里登录 ChatGPT，并打开一个已有的普通会话。若账号还没有会话，请先在网页手动聊一句。",
    );
    await ask("完成登录、清空输入框并等页面加载完成后，在这里按回车：");
  }
  const status = await provider.inspect();
  if (!status.ready || status.busy) throw new Error("browser_not_ready");
  try {
    state.selected = conversationUrl(status.url);
  } catch {
    throw new Error("conversation_required");
  }
  state.defaultSelected = state.selected;
  state.selectedTitle = status.title || "";
  delete state.watch;
  store.write("settings.json", settings);
  store.write("state.json", state);
  const reuse =
    saved &&
    (
      await ask(
        "已有微信配对，按回车继续使用；若已失效，输入 relogin 重新扫码：",
      )
    ).trim() !== "relogin";
  if (reuse) {
    log("2/2 继续使用现有微信配对。");
  } else {
    log(
      "2/2 使用你本人微信扫描下面的二维码并确认。不要扫描正在由另一套桥使用的同一个机器人。",
    );
    const client = new WeChatClient({});
    const code = await client.getQr();
    qr.generate(code.qrcode_img_content, { small: true });
    log("二维码仅供这次配对，请勿截图发到公开 Issue。");
    const response = await waitForPairing({
      client,
      qrcode: code.qrcode,
      signal: abort.signal,
      onStatus: (status) =>
        log(
          ["scaned", "scanned"].includes(status)
            ? "已扫码，请在手机确认。"
            : status === "confirmed"
              ? "微信已确认。"
              : "等待微信确认……",
        ),
      askVerify: async ({ signal }) =>
        (await ask("请输入微信登录页面显示的校验码：", signal)).trim(),
    });
    const credentials = validateConfirmedLogin(response);
    const binding = digest(`${credentials.botId}\0${credentials.ownerId}`);
    if (state.binding && state.binding !== binding)
      throw new Error("owner_changed");
    store.write("credentials.json", { ...credentials, pairedAt: Date.now() });
  }
  log(
    "设置完成。运行 npm start，然后在微信里发送 /help，再发送一句普通文字。\nCtrl+C 停止桥；电脑离线时无法转发。",
  );
}
async function start() {
  const credentials = store.read("credentials.json", null);
  if (!credentials) throw new Error("credentials_missing");
  const client = new WeChatClient({ credentials });
  const since = Date.now();
  const bridge = new Bridge({
    store,
    wechat: client,
    provider: null,
    credentials,
    log,
    since,
    signal: abort.signal,
  });
  if (!bridge.state.selected) throw new Error("conversation_required");
  const settings = store.read("settings.json", { mode: "browser" });
  if (settings.mode === "native") {
    provider = new NativeProvider({ settings });
    if (bridge.state.selected !== "dot")
      await provider.open(bridge.state.selected);
  } else {
    await openBrowser(bridge.state.selected);
    const status = await provider.inspect();
    if (!status.ready) throw new Error("browser_not_ready");
  }
  bridge.provider = provider;
  await bridge.initialize();
  preview = new HtmlPreview();
  bridge.preview = preview;
  try {
    const tunnel = await installedTunnel(dataDir);
    await preview.start(tunnel);
  } catch {
    /* Preview failure cannot stop ordinary replies. */
  }
  if (abort.signal.aborted) return;
  log(
    preview.ready
      ? "HTML 预览已就绪：组件转为临时网页链接，普通文字原样发送。"
      : "HTML 预览暂不可用，HTML 原文仍会发送。可检查网络后重启；若尚未安装，重新运行 setup。",
  );
  control = new LocalControl();
  await control.start({
    directory: dataDir,
    bridge,
    onStop: () => abort.abort(),
  });
  log(
    `微信桥运行中（${settings.mode === "native" ? "本机接入，请保持 Codex 运行" : "网页接入，请保持桥的浏览器打开"}）。Ctrl+C 停止桥与预览链接。\n微信发送 /help 查看命令。收件、GPT 回复和 Dot 提醒独立监听；启动前未接收的旧消息不会补发。`,
  );
  await runBridge({ bridge, client, abort, log });
}
async function doctor() {
  log(`Node ${process.version} · ${process.platform}/${process.arch}`);
  log(
    `浏览器安装：${browserInstalled() ? "正常" : "缺失 → npm run browser:install"}`,
  );
  try {
    await installedTunnel(dataDir);
    log("HTML 预览程序：校验通过（不启动隧道）");
  } catch {
    log(
      "HTML 预览程序：未安装或校验失败 → npm run setup；普通文字聊天不依赖它",
    );
  }
  const credentials = store.read("credentials.json", null);
  log(
    `微信本地配对：${credentials ? "存在（不输出令牌）" : "未配置 → npm run setup"}`,
  );
  const state = store.read("state.json", initialState());
  log(
    `历史网页结果未确认：${Object.values(state.records || {}).filter((x) => ["submitting", "accepted", "uncertain"].includes(x.status)).length} 条（请查看网页，旧消息不会重发）`,
  );
  log(
    `未确认微信投递：${Object.values(state.records || {}).filter((x) => ["replying", "delivery_uncertain"].includes(x.status)).length} 条`,
  );
  if (credentials) new WeChatClient({ credentials });
  const settings = store.read("settings.json", { mode: "browser" });
  if (settings.mode === "native") {
    provider = new NativeProvider({ settings });
    await provider.open(
      state.selected === "dot" ? state.defaultSelected : state.selected,
    );
    log("本机 GPT 会话读取：正常");
    if (provider.dotEnabled) {
      await provider.dotCall("baseline");
      log("Dot 个人房间与成员绑定：正常");
    }
  } else if (browserInstalled()) {
    await openBrowser(state.selected);
    const status = await provider.inspect();
    log(
      `ChatGPT 页面：${status.ready && !status.busy ? "就绪" : "需要登录、等待加载或结束生成"}`,
    );
    if (!status.ready || status.busy) process.exitCode = 1;
  } else process.exitCode = 1;
  try {
    conversationUrl(
      state.selected === "dot" ? state.defaultSelected : state.selected,
    );
  } catch {
    log("尚未绑定已有网页会话 → npm run setup");
    process.exitCode = 1;
  }
  if (!credentials) process.exitCode = 1;
  log("doctor 不发送消息；本地配对文件存在不代表服务端登录仍有效。");
}
function unlock() {
  const file = path.join(dataDir, "running.lock");
  if (!fs.existsSync(file)) {
    log("没有运行锁。");
    return;
  }
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(lock.pid) || lock.pid < 1)
    throw new Error("state_file_invalid");
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") {
      fs.unlinkSync(file);
      log("已清除失效运行锁，聊天账本和登录状态保持不变。");
      return;
    }
    throw error;
  }
  throw new Error("bridge_already_running_or_stale_lock");
}
try {
  if (command === "unlock") unlock();
  else if (["status", "stop", "notify"].includes(command)) {
    if (command === "notify" && !stdinNotification)
      throw new Error("invalid_notification");
    const input = command === "notify" ? await readNotification() : {};
    log(JSON.stringify(await controlRequest(dataDir, command, input)));
  } else if (["setup", "setup-native", "start", "doctor"].includes(command)) {
    store = new StateStore(dataDir);
    store.acquire();
    await { setup, "setup-native": setup, start, doctor }[command]();
  } else {
    log(
      "WeChat ChatGPT Bridge · 0.1.0-alpha.4\nnpm run setup   网页登录、HTML 预览与扫码\nnpm run setup:native   可选 Windows Codex/Dot 接入\nnpm start       运行桥（Ctrl+C 停止）\nnpm run doctor  诊断，不发送消息\nnpm run status / npm run stop  本机状态 / 停止\nnpm run notify -- --stdin  从标准输入读取本人通知\nnpm run unlock  清除已退出进程的运行锁\n可追加 -- --data-dir 独立目录",
    );
    if (command !== "help") process.exitCode = 2;
  }
} catch (error) {
  if (!abort.signal.aborted) {
    log(
      `未能完成：${hints[error.code] || hints[error.message] || "请检查网络、登录和本地目录权限。运行 npm run doctor，按 README 的排错步骤检查。"}`,
    );
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}
