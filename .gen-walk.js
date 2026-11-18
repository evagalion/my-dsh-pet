'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = '/Users/danghaoyu/WorkBuddy/大肥鱼'
const SRC = path.join(ROOT, 'assets/webm/螃蟹走路.webm')
const OUT = '/tmp/pet-motion'
fs.mkdirSync(OUT, { recursive: true })

// "原地朝一个方向走"的循环素材：窗口负责真实平移，素材只负责朝对方向迈步，
// 脚步方向 == 窗口移动方向，消除"踩滑板"感。
// 源素材角色侧脸朝左(稳定区间[1.6,7.8])，从1.6播到7.8(约6.2s)正好不碰到正面过渡帧。
// 生成两份：巡游走路-左(原样朝左)、巡游走路-右(水平镜像朝右)。
const html = `<!doctype html><html><body>
<video id="walk" muted playsinline></video><canvas id="c"></canvas>
<script>
const walk=document.getElementById('walk'), c=document.getElementById('c')
const LO=1.6, HI=7.8
window.__load=function(w){return new Promise(function(res){walk.onloadeddata=function(){res()};walk.src='file://'+w;walk.load()})}

window.__gen=function(mirror){
  c.width=640; c.height=360
  return new Promise(async function(res){
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8'
    const ctx=c.getContext('2d',{willReadFrequently:true})
    function frame(){
      ctx.clearRect(0,0,640,360)
      ctx.save()
      if(mirror){ ctx.translate(640,0); ctx.scale(-1,1) }
      ctx.drawImage(walk,0,0,640,360)
      ctx.restore()
    }
    walk.currentTime=LO
    await new Promise(r=>walk.onseeked=r)
    frame()
    const stream=c.captureStream(30)
    const rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:2400000})
    const chunks=[]; rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)}
    const stopped=new Promise(r=>rec.onstop=r)
    rec.start()
    walk.play()
    const ticker=setInterval(frame,1000/30)
    // 播到接近 HI 时停（留一点余量避免碰到正面帧）
    const watch=setInterval(()=>{ if(walk.currentTime>=HI-0.15){ clearInterval(ticker); clearInterval(watch); rec.stop() } },50)
    // 兜底：最多 8 秒强制停
    setTimeout(()=>{ clearInterval(ticker); clearInterval(watch); try{rec.stop()}catch(e){} },8000)
    await stopped
    walk.pause(); stream.getTracks().forEach(x=>x.stop())
    const blob=new Blob(chunks,{type:mime}); const buf=await blob.arrayBuffer()
    let bin='';const u8=new Uint8Array(buf)
    for(let k=0;k<u8.length;k+=8192) bin+=String.fromCharCode.apply(null,u8.subarray(k,k+8192))
    res({mime,bytes:blob.size,b64:btoa(bin),lastT:walk.currentTime})
  })
}
<\/script></body></html>`

app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{webSecurity:false,backgroundThrottling:false}})
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html))
  await win.webContents.executeJavaScript(`window.__load(${JSON.stringify(SRC)})`)
  console.log('SRC loaded')
  for(const [mirror,name] of [[false,'巡游走路-左'],[true,'巡游走路-右']]){
    const r=await win.webContents.executeJavaScript(`window.__gen(${mirror})`)
    const dest=path.join(ROOT,'assets/webm',name+'.webm')
    fs.writeFileSync(dest,Buffer.from(r.b64,'base64'))
    console.log('SAVED '+JSON.stringify({name,bytes:r.bytes,lastT:+r.lastT.toFixed(2)}))
  }
  setTimeout(()=>app.quit(),200)
})
