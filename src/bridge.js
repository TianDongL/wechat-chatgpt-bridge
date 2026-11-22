import {createHash, randomUUID} from 'node:crypto';
import {parseCommand, conversationUrl, HELP, splitText} from './commands.js';
import {extractOwnerText} from './wechat.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function initialState() {
  return {version: 1, cursor: '', selected: 'https://chatgpt.com/', records: {}, blocked: null};
}
export class Bridge {
  constructor({store, wechat, provider, credentials, log = () => {}, since = Date.now(), signal}) {
    Object.assign(this, {store, wechat, provider, credentials, log, since, signal});
    this.state = store.read('state.json', initialState()); this.listed = [];
    if (this.state.version !== 1 || typeof this.state.cursor !== 'string' || !this.state.records ||
        typeof this.state.records !== 'object' || Array.isArray(this.state.records)) throw new Error('state_file_invalid');
    conversationUrl(this.state.selected, {allowHome: true});
    const binding = digest(`${credentials.botId}\0${credentials.ownerId}`);
    if (this.state.binding && this.state.binding !== binding) throw new Error('owner_changed');
    this.state.binding = binding;
    for (const [key, record] of Object.entries(this.state.records)) {
      // Crash between reservation and response: never blindly submit again.
      if (['submitting', 'accepted'].includes(record.status)) {
        record.status = 'uncertain'; this.state.blocked = key;
      }
      if (record.status === 'replying') record.status = 'delivery_uncertain';
    }
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
    if (command.name === 'where') return `当前 ChatGPT 网页：\n${this.state.selected}${this.state.blocked ? '\n有提交结果待确认。请先核对网页，再发 /ack；不会重发。' : ''}\n发送 /help 查看命令。`;
    if (command.name === 'ack') {
      if (!this.state.blocked) return '没有待确认的网页提交。';
      const previous = this.state.records[this.state.blocked];
      if (previous) { previous.status = 'acknowledged'; delete previous.text; delete previous.contextToken; }
      this.state.blocked = null; this.save();
      return '已解除本地待确认状态，没有重发旧消息。请等网页完成回答后再发下一条。';
    }
    if (this.state.blocked && ['switch', 'new'].includes(command.name))
      return '有提交结果待确认。请先查看当前网页，再发 /ack。';
    if (command.name === 'list') {
      this.listed = (await this.provider.list()).slice(0, 20);
      return this.listed.length ? this.listed.map((x, i) => `${i + 1}. ${x.title}\n${x.url}`).join('\n\n') + '\n\n发送 /cd 编号切换；发送 /help 查看命令。' : '网页侧栏暂无可见会话。可以 /new，或 /cd 完整会话链接。发送 /help 查看命令。';
    }
    let target;
    if (command.name === 'new') target = 'https://chatgpt.com/';
    else if (command.name === 'switch') {
      if (!command.argument) return HELP;
      const item = /^[1-9]\d*$/.test(command.argument) ? this.listed[Number(command.argument) - 1]?.url : command.argument;
      try { target = conversationUrl(item); } catch { return '会话无效。先发 /list，再用 /cd 编号切换；也可以使用完整 ChatGPT 会话链接。发送 /help 查看命令。'; }
    }
    if (target === this.state.selected && command.name !== 'new') return `已在该会话：\n${target}\n发送 /help 查看命令。`;
    await this.provider.select(target);
    this.state.selected = target; this.save();
    return target === 'https://chatgpt.com/' ? '已打开新对话。下一条文字将在这里发送。发送 /help 查看命令。' : `已切换：\n${target}\n发送 /help 查看命令。`;
  }
  async process(key, record) {
    const command = parseCommand(record.text);
    if (command) {
      // Commands can navigate. Reserve before executing so a crash never replays /new.
      record.status = 'command'; this.save();
      let text;
      try { text = await this.command(command); } catch { text = '网页暂不可用。请检查桥的浏览器窗口，登录并等页面加载完成后再试。'; }
      await this.reply(key, record, text); return;
    }
    if (this.state.blocked) {
      await this.reply(key, record, '上一条网页提交尚未确认，这条没有发送。请查看网页，核对后发 /ack，再发送新消息。'); return;
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
        this.state.blocked = key; record.status = 'uncertain'; this.save();
        await this.reply(key, record, '这条消息的网页提交或回答结果暂未确认，为避免重复没有重发。请查看当前网页，核对后发送 /ack 解除等待。');
        record.status = 'uncertain'; this.save();
      } else {
        await this.reply(key, record, '这条消息尚未提交。请检查桥的浏览器是否已登录、页面是否忙碌或输入框是否留有草稿，再重新发送。');
      }
      return;
    }
    await this.reply(key, record, result.text);
  }
}
