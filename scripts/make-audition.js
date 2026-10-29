'use strict'

// 生成「挑音色」试听页：把 assets/tts/samples 里的样本列成可点播的表格。
// 用法：node scripts/make-audition.js

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SAMPLES = path.join(ROOT, 'assets', 'tts', 'samples')
const OUT = path.join(ROOT, 'assets', 'tts', 'audition.html')

// sherpa-onnx kokoro-multi-lang-v1_1 的 sid -> 音色名映射（只列中文女声 zf_*）
const SID2NAME = {
  3: 'zf_001', 4: 'zf_002', 5: 'zf_003', 6: 'zf_004', 7: 'zf_005', 8: 'zf_006', 9: 'zf_007',
  10: 'zf_008', 11: 'zf_017', 12: 'zf_018', 13: 'zf_019', 14: 'zf_021', 15: 'zf_022', 16: 'zf_023',
  17: 'zf_024', 18: 'zf_026', 19: 'zf_027', 20: 'zf_028', 21: 'zf_032', 22: 'zf_036', 23: 'zf_038',
  24: 'zf_039', 25: 'zf_040', 26: 'zf_042', 27: 'zf_043', 28: 'zf_044', 29: 'zf_046', 30: 'zf_047',
  31: 'zf_048', 32: 'zf_049', 33: 'zf_051', 34: 'zf_059', 35: 'zf_060', 36: 'zf_067', 37: 'zf_070',
  38: 'zf_071', 39: 'zf_072', 40: 'zf_073', 41: 'zf_074', 42: 'zf_075', 43: 'zf_076', 44: 'zf_077',
  45: 'zf_078', 46: 'zf_079', 47: 'zf_083', 48: 'zf_084', 49: 'zf_085', 50: 'zf_086', 51: 'zf_087',
  52: 'zf_088', 53: 'zf_090', 54: 'zf_092', 55: 'zf_093', 56: 'zf_094', 57: 'zf_099',
}

// ---- 基频估算：用来给「甜度/年轻感」排个序，省得 55 个挨个听 ----

function readWav(file) {
  const b = fs.readFileSync(file)
  let off = 12
  let rate = 24000
  let data = null
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4)
    const sz = b.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
    else if (id === 'data') {
      data = b.slice(off + 8, off + 8 + sz)
      break
    }
    off += 8 + sz + (sz % 2)
  }
  const n = Math.floor(data.length / 2)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2) / 32768
  return { s, rate }
}

function estF0(sig, rate) {
  const W = 1024
  const H = 512
  const out = []
  for (let p = 0; p + W < sig.length; p += H) {
    let e = 0
    for (let i = 0; i < W; i++) e += sig[p + i] * sig[p + i]
    if (e / W < 0.002) continue // 静音段跳过
    let best = 0
    let bestLag = 0
    for (let lag = Math.floor(rate / 400); lag <= Math.floor(rate / 70); lag++) {
      let c = 0
      for (let i = 0; i < W - lag; i++) c += sig[p + i] * sig[p + i + lag]
      c /= W - lag
      if (c > best) {
        best = c
        bestLag = lag
      }
    }
    if (bestLag) out.push(rate / bestLag)
  }
  if (!out.length) return 0
  out.sort((a, b) => a - b)
  return out[Math.floor(out.length / 2)] // 取中位数
}

function main() {
  if (!fs.existsSync(SAMPLES)) {
    console.error('没有找到样本目录：' + SAMPLES)
    process.exit(1)
  }
  const files = fs
    .readdirSync(SAMPLES)
    .filter((f) => f.endsWith('.wav'))
    .sort((a, b) => {
      const na = parseInt(String(a).replace(/\D/g, ''), 10)
      const nb = parseInt(String(b).replace(/\D/g, ''), 10)
      return na - nb
    })

  const rows = files
    .map((f) => {
      const sid = parseInt(String(f).replace(/\D/g, ''), 10)
      const name = SID2NAME[sid] || '未知'
      let hz = 0
      try {
        const { s, rate } = readWav(path.join(SAMPLES, f))
        hz = Math.round(estF0(s, rate))
      } catch (e) {
        /* 读不了就不排序，按 0 处理 */
      }
      return { sid, name, hz, file: 'samples/' + f }
    })
    .filter((r) => Number.isFinite(r.sid))
    .sort((a, b) => b.hz - a.hz) // 音调高的排前面：听起来更年轻、更甜

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>大肥鱼 · 语音音色试听</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 0; padding: 24px;
         background: #f6f7f9; color: #1f2328; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .tip { color: #6b7280; margin-bottom: 18px; }
  .hz { color: #0969da; font-size: 12px; }
  .hot { border-color: #f0c36d; background: #fffdf5; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; }
  .card .top { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .sid { font-weight: 600; font-variant-numeric: tabular-nums; }
  .name { color: #6b7280; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pick { margin-left: auto; font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
          border: 1px solid #d0d7de; background: #f6f8fa; }
  .pick:hover { background: #eaeef2; }
  audio { width: 100%; height: 32px; }
  .chosen { background: #fff8e1; border-color: #f0c36d; }
  #bar { position: sticky; top: 0; background: #f6f7f9; padding: 8px 0 12px; }
  #now { font-weight: 600; }
</style>
</head>
<body>
<h1>大肥鱼 · 语音音色试听（Kokoro 中文女声）</h1>
<div class="tip">共 ${rows.length} 个音色，已按音调从高到低排序（前 8 个标「推荐」，听起来更年轻、更甜）。点 ▶ 试听，满意就点「选它」，sid 会自动复制，把它告诉我即可。</div>
<div id="bar">当前选中：<span id="now">还没选</span></div>
<div class="grid">
${rows
  .map(
    (r, i) => `  <div class="card${i < 8 ? ' hot' : ''}" data-sid="${r.sid}">
    <div class="top"><span class="sid">#${r.sid}</span><span class="name">${r.name}</span>
      <span class="hz">${r.hz}Hz${i < 8 ? ' · 推荐' : ''}</span>
      <button class="pick" data-sid="${r.sid}">选它</button></div>
    <audio controls preload="none" src="${r.file}"></audio>
  </div>`
  )
  .join('\n')}
</div>
<script>
  var now = document.getElementById('now')
  document.querySelectorAll('.pick').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sid = btn.getAttribute('data-sid')
      document.querySelectorAll('.card').forEach(function (c) { c.classList.remove('chosen') })
      btn.closest('.card').classList.add('chosen')
      now.textContent = 'sid = ' + sid
      navigator.clipboard && navigator.clipboard.writeText(sid)
    })
  })
</script>
</body>
</html>
`
  fs.writeFileSync(OUT, html)
  console.log('已生成：' + OUT)
  console.log('样本数：' + rows.length)
}

main()
