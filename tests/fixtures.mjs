export const ids={20:'a'.repeat(32),21:'b'.repeat(32),22:'c'.repeat(32),23:'d'.repeat(32)};
export function row(name,type,id,enc='syntheticEnc') {
  const sizes={20:'512 KB',21:'1 MB',22:'2.5 MB',23:'-'};
  return `<ul class="dataBody_td" ${ids[id]?`objectid="${ids[id]}"`:''}><li><dt onclick="toOpen('${encodeURIComponent(name)}','${type}',${id},'','${ids[id] || ''}','',2,1,'202','${enc}','','1795492775645','',1)"><span>${name}</span></dt></li><li class="dataBody_size_stu">${sizes[id] || '-'}</li></ul>`;
}
export const rootHTML=`<!doctype html><html><body><div class="dataBody">${row('重复/目录','afolder',10)}${row('欢迎.txt','txt',20)}</div></body></html>`;
export const folderHTML=`<div class="dataBody">${row('同名.pdf','pdf',21)}${row('同名.pdf','pdf',22)}${row('需重试.pdf','pdf',23)}</div>`;
