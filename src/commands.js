const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function parseCommand(text) {
  if (typeof text !== 'string' || /[\r\n]/.test(text)) return null;
  const match = /^[ \t]*[\\/](help|where|list|cd|switch)(?:[ \t]+([^\s]+))?[ \t]*$/.exec(text);
  if (!match) return null;
  const name = match[1] === 'cd' ? 'switch' : match[1];
  if (name !== 'switch' && match[2]) return null;
  return {name, argument: match[2]};
}
export function conversationUrl(value) {
  if (typeof value !== 'string') throw new Error('invalid_conversation_url');
  if (new RegExp(`^${UUID}$`, 'i').test(value)) return `https://chatgpt.com/c/${value.toLowerCase()}`;
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid_conversation_url'); }
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash)
    throw new Error('invalid_conversation_url');
  if (!new RegExp(`^/c/${UUID}/?$`, 'i').test(url.pathname)) throw new Error('invalid_conversation_url');
  return `https://chatgpt.com${url.pathname.replace(/\/$/, '').toLowerCase()}`;
}
export const HELP = `微信 × ChatGPT 网页桥
/help 查看命令
/where 查看当前会话
/list 列出网页侧栏可见会话（最多 12 项）
/cd 1 切换到最近列表的第 1 项
/cd 网页会话链接或 UUID

旧命令 /switch 仍可使用。
命令须单独一行；正文里提到命令不会触发。普通文字送到当前 ChatGPT 会话。电脑、终端和桥的浏览器须保持运行。`;
export function splitText(text, maxBytes = 3800) {
  if (typeof text !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error('invalid_text');
  const chunks = []; let part = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) { chunks.push(part); part = ''; bytes = 0; }
    part += char; bytes += size;
  }
  if (part) chunks.push(part);
  return chunks;
}
