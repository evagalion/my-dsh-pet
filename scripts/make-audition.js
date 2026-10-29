'use strict'

// 生成「挑音色」试听页：把 assets/tts/samples* 里的样本按模型分组列成可点播的表格，
// 并按基频（音调高低）排序 —— 音调高的听起来更年轻、更甜。
// 用法：node scripts/make-audition.js

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const TTS = path.join(ROOT, 'assets', 'tts')
const OUT = path.join(TTS, 'audition.html')

// 每个模型一组：样本目录 + 文件名规则 + 写进配置的片段
const MODELS = [
  {
    key: 'theresa',
    title: 'Theresa（804 音色，二次元角色语音训练）',
    dir: 'samples2',
    re: /^theresa-(\d+)\.wav$/,
    cfg: (sid) => ({
      engine: 'vits',
      kind: 'vits',
      dir: 'assets/tts/vits-zh-hf-theresa',
      model: 'theresa.onnx',
      sid,
    }),
  },
  {
    key: 'melo',
    title: 'MeloTTS（中英混合，自然度口碑好，单音色）',
    dir: 'samples2',
    re: /^melo\d*\.wav$/,
    sidOf: () => 0,
    cfg: () => ({
      engine: 'vits',
      kind: 'vits',
      dir: 'assets/tts/vits-melo-tts-zh_en',
      model: 'model.onnx',
      sid: 0,
    }),
  },
  {
    key: 'kokoro',
    title: 'Kokoro v1.1-zh（55 个中文女声）',
    dir: 'samples',
    re: /^zf-(\d+)\.wav$/,
    cfg: (sid) => ({
      engine: 'kokoro',
      kind: 'kokoro',
      dir: 'assets/tts/kokoro-multi-lang-v1_1',
      model: 'model.onnx',
      sid,
    }),
  },
]

// ---- 基频估算：用来给「甜度/年轻感」排序 ----

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

function collect(m) {
  const dir = path.join(TTS, m.dir)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => m.re.test(f))
    .map((f) => {
      const mm = f.match(m.re)
      const sid = m.sidOf ? m.sidOf(mm) : parseInt(mm[1], 10)
      let hz = 0
      try {
        const { s, rate } = readWav(path.join(dir, f))
        hz = Math.round(estF0(s, rate))
      } catch (e) {
        /* 读不了就排最后 */
      }
      return { sid: Number.isFinite(sid) ? sid : 0, hz, file: m.dir + '/' + f }
    })
    .sort((a, b) => b.hz - a.hz)
}

function main() {
  const groups = []
  for (const m of MODELS) {
    const rows = collect(m)
    if (!rows.length) continue
    groups.push({
      title: m.title,
      rows: rows.map((r, i) => Object.assign({}, r, { hot: i < 6, cfg: JSON.stringify(m.cfg(r.sid)) })),
    })
  }
  if (!groups.length) {
    console.error('assets/tts 下没有找到任何样本，先生成再跑这个脚本')
    process.exit(1)
  }

  const cards = (rows) =>
    rows
      .map(
        (r) => `    <div class="card${r.hot ? ' hot' : ''}">
      <div class="top">
        <span class="sid">#${r.sid}</span>
        <span class="hz">${r.hz}Hz${r.hot ? ' · 推荐' : ''}</span>
        <button class="pick" data-cfg="${r.cfg.replace(/"/g, '&quot;')}">选它</button>
      </div>
      <audio controls preload="none" src="${r.file}"></audio>
    </div>`
      )
      .join('\n')

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
  .tip { color: #6b7280; margin-bottom: 10px; }
  h2 { font-size: 14px; margin: 22px 0 10px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 12px; }
  .card .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .sid { font-weight: 600; font-variant-numeric: tabular-nums; }
  .hz { color: #0969da; font-size: 12px; }
  .pick { margin-left: auto; font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
          border: 1px solid #d0d7de; background: #f6f8fa; }
  .pick:hover { background: #eaeef2; }
  .hot { border-color: #f0c36d; background: #fffdf5; }
  audio { width: 100%; height: 32px; }
  #bar { position: sticky; top: 0; background: #f6f7f9; padding: 10px 0 12px; border-bottom: 1px solid #e5e7eb; }
  #now { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #0f6e56; }
</style>
</head>
<body>
<h1>大肥鱼 · 语音音色试听</h1>
<div class="tip">按音调从高到低排序，每组前 6 个标「推荐」。点 ▶ 试听，满意点「选它」，配置片段会自动复制，发给大肥鱼即可。</div>
<div id="bar">当前选中：<span id="now">还没选</span></div>
${groups
  .map(
    (g) => `<h2>${g.title}（${g.rows.length} 个）</h2>
<div class="grid">
${cards(g.rows)}
</div>`
  )
  .join('\n')}
<script>
  var now = document.getElementById('now')
  document.querySelectorAll('.pick').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var cfg = btn.getAttribute('data-cfg')
      document.querySelectorAll('.card').forEach(function (c) { c.classList.remove('chosen') })
      btn.closest('.card').classList.add('chosen')
      now.textContent = cfg
      if (navigator.clipboard) navigator.clipboard.writeText(cfg)
    })
  })
</script>
</body>
</html>
`
  fs.writeFileSync(OUT, html)
  console.log('已生成：' + OUT)
  for (const g of groups) console.log('  ' + g.title + '：' + g.rows.length + ' 个')
}

main()
