// 離線快取：install 時預抓 vision 模型（18MB，下載一次後斷網也能開）；HTML 走 network-first
const CACHE='tapthrough-20260905c';
const PRECACHE=['./index.html','./vision/index.html','./vision/kiosk-refs.json','./vision/kiosk/model.json','./vision/model/model.json','./vision/model/group1-shard1of5','./vision/model/group1-shard2of5','./vision/model/group1-shard3of5','./vision/model/group1-shard4of5','./vision/model/group1-shard5of5','./vision/kiosk/group1-shard1of1','./vision/kiosk/group10-shard1of1','./vision/kiosk/group11-shard1of1','./vision/kiosk/group12-shard1of1','./vision/kiosk/group13-shard1of1','./vision/kiosk/group14-shard1of1','./vision/kiosk/group15-shard1of1','./vision/kiosk/group16-shard1of1','./vision/kiosk/group17-shard1of1','./vision/kiosk/group18-shard1of1','./vision/kiosk/group19-shard1of1','./vision/kiosk/group2-shard1of1','./vision/kiosk/group20-shard1of1','./vision/kiosk/group21-shard1of1','./vision/kiosk/group22-shard1of1','./vision/kiosk/group23-shard1of1','./vision/kiosk/group24-shard1of1','./vision/kiosk/group25-shard1of1','./vision/kiosk/group26-shard1of1','./vision/kiosk/group27-shard1of1','./vision/kiosk/group28-shard1of1','./vision/kiosk/group29-shard1of1','./vision/kiosk/group3-shard1of1','./vision/kiosk/group30-shard1of1','./vision/kiosk/group31-shard1of1','./vision/kiosk/group32-shard1of1','./vision/kiosk/group33-shard1of1','./vision/kiosk/group34-shard1of1','./vision/kiosk/group35-shard1of1','./vision/kiosk/group36-shard1of1','./vision/kiosk/group37-shard1of1','./vision/kiosk/group38-shard1of1','./vision/kiosk/group39-shard1of1','./vision/kiosk/group4-shard1of1','./vision/kiosk/group40-shard1of1','./vision/kiosk/group41-shard1of1','./vision/kiosk/group42-shard1of1','./vision/kiosk/group43-shard1of1','./vision/kiosk/group44-shard1of1','./vision/kiosk/group45-shard1of1','./vision/kiosk/group46-shard1of1','./vision/kiosk/group47-shard1of1','./vision/kiosk/group48-shard1of1','./vision/kiosk/group49-shard1of1','./vision/kiosk/group5-shard1of1','./vision/kiosk/group50-shard1of1','./vision/kiosk/group51-shard1of1','./vision/kiosk/group52-shard1of1','./vision/kiosk/group53-shard1of1','./vision/kiosk/group54-shard1of1','./vision/kiosk/group55-shard1of1','./vision/kiosk/group6-shard1of1','./vision/kiosk/group7-shard1of1','./vision/kiosk/group8-shard1of1','./vision/kiosk/group9-shard1of1','./vision/lib/coco-ssd.min.js','./vision/lib/jsQR.js','./vision/lib/qrcode.js','./vision/lib/tf.min.js'];
self.addEventListener('install',e=>e.waitUntil((async()=>{
  const c=await caches.open(CACHE);
  // 逐檔 best-effort：單檔失敗不讓整個 install 掛掉
  await Promise.all(PRECACHE.map(u=>c.add(u).catch(()=>{})));
  await self.skipWaiting();
})()));
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('tapthrough-')&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(u.origin!==self.location.origin)return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
    if(resp&&resp.ok&&resp.type==='basic'){const cl=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cl));}
    return resp;
  })));
});
