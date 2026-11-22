import { createHash, randomUUID } from "node:crypto";
import {
  parseCommand,
  conversationUrl,
  helpText,
  splitText,
} from "./commands.js";
import { extractOwnerText } from "./wechat.js";
import { splitPreviewText } from "./html-preview.js";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
const INPUT_TTL = 600_000,
  MAX_RECORDS = 10_000;
export function initialState() {
  return { version: 1, cursor: "", selected: null, records: {} };
}
export class Bridge {
  constructor({
    store,
    wechat,
    provider,
    credentials,
    preview,
    log = () => {},
    since = Date.now(),
    signal,
    now = Date.now,
  }) {
    Object.assign(this, {
      store,
      wechat,
      provider,
      credentials,
      preview,
      log,
      since,
      signal,
      now,
    });
    this.state = store.read("state.json", initialState());
    this.listed = [];
    this.generation = 0;
    this._sendChain = Promise.resolve();
    this.nextWebPoll = 0;
    this.nextDotPoll = 0;
    if (
      this.state.version !== 1 ||
      typeof this.state.cursor !== "string" ||
      !this.state.records ||
      typeof this.state.records !== "object" ||
      Array.isArray(this.state.records)
    )
      throw new Error("state_file_invalid");
    if (this.state.selected === "https://chatgpt.com/")
      this.state.selected = null;
    if (this.state.selected !== null && this.state.selected !== "dot")
      conversationUrl(this.state.selected);
    this.state.defaultSelected ??=
      this.state.selected === "dot" ? null : this.state.selected;
    if (this.state.defaultSelected) conversationUrl(this.state.defaultSelected);
    const binding = digest(`${credentials.botId}\0${credentials.ownerId}`);
    if (this.state.binding && this.state.binding !== binding)
      throw new Error("owner_changed");
    this.state.binding = binding;
    this.sessionBinding = digest(
      `${credentials.botId}\0${credentials.ownerId}\0${credentials.token}`,
    );
    for (const r of Object.values(this.state.records)) {
      // Resume native accepted records by reading, never by repeating a write.
      if (
        r.status === "submitting" ||
        (r.status === "accepted" && !r.native) ||
        r.status === "command"
      )
        r.status = "uncertain";
      if (r.status === "replying") r.status = "delivery_uncertain";
    }
    delete this.state.blocked;
    this.save();
  }
  save() {
    this.store.write("state.json", this.state);
  }
  add(key, record) {
    if (
      !Object.hasOwn(this.state.records, key) &&
      Object.keys(this.state.records).length >= MAX_RECORDS
    )
      throw new Error("ledger_capacity_reached");
    this.state.records[key] = record;
  }
  webPending() {
    return Object.values(this.state.records).find(
      (r) =>
        r.native &&
        r.target === this.state.selected &&
        ["accepted", "confirming"].includes(r.status),
    );
  }
  async initialize() {
    if (this.state.selected === "dot" && !this.provider.dotEnabled)
      throw new Error("dot_not_configured");
    const recovering = Object.values(this.state.records).some(
      (r) =>
        r.target === this.state.selected &&
        (r.messageId || (r.status === "confirming" && r.receipt)) &&
        ["accepted", "uncertain", "confirming"].includes(r.status),
    );
    if (
      this.state.selected &&
      this.state.selected !== "dot" &&
      (!recovering || this.state.watch?.url !== this.state.selected)
    )
      await this.resetWatch(this.state.selected);
    if (this.provider.dotEnabled) {
      const b = await this.provider.dotCall("baseline");
      if (b.status !== "ready") throw new Error("dot_not_ready");
      this.dotWatch = { cursor: b.cursor, openedAt: this.now() };
    }
  }
  async resetWatch(url, selected) {
    if (!this.provider.baseline) return;
    const b =
      selected?.cursor !== undefined
        ? { status: "ready", ...selected }
        : await this.provider.baseline(url);
    if (b.status !== "ready") throw new Error("provider_not_ready");
    this.state.watch = { url, cursor: b.cursor, openedAt: this.now() };
    this.state.selectedTitle = b.title || "";
    this.nextWebPoll = 0;
    this.save();
  }
  async ingest(batch) {
    if (
      !batch ||
      !Array.isArray(batch.msgs) ||
      typeof batch.get_updates_buf !== "string"
    )
      throw new Error("invalid_update_batch");
    for (const raw of batch.msgs) {
      const m = extractOwnerText(raw, this.credentials);
      if (!m || m.createdAt < this.since || m.createdAt > this.now() + 60_000)
        continue;
      const key = digest(`${this.credentials.botId}\0${m.id}`);
      if (Object.hasOwn(this.state.records, key)) continue;
      this.add(key, {
        kind: "inbox",
        status: "queued",
        text: m.text,
        contextToken: m.contextToken,
        at: this.now(),
      });
      if (
        !this.state.ownerContext ||
        this.state.ownerContext.session !== this.sessionBinding ||
        m.createdAt > (this.state.ownerContext.occurredAt || 0)
      )
        this.state.ownerContext = {
          token: m.contextToken,
          occurredAt: m.createdAt,
          session: this.sessionBinding,
        };
    }
    this.state.cursor = batch.get_updates_buf;
    this.save(); // Commit inbox and cursor before effects.
  }
  async drain({ wait = true } = {}) {
    if (this._draining) return;
    this._draining = true;
    try {
      await this.expireConfirmations();
      let waiting = !!this._submitTask;
      for (const [key, r] of Object.entries(this.state.records)) {
        if (this.signal?.aborted) break;
        if (r.status !== "queued") continue;
        if (parseCommand(r.text)) {
          await this.process(key, r);
          continue;
        }
        if (this.now() - r.at >= INPUT_TTL) {
          await this.reply(
            key,
            r,
            "这条消息等待超过 10 分钟，未提交。请确认当前入口后重新发送。",
          );
          continue;
        }
        if (waiting || this.webPending() || (r.retryAt ?? 0) > this.now()) {
          waiting = true;
          continue;
        }
        const task = this.process(key, r);
        this._submitTask = task;
        const tracked = task.finally(() => {
          if (this._submitTask === task) this._submitTask = null;
        });
        if (wait) await tracked;
        else {
          this._backgroundTask = tracked;
          tracked.catch((error) => {
            this.fatalError = error;
          });
          waiting = true;
        }
        if (r.status === "queued" || this.webPending()) waiting = true;
      }
    } finally {
      this._draining = false;
    }
  }
  async settle() {
    await this._backgroundTask;
    await this._sendChain;
  }
  async reply(key, r, text, options = {}) {
    const operation = this._sendChain.then(() =>
      this.deliver(key, r, text, options),
    );
    this._sendChain = operation;
    return operation;
  }
  async deliver(key, r, text, { renderHtml = false, sourceUrl } = {}) {
    this.store.saveReply(key, text);
    if (this.signal?.aborted) {
      r.status = "delivery_uncertain";
      this.save();
      return;
    }
    let outgoing = text;
    if (renderHtml && this.preview) {
      try {
        outgoing = this.preview.transform(key, text, {
          sourceUrl,
          protectedValues: [this.credentials.token, r.contextToken],
        });
      } catch {
        this.log("HTML 预览暂不可用，已保留原文发送。");
      }
    }
    r.parts = [];
    r.status = "replying";
    this.save();
    for (const part of outgoing === text
      ? splitText(text)
      : splitPreviewText(outgoing)) {
      if (this.signal?.aborted) {
        r.status = "delivery_uncertain";
        break;
      }
      const attempt = { clientId: `wcg-${randomUUID()}`, status: "reserved" };
      r.parts.push(attempt);
      this.save();
      try {
        await this.wechat.sendText(
          {
            text: part,
            contextToken: r.contextToken,
            clientId: attempt.clientId,
          },
          { signal: this.signal },
        );
        attempt.status = "sent";
        this.save();
      } catch (error) {
        attempt.status = "uncertain";
        r.status = "delivery_uncertain";
        if (error.code === "wechat_session_expired") {
          if (this.state.ownerContext) this.state.ownerContext.blocked = true;
          this.fatalError = error;
        }
        this.log(
          "微信发送结果未确认，未重发。完整回复已保存到本机 replies 目录。",
        );
        break;
      }
    }
    if (r.status === "replying") r.status = "done";
    delete r.text;
    delete r.contextToken;
    this.save();
  }
  async notice(key, r, text, name) {
    const id = digest(`notice:${key}:${name}`);
    if (this.state.records[id]) return;
    const item = {
      kind: "notice",
      status: "new",
      contextToken: r.contextToken,
      at: this.now(),
    };
    this.add(id, item);
    this.save();
    await this.reply(id, item, text);
  }
  async command(command) {
    if (command.name === "help")
      return helpText({
        dot: !!this.provider.dotEnabled,
        native: !!this.provider.submit,
      });
    const where = () =>
      this.state.selected === "dot"
        ? "当前入口：Dot 原会话"
        : `当前 ChatGPT 网页：${this.state.selectedTitle ? "\n" + this.state.selectedTitle : ""}\n${this.state.selected || "尚未选择，请发送 /cd 会话链接。"}`;
    if (command.name === "where") {
      const n = Object.values(this.state.records).filter(
        (r) => r.status === "uncertain",
      ).length;
      return `${where()}${n ? `\n有 ${n} 条历史结果未确认，旧消息不会重发。` : ""}\n发送 /help 查看命令。`;
    }
    if (command.name === "list") {
      this.listed = (await this.provider.list()).slice(0, 12);
      return this.listed.length
        ? this.listed
            .map(
              (x, i) =>
                `${i + 1}. ${x.title.replace(/[\r\n]/g, " ").slice(0, 160)}\n${x.url}`,
            )
            .join("\n\n") + "\n\n发送 /cd 编号切换；发送 /help 查看命令。"
        : "暂无可用会话。请用 /cd 完整会话链接选择已有会话。发送 /help 查看命令。";
    }
    if (!command.argument)
      return helpText({
        dot: !!this.provider.dotEnabled,
        native: !!this.provider.submit,
      });
    let target;
    if (command.argument === "dot") {
      if (!this.provider.dotEnabled)
        return "尚未配置 Dot；需要 Windows 本机接入模式并在 setup-native 绑定自己的 Dot。当前入口保持不变。发送 /help 查看命令。";
      target = "dot";
    } else if (command.argument === "gpt") {
      target = this.state.defaultSelected;
      if (!target)
        return "尚未配置默认 GPT 会话，请先运行 setup。发送 /help 查看命令。";
    } else {
      const item = /^[1-9]\d*$/.test(command.argument)
        ? this.listed[Number(command.argument) - 1]?.url
        : command.argument;
      try {
        target = conversationUrl(item);
      } catch {
        return "会话无效。先发 /list，再用 /cd 编号切换；也可以使用完整 ChatGPT 会话链接。发送 /help 查看命令。";
      }
    }
    if (target === this.state.selected)
      return `已在该会话：\n${where()}\n发送 /help 查看命令。`;
    if (this._submitTask || this.webPending())
      return "上一条网页消息仍在提交或等待回复，暂不能切换；当前入口保持不变。发送 /where 查看入口。";
    const selected =
      target === "dot" ? null : await this.provider.select(target);
    let baseline = null;
    if (target !== "dot" && this.provider.baseline) {
      baseline =
        selected?.cursor !== undefined
          ? { status: "ready", ...selected }
          : await this.provider.baseline(target);
      if (baseline.status !== "ready") throw new Error("provider_not_ready");
    }
    this.generation++;
    this.state.selected = target;
    this.state.defaultSelected ??= target === "dot" ? null : target;
    if (baseline) {
      this.state.watch = {
        url: target,
        cursor: baseline.cursor,
        openedAt: this.now(),
      };
      this.state.selectedTitle = baseline.title || "";
      this.nextWebPoll = 0;
    } else {
      delete this.state.watch;
      this.state.selectedTitle = selected?.title || "";
    }
    this.save();
    return `已切换：\n${where()}\n发送 /help 查看命令。`;
  }
  async defer(key, r, result) {
    r.status = "queued";
    r.failures = (r.failures || 0) + 1;
    r.retryAt =
      this.now() +
      Math.max(
        Math.min(180000, 12000 * 2 ** Math.min(r.failures - 1, 4)),
        (result.retry_after || 0) * 1000,
      );
    this.save();
    await this.notice(
      key,
      r,
      "当前会话忙碌或暂不可用，这条尚未提交，已暂存并会按顺序继续；超过 10 分钟将停止等待。",
      "waiting",
    );
  }
  async process(key, r) {
    const command = parseCommand(r.text);
    if (command) {
      r.status = "command";
      this.save();
      let text;
      try {
        text = await this.command(command);
      } catch {
        text = "当前入口暂不可用，请检查登录与本机程序；发送 /where 核对入口。";
      }
      await this.reply(key, r, text);
      return;
    }
    if (!this.state.selected) {
      await this.reply(
        key,
        r,
        "尚未选择已有网页会话，这条没有发送。请先发送 /cd 会话链接。发送 /help 查看命令。",
      );
      return;
    }
    if (r.target && r.target !== this.state.selected) {
      await this.reply(
        key,
        r,
        "等待期间入口已切换，这条尚未提交，也没有转发到新入口。请确认 /where 后重新发送。",
      );
      return;
    }
    if (this.state.selected === "dot" && this.dotBlocked) {
      await this.reply(
        key,
        r,
        "Dot 上一条提交结果未确认，已暂停向 Dot 发送新消息；主动提醒仍可接收。请先检查原 Dot 会话，再重启桥恢复。",
      );
      return;
    }
    r.status = "submitting";
    r.target ??= this.state.selected;
    r.requestId ??= randomUUID();
    this.save();
    if (this.provider.submit || r.target === "dot") {
      r.native = true;
      this.save();
      let result;
      try {
        result =
          r.target === "dot"
            ? await this.provider.dotCall("post", {
                text: r.text,
                requestId: r.requestId,
              })
            : await this.provider.submit(r.text, {
                expectedUrl: r.target,
                requestId: r.requestId,
              });
      } catch {
        result = { status: "uncertain" };
      }
      if (result.status === "not_dispatched") {
        if (result.reason === "invalid_text") {
          await this.reply(
            key,
            r,
            "消息超出当前入口支持的长度或格式，尚未提交。请分段发送。",
          );
          return;
        }
        await this.defer(key, r, result);
        return;
      }
      if (result.status === "accepted") {
        r.messageId = result.message_id;
        r.status = r.target === "dot" ? "submitted" : "accepted";
        delete r.text;
        this.save();
        this.nextWebPoll = 0;
        return;
      }
      if (result.status === "confirming" && result.receipt) {
        r.status = "confirming";
        r.receipt = result.receipt;
        r.confirmUntil = this.now() + 90000;
        delete r.text;
        this.save();
        this.nextWebPoll = 0;
        return;
      }
      r.status = "uncertain";
      if (r.target === "dot") this.dotBlocked = true;
      this.save();
      await this.notice(
        key,
        r,
        "这条消息的提交结果暂未确认，为避免重复没有重发。请查看当前会话。",
        "uncertain",
      );
      return;
    }
    let result;
    try {
      result = await this.provider.send(r.text, {
        expectedUrl: r.target,
        onSubmitted: async (submitted) => {
          r.status = "accepted";
          r.messageId = submitted.messageId;
          this.state.selected = conversationUrl(submitted.url);
          this.save();
        },
      });
      if (typeof result.text !== "string" || !result.text.trim())
        throw Object.assign(new Error("empty_reply"), { uncertain: true });
    } catch (error) {
      if (
        error.uncertain === false &&
        ["busy", "not_ready", "browser_unavailable"].includes(error.code)
      ) {
        await this.defer(key, r, {});
        return;
      }
      if (error.uncertain === false) {
        await this.reply(
          key,
          r,
          "这条消息尚未提交。请检查桥的浏览器是否已登录、页面是否忙碌或输入框是否留有草稿，再重新发送。",
        );
        return;
      }
      r.status = "uncertain";
      this.save();
      await this.notice(
        key,
        r,
        "这条消息的网页提交或回答结果暂未确认，为避免重复没有重发。请查看当前网页会话；后续消息须等网页空闲后再发送。",
        "uncertain",
      );
      return;
    }
    this.state.selected = conversationUrl(result.url);
    if (result.messageId && this.state.watch?.url === result.url)
      this.state.watch.cursor = result.messageId;
    this.save();
    await this.reply(key, r, result.text, {
      renderHtml: true,
      sourceUrl: result.url,
    });
  }
  context() {
    const v = this.state.ownerContext;
    return v &&
      v.session === this.sessionBinding &&
      !v.blocked &&
      typeof v.token === "string"
      ? v.token
      : null;
  }
  async expireConfirmations() {
    for (const [key, r] of Object.entries(this.state.records))
      if (r.status === "confirming" && this.now() >= r.confirmUntil) {
        r.status = "uncertain";
        this.save();
        await this.notice(
          key,
          r,
          "这条消息的网页提交结果暂未确认，为避免重复没有重发。请查看当前网页会话。",
          "uncertain",
        );
      }
  }
  async queueOutput(source, entry, sourceUrl) {
    const key = digest(`output:${source}:${entry.id}`);
    if (this.state.records[key] || !entry.text) return;
    const text = source === "dot" ? "【Dot】\n" + entry.text : entry.text;
    if (
      text.includes("\0") ||
      [this.credentials.token, this.context()]
        .filter(Boolean)
        .some((secret) => text.includes(secret))
    )
      return;
    this.add(key, {
      kind: "outbox",
      status: "outgoing",
      text,
      sourceUrl,
      at: this.now(),
    });
    this.save();
  }
  async flushOutgoing() {
    if (this._flushing) return;
    this._flushing = true;
    try {
      for (const [key, r] of Object.entries(this.state.records)) {
        if (this.signal?.aborted) break;
        if (r.status !== "outgoing") continue;
        if (this.now() - r.at >= INPUT_TTL) {
          this.store.saveReply(key, r.text);
          r.status = "expired";
          delete r.text;
          this.save();
          continue;
        }
        const token = this.context();
        if (!token) continue;
        r.contextToken = token;
        await this.reply(key, r, r.text, {
          renderHtml: true,
          sourceUrl: r.sourceUrl,
        });
      }
    } finally {
      this._flushing = false;
    }
  }
  async pollWeb() {
    if (
      this._pollingWeb ||
      this.signal?.aborted ||
      !this.provider.poll ||
      this.state.selected === "dot" ||
      !this.state.watch ||
      this.now() < this.nextWebPoll ||
      (this._submitTask && !this.provider.submit)
    )
      return;
    this._pollingWeb = true;
    const generation = this.generation,
      watch = { ...this.state.watch },
      pending = this.webPending();
    try {
      let result;
      try {
        result = await this.provider.poll({
          ...watch,
          receipt: pending?.receipt,
        });
      } catch {
        result = { status: "unavailable" };
      }
      if (
        generation !== this.generation ||
        this.state.selected !== watch.url ||
        this.signal?.aborted
      )
        return;
      if (result.status !== "page") {
        this.webFailures = (this.webFailures || 0) + 1;
        this.nextWebPoll =
          this.now() +
          Math.max(
            Math.min(180000, 12000 * 2 ** Math.min(this.webFailures - 1, 4)),
            (result.retry_after || 0) * 1000,
          );
        return;
      }
      this.webFailures = 0;
      if (
        pending?.status === "confirming" &&
        result.confirmation?.status === "accepted"
      ) {
        pending.status = "accepted";
        pending.messageId = result.confirmation.message_id;
        delete pending.receipt;
        this.save();
      }
      if (
        pending?.status === "confirming" &&
        this.now() >= pending.confirmUntil
      ) {
        pending.status = "uncertain";
        this.save();
        const key = Object.entries(this.state.records).find(
          ([, r]) => r === pending,
        )[0];
        await this.notice(
          key,
          pending,
          "这条消息的网页提交结果暂未确认，为避免重复没有重发。请查看当前网页会话。",
          "uncertain",
        );
      }
      for (const entry of result.entries) {
        await this.queueOutput(watch.url, entry, watch.url);
        if (entry.finished_turn)
          for (const [recordKey, record] of Object.entries(
            this.state.records,
          )) {
            if (
              record.target === watch.url &&
              record.messageId &&
              entry.user_id === record.messageId &&
              ["accepted", "uncertain"].includes(record.status)
            ) {
              record.status = "done";
              if (!entry.text)
                await this.notice(
                  recordKey,
                  record,
                  "当前网页这一轮已结束，但没有可回传的文字，请查看网页。",
                  "empty-final",
                );
              delete record.contextToken;
              delete record.receipt;
              delete record.text;
            }
          }
        this.state.watch.cursor = entry.id;
        this.save();
      }
      this.nextWebPoll =
        this.now() +
        (result.entries.length >= 10
          ? 250
          : (result.poll_after_ms ?? (this.webPending() ? 12000 : 30000)));
    } finally {
      this._pollingWeb = false;
    }
  }
  async pollDot() {
    if (
      !this.dotWatch ||
      this._pollingDot ||
      this.signal?.aborted ||
      this.now() < this.nextDotPoll
    )
      return;
    this._pollingDot = true;
    try {
      let result;
      try {
        result = await this.provider.dotCall("outbox", {
          after: this.dotWatch.cursor,
          openedAt: this.dotWatch.openedAt,
        });
      } catch {
        result = { status: "unavailable" };
      }
      if (result.status !== "page" || this.signal?.aborted) {
        this.nextDotPoll = this.now() + 6000;
        return;
      }
      for (const entry of result.entries) {
        await this.queueOutput("dot", entry);
        this.dotWatch.cursor = entry.id;
      }
      this.nextDotPoll =
        this.now() + (result.entries.length >= 10 ? 250 : 6000);
    } finally {
      this._pollingDot = false;
    }
  }
  async notify(input) {
    if (
      !input ||
      Object.keys(input).sort().join(",") !== "purpose,request_id,text" ||
      !["reminder", "progress", "todo", "test"].includes(input.purpose) ||
      typeof input.request_id !== "string" ||
      !input.request_id ||
      Buffer.byteLength(input.request_id) > 128 ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      Buffer.byteLength(input.text) > 4000 ||
      /\0/.test(input.text + input.request_id)
    )
      return { status: "rejected", retry_allowed: false };
    const key = digest(`notify:${input.request_id}`),
      previous = this.state.records[key];
    if (previous)
      return {
        status:
          "duplicate_" +
          (previous.status === "done"
            ? "sent"
            : previous.status === "rejected"
              ? "rejected"
              : "uncertain"),
        retry_allowed: false,
      };
    const contextToken = this.context();
    if (this.signal?.aborted || !contextToken)
      return { status: "not_ready", retry_allowed: false };
    if (
      [this.credentials.token, contextToken].some((secret) =>
        input.text.includes(secret),
      )
    )
      return { status: "rejected", retry_allowed: false };
    const r = {
      kind: "notification",
      status: "reserved",
      contextToken,
      at: this.now(),
    };
    this.add(key, r);
    this.save();
    await this.reply(key, r, input.text, { renderHtml: true });
    return {
      status: r.status === "done" ? "sent" : "uncertain",
      retry_allowed: false,
    };
  }
  status() {
    return {
      running: !this.signal?.aborted,
      mode: this.provider?.submit ? "native" : "browser",
      selected: this.state.selected === "dot" ? "dot" : "gpt",
      pending: !!this._submitTask || !!this.webPending(),
      contextReady: !!this.context(),
      dotEnabled: !!this.provider?.dotEnabled,
      htmlReady: !!this.preview?.ready,
      queued: Object.values(this.state.records).filter(
        (r) => r.status === "queued",
      ).length,
      uncertain: Object.values(this.state.records).filter((r) =>
        ["uncertain", "delivery_uncertain"].includes(r.status),
      ).length,
    };
  }
}
