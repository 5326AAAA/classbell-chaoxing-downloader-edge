import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeName,numbered,planTree,selectionState,selectNode,allFiles,parseToOpen,officialURL,fileURL,courseFromURL,parsePreview,typedName,materialName,dispositionName,parseFileSize,selectionSize,formatSelectionSize} from '../extension/lib/core.js';

const file=(key,name)=>({kind:'file',key,name,type:'pdf'});
test('folder selection propagates, partial state and deselection are correct',()=>{
  const nodes=[{kind:'folder',key:'a',name:'A',children:[file('1','one.pdf'),{kind:'folder',key:'b',name:'B',children:[file('2','two.pdf')]}]},file('3','three.pdf')];
  const selected=new Set();selectNode(nodes[0],selected,true);
  assert.deepEqual([...selected],['1','2']);assert.equal(selectionState(nodes[0],selected).checked,true);
  selected.delete('2');assert.equal(selectionState(nodes[0],selected).mixed,true);
  selectNode(nodes[0],selected,false);assert.equal(selected.size,0);
  for(const n of nodes)selectNode(n,selected,true);assert.equal(selected.size,3);assert.equal(allFiles(nodes).length,3);
});
test('file sizes parse byte values, rounded webpage units, empty values and invalid sizes',()=>{
  assert.deepEqual(parseFileSize('1,048,576'),{bytes:1048576,approximate:false});
  assert.deepEqual(parseFileSize('98 KB'),{bytes:100352,approximate:true});
  assert.deepEqual(parseFileSize('2.5MB'),{bytes:2621440,approximate:true});
  assert.deepEqual(parseFileSize('1 GiB'),{bytes:1073741824,approximate:true});
  assert.deepEqual(parseFileSize('0 B'),{bytes:0,approximate:false});
  for(const v of [null,undefined,'','-','未知','1.5','-1 MB',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal(parseFileSize(v),null);
});
test('selection sizes include descendants, update on deselection and distinguish unknown from zero',()=>{
  const nodes=[{kind:'folder',key:'folder',children:[{...file('1','one'),sizeBytes:1048576,sizeApproximate:true},{...file('2','two'),sizeBytes:524288}]},file('3','unknown'),{...file('4','empty'),sizeBytes:0}];
  const selected=new Set();selectNode(nodes[0],selected,true);
  assert.deepEqual(selectionSize(nodes,selected),{bytes:1572864,known:2,unknown:0,approximate:true});
  assert.equal(formatSelectionSize(selectionSize(nodes,selected)),'总大小 约 1.50 MB');
  selected.add('3');assert.equal(formatSelectionSize(selectionSize(nodes,selected)),'已知大小 约 1.50 MB，1 项大小未知');
  assert.equal(formatSelectionSize(selectionSize(nodes,new Set(['3']))),'总大小未知（1 项未提供大小）');
  assert.equal(formatSelectionSize(selectionSize(nodes,new Set(['4']))),'总大小 0.00 MB');
  assert.equal(formatSelectionSize(selectionSize(nodes,new Set())),'总大小 0 MB');
});
test('safe Windows names, traversal, devices, unicode, controls, extensions',()=>{
  for(const [raw,expected] of [['../a:b?.pdf','.._a_b_.pdf'],['CON.txt','_CON.txt'],['LPT1','_LPT1'],['nul.pdf','_nul.pdf'],['..','未命名'],['hello. ','hello'],['a\x00b.pdf','a_b.pdf'],['e\u0301.pdf','é.pdf']])assert.equal(sanitizeName(raw),expected);
  const long=sanitizeName('文'.repeat(200)+'.pptx');assert.ok(long.length<=120);assert.ok(long.endsWith('.pptx'));
  assert.equal(numbered('name.pdf',2),'name (2).pdf');assert.equal(numbered('.env',1),'.env (1)');
  assert.equal(typedName('讲义','pptx'),'讲义.pptx');assert.equal(typedName('讲义.docx','pdf'),'讲义.docx');
});
test('planned tree preserves directories and disambiguates files AND folders after normalization',()=>{
  const nodes=[{kind:'folder',key:'a',name:'a/b',children:[file('1','Report.pdf'),file('2','report.pdf')]},
    {kind:'folder',key:'b',name:'a:b',children:[file('3','..')]},file('4','a_b')];
  const plan=planTree(nodes,'CON');
  assert.deepEqual(plan.map(f=>f.relativePath),['_CON/a_b/Report.pdf','_CON/a_b/report (1).pdf','_CON/a_b (1)/未命名.pdf','_CON/a_b.pdf']);
  assert.equal(new Set(plan.map(x=>x.relativePath.toLowerCase())).size,4);
});
test('toOpen literal parser handles encoded names, quotes, numbers, escapes without executing code',()=>{
  const row=parseToOpen("return toOpen('%E8%AE%B2%E4%B9%89','afolder',123,'x','y','z',0,0,'a','folderenc');");
  assert.deepEqual(row,{kind:'folder',name:'讲义',type:'afolder',dataId:'123',enc:'folderenc'});
  assert.equal(parseToOpen("toOpen('a\\'b.pdf','pdf',3,'','','',0,0,'','enc')").name,"a'b.pdf");
  assert.equal(parseToOpen("toOpen('\\u8bb2\\x41.pdf','pdf',4,'','','',0,0,'','enc')").name,'讲A.pdf');
  assert.equal(parseToOpen("toOpen('chapter+one%2Btwo.pdf','pdf',4,'','','',0,0,'','enc')").name,'chapter one+two.pdf');
  assert.equal(parseToOpen("toOpen(alert(1),'pdf',3,'','','',0,0,'','enc')"),null);
  assert.equal(parseToOpen("evil();toOpen('name','pdf',3,'','','',0,0,'','enc')"),null);
  assert.equal(parseToOpen("toOpen('bad','pdf',-1,'','','',0,0,'','enc')"),null);
  assert.equal(parseToOpen("toOpen('bad','pdf',3,'','','',0,0,'',cookie.value)"),null);
});
test('official and file URL validation rejects host spoofing, credentials, ports and fragments',()=>{
  for(const url of ['https://chaoxing.com.evil.test/a','https://evilchaoxing.com/a','https://user@mooc1.chaoxing.com/a','https://mooc1.chaoxing.com:444/a','http://mooc1.chaoxing.com/a','https://mooc1.chaoxing.com/a#x'])assert.equal(officialURL(url),null);
  assert.ok(officialURL('https://mooc2-ans.chaoxing.com/path'));
  assert.equal(fileURL('http://d0.cldisk.com/download/x').href,'https://d0.cldisk.com/download/x');
  assert.ok(fileURL('https://cs.cldisk.com/x'));assert.ok(fileURL('https://s99.cldisk.com/x'));
  assert.equal(fileURL('https://d0.cldisk.com.evil.test/x'),null);assert.equal(fileURL('https://random.cldisk.com/x'),null);
});
test('course URL accepts case variants and hidden fields but validates required values',()=>{
  const c=courseFromURL('https://mooc1.chaoxing.com/coursedata?courseId=123&classId=456',{cpi:'789'});
  assert.equal(c.courseId,'123');assert.equal(c.classId,'456');assert.equal(c.cpi,'789');
  assert.equal(courseFromURL('https://mooc1.chaoxing.com/?courseid=abc&clazzid=2&cpi=3'),null);
  assert.equal(courseFromURL('https://example.com/?courseid=1&clazzid=2&cpi=3'),null);
});
test('ClassBell metadata identity, original/PDF and safe CDN policy are preserved',()=>{
  const id='a'.repeat(32),data={status:'success',objectid:id,filename:'资料.docx',download:'http://d0.cldisk.com/file',pdf:'https://s3.cldisk.com/p.pdf'};
  assert.equal(parsePreview(id,data).original,'https://d0.cldisk.com/file');assert.ok(parsePreview(id,data).pdf);
  assert.throws(()=>parsePreview('b'.repeat(32),data),/不匹配/);
  assert.throws(()=>parsePreview(id,{...data,download:'https://evil.test/x',pdf:''}),/没有可用/);
  assert.equal(parsePreview(id,{...data,download:'https://evil.test/x'}).original,undefined);
});
test('missing extensions use server metadata while preserving meaningful display names',()=>{
  assert.equal(materialName('第一章','server.docx','object'),'第一章.docx');
  assert.equal(materialName('a'.repeat(32),'真实资料.pdf','object'),'真实资料.pdf');
  assert.equal(materialName('display.pptx','server.pdf','object'),'display.pptx');
  assert.equal(dispositionName("attachment; filename*=UTF-8''%E8%AE%B2%E4%B9%89.pdf"),'讲义.pdf');
  assert.equal(dispositionName('attachment; filename="../../CON.txt"'),'.._.._CON.txt');
});
test('a current subfolder carries its signed data ID and readable root name',()=>{
  const c=courseFromURL('https://mooc1.chaoxing.com/coursedata?courseId=1&classId=2&cpi=3&dataId=42&enc=folder&dataName=%E8%AE%B2%E4%B9%89');
  assert.deepEqual(c.startFolder,{dataId:'42',enc:'folder'});assert.equal(c.startName,'讲义');
});
test('the current 14-argument toOpen template retains the folder signature field',()=>{
  const p=parseToOpen("toOpen('%E7%AC%AC%E4%B8%80%E7%AB%A0','afolder',123,'',\n '','',2,1,'456','folder-signature',\n '','1795492775645','',1)");
  assert.equal(p.name,'第一章');assert.equal(p.enc,'folder-signature');assert.equal(p.dataId,'123');
  const file=parseToOpen("toOpen('document.docx','docx',456,'','"+'f'.repeat(32)+"','',2,1,'789','signature','','1795492775645','',1)");
  assert.equal(file.objectId,'f'.repeat(32));
});
