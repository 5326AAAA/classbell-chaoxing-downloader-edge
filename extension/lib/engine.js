import {Problem,guard,isAbort,cancelled,delay,safeError} from './core.js';

export class DownloadQueue {
  constructor({resolve,save,onUpdate=()=>{},concurrency=2,retries=2,retryDelay=1000}) {
    Object.assign(this,{resolve,save,onUpdate,concurrency:Math.max(1,Math.min(4,concurrency)),retries,retryDelay});
    this.running=false;this.tasks=[];
  }
  cancel() {this.controller?.abort(cancelled());}
  emit(task) {this.onUpdate(task,this.tasks);}
  async run(items) {
    if(this.running)throw new Problem('已有下载任务正在运行');
    this.running=true;this.controller=new AbortController();const signal=this.controller.signal;
    this.tasks=items.map(item=>({item,key:item.key,status:'pending',attempt:0,bytes:0,total:null,error:'',path:item.relativePath}));
    for(const t of this.tasks)this.emit(t);
    let cursor=0;
    const work=async()=>{
      while(cursor<this.tasks.length) {
        const task=this.tasks[cursor++];
        if(signal.aborted){task.status='cancelled';this.emit(task);continue;}
        try {
          for(let attempt=0;attempt<=this.retries;attempt++) {
            guard(signal);task.attempt=attempt+1;task.bytes=0;task.error='';task.status='resolving';this.emit(task);
            try {
              const variants=await this.resolve(task.item,signal,attempt);
              if(!variants?.length)throw new Problem('没有可用的下载地址');
              let last,result,retryableFailure;
              for(const variant of variants) {
                guard(signal);task.status='downloading';task.bytes=0;task.variant=variant.pdf?'PDF':'原文件';this.emit(task);
                try {
                  result=await this.save(task.item,variant,signal,progress=>{Object.assign(task,progress);this.emit(task);});break;
                } catch(e){if(isAbort(e)||signal.aborted||e.code==='cleanup')throw e;last=e;if(e.retryable)retryableFailure=e;}
              }
              if(!result)throw retryableFailure || last || new Problem('所有下载地址均失败',{retryable:true});
              Object.assign(task,result);task.error='';this.emit(task);break;
            } catch(e) {
              if(isAbort(e) || signal.aborted || !(e.retryable || e instanceof TypeError) || attempt===this.retries)throw e;
              task.status='retrying';task.error=safeError(e);this.emit(task);
              await delay(Math.max(this.retryDelay*2**attempt,e.retryAfterMs || 0),signal);
            }
          }
        } catch(e) {
          task.status=(isAbort(e)||signal.aborted) && e.code!=='cleanup'?'cancelled':'failed';task.error=safeError(e);this.emit(task);
        }
      }
    };
    try {await Promise.all(Array.from({length:Math.min(this.concurrency,items.length)},work));return this.tasks;}
    finally {this.running=false;}
  }
}
