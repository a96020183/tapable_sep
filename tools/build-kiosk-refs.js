// 用法：把實拍機台照片放到 <repo>/_qa_photos/（不進 git），在 repo 根目錄 python -m http.server 4182，
// 然後 node tools/build-kiosk-refs.js → 輸出 kiosk-refs.new.json（門檻依正負樣本 margin 決定，本作品採 0.72）。
// 照片本體含個資，絕不提交。
// refs 擴充器：貪婪覆蓋到全部照片 >=0.75，refs 上限 12，驗負樣本
const {chromium}=require('playwright');
const fs=require('fs');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  const ctx=await browser.newContext({viewport:{width:640,height:480}});
  const mp=await ctx.newPage();
  await mp.goto('http://127.0.0.1:4182/vision/index.html?marker=1',{waitUntil:'networkidle'});
  await mp.waitForTimeout(800);
  const markerPng=(await mp.screenshot({type:'png'})).toString('base64');
  await mp.close();
  const files=fs.readdirSync('tvd-model/_qa_photos').filter(f=>/\.jpg$/i.test(f)).sort();
  const page=await ctx.newPage();
  page.on('pageerror',e=>console.log('ERR',e.message));
  await page.goto('http://127.0.0.1:4182/vision/index.html?nospeech=1',{waitUntil:'load'});
  const out=await page.evaluate(async({files,markerPng})=>{
    await tf.ready();
    const base=await tf.loadLayersModel('./kiosk/model.json');
    const knet=tf.model({inputs:base.inputs,outputs:base.getLayer('conv_pw_13_relu').output});
    const refsJ=await(await fetch('./kiosk-refs.json')).json();
    const kcv=document.createElement('canvas');kcv.width=224;kcv.height=224;
    const kcx=kcv.getContext('2d',{willReadFrequently:true});
    const embed=()=>tf.tidy(()=>{const t=tf.browser.fromPixels(kcv).toFloat().sub(127.5).div(127.5).expandDims(0);const f=knet.predict(t).mean([1,2]);return Array.from(f.div(f.norm(2,1,true)).dataSync())});
    const loadImg=src=>new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>no(new Error('img load fail: '+src.slice(0,80)));i.src=src});
    // 與 app 相同：cover 到 640x480 的 view，再全幅壓 224（app 的 full zone）
    const view=document.createElement('canvas');view.width=640;view.height=480;
    const vctx=view.getContext('2d');
    async function embedOf(src){
      const img=await loadImg(src);
      const s=Math.max(640/img.width,480/img.height),w=img.width*s,h=img.height*s;
      vctx.clearRect(0,0,640,480);vctx.drawImage(img,(640-w)/2,(480-h)/2,w,h);
      kcx.drawImage(view,0,0,640,480,0,0,224,224);
      return embed();
    }
    const sim=(a,b)=>{let d=0;for(let i=0;i<a.length;i++)d+=a[i]*b[i];return d};
    const best=(v,refs)=>Math.max(...refs.map(r=>sim(v,r)));
    const emb={};
    for(const f of files)emb[f]=await embedOf('../_qa_photos/'+encodeURIComponent(f));
    // 負樣本
    const negs={};
    function synth(fill){vctx.fillStyle=fill;vctx.fillRect(0,0,640,480);kcx.drawImage(view,0,0,640,480,0,0,224,224);return embed()}
    negs['純黑']=synth('#000');negs['純白']=synth('#fff');negs['純綠']=synth('#3a3');
    const g=vctx.createLinearGradient(0,0,640,480);g.addColorStop(0,'#123');g.addColorStop(1,'#eda');negs['漸層']=synth(g);
    const id=vctx.createImageData(640,480);for(let i=0;i<id.data.length;i++)id.data[i]=Math.random()*255;vctx.putImageData(id,0,0);kcx.drawImage(view,0,0,640,480,0,0,224,224);negs['噪點']=embed();
    negs['marker頁']=await embedOf('data:image/png;base64,'+markerPng);
    // 貪婪：從原 6 refs 出發，最低者入 refs 直到全 >=0.75 或 refs 滿 12
    const refs=refsJ.refs.slice();const added=[];
    for(let iter=0;iter<20;iter++){
      let low=null,lowSim=1;
      for(const f of files){const s=best(emb[f],refs);if(s<lowSim){lowSim=s;low=f}}
      if(lowSim>=0.75||refs.length>=12)break;
      refs.push(emb[low]);added.push({photo:low,was:+lowSim.toFixed(3)});
    }
    const finalPos=files.map(f=>({f,sim:+best(emb[f],refs).toFixed(3)}));
    const finalNeg=Object.entries(negs).map(([k,v])=>({k,sim:+best(v,refs).toFixed(3)}));
    return {added,finalPos,finalNeg,nRefs:refs.length,refs};
  },{files,markerPng});
  fs.writeFileSync('refs-report.json',JSON.stringify({added:out.added,pos:out.finalPos,neg:out.finalNeg,nRefs:out.nRefs},null,1));
  fs.writeFileSync('kiosk-refs.new.json',JSON.stringify({threshold:0.70,refs:out.refs.map(r=>r.map(x=>+x.toFixed(6)))}));
  console.log('新增 refs:',JSON.stringify(out.added));
  console.log('正樣本最低:',Math.min(...out.finalPos.map(p=>p.sim)),'負樣本最高:',Math.max(...out.finalNeg.map(n=>n.sim)));
  console.log('refs 總數:',out.nRefs);
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
