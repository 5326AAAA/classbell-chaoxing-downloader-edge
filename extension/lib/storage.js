function openDB() {
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open('classbell-materials',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('settings');
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
}
export async function getSetting(key) {
  const db=await openDB();
  try{return await new Promise((resolve,reject)=>{
    const t=db.transaction('settings','readonly');const r=t.objectStore('settings').get(key);
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });}finally{db.close();}
}
export async function setSetting(key,value) {
  const db=await openDB();
  try{await new Promise((resolve,reject)=>{
    const t=db.transaction('settings','readwrite');t.objectStore('settings').put(value,key);
    t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);
  });}finally{db.close();}
}
