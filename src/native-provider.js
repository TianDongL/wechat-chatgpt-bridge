import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import session from "./native/managed_chatgpt_session.cjs";
import web from "./native/web_chat_transport.cjs";
import dot from "./native/dot.cjs";
import { conversationUrl } from "./commands.js";

const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
export function resolveCodex(
  configured,
  {
    platform = process.platform,
    root = path.join(os.homedir(), "AppData/Local/OpenAI/Codex/bin"),
    activePaths,
  } = {},
) {
  if (platform !== "win32") throw new Error("native_requires_windows");
  root = path.resolve(root);
  const check = (value) => {
    if (
      path.dirname(path.dirname(value)) !== root ||
      path.basename(value).toLowerCase() !== "codex.exe" ||
      !/^[a-f0-9]{16,64}$/i.test(path.basename(path.dirname(value)))
    )
      throw new Error("native_install_invalid");
    for (let item = value; ; item = path.dirname(item)) {
      if (fs.lstatSync(item).isSymbolicLink())
        throw new Error("native_install_invalid");
      if (path.dirname(item) === item) break;
    }
    if (!fs.statSync(value).isFile() || fs.statSync(value).nlink !== 1)
      throw new Error("native_install_invalid");
    return value;
  };
  if (configured && fs.existsSync(configured))
    return check(path.resolve(configured));
  const entries = fs.readdirSync(root);
  if (entries.length > 128) throw new Error("native_install_invalid");
  const candidates = entries
    .filter((name) => /^[a-f0-9]{16,64}$/i.test(name))
    .map((name) => path.join(root, name, "codex.exe"))
    .filter((file) => fs.existsSync(file));
  if (candidates.length === 1) return check(candidates[0]);
  const active =
    activePaths ??
    JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "ConvertTo-Json -Compress -InputObject @((Get-Process -Name codex -ErrorAction SilentlyContinue).Path | Where-Object { $_ } | Select-Object -Unique)",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 65536,
        },
      ),
    );
  const running = candidates.filter((file) =>
    active.some(
      (item) => path.resolve(item).toLowerCase() === file.toLowerCase(),
    ),
  );
  if (running.length !== 1) throw new Error("native_install_ambiguous");
  return check(running[0]);
}

export class NativeProvider {
  constructor({
    settings,
    connect = session.connect,
    transport = web.run,
    resolve = resolveCodex,
  } = {}) {
    this.settings = settings;
    this.connect = connect;
    this.transport = transport;
    this.resolve = resolve;
    this.url = settings.defaultUrl;
    this.closed = false;
    this.dotEnabled = !!settings.dot;
  }
  async connection(executable) {
    if (this.closed) throw new Error("provider_closed");
    const request = await this.connect(executable);
    if (fingerprint(request.accountId) !== this.settings.accountHash)
      throw new Error("native_account_changed");
    return request;
  }
  async call(operation, url = this.url, extra = {}) {
    if (this.closed) throw new Error("provider_closed");
    const executable = this.resolve(this.settings.executable);
    const target = conversationUrl(url).split("/").at(-1);
    return this.transport(
      {
        operation,
        target,
        origin_thread: this.settings.originThread || target,
        ...extra,
      },
      executable,
      { connect: (file) => this.connection(file) },
    );
  }
  async open(url) {
    return this.select(url);
  }
  useTarget(url, title = "") {
    this.url = conversationUrl(url);
    this.title = title;
  }
  async select(url) {
    url = conversationUrl(url);
    const result = await this.call("baseline", url);
    if (result.status !== "ready")
      throw Object.assign(new Error("native_conversation_unavailable"), result);
    this.useTarget(url, result.title);
    return {
      url,
      title: result.title,
      ready: true,
      busy: result.busy,
      cursor: result.cursor,
    };
  }
  async inspect() {
    const result = await this.call("ready");
    return {
      url: this.url,
      title: this.title,
      ready: result.status === "ready",
      busy: result.status === "busy",
    };
  }
  async baseline(url = this.url, openedAt) {
    return this.call(
      "baseline",
      url,
      openedAt === undefined ? {} : { opened_at: openedAt },
    );
  }
  async list() {
    const result = await this.call("list");
    if (result.status !== "list")
      throw Object.assign(new Error("native_list_unavailable"), result);
    return result.items.map((item) => ({
      title: item.title,
      url: conversationUrl(item.id),
    }));
  }
  async submit(text, { expectedUrl, requestId }) {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 4096
    )
      return { status: "not_dispatched", reason: "invalid_text" };
    if (expectedUrl !== this.url)
      return { status: "not_dispatched", reason: "navigation_changed" };
    return this.call("post", expectedUrl, { text, request_id: requestId });
  }
  async poll({ url, cursor, openedAt, receipt, pendingUserId }) {
    return this.call("outbox", url, {
      after: cursor ?? "",
      opened_at: openedAt,
      ...(receipt ? { receipt } : {}),
      ...(pendingUserId ? { pending_user_id: pendingUserId } : {}),
    });
  }
  async dotCall(operation, input) {
    if (!this.dotEnabled || this.closed) throw new Error("dot_not_configured");
    const request = await this.connection(
      this.resolve(this.settings.executable),
    );
    return dot.run(request, this.settings.dot, operation, input);
  }
  async close() {
    this.closed = true;
  }
}

export async function discoverNative({
  executable,
  connect = session.connect,
  resolve = resolveCodex,
} = {}) {
  executable = resolve(executable);
  const request = await connect(executable);
  let identity = null;
  try {
    identity = (await dot.inspectIdentity(request)).identity;
  } catch {
    /* Dot is optional. */
  }
  const originThread = recentContext();
  return {
    mode: "native",
    executable,
    accountHash: fingerprint(request.accountId),
    dot: identity,
    originThread,
  };
}

export function recentContext(
  file = path.join(os.homedir(), ".codex/session_index.jsonl"),
) {
  // Read only a bounded metadata tail, never transcript files, auth files or
  // databases. Native app tools require an existing local Codex caller context.
  if (fs.lstatSync(file).isSymbolicLink())
    throw new Error("native_context_unavailable");
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size,
      start = Math.max(0, size - 65536),
      buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start) lines.shift();
    const rows = lines
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(
        (row) =>
          row &&
          /^[0-9a-f-]{36}$/i.test(row.id) &&
          Number.isFinite(Date.parse(row.updated_at)),
      )
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    if (!rows.length) throw new Error("native_context_unavailable");
    return rows[0].id;
  } finally {
    fs.closeSync(fd);
  }
}
