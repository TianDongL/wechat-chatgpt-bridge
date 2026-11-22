import {Parser} from 'htmlparser2';

export const MAX_TEXT_BYTES = 256_000;
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const ROOTS = new Set('html head body div section article main aside header footer nav form table svg canvas details figure picture video audio button select textarea ul ol dl pre h1 h2 h3 h4 p blockquote style script img input'.split(' '));
const AUXILIARY = new Set(['style', 'script', 'head', 'link', 'meta']);
const REFERENCES = new Set(['cite', 'link', 'citation', 'reference', 'source', 'ref']);
const customTag = (name, raw) => !REFERENCES.has(name) && /^<[A-Z][A-Za-z0-9]*\b/.test(raw);

// Parser positions point into the original string; never serialize HTML back
// through a DOM, normalize whitespace, or ask a model to rewrite the reply.
function htmlRanges(text) {
  let root = null, stack = [];
  const ranges = [];
  const parser = new Parser({
    onopentag(name, attributes, implied) {
      if (implied) return;
      const start = parser.startIndex, end = parser.endIndex + 1;
      const raw = text.slice(start, end), custom = customTag(name, raw);
      if (!root && (ROOTS.has(name) || custom)) {
        root = {start, visual: !AUXILIARY.has(name) || custom}; stack = [];
      }
      if (!root) return;
      if (VOID.has(name) || /\/\s*>$/.test(raw)) {
        if (!stack.length) { ranges.push({...root, end}); root = null; }
      } else stack.push(name);
    },
    onclosetag(name, implied) {
      // Implicit/EOF closes are not evidence of a complete component.
      if (implied || !root) return;
      const index = stack.lastIndexOf(name);
      if (index < 0) return;
      stack.splice(index);
      if (!stack.length) { ranges.push({...root, end: parser.endIndex + 1}); root = null; }
    },
  }, {decodeEntities: false, recognizeSelfClosing: true});
  try { parser.end(text); } catch { return []; }
  const groups = [];
  for (const range of ranges) {
    const previous = groups.at(-1);
    if (previous && !text.slice(previous.end, range.start).trim()) {
      previous.end = range.end; previous.visual ||= range.visual;
    } else groups.push({...range});
  }
  return groups.filter(group => group.visual).map(({start, end}) => {
    const doctype = /<!doctype\s+html[^>]*>\s*$/i.exec(text.slice(0, start));
    if (doctype) start = doctype.index;
    return {start, end, source: text.slice(start, end)};
  });
}

export function findComponents(text) {
  if (typeof text !== 'string' || !text.includes('<') || Buffer.byteLength(text) > MAX_TEXT_BYTES) return [];
  const components = [], protectedRanges = [];
  const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  let opening;
  while ((opening = fence.exec(text))) {
    const marker = opening[1], info = opening[2].trim().toLowerCase();
    const close = new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}[ \\t]*(?=\\r?$)', 'gm');
    close.lastIndex = fence.lastIndex;
    const ending = close.exec(text);
    if (!ending) { protectedRanges.push([opening.index, text.length]); break; }
    const source = text.slice(fence.lastIndex, ending.index), end = close.lastIndex;
    protectedRanges.push([opening.index, end]);
    if (['html', 'htm', 'xhtml', 'svg', ''].includes(info) && htmlRanges(source).length)
      components.push({start: opening.index, end, source});
    fence.lastIndex = end;
  }
  for (const inline of text.matchAll(/(`+)([^`\n]*?)\1/g)) protectedRanges.push([inline.index, inline.index + inline[0].length]);
  // split('') keeps UTF-16 positions aligned with parser offsets, including emoji.
  const masked = text.split('');
  for (const [start, end] of protectedRanges) {
    for (let i = start; i < end; i++) if (!/[\r\n]/.test(masked[i])) masked[i] = ' ';
  }
  for (const range of htmlRanges(masked.join('')))
    components.push({...range, source: text.slice(range.start, range.end)});
  return components.length <= 64 ? components.sort((a, b) => a.start - b.start) : [];
}

export const escapeHtml = text => text.replace(/[&<>"'\r\n]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;', '\n': '&#10;'}[char]));
export const FRAME_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const OUTER_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const RESIZE_JS = "addEventListener('message',event=>{const d=event.data;if(!d||d.kind!=='component-height'||!Number.isFinite(d.height))return;for(const frame of document.querySelectorAll('iframe')){if(event.source===frame.contentWindow){frame.style.height=Math.min(12000,Math.max(180,Math.ceil(d.height)))+'px';break;}}});";
const FRAME_HELPER = String.raw`<script>(()=>{function ready(){
for(const item of document.querySelectorAll('asyncimage')){const src=item.getAttribute('src');const box=document.createElement('div');if(src&&/^https:\/\//i.test(src)){const image=document.createElement('img');image.src=src;image.style.maxWidth='100%';image.alt=item.getAttribute('alt')||item.getAttribute('query')||'';box.append(image);}else{box.style.cssText='border:1px dashed #b8c4d0;border-radius:8px;padding:14px;color:#526172';box.textContent='此图片组件需要 GPT 原网页支持。'+(item.getAttribute('query')?' 图片描述：'+item.getAttribute('query'):'');}item.replaceWith(box);}
let queued=false;function size(){if(queued||__VIEWPORT_SIZED__)return;queued=true;requestAnimationFrame(()=>{queued=false;const body=document.body;if(!body)return;const margin=Number.parseFloat(getComputedStyle(body).marginBottom)||0;const bottoms=[body.getBoundingClientRect().bottom];for(const child of body.children){const style=getComputedStyle(child);if(style.position!=='fixed'&&style.display!=='none')bottoms.push(child.getBoundingClientRect().bottom+(Number.parseFloat(style.marginBottom)||0));}parent.postMessage({kind:'component-height',height:Math.max(...bottoms)+margin},'*');});}new ResizeObserver(size).observe(document.body||document.documentElement);addEventListener('load',size);size();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();})();</script>`;

function presentationTags(source) {
  const result = {headEnd: null, htmlEnd: null, custom: []};
  const parser = new Parser({onopentag(name, attributes, implied) {
    if (implied) return;
    const start = parser.startIndex, end = parser.endIndex + 1, raw = source.slice(start, end);
    if (name === 'head' && result.headEnd === null) result.headEnd = end;
    if (name === 'html' && result.htmlEnd === null) result.htmlEnd = end;
    const custom = /^<([A-Z][A-Za-z0-9]*)\b/.exec(raw);
    if (custom && /\/\s*>$/.test(raw)) result.custom.push({start, end, text: raw.replace(/\/\s*>$/, '>') + `</${custom[1]}>`});
  }}, {decodeEntities: false, recognizeSelfClosing: true});
  parser.end(source); return result;
}

export function frameDocument(source) {
  const defaults = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light}body{margin:12px;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}img,svg,video{max-width:100%}button,input,select,textarea{font:inherit}</style>';
  let adapted = source;
  for (const {start, end, text} of presentationTags(source).custom.reverse()) adapted = adapted.slice(0, start) + text + adapted.slice(end);
  const tags = presentationTags(adapted);
  if (tags.headEnd !== null) adapted = adapted.slice(0, tags.headEnd) + defaults + adapted.slice(tags.headEnd);
  else if (tags.htmlEnd !== null) adapted = adapted.slice(0, tags.htmlEnd) + '<head>' + defaults + '</head>' + adapted.slice(tags.htmlEnd);
  else adapted = '<!doctype html><html><head>' + defaults + '</head><body>' + adapted + '</body></html>';
  // Append rather than searching for </body>, which may be a string in JS.
  const viewportSized = /(?:height|min-height|max-height)\s*:[^;}]*\d(?:dvh|svh|lvh|vh)\b/i.test(source);
  return adapted + FRAME_HELPER.replace('__VIEWPORT_SIZED__', String(viewportSized));
}

export function pageDocument(text, components, token, sourceUrl) {
  const chunks = ['<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPT 组件预览</title><style>body{margin:0;background:#f4f6f8;color:#192832;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:960px;margin:auto;padding:20px 12px}header{padding:4px 8px 20px}h1{font-size:22px;margin:0 0 6px}header p{font-size:14px;color:#65717c;margin:0}a{color:#135eae;overflow-wrap:anywhere}.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:18px 8px}section{background:white;border:1px solid #dce3e9;border-radius:12px;margin:18px 0;overflow:hidden}section h2{font-size:14px;color:#61717e;padding:10px 16px;margin:0;border-bottom:1px solid #edf0f3}iframe{display:block;border:0;width:100%;height:560px}details{margin:20px 8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,Consolas,monospace;background:white;padding:14px;border-radius:8px}summary{cursor:pointer}.notice{padding:10px 16px;font-size:14px;color:#65717c}</style><script src="/viewer.js" defer></script></head><body><main><header><h1>GPT 组件预览</h1><p>保留原回复内容及组件代码。此链接随本机桥运行。</p>'];
  if (sourceUrl) chunks.push(`<a href="${escapeHtml(sourceUrl)}" rel="noreferrer noopener">在 GPT 打开原会话</a>`);
  chunks.push('</header>');
  let cursor = 0;
  components.forEach((component, index) => {
    if (component.start > cursor) chunks.push(`<div class="text">${escapeHtml(text.slice(cursor, component.start))}</div>`);
    chunks.push(`<section id="component-${index + 1}"><h2>组件 ${index + 1}</h2>`);
    if (/<[A-Z][a-z]*[A-Z][A-Za-z0-9]*\b/.test(component.source)) chunks.push('<p class="notice">此段含 GPT 专用组件，依赖原网页的部分可能无法完整显示；可查看原会话或下方原始代码。</p>');
    chunks.push(`<iframe title="GPT 组件 ${index + 1}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/p/${token}/c/${index}"></iframe></section>`);
    cursor = component.end;
  });
  if (cursor < text.length) chunks.push(`<div class="text">${escapeHtml(text.slice(cursor))}</div>`);
  chunks.push(`<details><summary>查看原始回复（完整原文）</summary><a href="/p/${token}/source.txt" download="gpt-original.txt">保存原始回复</a><pre>${escapeHtml(text)}</pre></details></main></body></html>`);
  return chunks.join('');
}
