import {Problem,guard,delay,officialURL,parseFileSize,isAbort} from './core.js';
import {Catalog} from './catalog.js';

const numeric=value=>/^\d{1,24}$/.test(value || '')?value:'';
const clean=value=>String(value || '').replace(/\s+/g,' ').trim().slice(0,180);
const blocked=text=>/章节未开放|未到开放时间|无权访问|没有权限|访问受限|解锁后|禁止访问/.test(text);
function documentOf(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  for(const node of doc.querySelectorAll('script,style,template'))node.remove();
  if(doc.querySelector('input[type=password]') || /请先登录|登录已失效/.test(doc.body.textContent))throw new Problem('登录已失效，请回学习通重新登录',{code:'login'});
  return doc;
}

// Both the course overview and the study sidebar use explicit chapter numbers.
// Extract identifiers as data only; never evaluate page event handlers or scripts.
export function parseChapters(html){
  const doc=documentOf(html),rows=[...doc.querySelectorAll('.chapter_item, .posCatalog_select')],nodes=[],byNumber=new Map(),seen=new Set();
  for(const row of rows){
    const label=row.querySelector('.clicktitle, .posCatalog_name, .posCatalog_title');if(!label)continue;
    const serial=clean(row.querySelector('.catalog_sbar, .posCatalog_sbar, .catalog_num')?.textContent);
    const number=/^\d+(?:\.\d+)*$/.test(serial)?serial:'';
    const titleLabel=label.cloneNode(true);for(const tag of titleLabel.querySelectorAll('.catalog_sbar,.posCatalog_sbar'))tag.remove();
    const title=clean(label.getAttribute('title') || row.getAttribute('title') || titleLabel.textContent);
    const name=number && !new RegExp('^'+number.replaceAll('.','\\.')+'(?:\\s|$)').test(title)?number+' '+title:title;
    const chapterId=numeric(row.id.replace(/^cur/,'')) || numeric(/(?:toOld|getTeacherAjax)\(\s*'\d+'\s*,\s*'(\d+)'/.exec(row.getAttribute('onclick') || '')?.[1]);
    const identity=chapterId || 'number:'+number+':'+name;
    if(!name || seen.has(identity))continue;seen.add(identity);
    const node={kind:'folder',name,number,chapterId,key:'chapter:'+identity,children:[]};
    let parentNumber=number;
    while(parentNumber.includes('.')){parentNumber=parentNumber.slice(0,parentNumber.lastIndexOf('.'));if(byNumber.has(parentNumber))break;}
    const parent=parentNumber!==number?byNumber.get(parentNumber):null;
    (parent?parent.children:nodes).push(node);if(number)byNumber.set(number,node);
  }
  return {nodes,recognized:rows.length>0,blocked:blocked(doc.body.textContent)};
}

export function parseStudy(html,base){
  const doc=documentOf(html),pages=[];
  for(const el of doc.querySelectorAll('iframe[src],a[href]')){
    const u=officialURL(el.getAttribute('src') || el.getAttribute('href'),base);
    if(u && /^\/(?:mooc-ans\/)?knowledge\/cards\/?$/.test(u.pathname))pages.push(u.href);
  }
  const tabs=[...doc.querySelectorAll('#prev_tab li[cardid], #prev_tab li[id^=dct]')];
  const count=tabs.length || Number(doc.querySelector('#cardcount')?.getAttribute('value')) || 0;
  if(count>100)throw new Problem('一节课件超过 100 页，请在网页分节查看');
  if(pages.length && count){const first=new URL(pages[0]);for(let num=0;num<count;num++){const u=new URL(first);u.searchParams.set('num',num);pages.push(u.href);}}
  const links=[];
  for(const el of doc.querySelectorAll('iframe[src],a[href]')){
    const u=officialURL(el.getAttribute('src') || el.getAttribute('href'),base);
    if(u && /\/(?:mycourse\/(?:stu|studentcourse|studentstudy)|knowledge\/cards)(?:\?|$)/.test(u.pathname))links.push(u.href);
  }
  return {pages:[...new Set(pages)],count,blocked:!pages.length && blocked(doc.body.textContent),links:[...new Set(links)]};
}

export function parseCards(html,base){
  const doc=documentOf(html),items=[],seen=new Set(),unsupported=[];let skipped=0,invalid=0;
  for(const frame of doc.querySelectorAll('iframe[data]')){
    const raw=frame.getAttribute('data');let data;
    try{data=JSON.parse(raw);}catch{invalid++;continue;}
    const rawSrc=frame.getAttribute('src'),src=rawSrc?officialURL(rawSrc,base):null;
    const type=String(data.type || /\.([a-z0-9]+)$/i.exec(data.name || data.title || '')?.[1] || '').replace(/^\./,'').toLowerCase();
    const module=frame.getAttribute('module') || '';
    // In the HTML response src is often absent; the site's JS assigns it later.
    // The serialized document type/class is available before that initialization.
    const documentType=/^(?:pdf|pptx?|docx?|xlsx?|txt|csv|rtf|epub)$/.test(type);
    const documentModule=/^(?:pdf|ppt|doc|document|download|file)$/i.test(module) || /(?:^|\s)insertdoc(?:-online)?(?:-|\s|$)/i.test(frame.className);
    const documentURL=src && /\/ananas\/modules\/(?:pdf|ppt|doc|document|download|file)\//i.test(src.pathname);
    const media=/^(?:video|audio|work|quiz)$/i.test(module) || /insert(?:video|audio|work)/i.test(frame.className) || src && /\/ananas\/modules\/(?:video|audio|work)\//i.test(src.pathname);
    // Only ordinary document/file cards. Do not load players, quizzes or task reporting.
    if(media){skipped++;continue;}
    if(rawSrc && !src && !/^about:blank$/i.test(rawSrc) || !(documentURL || documentModule || documentType)){
      if(data.objectid || data.objectId)unsupported.push(clean(type || module || '未知附件'));continue;
    }
    const objectId=String(data.objectid || data.objectId || '').toLowerCase();
    if(!/^[a-f0-9]{32}$/.test(objectId)){invalid++;continue;}
    if(seen.has(objectId))continue;seen.add(objectId);
    const size=parseFileSize(data.size) || parseFileSize(data.hsize);
    items.push({kind:'file',name:clean(data.title || data.name) || '章节课件',objectId,type,
      sizeBytes:size?.bytes ?? null,sizeApproximate:size?.approximate ?? false});
  }
  return {items,skipped,unsupported,invalid,blocked:!doc.querySelector('iframe[data]') && blocked(doc.body.textContent),recognized:Boolean(doc.querySelector('iframe[data],.ans-cc,.ans-job,#reader,.ans-non-exercise'))};
}

export class ChapterCatalog extends Catalog {
  async text(url,signal){await delay(this.interval,signal);return this.network.text(url,signal);}
  async outline(signal){
    const c=this.course;
    if(c.chapterHTML){const p=parseChapters(c.chapterHTML);if(p.nodes.length)return p.nodes;}
    const queue=[...(c.chapterLinks || []),c.sourceURL],seen=new Set();let last;
    while(queue.length && seen.size<6){
      guard(signal);const url=queue.shift(),u=officialURL(url);if(!u || seen.has(url))continue;seen.add(url);
      if(!/\/(?:mycourse\/(?:stu|studentcourse|studentstudy))\/?$/.test(u.pathname))continue;
      try{
        const r=await this.text(url,signal),parsed=parseChapters(r.text);
        if(parsed.nodes.length)return parsed.nodes;
        if(parsed.blocked)throw new Problem('课程章节未开放或当前账号无权访问');
        queue.push(...parseStudy(r.text,r.url).links);
      }catch(e){if(isAbort(e)||e.code==='login'||e.code==='source')throw e;last=e;}
    }
    throw last || new Problem('未识别章节目录。请在学习通打开“章节”，或进入一节能预览 PPT 的页面，再读取章节课件');
  }
  async chapter(node,signal){
    const c=this.course;
    const source=officialURL(c.sourceURL);
    // The study document tells us every card page, including empty parent sections.
    const study=new URL('/mooc-ans/mycourse/studentstudyAjax','https://mooc1.chaoxing.com');
    for(const [k,v] of Object.entries({chapterId:node.chapterId,courseId:c.courseId,clazzid:c.classId,cpi:c.cpi,verificationcode:'',mooc2:'1',editorPreview:'0',cardIndex:'0'}))study.searchParams.set(k,v);
    const current=source && /\/studentstudy$/.test(source.pathname) && source.searchParams.get('chapterId')===node.chapterId;
    const r=await this.text(current?source.href:study.href,signal),p=parseStudy(r.text,r.url);
    if(p.blocked)throw new Problem('该章节尚未开放或当前账号不能访问');
    if(!p.pages.length){
      if(/暂无内容|暂无课件|章节内容为空/.test(r.text))return [];
      // A valid study response must expose its card list. Never silently claim an incomplete scan.
      throw new Problem('未找到课件卡片页，请在网页确认此章节可打开');
    }
    const files=new Map();
    for(const url of p.pages){
      guard(signal);const u=officialURL(url);if(!u)continue;
      const params=Object.fromEntries([...u.searchParams].map(([k,v])=>[k.toLowerCase(),v]));
      if(params.courseid!==c.courseId || params.clazzid!==c.classId || params.knowledgeid!==node.chapterId)throw new Problem('章节课件参数不匹配，已停止此节读取');
      const q=await this.text(url,signal),cards=parseCards(q.text,q.url);
      if(cards.blocked)throw new Problem('该课件尚未开放或当前账号不能访问');
      if(!cards.recognized && !/暂无内容|暂无课件|章节内容为空/.test(q.text))throw new Problem('课件页面未识别，请在网页核对这一节');
      if(cards.invalid)this.warnings.push(node.name+'：有课件卡片未能解析，请在网页核对');
      if(cards.unsupported.length)this.warnings.push(node.name+'：有未识别的附件卡片（'+[...new Set(cards.unsupported)].join('、')+'），请在网页核对');
      if(cards.skipped)this.skipped+=cards.skipped;
      for(const file of cards.items)files.set(file.objectId,file);
    }
    return [...files.values()];
  }
  async scan(signal){
    this.count=0;this.skipped=0;this.warnings=[];const nodes=await this.outline(signal);let chapters=0;
    const walk=async(list,depth=0)=>{
      if(depth>this.maxDepth)throw new Problem('章节目录层数过多，请分章读取');
      for(const node of list){
        guard(signal);const nested=[...node.children];
        if(node.chapterId){
          if(++chapters>2000)throw new Problem('课程超过 2000 节，请分课程读取');
          this.onProgress({path:node.name,count:this.count});
          try{
            const files=await this.chapter(node,signal);
            for(const file of files){if(++this.count>this.maxNodes)throw new Problem('章节文件过多，请分课程读取');node.children.push({...file,key:node.key+'/file:'+file.objectId});}
          }catch(e){if(isAbort(e)||e.code==='login'||e.code==='source')throw e;node.scanError=e instanceof Problem?e.message:'章节读取失败';this.warnings.push(node.name+'：'+node.scanError);}
        }
        await walk(nested,depth+1);
      }
    };
    await walk(nodes);
    return {nodes,warnings:[...new Set(this.warnings)],skippedCards:this.skipped};
  }
}
