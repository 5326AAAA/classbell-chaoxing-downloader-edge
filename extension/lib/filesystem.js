import {Problem,sanitizeName,numbered,guard,materialName,dispositionName} from './core.js';
import {idleRead} from './network.js';

export class FolderWriter {
  constructor(root,network,{conflict='rename'}={}) {Object.assign(this,{root,network,conflict});this.directories=new Map();}
  async directory(parts,signal) {
    let dir=this.root;const prefix=[],actual=[];
    for(const part of parts) {
      guard(signal);if(part!==sanitizeName(part))throw new Problem('文件夹名称无效');
      prefix.push(part);const key=prefix.join('/');
      if(!this.directories.has(key))this.directories.set(key,this.makeDirectory(dir,part,signal));
      const resolved=await this.directories.get(key);dir=resolved.handle;actual.push(resolved.name);
    }
    return {handle:dir,parts:actual};
  }
  async makeDirectory(dir,part,signal) {
    const previous=this.allocation || Promise.resolve();let unlock;
    this.allocation=new Promise(resolve=>unlock=resolve);await previous;
    try {
      guard(signal);const entries=new Map();for await(const [name,handle] of dir.entries())entries.set(name.toLocaleLowerCase('en-US'),{name,handle});
      let name=part,n=0;
      while(entries.has(name.toLocaleLowerCase('en-US'))) {
        const found=entries.get(name.toLocaleLowerCase('en-US'));
        if(found.handle.kind==='directory')return {handle:found.handle,name:found.name};
        name=numbered(part,++n);
      }
      guard(signal);return {handle:await dir.getDirectoryHandle(name,{create:true}),name};
    } finally{unlock();}
  }
  async reserve(dir,raw,signal) {
    guard(signal);
    // A single manager-wide Web Lock serializes batches. The queue also keeps
    // name allocation ordered across concurrent transfers within this writer.
    const previous=this.allocation || Promise.resolve();let unlock;
    this.allocation=new Promise(resolve=>unlock=resolve);await previous;
    try {
      guard(signal);const used=new Set();for await(const name of dir.keys())used.add(name.toLocaleLowerCase('en-US'));
      const base=sanitizeName(raw);let name=base,n=0;
      if(this.conflict==='skip' && used.has(name.toLocaleLowerCase('en-US')))return {skipped:true,name};
      while(used.has(name.toLocaleLowerCase('en-US')))name=numbered(base,++n);
      guard(signal);const handle=await dir.getFileHandle(name,{create:true});
      return {handle,name,created:true};
    } finally{unlock();}
  }
  async save(item,variant,signal,onProgress=()=>{}) {
    guard(signal);
    const conn=await this.network.open(variant.url,signal);
    const response=conn.response;let reader,writable,dir,reservation,actualDirs=item.dirs,committed=false;
    try {
      const type=(response.headers.get('content-type') || '').toLowerCase();
      if(/(?:text\/html|application\/(?:json|xhtml\+xml))/.test(type))throw new Problem('服务器返回网页提示，未保存为文件',{retryable:true});
      if(!response.body)throw new Problem('文件响应为空',{retryable:true});
      reader=response.body.getReader();
      // Validate a prefix before creating a file. A stream chunk can be 1 byte.
      const chunks=[];let prefixSize=0,ended=false;
      while(prefixSize<512 && !ended) {
        guard(signal);const chunk=await idleRead(reader,signal);
        ended=chunk.done;if(!ended){chunks.push(chunk.value);prefixSize+=chunk.value.length;}
      }
      if(prefixSize===0)throw new Problem('文件内容为空',{retryable:true});
      const prefix=new Uint8Array(Math.min(prefixSize,512));let at=0;
      for(const c of chunks){const length=Math.min(c.length,prefix.length-at);if(length<=0)break;prefix.set(c.subarray(0,length),at);at+=length;}
      const sniff=new TextDecoder().decode(prefix).replace(/^\uFEFF/,'').trimStart();
      if(/^(?:<!doctype\s+html|<html|<head|<body|<script|<\?xml[^>]*>\s*<html)/i.test(sniff) || /^\{\s*"(?:error|status|success|msg)"\s*:/.test(sniff))throw new Problem('文件内容是网页或接口提示，未保存',{retryable:true});
      if(variant.pdf && new TextDecoder().decode(prefix.subarray(0,5))!=='%PDF-')throw new Problem('PDF 文件头无效',{retryable:true});
      const resolved=await this.directory(item.dirs,signal);dir=resolved.handle;actualDirs=resolved.parts;
      const name=materialName(variant.name,dispositionName(response.headers.get('content-disposition')),'');
      reservation=await this.reserve(dir,name,signal);
      const path=[...actualDirs,reservation.name].join('/');
      if(reservation.skipped)return {status:'skipped',path,bytes:0};
      writable=await reservation.handle.createWritable();
      const totalHeader=response.headers.get('content-length');
      const rawTotal=totalHeader && /^\d+$/.test(totalHeader)?Number(totalHeader):null;
      // fetch decompresses bodies. Only compare unencoded Content-Length.
      const total=response.headers.get('content-encoding')?null:rawTotal;
      let bytes=0;
      const write=async value=>{guard(signal);await writable.write(value);bytes+=value.byteLength;onProgress({bytes,total,path});};
      for(const chunk of chunks)await write(chunk);
      while(!ended) {
        const next=await idleRead(reader,signal);ended=next.done;if(!ended)await write(next.value);
      }
      guard(signal);
      if(total!==null && bytes!==total)throw new Problem('文件传输不完整，将重新尝试',{retryable:true});
      await writable.close();committed=true;
      // Cancellation after a successful commit must not mislabel a saved file.
      return {status:'saved',path,bytes,pdf:variant.pdf};
    } catch(e) {
      conn.abort();
      if(writable && !committed)try{await writable.abort();}catch{}
      if(reservation?.created && !committed) {
        try {await dir.removeEntry(reservation.name);}
        catch {throw new Problem('传输未完成，且未能清理空文件：'+[...actualDirs,reservation.name].join('/')+'；请手动检查',{code:'cleanup'});}
      }
      throw e;
    } finally {
      if(reader)try{await reader.cancel();reader.releaseLock();}catch{}
      else try{await response.body?.cancel();}catch{}
      conn.dispose();
    }
  }
}
