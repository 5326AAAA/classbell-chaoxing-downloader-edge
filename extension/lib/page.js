import {officialURL, courseFromURL, parseToOpen, parseFileSize} from './core.js';

function itemSize(element) {
  const row=element.closest('.dataBody_td, tr, [data-file-row]') || element;
  const cell=row.querySelector('.dataBody_size_stu, .dataBody_size, .file-size, [data-file-size]');
  for(const node of [element,row,cell].filter(Boolean))for(const name of ['data-size-bytes','data-file-size','data-filesize','filesize']){
    const parsed=parseFileSize(node.getAttribute(name));if(parsed)return parsed;
  }
  return parseFileSize(cell?.getAttribute('title')) || parseFileSize(cell?.textContent);
}

export function parsePage(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('input[type=password]') || /(?:passport2\.chaoxing\.com\/login|请先登录|登录已失效)/i.test(doc.body.textContent)) {
    return {login:true, items:[], pages:[], links:[], fields:{}, objectIds:[]};
  }
  const items=[], seen=new Set(), fields={};
  for (const el of doc.querySelectorAll('input[id], input[name]')) {
    const key=(el.name || el.id).toLowerCase();
    if (/^(courseid|clazzid|classid|cpi|enc)$/.test(key)) fields[key]=el.value.slice(0,256);
  }
  const add = (item,element) => {
    if (!item) return;
    if(item.kind==='file'){
      const size=itemSize(element);item.sizeBytes=size?.bytes ?? null;item.sizeApproximate=size?.approximate ?? false;
    }
    const key=item.kind + ':' + (item.dataId || item.objectId);
    if (!seen.has(key)) {seen.add(key);items.push(item);}
  };
  for (const el of doc.querySelectorAll('[onclick]')) add(parseToOpen(el.getAttribute('onclick')),el);
  for (const el of doc.querySelectorAll('[objectid], [data-objectid], [data-object-id]')) {
    const objectId=el.getAttribute('objectid') || el.getAttribute('data-objectid') || el.getAttribute('data-object-id');
    if (!/^[a-f0-9]{32}$/i.test(objectId || '') || el.closest('[onclick*="toOpen"]')) continue;
    const row=el.closest('.dataBody_td, tr, [data-file-row]');
    if(row && [...row.querySelectorAll('[onclick]')].some(node=>parseToOpen(node.getAttribute('onclick'))))continue;
    const dataId=el.getAttribute('dataid') || el.getAttribute('data-id') || '';
    const name=el.getAttribute('dataname') || el.getAttribute('data-name') || el.getAttribute('title') || el.querySelector('[title]')?.getAttribute('title') || el.textContent.trim().slice(0,160) || '课程资料';
    add({kind:'file',name,objectId:objectId.toLowerCase(),dataId:/^\d{1,24}$/.test(dataId)?dataId:'', type:el.getAttribute('filetype') || 'object'},el);
  }
  const specialEntries=[];
  for(const row of doc.querySelectorAll('.dataBody_td')){
    if(row.querySelector('[objectid],[data-objectid],[data-object-id]') || row.hasAttribute('objectid'))continue;
    if([...row.querySelectorAll('[onclick]')].some(e=>parseToOpen(e.getAttribute('onclick'))))continue;
    const title=row.querySelector('.rename_title,dt');
    if(title?.textContent.trim())specialEntries.push(title.textContent.trim().slice(0,160));
  }
  const links=[], pages=[], objectIds=new Set();
  let unsupportedPagination=false;
  for (const el of doc.querySelectorAll('a[href],iframe[src],frame[src]')) {
    const raw=el.getAttribute('href') || el.getAttribute('src'), url=officialURL(raw,base);
    if (!url) continue;
    if (/\/coursedata(?:\/|$)/.test(url.pathname)) {
      const isPage=[...url.searchParams.keys()].some(k => /^(page|pageno|pagenum|pageindex)$/i.test(k));
      (isPage ? pages : links).push(url.href);
    }
    for(const [k,v] of url.searchParams) if(/^objectid$/i.test(k) && /^[a-f0-9]{32}$/i.test(v))objectIds.add(v.toLowerCase());
  }
  for (const match of html.matchAll(/(?:["']?objectid["']?\s*[:=]\s*["']|\/ananas\/status\/)([a-f0-9]{32})/gi)) objectIds.add(match[1].toLowerCase());
  for(const el of doc.querySelectorAll('a,button')) {
    if(!/下一页|下页|next/i.test(el.textContent.trim()) || el.matches('[disabled],.disabled') || el.getAttribute('aria-disabled')==='true')continue;
    const u=officialURL(el.getAttribute('href') || '',base);
    if(!u || !pages.includes(u.href))unsupportedPagination=true;
  }
  const empty=/暂无(?:资料|数据|内容|文件)|没有(?:资料|文件)|文件夹为空|暂无相关/.test(doc.body.textContent);
  return {login:false,items,fields,empty,recognized:items.length>0 || empty || specialEntries.length>0, pages:[...new Set(pages)],
    links:[...new Set(links)],objectIds:[...objectIds],unsupportedPagination,specialEntries};
}

// Passed to chrome.scripting.executeScript. Keep this function self-contained.
export function inspectPage() {
  if (location.protocol !== 'https:' || !(location.hostname==='chaoxing.com' || location.hostname.endsWith('.chaoxing.com'))) return null;
  const fields={};
  for(const el of document.querySelectorAll('input[name],input[id]')) {
    const k=(el.name || el.id).toLowerCase();
    if(/^(courseid|clazzid|classid|cpi|enc)$/.test(k)) fields[k]=el.value.slice(0,256);
  }
  const links=[];
  for(const el of document.querySelectorAll('a[href],iframe[src],frame[src]')) {
    try {
      const u=new URL(el.getAttribute('href') || el.getAttribute('src'),location.href);
      if(u.protocol==='https:' && (u.hostname==='chaoxing.com' || u.hostname.endsWith('.chaoxing.com')) &&
        (/coursedata|mycourse\/stu|knowledge\/cards|stucoursemiddle/.test(u.pathname))) links.push(u.href);
    } catch{}
  }
  const chapterRoots=[...document.querySelectorAll('#coursetree, .chapter_unit')];
  const chapterHTML=chapterRoots.map(e=>e.outerHTML).join('\n').slice(0,4*1024*1024);
  return {url:location.href,title:document.title,fields,links:[...new Set(links)].slice(0,100),chapterHTML};
}
export function contextsFromSnapshots(snapshots,scope='materials') {
  const found=[];const keys=new Set();
  // Prefer the actual data frame so its signed parameters are retained.
  const score=s=>scope==='chapters'?Number(Boolean(s.chapterHTML))*2+Number(/studentstudy/.test(s.url)):Number(/coursedata/.test(s.url));
  for(const s of snapshots.filter(Boolean).sort((a,b)=>score(b)-score(a))) {
    for(const value of [s.url,...s.links]) {
      const c=courseFromURL(value,s.fields,s.title);
      if(!c)continue;
      const key=[c.courseId,c.classId,c.cpi].join(':');
      if(keys.has(key))continue;keys.add(key);
      c.materialLinks=[...new Set(snapshots.filter(Boolean).flatMap(t=>[t.url,...t.links]))].filter(u=>{
        const v=courseFromURL(u,s.fields);return v && v.courseId===c.courseId && v.classId===c.classId && /coursedata/.test(new URL(u).pathname);
      });
      const session=snapshots.find(t=>t && t.tabId && new URL(t.url).origin===c.origin);
      if(session)c.sessionRef={tabId:session.tabId,frameId:session.frameId || 0,origin:c.origin};
      const related=snapshots.filter(t=>{
        if(!t)return false;const v=courseFromURL(t.url,t.fields);return v && v.courseId===c.courseId && v.classId===c.classId;
      });
      c.sessionRefs=[...new Map(related.filter(t=>t.tabId).map(t=>[new URL(t.url).origin,{tabId:t.tabId,frameId:t.frameId || 0,origin:new URL(t.url).origin}])).values()];
      c.chapterHTML=related.find(t=>t.chapterHTML)?.chapterHTML || '';
      c.chapterLinks=[...new Set(related.flatMap(t=>[t.url,...t.links]))].filter(u=>/\/mycourse\/(?:stu|studentcourse|studentstudy)(?:\?|$)/.test(u));
      c.cardPages=[...new Set(related.flatMap(t=>[t.url,...t.links]))].filter(u=>/\/knowledge\/cards(?:\?|$)/.test(u));
      found.push(c);
    }
  }
  return found;
}
