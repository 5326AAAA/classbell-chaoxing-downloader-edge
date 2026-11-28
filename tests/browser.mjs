import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {ids,row,rootHTML,folderHTML} from './fixtures.mjs';
import {chapterOverview,chapterSidebar,chapterStudy,chapterCard} from './chapter-fixtures.mjs';

const require=createRequire(import.meta.url);
let playwright;
try{playwright=require('playwright');}catch{
  if(!process.env.PLAYWRIGHT_MODULE)throw new Error('请先 npm install，或设置 PLAYWRIGHT_MODULE 指向 Playwright 包目录');
  playwright=require(process.env.PLAYWRIGHT_MODULE);
}
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratch=resolve(process.env.CLASSBELL_TEST_WORK || resolve(project,'../../work'));
await mkdir(scratch,{recursive:true});const profile=await mkdtemp(resolve(scratch,'edge-test-'));
const results=[];const check=(name,fn)=>Promise.resolve().then(fn).then(()=>{results.push({name,status:'passed'});console.log('PASS '+name);});
const context=await playwright.chromium.launchPersistentContext(profile,{
  executablePath:process.env.EDGE_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless:true,viewport:{width:1440,height:1100},ignoreDefaultArgs:['--disable-extensions'],
  args:[`--disable-extensions-except=${resolve(project,'extension')}`,`--load-extension=${resolve(project,'extension')}`,'--no-first-run','--no-default-browser-check']
});
let page,source,version,extensionId;const errors=[];let failing=true,stall=false,releaseStall;const counts=new Map();
let sawSessionCookie=false,sawCookieOnCDN=false;
try{
  version=context.browser()?.version() || 'Microsoft Edge';
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:20000});
  extensionId=new URL(worker.url()).hostname;
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await context.addCookies([{name:'classbell_fixture',value:'synthetic-session',domain:'.chaoxing.com',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
  await context.route(/^https:\/\/[^/]+\.chaoxing\.com\//,async route=>{
    const u=new URL(route.request().url());
    const headers=await route.request().allHeaders();if((headers.cookie || '').includes('classbell_fixture='))sawSessionCookie=true;
    if(u.pathname.endsWith('/mycourse/stu'))return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<html><head><title>合成课程</title></head><body><h1>合成课程</h1><iframe src="/mooc2-ans/coursedata/stu-datalist?courseid=101&clazzid=202&cpi=303"></iframe></body></html>'});
    if(u.pathname.endsWith('stu-datalist'))return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:u.searchParams.get('dataId')==='10'?folderHTML:rootHTML});
    if(u.pathname.endsWith('downloadData') && u.searchParams.get('dataId')==='77')return route.fulfill({status:200,contentType:'application/pdf',headers:{'Content-Disposition':'attachment; filename="synthetic.pdf"'},body:'%PDF-1.7\nsynthetic direct response\n%%EOF\n'});
    if(u.pathname.endsWith('downloadData') && u.searchParams.get('dataId')==='78')return route.fulfill({status:302,headers:{Location:'https://d0.cldisk.com/file/78'},body:''});
    if(u.pathname.endsWith('downloadData') && u.searchParams.get('dataId')==='79')return route.fulfill({status:200,contentType:'application/octet-stream',body:Buffer.alloc(256*1024,65)});
    if(u.pathname.endsWith('toPreview'))return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:`<iframe src="/ananas/modules/pdf/index.html?objectid=${ids[u.searchParams.get('dataId')]}"></iframe>`});
    if(u.pathname.includes('/ananas/status/')){
      const id=u.pathname.split('/').pop();return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'success',objectid:id,filename:'synthetic.pdf',download:`https://d0.cldisk.com/file/${id}`,pdf:id===ids[21]?`https://s3.cldisk.com/pdf/${id}`:''})});
    }
    return route.fulfill({status:404,body:'synthetic endpoint not found'});
  });
  await context.route(/^https:\/\/[^/]+\.cldisk\.com\//,async route=>{
    const u=new URL(route.request().url()),id=u.pathname.split('/').pop();counts.set(id,(counts.get(id)||0)+1);
    const headers=await route.request().allHeaders();if((headers.cookie || '').includes('classbell_fixture='))sawCookieOnCDN=true;
    if(stall && id===ids[20]){await new Promise(resolve=>releaseStall=resolve);try{return await route.fulfill({status:200,body:'cancelled fixture'});}catch{return;}}
    if(u.hostname==='d0.cldisk.com' && (id===ids[21] || id===ids[23] && failing))return route.fulfill({status:503,body:'synthetic temporary failure'});
    return route.fulfill({status:200,contentType:id===ids[20]?'text/plain':'application/pdf',headers:id==='77'?{'Content-Disposition':'attachment; filename="synthetic.pdf"'}:{},body:id===ids[20]?'synthetic welcome':'%PDF-1.7\nsynthetic file\n%%EOF\n'});
  });
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('准备就绪'));
  await check('MV3 extension loads in isolated Edge profile',async()=>{
    const manifest=await worker.evaluate(()=>chrome.runtime.getManifest());assert.equal(manifest.manifest_version,3);assert.ok(!manifest.permissions.includes('cookies'));assert.equal(await page.title(),'ClassBell · 课程资料下载');
  });
  await check('DOM parsers: modern rows, object attributes, empty/login/unrecognized pages and pagination',async()=>{
    const result=await page.evaluate(async html=>{
      const {parsePage,contextsFromSnapshots}=await import('./lib/page.js');const base='https://mooc2-ans.chaoxing.com/mooc2-ans/coursedata/stu-datalist?courseid=101&clazzid=202&cpi=303';
      return {modern:parsePage(html,base),object:parsePage('<div class="dataBody_td" objectid="'+ 'f'.repeat(32)+'" dataname="单独资料.pdf" data-size-bytes="2097152"></div>',base),empty:parsePage('<p>暂无资料</p>',base),unknown:parsePage('<html>not a course page</html>',base),login:parsePage('<input type="password">',base),pagination:parsePage(html+'<a href="?pageNum=2">下一页</a>',base),jsPagination:parsePage(html+'<a onclick="go(2)">下一页</a>',base),special:parsePage('<ul class="dataBody_td" type="tch-courseware"><dt onclick=""><a class="rename_title">教师课件</a></dt></ul>',base),contexts:contextsFromSnapshots([{url:base,title:'合成课程',fields:{},links:[]}])};
    },rootHTML);
    assert.equal(result.modern.items.length,2);assert.equal(result.object.items[0].objectId,'f'.repeat(32));assert.equal(result.empty.recognized,true);assert.equal(result.unknown.recognized,false);assert.equal(result.login.login,true);assert.equal(result.pagination.pages.length,1);assert.equal(result.jsPagination.unsupportedPagination,true);assert.deepEqual(result.special.specialEntries,['教师课件']);assert.equal(result.contexts[0].courseId,'101');
    assert.equal(result.modern.items.find(i=>i.kind==='file').sizeBytes,524288);
    assert.equal(result.object.items[0].sizeBytes,2097152);assert.equal(result.object.items[0].sizeApproximate,false);
  });
  await check('chapter parsers preserve both directory templates, every card tab, exact sizes and document identity',async()=>{
    const result=await page.evaluate(async fixture=>{
      const {parseChapters,parseStudy,parseCards}=await import('./lib/chapters.js');
      const base='https://mooc1.chaoxing.com/mycourse/studentstudy';
      const video=`<iframe src="/ananas/modules/video/index.html" data='{"objectid":"${'e'.repeat(32)}"}'></iframe>`;
      const evil=`<iframe src="https://evil.test/ananas/modules/pdf/index.html" data='{"objectid":"${'f'.repeat(32)}"}'></iframe>`;
      return {overview:parseChapters(fixture.overview),sidebar:parseChapters(fixture.sidebar),study:parseStudy(fixture.study,base),cards:parseCards(fixture.card+fixture.card+video+evil,base),initialized:parseCards(fixture.card.replace('module="pdf"','src="/ananas/modules/pdf/index.html"'),base)};
    },{overview:chapterOverview,sidebar:chapterSidebar,study:chapterStudy('11',2),card:chapterCard()});
    assert.equal(result.overview.nodes[0].children[0].children[0].chapterId,'111');
    assert.equal(result.overview.nodes[0].children[0].name,'1.1 含两张课件');
    assert.equal(result.sidebar.nodes[0].children[0].chapterId,'11');assert.equal(result.study.pages.length,2);
    assert.equal(new URL(result.study.pages[1]).searchParams.get('num'),'1');assert.equal(result.cards.items.length,1);
    assert.equal(result.cards.items[0].type,'ppt');assert.equal(result.cards.items[0].sizeBytes,1048576);assert.equal(result.cards.skipped,1);assert.equal(result.cards.unsupported.length,1);
    assert.equal(result.initialized.items.length,1);
  });
  await check('chapter scan reads multiple cards, deduplicates within a section, retains cross-section files, and reports blocked chapters',async()=>{
    const result=await page.evaluate(async fixture=>{
      const {ChapterCatalog}=await import('./lib/chapters.js');const {allFiles,selectNode,selectionSize,planTree}=await import('./lib/core.js');
      const calls=[];const network={text:async url=>{
        calls.push(url);const u=new URL(url),id=u.searchParams.get('chapterId') || u.searchParams.get('knowledgeid');
        let text;if(id==='12')text='<p>章节未开放</p>';
        else if(/\/studentstudy(?:Ajax)?$/.test(u.pathname))text=fixture.studies[id];
        else text=u.searchParams.get('num')==='1'?fixture.second:fixture.first;
        return {url,text};
      }};
      const c={courseId:'101',classId:'202',cpi:'303',origin:'https://mooc1.chaoxing.com',sourceURL:'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=101&clazzid=202&cpi=303',chapterHTML:fixture.overview};
      const result=await new ChapterCatalog(network,c,{interval:0}).scan();
      const selected=new Set();selectNode(result.nodes[0].children[0],selected,true);
      return {result,files:allFiles(result.nodes),size:selectionSize(result.nodes,selected),paths:planTree(result.nodes,'测试').map(n=>n.relativePath),calls};
    },{overview:chapterOverview,studies:{11:chapterStudy('11',2),111:chapterStudy('111')},first:chapterCard()+'<iframe module="video" data=\'{"objectid":"'+ 'c'.repeat(32)+'"}\'></iframe>',second:chapterCard('f'.repeat(32),'课件.ppt')+chapterCard()});
    assert.equal(result.files.length,3);assert.equal(result.size.bytes,3*1048576);assert.equal(result.result.warnings.length,1);
    assert.equal(result.result.skippedCards,2);
    assert.ok(result.result.warnings[0].includes('未开放'));assert.equal(result.calls.filter(u=>u.includes('/knowledge/cards')).length,3);
    assert.ok(result.paths.some(p=>p.endsWith('课件 (1).ppt')));assert.ok(result.paths.every(p=>p.startsWith('测试/1 示例第一章/')));
  });
  await check('chapter cancellation halts traversal; unknown study responses cannot appear as a complete empty course',async()=>{
    const result=await page.evaluate(async fixture=>{
      const {ChapterCatalog}=await import('./lib/chapters.js');
      const c={courseId:'101',classId:'202',cpi:'303',origin:'https://mooc1.chaoxing.com',sourceURL:'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=101&clazzid=202&cpi=303',chapterHTML:fixture};
      const partial=await new ChapterCatalog({text:async url=>({url,text:'<html>unknown template</html>'})},c,{interval:0}).scan();
      const controller=new AbortController();let calls=0,error;
      try{await new ChapterCatalog({text:async url=>{calls++;controller.abort(new DOMException('cancel','AbortError'));return {url,text:''};}},c,{interval:0}).scan(controller.signal);}catch(e){error=e.name;}
      return {warnings:partial.warnings.length,calls,error};
    },chapterOverview);
    assert.equal(result.warnings,3);assert.equal(result.calls,1);assert.equal(result.error,'AbortError');
  });
  await check('recursive catalog follows signed folders, deduplicates pages, detects cycles and reports partial failures',async()=>{
    const result=await page.evaluate(async()=>{
      const {Catalog}=await import('./lib/catalog.js');const {Problem}=await import('./lib/core.js');
      const row=(name,type,id)=>`<dt onclick="toOpen('${name}','${type}',${id},'x','y','z',0,0,'a','enc')"></dt>`;
      const c={courseId:'101',classId:'202',cpi:'303',enc:'',origin:'https://mooc2-ans.chaoxing.com',materialLinks:['https://mooc2-ans.chaoxing.com/mooc2-ans/coursedata/stu-datalist?stuenc=synthetic']};
      const calls=[];const fake={text:async url=>{
        const u=new URL(url);calls.push(url);const id=u.searchParams.get('dataId'),p=u.searchParams.get('pageNum');
        if(id==='11')throw new Problem('synthetic folder failure');
        let text=id==='10'?row('cycle','afolder',10)+row('child','pdf',101):p==='2'?row('root','pdf',100)+row('second','pdf',102):row('folder','afolder',10)+row('broken','afolder',11)+row('root','pdf',100)+'<a href="?pageNum=2">下一页</a>';
        return {text,url};
      }};
      const catalog=new Catalog(fake,c,{interval:0});const result=await catalog.scan();return {...result,calls};
    });
    assert.equal(result.nodes.length,4);assert.equal(result.nodes[0].children[0].scanError,'检测到循环目录');assert.ok(result.warnings.length>=2);
    assert.ok(result.calls.some(u=>u.includes('dataId=10')&&u.includes('enc=enc')&&u.includes('stuenc=synthetic')));
  });
  await check('native File System API: streaming, filename collisions, skip, directory/file collision and IndexedDB handle persistence',async()=>{
    const result=await page.evaluate(async()=>{
      const {FolderWriter}=await import('./lib/filesystem.js');const {Network}=await import('./lib/network.js');const {getSetting,setSetting}=await import('./lib/storage.js');
      const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('native-files',{create:true});
      const network=new Network(async()=>new Response('synthetic bytes',{headers:{'content-type':'application/octet-stream','content-length':'15'}}));
      const writer=new FolderWriter(dir,network),item={dirs:['Course'],name:'report.pdf'},v={url:'https://d0.cldisk.com/file',name:'report.pdf'};
      const first=await writer.save(item,v),second=await writer.save(item,{...v,name:'REPORT.pdf'});
      const skipped=await new FolderWriter(dir,network,{conflict:'skip'}).save(item,v);
      const existing=await dir.getFileHandle('Clash',{create:true});const w=await existing.createWritable();await w.write('existing');await w.close();
      const clash=await writer.save({dirs:['clash']},v);
      await setSetting('test-handle',dir);const stored=await getSetting('test-handle');
      const report=await (await (await dir.getDirectoryHandle('Course')).getFileHandle('report.pdf')).getFile();
      const existingText=await (await existing.getFile()).text();
      return {first,second,skipped,clash,same:await stored.isSameEntry(dir),text:await report.text(),existingText};
    });
    assert.equal(result.first.status,'saved');assert.equal(result.first.bytes,15);assert.equal(result.text,'synthetic bytes');assert.equal(result.second.path,'Course/REPORT (1).pdf');assert.equal(result.skipped.status,'skipped');assert.equal(result.clash.path,'clash (1)/report.pdf');assert.equal(result.existingText,'existing');assert.equal(result.same,true);
  });
  await check('native file writes: split PDF signature, truncated stream and HTML masquerade validation',async()=>{
    const result=await page.evaluate(async()=>{
      const {FolderWriter}=await import('./lib/filesystem.js');const {Network}=await import('./lib/network.js');
      const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('validation-files',{create:true});const enc=new TextEncoder();
      const stream=new ReadableStream({start(c){for(const s of ['%','P','D','F','-1.7\nfixture'])c.enqueue(enc.encode(s));c.close();}});
      const good=await new FolderWriter(root,new Network(async()=>new Response(stream))).save({dirs:[]},{url:'https://s3.cldisk.com/good',name:'good.pdf',pdf:true});
      const errors=[];
      for(const [name,body,headers] of [['truncated.pdf','abc',{'content-length':'100'}],['html.pdf','<!doctype html><html>login</html>',{'content-type':'application/octet-stream'}],['invalid.pdf','not a PDF',{}]]){
        try{await new FolderWriter(root,new Network(async()=>new Response(body,{headers}))).save({dirs:[]},{url:'https://s3.cldisk.com/bad',name,pdf:name==='invalid.pdf'});}catch(e){errors.push(e.message);}
      }
      const entries=[];for await(const name of root.keys())entries.push(name);return {good,errors,entries};
    });
    assert.equal(result.good.status,'saved');assert.equal(result.errors.length,3);assert.deepEqual(result.entries,['good.pdf']);
  });
  await check('native streaming cancellation aborts writes and removes the created partial file',async()=>{
    const result=await page.evaluate(async()=>{
      const {FolderWriter}=await import('./lib/filesystem.js');const {Network}=await import('./lib/network.js');
      const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('cancel-files',{create:true});const controller=new AbortController();
      const network=new Network(async(_,options)=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024).fill(65));options.signal.addEventListener('abort',()=>c.error(options.signal.reason),{once:true});}})));
      let name;try{await new FolderWriter(root,network).save({dirs:[]},{url:'https://d0.cldisk.com/slow',name:'partial.bin'},controller.signal,()=>controller.abort(new DOMException('cancel','AbortError')));}catch(e){name=e.name;}
      const entries=[];for await(const n of root.keys())entries.push(n);return {name,entries};
    });assert.equal(result.name,'AbortError');assert.deepEqual(result.entries,[]);
  });
  await check('native DNR rules are scoped to extension requests and course Referer',async()=>{
    const result=await page.evaluate(async()=>{
      const {configureReferer}=await import('./lib/network.js');await configureReferer('https://mooc2-ans.chaoxing.com');
      const rules=await chrome.declarativeNetRequest.getSessionRules();
      const own=await chrome.declarativeNetRequest.testMatchOutcome({url:'https://d0.cldisk.com/file',type:'xmlhttprequest',initiator:'chrome-extension://'+chrome.runtime.id});
      const regular=await chrome.declarativeNetRequest.testMatchOutcome({url:'https://d0.cldisk.com/file',type:'xmlhttprequest',initiator:'https://mooc2-ans.chaoxing.com'});
      return {rules,own,regular,id:chrome.runtime.id};
    });
    assert.equal(result.rules.length,2);assert.deepEqual(result.rules[0].condition.initiatorDomains,[result.id]);assert.ok(result.own.matchedRules.some(r=>r.ruleId===1001));assert.equal(result.regular.matchedRules.length,0);
  });
  await check('native fetch uses downloadData with session cookie and safe filename extension',async()=>{
    source=await context.newPage();await source.goto('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=101&clazzid=202&cpi=303');
    sawSessionCookie=false;
    const result=await page.evaluate(async()=>{
      const {Catalog}=await import('./lib/catalog.js');const {Network}=await import('./lib/network.js');const {FolderWriter}=await import('./lib/filesystem.js');const {PageSource}=await import('./lib/source.js');
      const network=new Network(),course={courseId:'101',classId:'202',cpi:'303',enc:'',origin:'https://mooc2-ans.chaoxing.com'},item={dataId:'77',name:'显示名',type:'object',dirs:[]};
      const tabs=await chrome.tabs.query({url:[course.origin+'/*']});network.source=new PageSource({tabId:tabs[0].id,frameId:0,origin:course.origin});
      const candidates=await new Catalog(network,course,{interval:0}).candidates(item,undefined,'original');
      const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('direct-download',{create:true});
      const result=await new FolderWriter(dir,network).save(item,candidates[0]);return result;
    });
    assert.equal(result.status,'saved');assert.equal(result.path,'显示名.pdf');assert.equal(sawSessionCookie,true);assert.equal(sawCookieOnCDN,false);
  });
  await check('source-page downloadData redirect resolves through read-only webRequest to native CDN fetch',async()=>{
    const result=await page.evaluate(async()=>{
      const {Network}=await import('./lib/network.js');const {PageSource}=await import('./lib/source.js');const {FolderWriter}=await import('./lib/filesystem.js');
      const origin='https://mooc2-ans.chaoxing.com',tabs=await chrome.tabs.query({url:[origin+'/*']}),network=new Network();
      network.source=new PageSource({tabId:tabs[0].id,frameId:0,origin});
      const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('redirect-download',{create:true});
      return new FolderWriter(dir,network).save({dirs:[]},{url:origin+'/mooc2-ans/coursedata/downloadData?dataId=78&courseId=101&classId=202&cpi=303',name:'redirect.pdf'});
    });assert.equal(result.status,'saved');assert.equal(sawCookieOnCDN,false);assert.ok(counts.get('78')>=1);
  });
  await check('source-page streaming cancellation closes the port and cleans the partial file',async()=>{
    const result=await page.evaluate(async()=>{
      const {Network}=await import('./lib/network.js');const {PageSource}=await import('./lib/source.js');const {FolderWriter}=await import('./lib/filesystem.js');
      const origin='https://mooc2-ans.chaoxing.com',tabs=await chrome.tabs.query({url:[origin+'/*']}),network=new Network(),controller=new AbortController();
      network.source=new PageSource({tabId:tabs[0].id,frameId:0,origin});
      const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('source-cancel',{create:true});
      let error;try{await new FolderWriter(dir,network).save({dirs:[]},{url:origin+'/coursedata/downloadData?dataId=79',name:'partial.bin'},controller.signal,()=>controller.abort(new DOMException('cancel','AbortError')));}catch(e){error=e.name;}
      const names=[];for await(const name of dir.keys())names.push(name);return {error,names};
    });assert.equal(result.error,'AbortError');assert.deepEqual(result.names,[]);
  });
  await check('UI course reading, folder selection, mixed selection and select all under search',async()=>{
    // OPFS uses real browser file handles. Only the native picker is replaced.
    await page.evaluate(async()=>{
      const handle=await (await navigator.storage.getDirectory()).getDirectoryHandle('ui-downloads',{create:true});
      Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=>handle});
    });
    await page.locator('#refreshTabs').click();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('#source option')).some(o=>o.value));
    await page.locator('#read').click();await page.waitForFunction(()=>document.getElementById('fileCount').textContent==='4 项',{timeout:20000});
    await page.getByRole('checkbox',{name:'重复/目录',exact:true}).check();assert.equal(await page.locator('#selectedCount').textContent(),'已选 3 项');
    await page.getByRole('checkbox',{name:'同名.pdf',exact:true}).first().uncheck();assert.equal(await page.getByRole('checkbox',{name:'重复/目录',exact:true}).evaluate(e=>e.indeterminate),true);
    await page.locator('#search').fill('同名');await page.locator('#selectAll').check();assert.equal(await page.locator('#selectedCount').textContent(),'已选 4 项');
    await page.locator('#search').fill('');await page.locator('#pickFolder').click();await page.waitForFunction(()=>document.getElementById('folderName').textContent==='ui-downloads');
    assert.equal(await page.locator('#start').isEnabled(),true);
  });
  await check('UI collapse/expand covers nested folders and survives selection changes; selected sizes and URL clear update',async()=>{
    const nested=async route=>{
      const u=new URL(route.request().url()),id=u.searchParams.get('dataId');
      const body=id==='10'?folderHTML:id==='11'?row('内层目录','afolder',12):id==='12'?'<p>暂无资料</p>':rootHTML+row('更多目录','afolder',11);
      await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
    };
    await context.route(/https:\/\/[^/]+\.chaoxing\.com\/.*stu-datalist.*/,nested);
    await page.locator('#read').click();await page.waitForFunction(()=>document.querySelectorAll('#tree details.folder').length===3 && !document.getElementById('collapseAll').disabled);
    await page.locator('#collapseAll').click();assert.equal(await page.locator('#tree details[open]').count(),0);
    await page.getByRole('checkbox',{name:'欢迎.txt',exact:true}).check();assert.equal(await page.locator('#tree details[open]').count(),0);
    assert.equal(await page.locator('#selectedSize').textContent(),'总大小 约 0.50 MB');
    await page.locator('#expandAll').click();assert.equal(await page.locator('#tree details[open]').count(),3);
    await page.locator('#selectAll').check();assert.equal(await page.locator('#selectedSize').textContent(),'已知大小 约 4.00 MB，1 项大小未知');
    await page.locator('.manual summary').click();await page.locator('#courseUrl').fill('https://mooc2-ans.chaoxing.com/synthetic-course');
    await page.locator('#clearUrl').click();assert.equal(await page.locator('#courseUrl').inputValue(),'');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'courseUrl');assert.equal(await page.locator('#selectedCount').textContent(),'已选 4 项');
    await page.locator('.manual summary').click();await context.unroute(/https:\/\/[^/]+\.chaoxing\.com\/.*stu-datalist.*/,nested);
  });
  await check('UI batch downloads to real handles, PDF fallback, retries, duplicate names and privacy-safe report',async()=>{
    await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('summary').textContent.includes('已保存 3')&&document.getElementById('summary').textContent.includes('失败 1')&&!document.getElementById('retry').disabled,{timeout:25000});
    assert.equal(counts.get(ids[23]),3);
    const report=await page.evaluate(async()=>{
      const {getSetting}=await import('./lib/storage.js');const report=await getSetting('lastRun');
      const root=await getSetting('folder');const names=[];
      async function walk(d,p=''){for await(const [name,h] of d.entries())if(h.kind==='directory')await walk(h,p+name+'/');else names.push(p+name);}
      await walk(root);return {report,names};
    });
    assert.equal(report.names.length,3);assert.ok(report.names.some(n=>n.includes('重复_目录/同名 (1).pdf')));assert.ok(report.report.tasks.some(t=>t.variant==='PDF'&&t.status==='saved'));
    assert.ok(!/https:\/\/|Cookie|syntheticEnc|objectid|enc=/.test(JSON.stringify(report.report)));
  });
  await check('UI manual retry preserves completed tasks and reload remembers the directory handle',async()=>{
    const before=counts.get(ids[20]);failing=false;
    await page.locator('#retry').click();await page.waitForFunction(()=>document.getElementById('summary').textContent.includes('已保存 4')&&!document.getElementById('start').disabled,{timeout:20000});assert.equal(counts.get(ids[20]),before);
    await page.screenshot({path:resolve(project,'test-results','界面预览.png'),fullPage:true});
    await page.reload();await page.waitForFunction(()=>document.getElementById('folderName').textContent==='ui-downloads');assert.ok((await page.locator('#lastRun').textContent()).includes('已保存 4'));
  });
  await check('UI refresh shortcuts preserve active downloads; cancel releases protection and cancels remaining queue',async()=>{
    await page.locator('.manual summary').click();await page.locator('#courseUrl').fill('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=101&clazzid=202&cpi=303');await page.locator('#readUrl').click();await page.waitForFunction(()=>document.getElementById('fileCount').textContent==='4 项');
    await page.locator('#selectAll').check();await page.locator('#concurrency').selectOption('1');
    // First item in the planned tree is dataId=21. Delay that response as well.
    const cancelRoute=async route=>{await new Promise(resolve=>releaseStall=resolve);try{await route.fulfill({status:200,body:'%PDF-1.7\nfixture'});}catch{}};
    await context.route(`https://d0.cldisk.com/file/${ids[21]}`,cancelRoute);
    await page.locator('#start').click();await page.getByText('下载中',{exact:true}).first().waitFor();
    await page.keyboard.press('F5');assert.ok((await page.locator('#notice').textContent()).includes('已保留当前课程和任务'));assert.equal(await page.locator('#fileCount').textContent(),'4 项');
    await page.keyboard.press('Control+r');assert.equal(await page.locator('#cancel').isEnabled(),true);
    await page.locator('#cancel').click();
    await page.waitForFunction(()=>document.getElementById('summary').textContent.includes('取消 4')&&!document.getElementById('retry').disabled,{timeout:10000});
    releaseStall?.();await context.unroute(`https://d0.cldisk.com/file/${ids[21]}`,cancelRoute);
    assert.equal(await page.evaluate(()=>{const e=new KeyboardEvent('keydown',{key:'r',ctrlKey:true,bubbles:true,cancelable:true});document.dispatchEvent(e);return e.defaultPrevented;}),false);
  });
  await check('UI chapter range uses the logged-in same-origin bridge, supports chapter selection and saves nested PPT files',async()=>{
    const chapterRoute=async route=>{
      const u=new URL(route.request().url()),id=u.searchParams.get('chapterId') || u.searchParams.get('knowledgeid');
      const body=id==='12'?'<p>章节未开放</p>':/\/studentstudy(?:Ajax)?$/.test(u.pathname)?
        '<html><head><title>合成章节课件</title></head><body>'+chapterOverview+chapterStudy(id,id==='11'?2:1)+'</body></html>':
        u.searchParams.get('num')==='1'?chapterCard('f'.repeat(32),'课件.ppt'):chapterCard();
      await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
    };
    await context.route(/https:\/\/mooc1\.chaoxing\.com\/(?:(?:mooc-ans\/)?mycourse\/studentstudy(?:Ajax)?|mooc-ans\/knowledge\/cards).*/,chapterRoute);
    const chapterSource=await context.newPage();await chapterSource.goto('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=101&clazzid=202&cpi=303&chapterId=11');
    await page.locator('#refreshTabs').click();await page.locator('#source').selectOption({label:'合成章节课件'});await page.locator('#scope').selectOption('chapters');
    await page.locator('#read').click();await page.waitForFunction(()=>document.getElementById('fileCount').textContent==='3 项' && !document.getElementById('read').disabled,{timeout:20000});
    assert.ok((await page.locator('#warnings').textContent()).includes('未开放'));
    await page.getByRole('checkbox',{name:'1 示例第一章',exact:true}).check();assert.equal(await page.locator('#selectedCount').textContent(),'已选 3 项');
    assert.equal(await page.locator('#selectedSize').textContent(),'总大小 3.00 MB');
    await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('summary').textContent.includes('已保存 3') && !document.getElementById('read').disabled,{timeout:20000});
    const paths=await page.evaluate(async()=>{const {getSetting}=await import('./lib/storage.js');return (await getSetting('lastRun')).tasks.map(t=>t.path);});
    assert.equal(paths.length,3);assert.ok(paths.every(p=>p.endsWith('.ppt')));assert.ok(paths.some(p=>p.endsWith('课件 (1).ppt')));
    await page.screenshot({path:resolve(project,'test-results','章节课件界面.png'),fullPage:true});
    if(!await page.locator('.manual').evaluate(e=>e.open))await page.locator('.manual summary').click();
    await page.locator('#courseUrl').fill('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=101&clazzid=202&cpi=303');
    await page.locator('#readUrl').click();await page.waitForFunction(()=>document.getElementById('fileCount').textContent==='3 项' && !document.getElementById('readUrl').disabled,{timeout:20000});
    assert.ok((await page.locator('#courseHint').textContent()).includes('整课章节'));
    await chapterSource.close();await context.unroute(/https:\/\/mooc1\.chaoxing\.com\/(?:(?:mooc-ans\/)?mycourse\/studentstudy(?:Ajax)?|mooc-ans\/knowledge\/cards).*/,chapterRoute);
  });
  assert.deepEqual(errors,[]);
}catch(e){results.push({name:'browser suite',status:'failed',error:e.message});throw e;}
finally{
  releaseStall?.();await mkdir(resolve(project,'test-results'),{recursive:true});
  await writeFile(resolve(project,'test-results/browser.json'),JSON.stringify({time:new Date().toISOString(),browser:version,tests:results,scope:'Isolated headless Edge; synthetic course responses and HttpOnly session cookie; same-origin page bridge, native redirect observation, OPFS handles and IndexedDB. No real Chaoxing account or OS directory picker validation.'},null,2));
  await context.close();
}
