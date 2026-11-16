'use strict'

;(function () {
  const api = window.chatAPI
  const log = document.getElementById('log')
  const quick = document.getElementById('quick')
  const form = document.getElementById('form')
  const input = document.getElementById('input')
  const sendBtn = document.getElementById('send')
  const hello = document.getElementById('hello')
  const hint = document.getElementById('hint')

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  function scroll() {
    log.scrollTop = log.scrollHeight
  }

  function addMsg(who, text, opts) {
    opts = opts || {}
    if (hello && hello.parentNode) hello.remove()
    const el = document.createElement('div')
    el.className = 'msg ' + (who === 'me' ? 'me' : 'pet') + (opts.offline ? ' offline' : '') + (opts.typing ? ' typing' : '')
    const label = opts.typing ? '' : '<div class="who">' + (who === 'me' ? '我' : '大肥鱼') + '</div>'
    const mode = opts.typing || opts.offline == null ? '' : '<div class="mode">' + (opts.offline ? '离线模式' : '在线 · 大模型') + '</div>'
    el.innerHTML = label + '<div class="bubble">' + esc(text) + '</div>' + mode
    log.appendChild(el)
    scroll()
    return el
  }

  function clearLog() {
    log.innerHTML =
      '<div class="hello" id="hello"><div class="hi-emoji">🐳</div>' +
      '<div class="hi-title">嗨，我是大肥鱼~</div><div class="hi-sub">随口聊两句吧，我在呢</div></div>'
  }

  function send(text) {
    text = String(text || '').trim()
    if (!text) return
    addMsg('me', text)
    input.value = ''
    const pending = addMsg('pet', '…', { typing: true })
    pending.dataset.pending = '1'
    api.send(text)
  }

  api.on('chat:init', (d) => {
    d = d || {}
    if (Array.isArray(d.quickAsks) && d.quickAsks.length) {
      quick.innerHTML = ''
      for (const q of d.quickAsks) {
        const b = document.createElement('button')
        b.className = 'chip'
        b.textContent = q
        b.addEventListener('click', () => send(q))
        quick.appendChild(b)
      }
    }
    if (d.hint) hint.textContent = d.hint
  })

  api.on('chat:reply', (d) => {
    d = d || {}
    const pending = log.querySelector('.msg[data-pending="1"]')
    if (pending) {
      pending.classList.remove('typing')
      pending.removeAttribute('data-pending')
      pending.querySelector('.bubble').textContent = d.line || '…'
      pending.classList.toggle('offline', !d.online)
      const mode = document.createElement('div')
      mode.className = 'mode'
      mode.textContent = d.online ? '在线 · 大模型' : '离线模式'
      pending.appendChild(mode)
    } else {
      addMsg('pet', d.line || '…', { offline: !d.online })
    }
    scroll()
  })

  api.on('chat:error', (d) => {
    const pending = log.querySelector('.msg[data-pending="1"]')
    if (pending) {
      pending.classList.remove('typing')
      pending.removeAttribute('data-pending')
      pending.querySelector('.bubble').textContent = '哎呀，我卡壳了：' + ((d && d.error) || '未知错误')
      pending.classList.add('offline')
    }
  })

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    send(input.value)
  })
  document.getElementById('close').addEventListener('click', () => api.close())
  document.getElementById('clear').addEventListener('click', () => {
    api.clear()
    clearLog()
  })
  input.focus()
  api.ready()
})()
