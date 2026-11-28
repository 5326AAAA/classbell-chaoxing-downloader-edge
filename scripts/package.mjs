import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(resolve(root,'extension/manifest.json'),'utf8'));
const files=[];
async function walk(dir){
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(['node_modules','.git'].includes(entry.name))continue;
    const path=resolve(dir,entry.name);
    if(entry.isSymbolicLink())throw new Error('交付目录不能包含符号链接：'+entry.name);
    if(entry.isDirectory())await walk(path);else if(entry.isFile())files.push(path);
  }
}
await walk(root);files.sort();
const table=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc=buf=>{let c=0xffffffff;for(const byte of buf)c=table[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const local=[],central=[];let offset=0;
for(const file of files){
  const name=Buffer.from('ClassBell-Edge/'+relative(root,file).replaceAll('\\','/'),'utf8'),body=await readFile(file),sum=crc(body);
  // Standard ZIP, UTF-8 filenames, STORE method; fixed date for reproducible archives.
  const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50);lh.writeUInt16LE(20,4);lh.writeUInt16LE(0x800,6);lh.writeUInt16LE(0,8);lh.writeUInt16LE(0x5d78,12);lh.writeUInt32LE(sum,14);lh.writeUInt32LE(body.length,18);lh.writeUInt32LE(body.length,22);lh.writeUInt16LE(name.length,26);
  local.push(lh,name,body);
  const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(0x800,8);ch.writeUInt16LE(0x5d78,14);ch.writeUInt32LE(sum,16);ch.writeUInt32LE(body.length,20);ch.writeUInt32LE(body.length,24);ch.writeUInt16LE(name.length,28);ch.writeUInt32LE(offset,42);central.push(ch,name);offset+=lh.length+name.length+body.length;
}
const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...local,dir,end]),name=`ClassBell-Edge-v${manifest.version}-source.zip`,out=resolve(root,'..',name);
await writeFile(out,zip);const hash=createHash('sha256').update(zip).digest('hex');
await writeFile(out+'.sha256',hash+'  '+name+'\n');console.log(`${name}: ${files.length} files, ${zip.length} bytes\nSHA256 ${hash}`);
