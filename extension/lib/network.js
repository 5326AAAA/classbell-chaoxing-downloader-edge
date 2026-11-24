import {Problem,officialURL,fileURL,guard,isAbort} from './core.js';

export async function configureReferer(origin) {
  const u=officialURL(origin + '/');
  if (!u) throw new Problem('请选择官方学习通课程页面');
  // Only requests initiated by THIS extension are changed; ordinary tabs are unaffected.
  const condition={initiatorDomains:[chrome.runtime.id],requestDomains:['chaoxing.com','cldisk.com'],resourceTypes:['xmlhttprequest']};
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[1001,1002],addRules:[
    {id:1001,priority:1,condition,action:{type:'modifyHeaders',requestHeaders:[{header:'Referer',operation:'set',value:u.origin+'/'}]}},
    {id:1002,priority:2,condition:{...condition,urlFilter:'|http://'},action:{type:'upgradeScheme'}}
  ]});
}
export class Network {
  constructor(fetcher=globalThis.fetch.bind(globalThis)) {this.fetcher=fetcher;}
  async open(url,signal,{metadata=false}={}) {
    guard(signal);
    if (!(metadata?officialURL(url):fileURL(url))) throw new Problem('下载地址不在支持的学习通文件域名内');
    if(this.source?.accepts(url)) {
      const conn=await this.source.open(url,signal,{metadata});
      if(conn.redirect)return this.open(conn.redirect,signal,{metadata:false});
      try{this.validate(conn.response,url,metadata);return conn;}catch(e){conn.abort();conn.dispose();throw e;}
    }
    const controller=new AbortController();
    const onAbort=()=>controller.abort(signal.reason);
    signal?.addEventListener('abort',onAbort,{once:true});
    // Header timeout; stream reads have their own idle timeout.
    const timer=setTimeout(()=>controller.abort(new DOMException('请求超时','TimeoutError')),30000);
    try {
      const r=await this.fetcher(url,{credentials:officialURL(url)?'include':'omit',redirect:'follow',cache:'no-store',signal:controller.signal,
        headers:metadata?{Accept:'application/json, text/html, */*','X-Requested-With':'XMLHttpRequest'}:{}});
      clearTimeout(timer);
      this.validate(r,url,metadata);
      return {response:r,dispose:()=>signal?.removeEventListener('abort',onAbort),abort:()=>controller.abort()};
    } catch(e) {
      controller.abort();
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      if(signal?.aborted)throw signal.reason;
      if(e?.name==='TimeoutError')throw new Problem('请求超时，将重新尝试',{retryable:true});
      if(e instanceof TypeError)throw new Problem('网络连接失败，请检查网络或扩展的网站访问权限',{retryable:true});
      throw e;
    }
  }
  validate(r,url,metadata) {
    if (!(metadata?officialURL(r.url || url):fileURL(r.url || url))) throw new Problem('服务器跳转到不支持的地址，请回到课程页检查登录');
    if (/passport\d*\.chaoxing\.com|\/(?:login|mlogin)(?:\?|$)/i.test(r.url || '') || r.status===401) throw new Problem('登录已失效，请在学习通网页重新登录后读取资料',{code:'login'});
    if (!r.ok) {
        const retry=r.headers.get('retry-after');
        const retryAfterMs=retry?Math.min(600000,Math.max(0,/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now()) || 0):0;
        throw new Problem(r.status===403?'服务器拒绝下载，请确认当前账号能在课程页访问该资料':r.status===429?'服务器限制请求频率，等待后重试':`服务器返回 HTTP ${r.status}`,{retryable:[408,425,429].includes(r.status)||r.status>=500,code:'http',retryAfterMs});
    }
  }
  async text(url,signal) {
    const conn=await this.open(url,signal,{metadata:true});
    const reader=conn.response.body?.getReader();
    if(!reader){conn.dispose();throw new Problem('服务器响应为空',{retryable:true});}
    const chunks=[];let size=0;
    try {
      while(true) {
        const {value,done}=await idleRead(reader,signal);
        if(done)break;size+=value.byteLength;
        if(size>4*1024*1024)throw new Problem('资料页面超过 4 MiB，请缩小到单个目录后重试');
        chunks.push(value);
      }
      const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
      const text=new TextDecoder().decode(bytes);
      if(/<input[^>]+type\s*=\s*["']?password|请先登录|登录已失效/i.test(text))throw new Problem('登录已失效，请回到学习通网页重新登录',{code:'login'});
      return {text,url:conn.response.url || url};
    } catch(e) {conn.abort();throw e;}
    finally {try{await reader.cancel();reader.releaseLock();}catch{}conn.dispose();}
  }
}
export async function idleRead(reader,signal,timeout=45000) {
  guard(signal);let timer,abort;
  try {
    return await Promise.race([reader.read(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Problem('文件传输长时间没有响应',{retryable:true})),timeout);
      abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});
    })]);
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
