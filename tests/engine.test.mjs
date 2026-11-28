import test from 'node:test';
import assert from 'node:assert/strict';
import {DownloadQueue} from '../extension/lib/engine.js';
import {Problem,delay} from '../extension/lib/core.js';

const items=Array.from({length:6},(_,i)=>({key:String(i),name:`File ${i}`,relativePath:`Course/${i}.pdf`}));
const variant={url:'https://d0.cldisk.com/test',name:'test.pdf'};
test('transient failure retries twice and re-resolves a fresh signed URL each time',async()=>{
  let resolves=0,saves=0;const updates=[];
  const q=new DownloadQueue({retryDelay:1,resolve:async()=>{resolves++;return [variant];},save:async()=>{if(++saves<3)throw new Problem('temporary',{retryable:true});return {status:'saved',bytes:10};},onUpdate:t=>updates.push(t.status)});
  const [t]=await q.run(items.slice(0,1));assert.equal(resolves,3);assert.equal(t.attempt,3);assert.equal(t.status,'saved');assert.equal(updates.filter(x=>x==='retrying').length,2);
});
test('permanent failures do not retry; exhausted failure remains failed',async()=>{
  let n=0;const q=new DownloadQueue({retryDelay:1,resolve:async()=>[variant],save:async()=>{n++;throw new Problem('forbidden');}});
  assert.equal((await q.run(items.slice(0,1)))[0].status,'failed');assert.equal(n,1);
  q.save=async()=>{throw new Problem('temporary',{retryable:true});};assert.equal((await q.run(items.slice(0,1)))[0].attempt,3);
});
test('cancel aborts active transfers and marks every queued item cancelled',async()=>{
  let started=0;const q=new DownloadQueue({concurrency:2,resolve:async()=>[variant],save:async(_,__,signal)=>{if(++started===2)setTimeout(()=>q.cancel(),2);await delay(1000,signal);return {status:'saved'};}});
  const tasks=await q.run(items);assert.ok(tasks.every(t=>t.status==='cancelled'));assert.equal(started,2);assert.equal(q.running,false);
});
test('cancel during retry backoff aborts promptly and does not retry again',async()=>{
  let n=0;const q=new DownloadQueue({retryDelay:5000,resolve:async()=>[variant],save:async()=>{n++;throw new Problem('temporary',{retryable:true});},onUpdate:t=>{if(t.status==='retrying')q.cancel();}});
  const tasks=await q.run(items.slice(0,1));assert.equal(tasks[0].status,'cancelled');assert.equal(n,1);
});
test('successful commit at cancellation boundary is still saved; waiting files cancel',async()=>{
  const q=new DownloadQueue({concurrency:1,resolve:async()=>[variant],save:async()=>{q.cancel();return {status:'saved',bytes:10};}});
  const tasks=await q.run(items.slice(0,2));assert.equal(tasks[0].status,'saved');assert.equal(tasks[1].status,'cancelled');
});
test('manual retry of failed/cancelled tasks does not repeat saved files',async()=>{
  const saved=[];let fail=true;const q=new DownloadQueue({retries:0,resolve:async()=>[variant],save:async item=>{if(item.key==='1'&&fail)throw new Problem('failed');saved.push(item.key);return {status:'saved'};}});
  const first=await q.run(items.slice(0,2));fail=false;const retry=first.filter(t=>['failed','cancelled'].includes(t.status)).map(t=>t.item);
  await q.run(retry);assert.deepEqual(saved,['0','1']);
});
test('concurrency is bounded and a second run cannot replace an active queue',async()=>{
  let active=0,peak=0;const q=new DownloadQueue({concurrency:3,resolve:async()=>[variant],save:async()=>{peak=Math.max(peak,++active);await delay(5);active--;return {status:'saved'};}});
  const run=q.run(items);await assert.rejects(q.run(items),/已有下载/);await run;assert.equal(peak,3);
});
test('PDF fallback and skipped conflicts have distinct final states',async()=>{
  const q=new DownloadQueue({resolve:async()=>[variant,{...variant,pdf:true,name:'fallback.pdf'}],save:async(_,v)=>{if(!v.pdf)throw new Problem('original failed');return {status:'saved',pdf:true,path:'Course/fallback.pdf'};}});
  assert.equal((await q.run(items.slice(0,1)))[0].pdf,true);
  q.save=async()=>({status:'skipped',bytes:0});assert.equal((await q.run(items.slice(0,1)))[0].status,'skipped');
});
test('cleanup failure is a visible failed task even if cancellation occurred',async()=>{
  const q=new DownloadQueue({resolve:async()=>[variant],save:async()=>{q.cancel();throw new Problem('cleanup failed',{code:'cleanup'});}});
  assert.equal((await q.run(items.slice(0,1)))[0].status,'failed');
});
