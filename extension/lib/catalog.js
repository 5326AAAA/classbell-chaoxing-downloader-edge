import {Problem,guard,delay,officialURL,parsePreview,typedName,materialName,pdfName,isAbort} from './core.js';
import {parsePage} from './page.js';

export function listURL(base,c,folder) {
  folder ||= c.startFolder;
  const u=officialURL(base);if(!u)throw new Problem('资料入口地址不受支持');
  for(const k of [...u.searchParams.keys()])if(/^(courseid|clazzid|classid|cpi|ut|dataid|folderid|enc)$/i.test(k))u.searchParams.delete(k);
  u.searchParams.set('courseid',c.courseId);u.searchParams.set('clazzid',c.classId);
  u.searchParams.set('cpi',c.cpi);u.searchParams.set('ut','s');
  if(folder?.dataId){u.searchParams.set('dataId',folder.dataId);if(folder.enc)u.searchParams.set('enc',folder.enc);}
  else if(c.enc)u.searchParams.set('enc',c.enc);
  return u.href;
}
export function downloadURLs(c,item,action='downloadData') {
  const origins=[c.origin,'https://mooc1.chaoxing.com'];
  const paths=c.origin.includes('mooc2-ans')?['/mooc2-ans/coursedata/','/coursedata/','/mooc-ans/coursedata/']:['/coursedata/','/mooc-ans/coursedata/'];
  const out=[];
  for(const origin of origins)for(const path of paths) {
    const u=new URL(path+action,origin);
    for(const [k,v] of Object.entries({dataId:item.dataId,classId:c.classId,courseId:c.courseId,cpi:c.cpi,ut:'s'}))u.searchParams.set(k,v);
    if(item.enc)u.searchParams.set('enc',item.enc);
    out.push(u.href);
  }
  return [...new Set(out)];
}
export class Catalog {
  constructor(network,course,{onProgress=()=>{},interval=300,maxDepth=24,maxNodes=20000}={}) {
    Object.assign(this,{network,course,onProgress,interval,maxDepth,maxNodes});this.endpoint=null;this.count=0;this.warnings=[];
  }
  async page(url,signal) {
    await delay(this.interval,signal);
    const r=await this.network.text(url,signal);const parsed=parsePage(r.text,r.url);
    if(parsed.login)throw new Problem('登录已失效，请回到学习通重新登录',{code:'login'});
    return {...parsed,url:r.url};
  }
  async folder(folder,signal) {
    const c=this.course;
    const raw=this.endpoint?[this.endpoint]:[
      ...(c.materialLinks || []).filter(u=>/stu-datalist/.test(u)),
      c.origin+'/mooc2-ans/coursedata/stu-datalist',
      'https://mooc2-ans.chaoxing.com/mooc2-ans/coursedata/stu-datalist',
      ...(c.materialLinks || []),c.origin+'/coursedata'
    ];
    const queue=[...new Set(raw.map(u=>listURL(u,c,folder)))];const tried=new Set();let last;
    while(queue.length && tried.size<10) {
      const url=queue.shift();if(tried.has(url))continue;tried.add(url);
      try {
        const p=await this.page(url,signal);
        if(p.recognized) {
          for(const name of p.specialEntries)this.warnings.push('特殊入口尚需在网页单独查看：'+name);
          const endpoint=new URL(p.url);
          for(const key of [...endpoint.searchParams.keys()])if(/^(page|pageno|pagenum|pageindex)$/i.test(key))endpoint.searchParams.delete(key);
          this.endpoint=endpoint.href;
          const items=[...p.items];const pageSeen=new Set([p.url]);let next=[...p.pages];
          if(p.unsupportedPagination)this.warnings.push('发现无法解析的翻页按钮，当前目录可能还有资料，请在网页翻页后再次读取。');
          while(next.length) {
            guard(signal);const target=next.shift(),u=officialURL(target);
            if(pageSeen.has(target))continue;
            if(pageSeen.size>=200)throw new Problem('目录分页超过 200 页，请分目录读取');
            // A pagination link may only stay on this list, course and folder.
            if(!u || u.origin!==new URL(p.url).origin || u.pathname!==new URL(p.url).pathname)continue;
            const candidate=listURL(u.href,c,folder);if(pageSeen.has(candidate))continue;
            pageSeen.add(candidate);
            const q=await this.page(candidate,signal);
            if(!q.recognized)throw new Problem('后续分页无法识别，当前目录读取不完整');
            for(const name of q.specialEntries)this.warnings.push('特殊入口尚需在网页单独查看：'+name);
            items.push(...q.items);next.push(...q.pages);
            if(q.unsupportedPagination)this.warnings.push('部分分页按钮未识别，请在网页翻页后核对。');
          }
          const unique=new Map();for(const item of items)unique.set(item.kind+':'+(item.dataId || item.objectId),item);
          return [...unique.values()];
        }
        for(const link of p.links) {
          if(/stu-datalist/.test(link))queue.push(listURL(link,{...c,...(p.fields.enc?{enc:p.fields.enc}:{})},folder));
        }
      } catch(e) {
        if(isAbort(e) || e.code==='login' || e.code==='source')throw e;last=e;
      }
    }
    throw last || new Problem('未识别资料列表。请先在课程中打开“资料”，再点击扩展读取；也可能是该课程使用了不同页面模板。');
  }
  async scan(signal) {
    this.count=0;this.warnings=[];
    const walk=async(folder,prefix,ancestors,depth)=>{
      guard(signal);
      if(depth>this.maxDepth)throw new Problem(`目录超过 ${this.maxDepth} 层，请在网页打开更深目录后单独读取`);
      this.onProgress({folders:prefix.length,path:prefix.map(n=>n.name).join('/') || '根目录',count:this.count});
      const children=await this.folder(folder,signal),out=[];
      for(const child of children) {
        guard(signal);if(++this.count>this.maxNodes)throw new Problem(`资料超过 ${this.maxNodes} 项，请分目录读取`);
        const id=child.kind+':'+(child.dataId || child.objectId);
        const node={...child,key:[...prefix.map(n=>n.keyPart),id].join('/'),keyPart:id};out.push(node);
        if(child.kind==='folder') {
          if(ancestors.has(id)){node.children=[];node.scanError='检测到循环目录';this.warnings.push('检测到循环目录：'+child.name);continue;}
          try {node.children=await walk(child,[...prefix,node],new Set([...ancestors,id]),depth+1);}
          catch(e){if(isAbort(e) || e.code==='login' || e.code==='source')throw e;node.children=[];node.scanError=e instanceof Problem?e.message:'目录读取失败';this.warnings.push(child.name+'：'+node.scanError);}
        }
      }
      return out;
    };
    const nodes=await walk(null,[],new Set(),0);
    return {nodes,warnings:[...new Set(this.warnings)]};
  }
  async candidates(item,signal,mode='auto') {
    let objectId=item.objectId;
    if(!objectId && item.dataId) {
      // Preview exposes the same ananas object identifier used by ClassBell.
      for(const u of downloadURLs(this.course,item,'toPreview').slice(0,3)) {
        try {const p=await this.page(u,signal);if(p.objectIds.length===1){objectId=p.objectIds[0];break;}}
        catch(e){if(isAbort(e) || e.code==='login' || e.code==='source')throw e;}
      }
    }
    if(objectId) {
      let last;
      for(const origin of [...new Set([this.course.origin,'https://mooc2-ans.chaoxing.com','https://mooc1.chaoxing.com'])]) {
        try {
          const u=origin+'/ananas/status/'+objectId+'?flag=normal&ro=0';
          const r=await this.network.text(u,signal);let data;
          try{data=JSON.parse(r.text);}catch{throw new Problem('文件预览返回了网页，可能需要重新打开预览',{retryable:true});}
          const p=parsePreview(objectId,data), name=materialName(item.name,p.name,item.type);
          const variants=[];
          if(mode!=='pdf' && p.original)variants.push({url:p.original,name,pdf:false});
          if(mode!=='original' && p.pdf)variants.push({url:p.pdf,name:pdfName(name),pdf:true});
          if(!variants.length)throw new Problem(mode==='pdf'?'该资料没有可用 PDF':'该资料没有原文件');
          return variants;
        } catch(e){if(isAbort(e)||e.code==='login'||e.code==='source')throw e;last=e;}
      }
      if(mode==='pdf' || !item.dataId)throw last;
    }
    if(mode==='pdf')throw new Problem('无法解析该资料的 PDF，请选择原文件优先');
    if(!item.dataId)throw new Problem('资料没有可解析的文件标识');
    return downloadURLs(this.course,item).map(url=>({url,name:typedName(item.name,item.type),pdf:false}));
  }
}
