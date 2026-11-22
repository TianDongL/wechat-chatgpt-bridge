import {createHash, randomUUID} from 'node:crypto';
import {parseCommand, conversationUrl, HELP, splitText} from './commands.js';
import {extractOwnerText} from './wechat.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function initialState() {
  return {version: 1, cursor: '', selected: null, records: {}};
}
export class Bridge {
  constructor({store, wechat, provider, credentials, log = () => {}, since = Date.now(), signal}) {
    Object.assign(this, {store, wechat, provider, credentials, log, since, signal});
    this.state = store.read('state.json', initialState()); this.listed = [];
    if (this.state.version !== 1 || typeof this.state.cursor !== 'string' || !this.state.records ||
        typeof this.state.records !== 'object' || Array.isArray(this.state.records)) throw new Error('state_file_invalid');
    // Older candidates could point at the new-chat page. Require an existing
    // conversation before forwarding, without discarding the delivery ledger.
    if (this.state.selected === 'https://chatgpt.com/') this.state.selected = null;
    if (this.state.selected !== null) conversationUrl(this.state.selected);
    const binding = digest(`${credentials.botId}\0${credentials.ownerId}`);
    if (this.state.binding && this.state.binding !== binding) throw new Error('owner_changed');
    this.state.binding = binding;
    for (const record of Object.values(this.state.records)) {
      // Crash between reservation and response: never blindly submit again.
      if (['submitting', 'accepted'].includes(record.status)) {
        record.status = 'uncertain';
      }
      if (record.status === 'replying') record.status = 'delivery_uncertain';
    }
    // Uncertainty belongs to the original message. Keep its reservation but
    // remove the old manual-ack gate; every new send still checks page readiness.
    delete this.state.blocked;
    this.save();
  }
  save() { this.store.write('state.json', this.state); }
  async ingest(batch) {
    if (!batch || !Array.isArray(batch.msgs) || typeof batch.get_updates_buf !== 'string') throw new Error('invalid_update_batch');
    for (const raw of batch.msgs) {
      const msg = extractOwnerText(raw, this.credentials);
      if (!msg || msg.createdAt < this.since) continue;
      const key = digest(`${this.credentials.botId}\0${msg.id}`);
      if (Object.hasOwn(this.state.records, key)) continue;
      this.state.records[key] = {status: 'queued', text: msg.text, contextToken: msg.contextToken, at: Date.now()};
    }
    this.state.cursor = batch.get_updates_buf;
    // Cursor and inbox commit together. No side effect occurs before this succeeds.
    this.save();
  }
  async drain() {
    for (const [key, record] of Object.entries(this.state.records)) {
      if (this.signal?.aborted) break;
      if (record.status === 'queued') await this.process(key, record);
    }
  }
  async reply(key, record, text) {
    this.store.saveReply(key, text);
    if (this.signal?.aborted) { record.status = 'delivery_uncertain'; this.save(); return; }
    record.parts = []; record.status = 'replying'; this.save();
    for (const part of splitText(text)) {
      if (this.signal?.aborted) { record.status = 'delivery_uncertain'; break; }
      const attempt = {clientId: `wcg-${randomUUID()}`, status: 'reserved'};
      record.parts.push(attempt); this.save();
      try {
        await this.wechat.sendText({text: part, contextToken: record.contextToken, clientId: attempt.clientId}, {signal: this.signal});
        attempt.status = 'sent'; this.save();
      } catch {
        attempt.status = 'uncertain'; record.status = 'delivery_uncertain';
        this.log('微信发送结果未确认，未重发。完整回复已保存到本机 replies 目录。');
        break;
      }
    }
    if (record.status === 'replying') record.status = 'done';
    delete record.text; delete record.contextToken;
    this.save();
  }
  async command(command) {
    if (command.name === 'help') return HELP;
    if (command.name === 'where') {
      const uncertain = Object.values(this.state.records).filter(record => record.status === 'uncertain').length;
      return `当前 ChatGPT 网页：\n${this.state.selected || '尚未选择，请发送 /cd 会话链接。'}${uncertain ? `\n有 ${uncertain} 条历史提交或回答结果未确认，请查看网页；旧消息不会重发。` : ''}\n发送 /help 查看命令。`;
    }
    if (command.name === 'list') {
      this.listed = (await this.provider.list()).slice(0, 12);
      return this.listed.length ? this.listed.map((x, i) => `${i + 1}. ${x.title}\n${x.url}`).join('\n\n') + '\n\n发送 /cd 编号切换；发送 /help 查看命令。' : '网页侧栏暂无可见会话。请用 /cd 完整会话链接选择已有会话。发送 /help 查看命令。';
    }
    let target;
    if (command.name === 'switch') {
      if (!command.argument) return HELP;
      const item = /^[1-9]\d*$/.test(command.argument) ? this.listed[Number(command.argument) - 1]?.url : command.argument;
      try { target = conversationUrl(item); } catch { return '会话无效。先发 /list，再用 /cd 编号切换；也可以使用完整 ChatGPT 会话链接。发送 /help 查看命令。'; }
    }
    if (target === this.state.selected) return `已在该会话：\n${target}\n发送 /help 查看命令。`;
    await this.provider.select(target);
    this.state.selected = target; this.save();
    return `已切换：\n${target}\n发送 /help 查看命令。`;
  }
  async process(key, record) {
    const command = parseCommand(record.text);
    if (command) {
      // Commands can navigate. Reserve before executing so a crash never replays them.
      record.status = 'command'; this.save();
      let text;
      try { text = await this.command(command); } catch { text = '网页暂不可用。请检查桥的浏览器窗口，登录并等页面加载完成后再试。'; }
      await this.reply(key, record, text); return;
    }
    if (!this.state.selected) {
      await this.reply(key, record, '尚未选择已有网页会话，这条没有发送。请先发送 /cd 会话链接。发送 /help 查看命令。'); return;
    }
    record.status = 'submitting'; this.save();
    let result;
    try {
      result = await this.provider.send(record.text, {expectedUrl: this.state.selected, onSubmitted: async submitted => {
        record.status = 'accepted'; record.messageId = submitted.messageId;
        this.state.selected = conversationUrl(submitted.url); this.save();
      }});
      if (typeof result.text !== 'string' || !result.text.trim()) throw Object.assign(new Error('empty_reply'), {uncertain: true});
      this.state.selected = conversationUrl(result.url); this.save();
    } catch (error) {
      if (error.uncertain !== false) {
        record.status = 'uncertain'; this.save();
        await this.reply(key, record, '这条消息的网页提交或回答结果暂未确认，为避免重复没有重发。请查看当前网页会话；后续消息须等网页空闲后再发送。');
        record.status = 'uncertain'; this.save();
      } else {
        await this.reply(key, record, '这条消息尚未提交。请检查桥的浏览器是否已登录、页面是否忙碌或输入框是否留有草稿，再重新发送。');
      }
      return;
    }
    await this.reply(key, record, result.text);
  }
}
