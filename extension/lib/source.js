import {Problem,guard,fileURL,officialURL} from './core.js';

export class PageSource {
  constructor(ref){this.refs=Array.isArray(ref)?ref:[ref];this.ref=this.refs[0];}
  accepts(url){const u=officialURL(url);return this.refs.some(ref=>u?.origin===ref.origin) && /\/(?:coursedata(?:\/|$)|ananas\/status\/|mycourse\/(?:stu|studentcourse|studentstudy|studentstudyAjax)(?:\/|$)|knowledge\/cards(?:\/|$))/.test(u.pathname);}
  async open(url,signal,{metadata=false}={}) {
    guard(signal);const ref=this.refs.find(r=>r.origin===new URL(url).origin);if(!ref)throw new Problem('没有对应的课程页面通道',{code:'source'});const {tabId,frameId}=ref;
    try{await chrome.scripting.executeScript({target:{tabId,frameIds:[frameId]},files:['bridge.js']});}
    catch{throw new Problem('课程标签页已关闭、跳转或失去访问权限，请重新打开资料页并读取',{code:'source'});}
    guard(signal);
    return new Promise((resolve,reject)=>{
      let port,controller,headersReceived=false,settled=false,closed=false,redirectListener;
      const cleanup=()=>{
        clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(redirectListener)chrome.webRequest.onBeforeRedirect.removeListener(redirectListener);
      };
      const close=()=>{if(closed)return;closed=true;cleanup();try{port?.disconnect();}catch{}};
      const fail=e=>{if(controller)try{controller.error(e);}catch{}if(!settled){settled=true;reject(e);}close();};
      const abort=()=>fail(signal.reason);
      const timer=setTimeout(()=>fail(new Problem('课程页面响应超时',{retryable:true})),30000);
      signal?.addEventListener('abort',abort,{once:true});
      if(!metadata && /\/downloadData(?:\?|$)/i.test(url)){
        // Observe only the exact request in the chosen course frame. No request
        // headers are read. Signed CDN links stay in memory and are never logged.
        redirectListener=details=>{
          if(details.tabId!==tabId || details.frameId!==frameId || details.url!==url)return;
          const next=fileURL(details.redirectUrl);
          if(!next || officialURL(next.href))return;
          if(!settled){settled=true;resolve({redirect:next.href});}close();
        };
        chrome.webRequest.onBeforeRedirect.addListener(redirectListener,{urls:[ref.origin+'/*'],types:['xmlhttprequest']});
      }
      try{port=chrome.tabs.connect(tabId,{frameId,name:'classbell-material-stream'});}catch{fail(new Problem('课程请求通道未连接，请重新读取课程',{code:'source'}));return;}
      port.onDisconnect.addListener(()=>{
        // Read lastError to consume it without logging internal URLs or values.
        void chrome.runtime.lastError;
        if(!closed)fail(new Problem('课程标签页已刷新或关闭，请重新读取课程',{code:'source'}));
      });
      port.onMessage.addListener(m=>{
        if(closed)return;
        if(m.kind==='headers' && !headersReceived){
          headersReceived=true;clearTimeout(timer);
          if(m.status<200 || m.status>599){fail(new Problem('课程页面未返回可读取的响应',{retryable:true}));return;}
          const body=new ReadableStream({start(c){controller=c;},pull(){if(!closed)port.postMessage({kind:'pull'});},cancel(){close();}});
          const response=new Response([204,205,304].includes(m.status)?null:body,{status:m.status,statusText:m.statusText,headers:m.headers});
          Object.defineProperty(response,'url',{value:m.url});
          if(!settled){settled=true;resolve({response,dispose:close,abort:close});}
        }else if(m.kind==='chunk'){
          const decoded=atob(m.data),bytes=new Uint8Array(decoded.length);for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);
          try{controller.enqueue(bytes);}catch{close();}
        }else if(m.kind==='end'){
          try{controller.close();}catch{}close();
        }else if(m.kind==='error')fail(new Problem(m.code==='source'?'课程请求通道不可用，请重新读取课程':'课程页面请求失败，请确认页面仍已登录并保持打开',{code:m.code==='source'?'source':'network',retryable:m.code==='network'}));
      });
      port.postMessage({kind:'open',url,metadata});
    });
  }
}
