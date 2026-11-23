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
  IDLE_RETURN_MS = 600_000,
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
    this.listed = this.state.listed ?? [];
    this.generation = 0;
    this._sendChain = Promise.resolve();
    this.nextWebPoll = 0;
    this.idleWebInterval = 30000;
    this.nextDotPoll = 0;
    this.webReadFloor = 0;
    this.pushSettle = false;
    this.historyReads = 0;
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
    if (this.state.titleSync !== 1) {
      this.syncListTitle();
      this.state.titleSync = 1;
    }
    if (this.provider.push && this.state.watch) {
      const watch = this.state.watch;
      watch.branchAnchor ??= watch.cursor;
      watch.baselineAnchor ??= !this.state.records[digest(
        `output:${watch.url}:${watch.branchAnchor}`
      )];
    }
    this.save();
  }
  syncListTitle() {
    const item = this.listed.find((row) => row.url === this.state.selected);
    if (item?.title?.trim()) this.state.selectedTitle = item.title;
  }
  syncPush() {
    if (!this.provider.push) return;
    this.provider.push.select(this.state.selected, this.generation);
    this.nextWebPoll = this.now() + (this.webPending() || this.state.watch?.deferred ? 20000 : 180000);
    this.webReadFloor = 0;
    this.pushSettle = false;
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
  webWait() {
    const seconds = Math.ceil(
      ((this.state.webRetryAt || 0) - this.now()) / 1000,
    );
    return seconds > 0 ? `网页请求受到限流，至少 ${seconds} 秒后再连接。` : "";
  }
  noteWebLimit(result) {
    if (result?.http_status !== 429) return;
    const seconds = Number.isFinite(result.retry_after)
      ? result.retry_after
      : 60;
    const until = this.now() + 1000 * Math.max(60, seconds);
    if (until > (this.state.webRetryAt || 0)) {
      this.state.webRetryAt = until;
      this.save();
    }
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
    const url = this.state.selected;
    if (url && url !== "dot") {
      this.provider.useTarget?.(url, this.state.selectedTitle);
      const watch = this.state.watch;
      if (
        !this.provider.push && !this.webWait() &&
        (watch?.url !== url ||
          (!recovering && !watch?.fromList && !watch?.deferred))
      ) {
        try {
          await this.resetWatch(url);
        } catch (error) {
          this.noteWebLimit(error);
          if (!this.webWait()) throw error;
        }
      }
      if (this.webWait()) {
        const previous =
          watch?.url === url ? watch : { url, openedAt: this.now() };
        this.state.watch = { ...previous, deferred: true };
        this.save();
      }
      if (this.provider.push && this.state.watch?.url !== url) {
        this.state.watch = { url, openedAt: this.now(), deferred: true, baselineAnchor: true };
        this.save();
      }
    }
    if (this.provider.dotEnabled) {
      const b = await this.provider.dotCall("baseline");
      if (b.status !== "ready") throw new Error("dot_not_ready");
      this.dotWatch = { cursor: b.cursor, openedAt: this.now() };
    }
    this.syncPush();
  }
  async resetWatch(url, selected) {
    if (!this.provider.baseline) return;
    const b =
      selected?.cursor !== undefined
        ? { status: "ready", ...selected }
        : await this.provider.baseline(url);
    if (b.status !== "ready")
      throw Object.assign(new Error("provider_not_ready"), b);
    this.state.watch = {
      url, cursor: b.cursor, openedAt: this.now(),
      ...(this.provider.push ? { branchAnchor: b.branchAnchor ?? b.branch_anchor ?? b.cursor, baselineAnchor: true } : {}),
    };
    this.state.selectedTitle = b.title || "";
    this.nextWebPoll = 0;
    this.save();
  }
  async connectListed(watch) {
    if (!watch?.deferred) return true;
    if (this.webWait() || this.now() < this.nextWebPoll) return false;
    if (!this._connectingWatch) {
      this._connectingWatch = this.readListed(watch).finally(() => {
        this._connectingWatch = null;
      });
    }
    await this._connectingWatch;
    return this.state.watch === watch && !watch.deferred;
  }
  async readListed(watch) {
    let baseline;
    try {
      if (this.provider.useTarget) {
        baseline = await this.provider.baseline(watch.url, watch.openedAt);
      } else {
        const page = await this.provider.select(watch.url);
        baseline =
          page?.cursor !== undefined || !this.provider.baseline
            ? {
                status: page?.ready === false ? "unavailable" : "ready",
                cursor: "",
                ...page,
              }
            : await this.provider.baseline(watch.url, watch.openedAt);
      }
    } catch (error) {
      baseline = error;
    }
    this.noteWebLimit(baseline);
    if (this.state.watch !== watch || this.signal?.aborted) return;
    if (baseline?.status !== "ready" || typeof baseline.cursor !== "string") {
      this.nextWebPoll = Math.max(
        this.now() + 12000,
        this.state.webRetryAt || 0,
      );
      return;
    }
    watch.cursor ??= baseline.cursor;
    delete watch.deferred;
    this.state.selectedTitle = baseline.title || this.state.selectedTitle;
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
      if (this.state.idleReturn) {
        if (parseCommand(m.text))
          this.state.idleReturn.due = this.now() + IDLE_RETURN_MS;
        else delete this.state.idleReturn;
      }
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
    this.returnIdleToDot();
    this.save(); // Commit inbox and cursor before effects.
  }
  returnIdleToDot() {
    const timer = this.state.idleReturn;
    if (
      !timer ||
      this.now() < timer.due ||
      !this.provider.dotEnabled ||
      timer.url !== this.state.selected ||
      this._submitTask ||
      this.webPending()
    )
      return;
    if (
      Object.values(this.state.records).some(
        (r) =>
          r.status === "queued" ||
          (r.sourceUrl === timer.url &&
            ["outgoing", "replying"].includes(r.status)),
      )
    )
      return;
    const key = digest("idle-dot:" + timer.reply);
    if (!this.state.records[key])
      this.add(key, {
        kind: "idle_return",
        status: "outgoing",
        at: this.now(),
        text: "网页回复已送达微信。之后 10 分钟没有收到你的新消息，已自动切回原 Dot 会话。",
      });
    this.generation++;
    this.state.selected = "dot";
    this.state.selectedTitle = "";
    delete this.state.watch;
    delete this.state.idleReturn;
    this.syncPush();
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
  async deliver(
    key,
    r,
    text,
    { renderHtml = false, sourceUrl, webReply = false } = {},
  ) {
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
    if (
      r.status === "done" &&
      webReply &&
      this.provider.dotEnabled &&
      sourceUrl === this.state.selected &&
      (r.webOpenedAt === undefined ||
        r.webOpenedAt === this.state.watch?.openedAt) &&
      !Object.values(this.state.records).some(
        (item) => item.status === "queued" && !parseCommand(item.text),
      )
    ) {
      this.state.idleReturn = {
        url: sourceUrl,
        reply: key,
        due: this.now() + IDLE_RETURN_MS,
      };
    }
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
      const waiting = this.state.watch?.deferred
        ? "\n" + (this.webWait() || "正在等待连接所选网页。")
        : "";
      return `${where()}${waiting}${n ? `\n有 ${n} 条历史结果未确认，旧消息不会重发。` : ""}\n发送 /help 查看命令。`;
    }
    if (command.name === "list") {
      if (!this.webWait()) {
        try {
          const items = (await this.provider.list()).slice(0, 12).map((x) => ({
            url: conversationUrl(x.url),
            title: x.title.slice(0, 160),
          }));
          this.listed = items;
          this.state.listed = items;
          this.syncListTitle();
          this.state.titleSync = 1;
          this.save();
        } catch (error) {
          this.noteWebLimit(error);
          if (!this.webWait()) throw error;
        }
      }
      const wait = this.webWait();
      return this.listed.length
        ? (wait ? wait + " 以下沿用上次列表：\n" : "") +
            this.listed
              .map(
                (x, i) =>
                  `${i + 1}. ${x.title.replace(/[\r\n]/g, " ").slice(0, 160)}\n${x.url}`,
              )
              .join("\n\n") +
            "\n\n发送 /cd 编号切换；发送 /help 查看命令。"
        : wait
          ? wait + " 尚无上次列表，请稍后发送 /list。"
          : "暂无可用会话。请用 /cd 完整会话链接选择已有会话。发送 /help 查看命令。";
    }
    if (!command.argument)
      return helpText({
        dot: !!this.provider.dotEnabled,
        native: !!this.provider.submit,
      });
    let target, listed;
    if (command.argument === "dot") {
      if (!this.provider.dotEnabled)
        return "尚未配置 Dot；需要 Windows 本机接入模式并在 setup-native 绑定自己的 Dot。当前入口保持不变。发送 /help 查看命令。";
      target = "dot";
    } else if (command.argument === "gpt") {
      target = this.state.defaultSelected;
      if (!target)
        return "尚未配置默认 GPT 会话，请先运行 setup。发送 /help 查看命令。";
    } else {
      const byNumber = /^[1-9]\d*$/.test(command.argument);
      listed = byNumber ? this.listed[Number(command.argument) - 1] : null;
      const item = byNumber ? listed?.url : command.argument;
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
    if (listed) {
      this.generation++;
      delete this.state.idleReturn;
      this.state.selected = target;
      this.state.defaultSelected ??= target;
      this.state.selectedTitle = listed.title;
      this.state.watch = {
        url: target,
        openedAt: this.now(),
        deferred: true,
        fromList: true,
        ...(this.provider.push ? { baselineAnchor: true } : {}),
      };
      this.provider.useTarget?.(target, listed.title);
      this.nextWebPoll = 0;
      this.idleWebInterval = 30000;
      this.save();
      this.syncPush();
      return `已切换。\n${where()}\n${this.webWait() || "正在等待连接所选网页。"}\n发送 /help 查看命令。`;
    }
    if (target !== "dot" && this.webWait())
      return this.webWait() + " 当前入口保持不变。";
    if (target !== "dot" && this._connectingWatch)
      return "正在连接网页，请稍后再切换。当前入口保持不变。";
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
    this.idleWebInterval = 30000;
    delete this.state.idleReturn;
    this.state.selected = target;
    this.state.defaultSelected ??= target === "dot" ? null : target;
    if (baseline) {
      this.state.watch = {
        url: target,
        cursor: baseline.cursor,
        openedAt: this.now(),
        ...(this.provider.push ? { branchAnchor: baseline.branchAnchor ?? baseline.branch_anchor ?? baseline.cursor, baselineAnchor: true } : {}),
      };
      this.state.selectedTitle = baseline.title || "";
      this.nextWebPoll = 0;
    } else {
      delete this.state.watch;
      this.state.selectedTitle = selected?.title || "";
    }
    this.save();
    this.syncPush();
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
      } catch (error) {
        this.noteWebLimit(error);
        text = this.webWait()
          ? this.webWait() + " 当前入口保持不变。"
          : "当前入口暂不可用，请检查登录与本机程序；发送 /where 核对入口。";
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
    if (
      this.state.selected !== "dot" &&
      (this.webWait() || (!this.provider.push && this.state.watch?.deferred))
    ) {
      r.target ??= this.state.selected;
      this.save();
      if (this.webWait() || !(await this.connectListed(this.state.watch))) {
        r.retryAt = Math.max(
          this.state.webRetryAt || 0,
          this.nextWebPoll,
          this.now() + 1000,
        );
        this.save();
        await this.notice(
          key,
          r,
          (this.webWait() || "正在连接所选网页会话。") +
            " 这条消息将按顺序等待发送到所选会话，有效期为 10 分钟。",
          "waiting",
        );
        return;
      }
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
      if (r.target !== "dot") this.noteWebLimit(result);
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
        this.nextWebPoll = this.provider.push ? Math.min(this.nextWebPoll, this.now() + 90000) : 0;
        return;
      }
      if (result.status === "confirming" && result.receipt) {
        r.status = "confirming";
        r.receipt = result.receipt;
        r.confirmUntil = this.now() + 90000;
        delete r.text;
        this.save();
        this.nextWebPoll = this.provider.push ? Math.min(this.nextWebPoll, this.now() + 8000) : 0;
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
      webReply: true,
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
      ...(sourceUrl ? { webOpenedAt: this.state.watch?.openedAt } : {}),
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
        if (r.kind !== "idle_return" && this.now() - r.at >= INPUT_TTL) {
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
          webReply: r.kind === "outbox" && !!r.sourceUrl,
        });
      }
    } finally {
      this._flushing = false;
    }
  }
  async pollWeb() {
    const push = this.provider.push;
    if (
      this._pollingWeb || this.signal?.aborted || !this.provider.poll ||
      this.state.selected === "dot" || !this.state.watch
    ) return;
    if (push) {
      const event = push.take();
      if (event.retryAfter)
        this.noteWebLimit({ http_status: 429, retry_after: event.retryAfter });
      if (event.dirty) {
        this.nextWebPoll = Math.min(this.nextWebPoll, this.now() + 600);
        this.pushSettle ||= event.dirty === "update";
      }
      if (!this.webWait()) push.tick();
      if (push.status().state !== "ready" && this.nextWebPoll === Infinity)
        this.nextWebPoll = this.now() + 180000;
    }
    if (
      this.webWait() || this.now() < this.nextWebPoll ||
      (push && this.now() < this.webReadFloor) ||
      (this._submitTask && (push || !this.provider.submit))
    ) return;
    this._pollingWeb = true;
    const generation = this.generation, watch = this.state.watch;
    const lastRequest = push && Object.values(this.state.records).findLast(
      (r) => r.native && r.target === watch.url && r.at >= watch.openedAt,
    );
    const pending = this.webPending() || (lastRequest?.status === "uncertain" &&
      !lastRequest.ambiguous && (lastRequest.receipt || lastRequest.messageId) ? lastRequest : null);
    const guarded = !!(push && pending);
    const originalCursor = watch.cursor;
    const settle = this.pushSettle;
    this.pushSettle = false;
    try {
      if (watch.deferred && !push) {
        await this.connectListed(watch);
        return;
      }
      let result;
      try {
        this.historyReads++;
        result = await this.provider.poll({
          ...watch,
          receipt: pending?.receipt,
          pendingUserId: pending?.messageId,
        });
      } catch (error) {
        result = error || { status: "unavailable" };
      }
      this.noteWebLimit(result);
      if (
        generation !== this.generation || this.state.watch !== watch ||
        this.state.selected !== watch.url || this.signal?.aborted ||
        originalCursor !== watch.cursor
      ) return;
      if (result.status !== "page") {
        this.webFailures = (this.webFailures || 0) + 1;
        this.nextWebPoll = this.now() + Math.max(
          Math.min(180000, 12000 * 2 ** Math.min(this.webFailures - 1, 4)),
          (result.retry_after || 0) * 1000,
        );
        return;
      }
      this.webFailures = 0;
      if (push) {
        if (watch.cursor == null && typeof result.start_cursor === "string") {
          watch.cursor = result.start_cursor;
          if (!guarded) watch.branchAnchor = result.start_anchor || watch.cursor || null;
        }
        delete watch.deferred;
      }
      if (
        pending?.receipt && ["confirming", "uncertain"].includes(pending.status) &&
        result.confirmation?.status === "accepted"
      ) {
        pending.status = "accepted";
        pending.messageId = result.confirmation.message_id;
        delete pending.receipt;
      }
      if (pending?.status === "confirming" && this.now() >= pending.confirmUntil) {
        pending.status = "uncertain";
        this.save();
        const key = Object.entries(this.state.records).find(([, r]) => r === pending)[0];
        await this.notice(key, pending,
          "这条消息的网页提交结果暂未确认，为避免重复没有重发。请查看当前网页会话。",
          "uncertain");
      }
      if (guarded && (result.ambiguous_turn || result.confirmation?.status === "ambiguous")) {
        pending.status = "uncertain";
        pending.ambiguous = true;
        watch.branchAnchor = "ambiguous:" + (pending.messageId || pending.requestId);
        watch.baselineAnchor = false;
        const key = Object.entries(this.state.records).find(([, r]) => r === pending)[0];
        this.save();
        await this.notice(key, pending,
          "这条微信提问在网页里有多个版本，无法确定对应回复。请在网页查看。",
          "ambiguous-turn");
      }
      const completed = pending?.messageId &&
        result.completed?.user_id === pending.messageId && result.completed?.finished_turn
        ? result.completed : null;
      const entries = [...(guarded ? [] : result.entries), ...(completed ? [completed] : [])];
      let observedFinal = false;
      for (const entry of entries) {
        await this.queueOutput(watch.url, entry, watch.url);
        if (entry.finished_turn) {
          observedFinal = true;
          for (const [recordKey, record] of Object.entries(this.state.records)) {
            if (
              record.target === watch.url && record.messageId &&
              entry.user_id === record.messageId &&
              ["accepted", "uncertain"].includes(record.status)
            ) {
              record.status = "done";
              if (!entry.text) await this.notice(recordKey, record,
                "当前网页这一轮已结束，但没有可回传的文字，请查看网页。",
                "empty-final");
              delete record.contextToken;
              delete record.receipt;
              delete record.text;
            }
          }
          if (push) {
            watch.branchAnchor = watch.cursor = entry.id;
            watch.baselineAnchor = false;
          }
        }
        if (entry !== completed) watch.cursor = entry.id;
        this.save();
      }
      this.save();
      if (push) {
        let delay = Infinity;
        if (entries.length >= 10) delay = 3000;
        else if (settle && !observedFinal) delay = 5000;
        else if (pending?.status === "confirming") delay = Math.max(1000, Math.min(20000, pending.confirmUntil - this.now()));
        else if (this.webPending()) delay = 90000;
        else if (push.status().state !== "ready") delay = 180000;
        this.nextWebPoll = this.now() + delay;
      } else {
        this.nextWebPoll = this.now() + (result.entries.length >= 10
          ? 250 : (result.poll_after_ms ?? (this.webPending() ? 12000 : this.idleWebInterval)));
        this.idleWebInterval = result.entries.length || pending || this.webPending()
          ? 30000 : Math.min(120000, this.idleWebInterval * 2);
      }
    } finally {
      if (push && generation === this.generation) this.webReadFloor = this.now() + 3000;
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
      autoDotInSeconds: this.state.idleReturn
        ? Math.max(
            0,
            Math.ceil((this.state.idleReturn.due - this.now()) / 1000),
          )
        : null,
      contextReady: !!this.context(),
      dotEnabled: !!this.provider?.dotEnabled,
      ...(this.provider.push ? {
        webPush: this.provider.push.status(),
        webHistoryReads: this.historyReads,
        webRetryInSeconds: Math.max(0, Math.ceil(((this.state.webRetryAt || 0) - this.now()) / 1000)),
      } : {}),
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
