export class Problem extends Error {
  constructor(message, {retryable = false, code = 'problem', retryAfterMs = 0} = {}) {
    super(message); this.name = 'Problem'; this.retryable = retryable; this.code = code; this.retryAfterMs = retryAfterMs;
  }
}
export function guard(signal) { signal?.throwIfAborted(); }
export const isAbort = (e) => e?.name === 'AbortError';
export function cancelled() { return new DOMException('已取消', 'AbortError'); }
export function safeError(e) {
  if (isAbort(e)) return '已取消';
  if (e instanceof Problem) return e.message;
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return '文件夹写入权限不可用，请点击重新授权';
  if (e?.name === 'QuotaExceededError') return '磁盘空间不足或存储配额不足';
  if (e?.name === 'NotFoundError') return '所选文件夹已移动或删除，请重新选择';
  if (e?.name === 'NoModificationAllowedError') return '文件被占用或文件夹不可写';
  if (e instanceof TypeError) return '网络请求失败，请检查连接和扩展的网站访问权限';
  return '操作未完成，请检查网络、磁盘空间或文件夹权限';
}
export function officialURL(value, base) {
  try {
    const u = new URL(value, base);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash ||
      !(u.hostname === 'chaoxing.com' || u.hostname.endsWith('.chaoxing.com'))) return null;
    return u;
  } catch { return null; }
}
// Same cldisk host policy as CourseMaterial.fileUrl in ClassBell.
export function fileURL(value, base) {
  try {
    const u = new URL(value, base);
    if (u.protocol === 'http:' && !u.port) u.protocol = 'https:';
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash) return null;
    if (officialURL(u.href) || /^(?:d\d{1,2}|s\d{1,2}|cs)\.cldisk\.com$/i.test(u.hostname)) return u;
    return null;
  } catch { return null; }
}
export function courseFromURL(value, fields = {}, name = '') {
  const u = officialURL(value); if (!u) return null;
  const params = Object.fromEntries([...u.searchParams].map(([k,v]) => [k.toLowerCase(), v]));
  for (const [k,v] of Object.entries(fields)) if (!params[k.toLowerCase()]) params[k.toLowerCase()] = v;
  const courseId = params.courseid || params.course_id;
  const classId = params.clazzid || params.classid || params.class_id;
  const cpi = params.cpi;
  if (![courseId, classId, cpi].every(v => /^\d{1,24}$/.test(v || ''))) return null;
  const enc = /^[\w-]{0,256}$/.test(params.enc || '') ? params.enc || '' : '';
  const dataId=params.dataid;
  const startFolder=/^\d{1,24}$/.test(dataId || '') && !/^0+$/.test(dataId)?{dataId,enc}:null;
  return {courseId, classId, cpi, enc, startFolder, startName:startFolder?params.dataname || '当前资料目录':'', origin: u.origin, sourceURL: u.href,
    name: String(name || '课程资料').replace(/\s*[-|_]\s*(?:超星|学习通|课程门户).*$/, '').trim().slice(0,100)};
}
export function sanitizeName(value, fallback = '未命名') {
  let name = String(value || '').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/[. ]+$/g, '').trim();
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = '_' + name;
  if (name.length > 120) {
    const ext = /\.[a-z0-9]{1,12}$/i.exec(name)?.[0] || '';
    name = name.slice(0, 120 - ext.length).replace(/[\ud800-\udbff]$/, '') + ext;
  }
  return name.replace(/[. ]+$/g, '') || fallback;
}
export function numbered(name, n) {
  if (!n) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0,dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}
export function typedName(name, type) {
  name = sanitizeName(name);
  if (!/\.[a-z0-9]{1,12}$/i.test(name) && /^(pdf|docx?|pptx?|xlsx?|zip|rar|7z|txt|csv|mp[34]|png|jpe?g)$/i.test(type || '')) return name + '.' + type.toLowerCase();
  return name;
}
export function materialName(preferred, serverName, type) {
  const raw=!preferred || /^[a-f0-9]{32}$/i.test(preferred)?serverName || preferred:preferred;
  let name=typedName(raw,type);
  if(!/\.[a-z0-9]{1,12}$/i.test(name)){
    const ext=/\.[a-z0-9]{1,12}$/i.exec(serverName || '')?.[0];if(ext)name=sanitizeName(name+ext);
  }
  return name;
}
export function dispositionName(header) {
  const encoded=/filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header || '');
  if(encoded)try{return sanitizeName(decodeURIComponent(encoded[1].trim()));}catch{}
  const basic=/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(header || '');
  return basic?sanitizeName((basic[1] ?? basic[2]).trim()):'';
}
export const pdfName = name => name.replace(/\.[^.]+$/, '') + '.pdf';
export function allFiles(nodes) { return nodes.flatMap(n => n.kind === 'folder' ? allFiles(n.children || []) : [n]); }
export function parseFileSize(value) {
  if(typeof value==='number')return Number.isSafeInteger(value) && value>=0?{bytes:value,approximate:false}:null;
  const text=String(value ?? '').trim().replace(/,/g,'').replace(/\u00a0/g,' ');
  if(/^\d+$/.test(text))return parseFileSize(Number(text));
  const match=/^(\d+(?:\.\d+)?)\s*(bytes?|字节|[kmgt]i?b?|b)$/i.exec(text);
  if(!match)return null;
  const unit=match[2].toLowerCase(),power=({k:1,m:2,g:3,t:4})[unit[0]] || 0;
  const bytes=Math.round(Number(match[1])*1024**power);
  return Number.isSafeInteger(bytes) && bytes>=0?{bytes,approximate:power>0}:null;
}
export function selectionSize(nodes,selected) {
  const result={bytes:0,known:0,unknown:0,approximate:false};
  for(const file of allFiles(nodes)){
    if(selected && !selected.has(file.key))continue;
    if(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes>=0){result.bytes+=file.sizeBytes;result.known++;result.approximate ||= Boolean(file.sizeApproximate);}
    else result.unknown++;
  }
  return result;
}
export function formatSelectionSize(total) {
  if(!total.known && !total.unknown)return '总大小 0 MB';
  if(!total.known)return `总大小未知（${total.unknown} 项未提供大小）`;
  const mb=total.bytes/1024**2;
  const amount=mb>0 && mb<0.01?'< 0.01':mb.toLocaleString('zh-Hans',{minimumFractionDigits:2,maximumFractionDigits:2});
  return `${total.unknown?'已知大小':'总大小'} ${total.approximate?'约 ':''}${amount} MB${total.unknown?`，${total.unknown} 项大小未知`:''}`;
}
export function selectNode(node, selected, checked) {
  for (const f of allFiles([node])) checked ? selected.add(f.key) : selected.delete(f.key);
}
export function selectionState(node, selected) {
  const files = allFiles([node]); const n = files.filter(f => selected.has(f.key)).length;
  return {checked: n > 0 && n === files.length, mixed: n > 0 && n < files.length, count: files.length};
}
export function planTree(nodes, rootName) {
  const files = [];
  function walk(siblings, prefix) {
    const used = new Set();
    for (const node of siblings) {
      const raw = sanitizeName(node.kind === 'file' ? typedName(node.name, node.type) : node.name);
      let name = raw, n = 0;
      while (used.has(name.toLocaleLowerCase('en-US'))) name = numbered(raw, ++n);
      used.add(name.toLocaleLowerCase('en-US'));
      if (node.kind === 'folder') walk(node.children || [], [...prefix, name]);
      else files.push({...node, name, dirs: prefix, relativePath: [...prefix, name].join('/')});
    }
  }
  walk(nodes, [sanitizeName(rootName || '课程资料')]);
  return files;
}
export function parsePreview(id, data) {
  if (!/^[a-f0-9]{32}$/i.test(id) || data?.status !== 'success' ||
    String(data.objectid || data.objectId || '').toLowerCase() !== id.toLowerCase()) {
    throw new Problem('文件预览信息不匹配或尚未生成', {retryable:true});
  }
  const original = data.download && fileURL(data.download), pdf = data.pdf && fileURL(data.pdf);
  if (!original && !pdf) throw new Problem('预览中没有可用的原文件或 PDF 地址', {retryable:true});
  return {name: sanitizeName(data.filename || '课程资料'), original: original?.href, pdf:pdf?.href};
}
export async function delay(ms, signal) {
  guard(signal);
  await new Promise((resolve,reject) => {
    const abort = () => {clearTimeout(timer); reject(signal.reason || cancelled());};
    const timer = setTimeout(() => {signal?.removeEventListener('abort',abort); resolve();}, ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
// Parse string/number literals only. Never eval or call page functions.
export function parseToOpen(code) {
  const head = /^\s*(?:return\s+)?(?:window\.)?toOpen\s*\(/.exec(code || '');
  if (!head) return null;
  const args=[]; let i=head[0].length;
  while (i < code.length && args.length < 20) {
    while (/\s/.test(code[i] || '') && i<code.length) i++;
    const q=code[i]; let value='';
    if (q === "'" || q === '"') {
      i++; let closed=false;
      while(i<code.length) {
        let c=code[i++];
        if(c===q){closed=true;break;}
        if(c==='\\') {
          c=code[i++];
          if(c==='u' || c==='x') {
            const len=c==='u'?4:2, hex=code.slice(i,i+len);
            if(!new RegExp(`^[a-f0-9]{${len}}$`,'i').test(hex)) return null;
            value+=String.fromCharCode(parseInt(hex,16));i+=len;
          } else value+=({n:'\n',r:'\r',t:'\t'}[c] ?? c ?? '');
        } else value+=c;
      }
      if(!closed)return null;
    } else {
      const start=i;while(i<code.length && !/[,)]/.test(code[i]))i++;
      value=code.slice(start,i).trim();
      if(!/^(?:-?\d+|true|false|null|undefined)$/.test(value))return null;
    }
    args.push(value);
    while(i<code.length && /\s/.test(code[i]))i++;
    if(code[i]===','){i++;continue;} if(code[i]===')' || i===code.length)break;return null;
  }
  if(args.length<10 || !/^\d{1,24}$/.test(args[2]))return null;
  let name=args[0];try{name=decodeURIComponent(name.replace(/\+/g,' '));}catch{}
  const item={kind:args[1]==='afolder'?'folder':'file', name, type:args[1], dataId:args[2],enc:args[9]};
  if(item.kind==='file' && /^[a-f0-9]{32}$/i.test(args[4] || ''))item.objectId=args[4].toLowerCase();
  return item;
}
