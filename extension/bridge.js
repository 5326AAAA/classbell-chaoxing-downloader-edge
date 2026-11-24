// Isolated content-script world. The page never receives extension messages,
// directory handles, or cookies. Requests use the page's own same-origin session.
(() => {
  if(globalThis.__classbellMaterialBridge)return;
  globalThis.__classbellMaterialBridge=true;
  chrome.runtime.onConnect.addListener(port=>{
    if(port.name!=='classbell-material-stream' || port.sender?.id!==chrome.runtime.id)return;
    const controller=new AbortController();let reader,opened=false,pulling=false;
    const send=m=>{try{port.postMessage(m);}catch{controller.abort();}};
    const encode=bytes=>{
      let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);
    };
    port.onDisconnect.addListener(()=>{controller.abort();reader?.cancel().catch(()=>{});});
    port.onMessage.addListener(async message=>{
      try{
        if(message.kind==='open' && !opened){
          opened=true;const u=new URL(message.url);
          const data=/^\/(?:mooc2-ans\/(?:mooc2-ans\/)?|mooc-ans\/)?coursedata(?:\/(?:stu-datalist|toPreview|downloadData))?\/?$/i.test(u.pathname);
          const status=/^\/(?:mooc-ans\/)?ananas\/status\/[a-f0-9]{32}$/i.test(u.pathname);
          if(u.origin!==location.origin || u.protocol!=='https:' || u.username || u.password || u.hash || !(data || status)){
            send({kind:'error',code:'source',message:'页面请求地址无效'});return;
          }
          const r=await fetch(u.href,{method:'GET',credentials:'include',cache:'no-store',redirect:'follow',signal:controller.signal,
            headers:message.metadata?{Accept:'application/json, text/html, */*','X-Requested-With':'XMLHttpRequest'}:{}});
          const headers={};for(const k of ['content-type','content-length','content-encoding','content-disposition','retry-after'])if(r.headers.has(k))headers[k]=r.headers.get(k);
          reader=r.body?.getReader();send({kind:'headers',status:r.status,statusText:r.statusText,headers,url:r.url});
        }else if(message.kind==='pull' && reader && !pulling){
          pulling=true;const {done,value}=await reader.read();pulling=false;
          send(done?{kind:'end'}:{kind:'chunk',data:encode(value)});
        }
      }catch{
        if(!controller.signal.aborted)send({kind:'error',code:'network',message:'课程页面请求失败，请确认页面仍已登录并保持打开'});
      }
    });
  });
})();
