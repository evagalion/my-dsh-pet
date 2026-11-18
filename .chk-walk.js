'use strict'
const { app, BrowserWindow } = require('electron')
const path=require('path'), fs=require('fs')
const ROOT='/Users/danghaoyu/WorkBuddy/大肥鱼'
const html=`<!doctype html><html><body><video id="v" muted playsinline></video><canvas id="c"></canvas><script>
const v=document.getElementById('v'),c=document.getElementById('c');
window.__load=s=>new Promise(r=>{v.onloadeddata=()=>{c.width=v.videoWidth;c.height=v.videoHeight;r(v.duration)};v.src='file://'+s;v.load()});
window.__grab=t=>new Promise(r=>{v.currentTime=t;v.onseeked=()=>{const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(v,0,0);r(c.toDataURL('image/png'))}});
<\/script></body></html>`
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false,webPreferences:{webSecurity:false,backgroundThrottling:false}})
  await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html))
  for(const name of ['巡游走路-左','巡游走路-右']){
    const dur=await w.webContents.executeJavaScript(`window.__load(${JSON.stringify(path.join(ROOT,'assets/webm',name+'.webm'))})`)
    const g=await w.webContents.executeJavaScript(`window.__grab(${Math.min(2.5,dur-0.1)})`)
    fs.writeFileSync('/tmp/pet-motion/'+name+'.png',Buffer.from(g.split(',')[1],'base64'))
    console.log('CHK '+name+' dur='+dur.toFixed(2))
  }
  setTimeout(()=>app.quit(),100)
})
