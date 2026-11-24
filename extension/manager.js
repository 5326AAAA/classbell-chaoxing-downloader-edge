import {Problem,allFiles,planTree,selectNode,selectionState,selectionSize,formatSelectionSize,courseFromURL,sanitizeName,safeError,isAbort} from './lib/core.js';
import {inspectPage,contextsFromSnapshots} from './lib/page.js';
import {Network,configureReferer} from './lib/network.js';
import {Catalog} from './lib/catalog.js';
import {FolderWriter} from './lib/filesystem.js';
import {DownloadQueue} from './lib/engine.js';
import {getSetting,setSetting} from './lib/storage.js';
import {PageSource} from './lib/source.js';

const $=id=>document.getElementById(id);
const state={nodes:[],selected:new Set(),collapsedFolders:new Set(),folder:null,course:null,catalog:null,queue:null,busy:'',scanController:null,history:new Map(),taskElements:new Map(),lastRender:0};
const labels={pending:'等待',resolving:'解析地址',downloading:'下载中',retrying:'等待重试',saved:'已保存',skipped:'已跳过',failed:'失败',cancelled:'已取消'};
const terminal=new Set(['saved','skipped','failed','cancelled']);
const network=new Network();
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
function busy(value){state.busy=value;updateControls();}
function updateControls(){
  const active=Boolean(state.busy);
  for(const id of ['read','readUrl','clearUrl','source','refreshTabs','rootName','mode','conflict','concurrency','pickFolder','grantFolder','clearSelection','selectAll','courseUrl'])$(id).disabled=active;
  $('clearUrl').disabled=active || !$('courseUrl').value;
  $('collapseAll').disabled=$('expandAll').disabled=state.busy==='scan' || !state.nodes.some(n=>n.kind==='folder');
  $('cancel').disabled=!active;
  $('start').disabled=active || !state.selected.size || !state.folder;
  $('retry').disabled=active || !state.folder || ![...state.history.values()].some(t=>['failed','cancelled'].includes(t.status));
  $('exportReport').disabled=state.history.size===0;
  for(const box of $('tree').querySelectorAll('input'))box.disabled=active;
  const files=allFiles(state.nodes),n=files.filter(f=>state.selected.has(f.key)).length;
  $('selectAll').checked=n>0 && n===files.length;$('selectAll').indeterminate=n>0 && n<files.length;
  $('selectAll').disabled=active || !files.length;$('selectedCount').textContent=`已选 ${n} 项`;$('fileCount').textContent=`${files.length} 项`;
  $('selectedSize').textContent=formatSelectionSize(selectionSize(state.nodes,state.selected));
  $('destination').textContent=state.folder?`保存到 ${state.folder.name} / ${sanitizeName($('rootName').value || '课程资料')}`:'请选择保存文件夹';
}
function el(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function renderTree(){
  const root=$('tree'),query=$('search').value.trim().toLocaleLowerCase();root.replaceChildren();
  const matches=node=>node.name.toLocaleLowerCase().includes(query) || node.kind==='folder' && (node.children || []).some(matches);
  const append=(nodes,parent,inherited=false)=>{
    for(const node of nodes){
      if(query && !inherited && !matches(node))continue;
      const box=el('input');box.type='checkbox';box.dataset.key=node.key;box.setAttribute('aria-label',node.name);
      const chosen=selectionState(node,state.selected);box.checked=chosen.checked;box.indeterminate=chosen.mixed;box.disabled=Boolean(state.busy) || !chosen.count;
      box.addEventListener('change',()=>{selectNode(node,state.selected,box.checked);renderTree();updateControls();});
      if(node.kind==='folder'){
        const details=el('details','folder');details.dataset.key=node.key;details.open=!state.collapsedFolders.has(node.key);
        details.addEventListener('toggle',()=>{if(details.isConnected)details.open?state.collapsedFolders.delete(node.key):state.collapsedFolders.add(node.key);});
        const summary=el('summary'),label=el('label');label.append(box,el('span','folder-name',node.name),el('small','',`${chosen.count} 项`));summary.append(label);
        box.addEventListener('click',e=>e.stopPropagation());label.addEventListener('click',e=>e.stopPropagation());
        details.append(summary);if(node.scanError)details.append(el('span','scan-error',node.scanError));
        append(node.children || [],details,inherited || node.name.toLocaleLowerCase().includes(query));parent.append(details);
      }else{
        const row=el('label','file');row.append(box,el('span','file-icon','▤'),el('span','',node.name));parent.append(row);
      }
    }
  };
  append(state.nodes,root);
  if(!root.children.length)root.append(el('div','empty',query?'没有匹配资料':state.course?'此目录没有可下载文件':'先读取课程资料'));
}
function setAllFoldersCollapsed(collapsed){
  const walk=nodes=>{for(const n of nodes)if(n.kind==='folder'){collapsed?state.collapsedFolders.add(n.key):state.collapsedFolders.delete(n.key);walk(n.children || []);}};
  walk(state.nodes);for(const details of $('tree').querySelectorAll('details.folder'))details.open=!collapsed;
}
async function refreshTabs(preferred){
  const tabs=await chrome.tabs.query({url:['https://*.chaoxing.com/*']});
  const selected=preferred || Number($('source').value);$('source').replaceChildren();
  if(!tabs.length){const option=el('option','','先在 Edge 中登录学习通，打开课程的“资料”');option.value='';$('source').append(option);}
  else for(const tab of tabs){const option=el('option','',tab.title || '学习通课程');option.value=tab.id;$('source').append(option);}
  if(tabs.some(t=>t.id===selected))$('source').value=selected;
  return tabs;
}
async function withLock(operation){
  if(!navigator.locks)throw new Problem('此浏览器缺少任务锁支持，请更新 Microsoft Edge');
  return navigator.locks.request('classbell-material-operation',{ifAvailable:true},async lock=>{
    if(!lock)throw new Problem('另一个 ClassBell 标签页正在处理资料，请先完成或取消那里的任务');
    return operation();
  });
}
async function readCourse(course){
  network.source=course.sessionRef?new PageSource(course.sessionRef):null;
  state.course=course;state.nodes=[];state.selected.clear();state.collapsedFolders.clear();state.history.clear();state.taskElements.clear();renderTasks();renderTree();
  $('rootName').value=sanitizeName(course.startName || course.name || '课程资料');$('courseHint').textContent=`课程 ${course.courseId} · ${course.startFolder?'读取当前资料目录及子目录':'读取官方资料区及子目录'}`;
  $('warnings').hidden=true;state.scanController=new AbortController();busy('scan');
  try{
    await withLock(async()=>{
      await configureReferer(course.origin);
      const catalog=new Catalog(network,course,{onProgress:p=>notice(`正在读取：${p.path} · 已发现 ${p.count} 项文件 / 文件夹`)});
      const result=await catalog.scan(state.scanController.signal);state.catalog=catalog;state.nodes=result.nodes;
      if(result.warnings.length){$('warnings').hidden=false;$('warnings').textContent='部分目录需要核对：\n'+result.warnings.join('\n');}
      notice(`已读取 ${allFiles(result.nodes).length} 项文件${result.warnings.length?'，部分目录未完整读取，请查看提示':''}。勾选要下载的资料。`);
    });
  }catch(e){notice(isAbort(e)?'已取消资料读取。可重新读取。':safeError(e),!isAbort(e));}
  finally{busy('');renderTree();updateControls();}
}
async function readTab(){
  const tabId=Number($('source').value);if(!tabId)throw new Problem('请先在 Edge 打开已登录课程的“资料”页面，再刷新页面列表');
  busy('inspect');notice('正在识别课程和资料入口…');
  let snapshots;
  try{
    const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:inspectPage});
    snapshots=results.filter(r=>r.result).map(r=>({...r.result,frameId:r.frameId,tabId}));
  }catch{throw new Problem('无法读取此页面。请刷新课程资料页，检查扩展的学习通网站访问权限后再试');}
  finally{busy('');}
  const courses=contextsFromSnapshots(snapshots);
  if(!courses.length)throw new Problem('未找到课程参数。请在课程中点击“资料”，等待载入后再读取');
  await readCourse(courses[0]);
}
async function pickFolder(){
  if(!window.showDirectoryPicker)throw new Problem('当前浏览器不支持文件夹选择器，请使用新版桌面 Microsoft Edge');
  // The picker is the first awaited operation inside this click handler.
  const handle=await window.showDirectoryPicker({id:'classbell-materials',mode:'readwrite',startIn:state.folder || 'downloads'});
  state.folder=handle;await setSetting('folder',handle);await showFolder();
  notice('已选择保存文件夹。勾选资料后开始下载。');
}
async function showFolder(){
  const handle=state.folder;
  if(!handle){updateControls();return;}
  const permission=await handle.queryPermission({mode:'readwrite'});
  $('folderName').textContent=handle.name;$('grantFolder').hidden=permission==='granted';
  $('folderHint').textContent=permission==='granted'?'已获写入权限。将保留课程目录结构，重名策略可在下方选择。':'已记住上次选择。请点击“重新授权上次文件夹”，或另选文件夹。';
  updateControls();
}
function taskElement(t){
  let refs=state.taskElements.get(t.key);if(refs)return refs;
  const node=el('div','task'),title=el('div','task-title'),name=el('span','',t.item.name),status=el('span','state');title.append(name,status);
  const detail=el('small'),error=el('small','task-error'),bar=el('progress');bar.max=1;bar.value=0;bar.setAttribute('aria-label',t.item.name+'下载进度');node.append(title,detail,error,bar);
  refs={node,status,detail,error,bar};state.taskElements.set(t.key,refs);$('tasks').append(node);return refs;
}
function size(n){return n>=1024**3?(n/1024**3).toFixed(2)+' GiB':n>=1024**2?(n/1024**2).toFixed(1)+' MiB':n>=1024?(n/1024).toFixed(1)+' KiB':n+' B';}
function renderTasks(){
  const tasks=[...state.history.values()];
  if(!tasks.length){$('tasks').replaceChildren(el('div','empty','勾选资料后开始下载'));$('summary').textContent='尚未开始下载';$('batchProgress').value=0;return;}
  if(!state.taskElements.size)$('tasks').replaceChildren();
  for(const t of tasks){
    const r=taskElement(t);r.status.textContent=labels[t.status] || t.status;r.status.className='state '+t.status;
    r.detail.textContent=(t.path || t.item.relativePath)+' · '+size(t.bytes || 0)+(t.total?' / '+size(t.total):'')+(t.attempt?` · 第 ${t.attempt} 次`:'')+(t.variant?' · '+t.variant:'');
    r.error.textContent=t.error || '';r.error.hidden=!t.error;
    r.bar.hidden=t.status!=='downloading';if(t.total){r.bar.max=t.total;r.bar.value=t.bytes;}else r.bar.removeAttribute('value');
  }
  const count=s=>tasks.filter(t=>t.status===s).length,done=tasks.filter(t=>terminal.has(t.status)).length;
  $('summary').textContent=`${done} / ${tasks.length} 项已处理 · 已保存 ${count('saved')} · 跳过 ${count('skipped')} · 失败 ${count('failed')} · 取消 ${count('cancelled')}`;
  $('batchProgress').max=tasks.length;$('batchProgress').value=done;updateControls();
}
let renderTimer;
function updateTask(task){state.history.set(task.key,task);if(!renderTimer)renderTimer=setTimeout(()=>{renderTimer=null;renderTasks();},100);}
function report(){return {version:chrome.runtime.getManifest().version,time:new Date().toISOString(),tasks:[...state.history.values()].map(t=>({name:t.item.name,path:t.path,status:t.status,attempts:t.attempt,bytes:t.bytes,variant:t.variant || '',error:t.error || ''}))};}
async function download(items,isRetry=false){
  if(!state.folder)throw new Problem('请先点击“选择文件夹”');
  // requestPermission is invoked directly from the user's click, before network or lock work.
  const permission=await state.folder.requestPermission({mode:'readwrite'});
  if(permission!=='granted'){await showFolder();throw new Problem('尚未获准写入所选文件夹，请重新授权');}
  if(!state.catalog || !items.length)throw new Problem('请先读取并勾选课程资料');
  if(!isRetry){state.history.clear();state.taskElements.clear();$('tasks').replaceChildren();}
  busy('download');notice(`正在下载 ${items.length} 项资料，请保留此标签页。`);
  const writer=new FolderWriter(state.folder,network,{conflict:$('conflict').value});
  const mode=$('mode').value;
  state.queue=new DownloadQueue({resolve:(item,signal)=>state.catalog.candidates(item,signal,mode),save:(item,variant,signal,progress)=>writer.save(item,variant,signal,progress),concurrency:Number($('concurrency').value),onUpdate:updateTask});
  try{
    await withLock(async()=>{await configureReferer(state.course.origin);await state.queue.run(items);});
    const result=report();await setSetting('lastRun',result);
    notice('本次任务已处理完毕。请查看逐项结果；失败或取消项可单独重试。');
  }finally{clearTimeout(renderTimer);renderTimer=null;busy('');renderTasks();await showFolder();}
}
function click(id,handler){$(id).addEventListener('click',()=>Promise.resolve().then(handler).catch(e=>{if(!isAbort(e))notice(safeError(e),true);updateControls();}));}
// User activation survives microtasks; picker/permission remain first async actions.
click('refreshTabs',()=>refreshTabs());click('read',readTab);
click('clearUrl',()=>{$('courseUrl').value='';$('courseUrl').focus();updateControls();});
click('collapseAll',()=>setAllFoldersCollapsed(true));click('expandAll',()=>setAllFoldersCollapsed(false));
click('readUrl',async()=>{
  const c=courseFromURL($('courseUrl').value);if(!c)throw new Problem('请输入包含 courseid、clazzid / classId、cpi 的官方课程资料页 HTTPS 链接');
  c.materialLinks=/coursedata/.test(c.sourceURL)?[c.sourceURL]:[];
  const tabs=await chrome.tabs.query({url:[c.origin+'/*']});
  if(tabs[0])c.sessionRef={tabId:tabs[0].id,frameId:0,origin:c.origin};
  return readCourse(c);
});
click('pickFolder',pickFolder);
click('grantFolder',async()=>{const status=await state.folder.requestPermission({mode:'readwrite'});await showFolder();if(status!=='granted')throw new Problem('文件夹写入权限未授予');});
click('start',()=>download(planTree(state.nodes,$('rootName').value).filter(f=>state.selected.has(f.key))));
click('retry',()=>download([...state.history.values()].filter(t=>['failed','cancelled'].includes(t.status)).map(t=>t.item),true));
click('cancel',()=>{state.scanController?.abort();state.queue?.cancel();notice('正在取消任务并清理本次未完成文件…');});
click('clearSelection',()=>{state.selected.clear();renderTree();updateControls();});
$('selectAll').addEventListener('change',()=>{for(const n of state.nodes)selectNode(n,state.selected,$('selectAll').checked);renderTree();updateControls();});
$('search').addEventListener('input',()=>{if($('search').value.trim())state.collapsedFolders.clear();renderTree();});$('rootName').addEventListener('input',updateControls);
$('courseUrl').addEventListener('input',updateControls);
for(const id of ['mode','conflict','concurrency'])$(id).addEventListener('change',()=>setSetting('preferences',{mode:$('mode').value,conflict:$('conflict').value,concurrency:$('concurrency').value}).catch(()=>notice('下载选项暂未记住，下次打开请重新选择',true)));
click('exportReport',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report(),null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download='ClassBell-下载记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});
window.addEventListener('beforeunload',e=>{if(state.busy){e.preventDefault();e.returnValue='';}});
window.addEventListener('keydown',e=>{
  const refresh=e.key==='F5' || (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase()==='r';
  if(refresh && state.busy==='download'){
    e.preventDefault();e.stopImmediatePropagation();notice('下载仍在进行，已保留当前课程和任务。完成后可正常刷新；如需现在离开，请先取消任务。');
  }
},true);
chrome.runtime.onMessage.addListener(message=>{
  if(message.type==='source-changed'){
    if(state.busy){notice('当前任务继续运行。完成后可刷新页面列表，选择新的课程。');return;}
    refreshTabs(message.tabId).then(()=>notice('已定位刚打开的学习通页面。点击“读取资料”开始读取。')).catch(()=>{});
  }
});
async function init(){
  $('versionBadge').textContent='Edge · v'+chrome.runtime.getManifest().version;
  try{const tab=await chrome.tabs.getCurrent();if(tab?.id)await chrome.tabs.update(tab.id,{autoDiscardable:false});}catch{}
  await refreshTabs(Number(new URLSearchParams(location.search).get('source')));
  state.folder=await getSetting('folder');await showFolder();
  const prefs=await getSetting('preferences');if(prefs)for(const k of ['mode','conflict','concurrency'])if([...$(k).options].some(o=>o.value===String(prefs[k])))$(k).value=prefs[k];
  const last=await getSetting('lastRun');if(last?.tasks)$('lastRun').textContent=`上次记录：已保存 ${last.tasks.filter(t=>t.status==='saved').length} 项。重新打开后请再次读取课程资料。`;
  updateControls();
}
init().catch(e=>notice(safeError(e),true));
