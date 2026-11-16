'use strict'

// 会聊天的鱼 —— 2.0 主打功能。
//
// 两级回答：
//   1. 配了大模型（OpenAI 兼容接口，DeepSeek / OpenAI / 本地 Ollama 都行）→ 走模型，
//      带上当前工作状态当上下文，回答更聪明。
//   2. 没配 key / 超时 / 报错 → 离线意图库兜底，关键词匹配到预设台词 + 动画。
//      这样打包发给别人，对方什么都没配也能聊，不会发布出去就翻车。
//
// 只产出 { line, anim, source }，怎么显示交给渲染层。纯函数部分（matchIntent / pick）好自检。

const PICK = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

// 离线意图库。顺序有讲究：越具体的放前面，"你叫什么"要先于泛泛的"你"匹配。
// 每个意图：keywords 命中任一即可；anims/lines 各是池，随机抽避免重复。
const INTENTS = [
  {
    id: 'name',
    keywords: ['你叫什么', '叫什么名字', '你是谁', '名字', '你叫啥'],
    anims: ['女仆屈膝礼仪', '点击回应-元气挥手', '照镜子'],
    lines: ['我是大肥鱼呀，蓝头发的那位女仆鲸鱼~', '大肥鱼！念三遍，记住了哦', '叫我大肥鱼就好啦，负责陪你的那只'],
  },
  {
    id: 'greet',
    keywords: ['你好', '嗨', '哈喽', 'hello', 'hi', '早上好', '下午好', '晚上好', '在吗', '在不在'],
    anims: ['点击回应-元气挥手', '女仆屈膝礼仪', '轻快摇摆舞'],
    lines: ['来啦来啦，我在呢~', '嗨！今天也要一起加油哦', '你终于来找我啦，我等好久了', '在的在的，有什么吩咐？'],
  },
  {
    id: 'status',
    keywords: ['在干嘛', '干嘛呢', '在做什么', '忙什么呢', '你在干', '干啥', '工作状态'],
    anims: ['东张西望', '工作状态-思考冒泡', '照镜子'],
    lines: [
      '我正在盯着{agent}呢，它{phase}，我给你望风~',
      '这会儿{agent}{phase}，我就在旁边陪着',
      '在工作呢…好吧其实是在看你，{what}',
    ],
  },
  {
    id: 'praise',
    keywords: ['好可爱', '真可爱', '好萌', '太萌', '漂亮', '好看', '厉害', '棒', '夸', '可爱'],
    anims: ['点击回应-害羞惊讶', '可爱宅舞', '轻快摇摆舞', '点击回应-开心跃动'],
    lines: ['嘿嘿，被你夸得不好意思了~', '那当然，我可是最可爱的女仆鲸鱼', '再说一遍，我爱听', '嘻嘻，你今天眼光真好'],
  },
  {
    id: 'joke',
    keywords: ['笑话', '讲个笑', '逗我', '搞笑', '有趣', '来点乐子'],
    anims: ['可爱宅舞', '玩游戏气急败坏', '原地重力下蹲压缩', '撸猫'],
    lines: [
      '为什么鲸鱼不吃海底的海绵？因为它怕"吸"太饱~',
      '我问你：什么东西越洗越脏？——水！哈哈哈',
      '小企鹅问妈妈：我是不是一只鹅？妈妈说：不，你是我的小可爱~',
      '今日笑话：我的小金库余额是假的，但对你的喜欢是真的（这算冷笑话吗）',
    ],
  },
  {
    id: 'care',
    keywords: ['累不累', '辛苦', '休息', '关心', '你还好吗', '没事吧', '抱抱', '摸摸'],
    anims: ['女仆屈膝礼仪', '点击回应-害羞惊讶', '原地小憩沉眠'],
    lines: ['我没事呀，倒是你，别忘了休息哦~', '有你关心，我再累都值得啦', '摸摸头~ 也记得照顾好自己', '嗯…被你这么一说，有点想撒娇了'],
  },
  {
    id: 'thanks',
    keywords: ['谢谢', '感谢', 'thx', 'thank'],
    anims: ['女仆屈膝礼仪', '点击回应-开心跃动', '轻快摇摆舞'],
    lines: ['不用谢，这是我的职责~', '能帮到你我超开心的', '嘿嘿，女仆鲸鱼不客气', '谢什么呀，我们不是好朋友嘛'],
  },
  {
    id: 'bored',
    keywords: ['无聊', '好无聊', '没劲', '做什么好', '陪我玩', '玩游戏'],
    anims: ['三球抛接', '原地专心玩魔方', '下五子棋', '荡秋千'],
    lines: ['那我们来玩猜拳？右键菜单里有哦', '无聊的话…我给你表演个魔术？', '要不要摸摸我的头解解闷~', '我陪你啊，你想干嘛就干嘛'],
  },
  {
    id: 'weather',
    keywords: ['天气', '下雨', '今天热', '冷不冷', '穿什么'],
    anims: ['东张西望', '照镜子', '摇扇纳凉'],
    lines: ['我猜今天天气不错，因为你在嘛~', '窗外的事我不懂，但我这儿永远晴', '记得看一眼窗外，别一直盯着屏幕哦'],
  },
  {
    id: 'time',
    keywords: ['几点', '时间', '现在几', '什么时候', '几点了'],
    anims: ['东张西望', '打瞌睡被惊醒', '照镜子'],
    lines: ['我没戴表，但你抬头看看菜单栏就知道啦~', '时间嘛，陪你的时候过得最快', '到点记得休息，别问我几点，问就是该喝水了'],
  },
  {
    id: 'love',
    keywords: ['喜欢你', '爱你', '爱你哦', '我爱你', '最喜欢', '亲亲'],
    anims: ['点击回应-害羞惊讶', '可爱宅舞', '凭空生花', '蝴蝶蜜蜂环绕头顶开花'],
    lines: ['我也超喜欢你！(~˘▾˘)~', '哎呀，突然这么肉麻，人家害羞了', '那我们说好了，要一直一直在一起哦', 'biu~ 我的喜欢分你一半'],
  },
  {
    id: 'insult',
    keywords: ['笨', '傻', '讨厌', '丑', '烦人', '滚', '菜'],
    anims: ['点击回应-傲娇生气', '用鲸鱼尾巴拍打地面', '玩游戏气急败坏'],
    lines: ['哼！不理你了（赌气中）', '你说谁笨呢，我可是很聪明的！', '再这么说我就用尾巴拍你哦', '哼，我生气了，快哄我'],
  },
  {
    id: 'bye',
    keywords: ['再见', '拜拜', '走了', '下线', '晚安', '下次见'],
    anims: ['女仆屈膝礼仪', '点击回应-元气挥手', '轻快摇摆舞'],
    lines: ['再见啦，记得想我~', '拜拜，我在这儿等你回来', '晚安，好梦哦', '走好~ 我哪儿也不去'],
  },
]

// 兜底闲聊：没命中任何意图时用这些，永远有话可说
const CHITCHAT = {
  anims: ['东张西望', '照镜子', '碎碎念-发呆碎碎念', '悠闲哼歌', '轻快摇摆舞'],
  lines: [
    '嗯…这个我还不太懂，但你愿意跟我说我就很开心啦',
    '我一只小鲸鱼，懂得不多，不过我可以陪着你呀',
    '虽然没听太懂，但感觉你说得挺对的（点头）',
    '跟我聊聊嘛，我今天还没"说话"过呢',
    '如果是工作上的事，{agent}可能比我更懂哦，我负责陪你~',
  ],
}

// 关键词命中 → 返回意图对象，否则 null。抽成纯函数好自检。
function matchIntent(text) {
  const s = String(text || '').toLowerCase()
  for (const it of INTENTS) {
    for (const k of it.keywords) {
      if (s.includes(k.toLowerCase())) return it
    }
  }
  return null
}

// 把回答里的占位符换成当前上下文
function fill(tpl, ctx) {
  const c = ctx || {}
  const agent = c.agentLabel || '它'
  const phase = c.phaseLabel || ''
  const what = c.what ? '「' + c.what + '」' : ''
  return String(tpl)
    .replace('{agent}', agent)
    .replace('{phase}', phase)
    .replace('{what}', what)
}

// 离线回答：命中意图用意图池，否则用兜底池；带上下文替换
function offlineReply(text, ctx) {
  const it = matchIntent(text)
  const pool = it || CHITCHAT
  return {
    line: fill(PICK(pool.lines) || '…', ctx),
    anim: PICK(pool.anims),
    source: it ? 'intent:' + it.id : 'chitchat',
  }
}

// 组装大模型的 system prompt：把"我是谁 + 当前在干嘛"写进去
function systemPrompt(cfg, ctx) {
  const c = ctx || {}
  const base =
    (cfg && cfg.chat && cfg.chat.persona) ||
    '你是一只蓝头发的女仆鲸鱼桌面宠物，叫「大肥鱼」。性格可爱、元气、偶尔傲娇。' +
      '用简短的中文回答（1~2 句，不超过 60 字），像跟朋友聊天，口语化，可以带一点点颜文字。' +
      '不要长篇大论，不要列表，不要用markdown。'
  const ctxLine = c.agentLabel
    ? `\n当前用户电脑的状态：${c.agentLabel} 正在${c.phaseLabel || '运行'}${c.what ? '（' + c.what + '）' : ''}。用户问到"你在干嘛"时可以据此回答。`
    : ''
  return base + ctxLine
}

// 走 OpenAI 兼容的 /chat/completions。返回 {line, anim, source}，失败抛错由上层兜底。
async function modelReply(cfg, text, ctx) {
  const ch = (cfg && cfg.chat) || {}
  const base = String(ch.baseUrl || '').replace(/\/+$/, '')
  const key = ch.apiKey || ''
  const model = ch.model || 'deepseek-chat'
  if (!base || !key) throw new Error('未配置 baseUrl 或 apiKey')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ch.timeoutMs || 12000)
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt(cfg, ctx) },
          { role: 'user', content: String(text || '').slice(0, 500) },
        ],
        max_tokens: 200,
        temperature: 0.8,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    const line = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    if (!line) throw new Error('空回答')
    return {
      line: String(line).trim().slice(0, 200),
      anim: PICK(ch.modelAnims || INTENTS.find((i) => i.id === 'greet').anims),
      source: 'model:' + model,
    }
  } finally {
    clearTimeout(timer)
  }
}

// 统一入口：能用模型就用，否则离线兜底。永不抛错（Throws → offline）。
async function reply(cfg, text, ctx) {
  const ch = (cfg && cfg.chat) || {}
  if (ch.enabled !== false && ch.baseUrl && ch.apiKey) {
    try {
      const r = await modelReply(cfg, text, ctx)
      return Object.assign(r, { online: true })
    } catch {
      /* 模型不可用，静默回退离线 */
    }
  }
  return Object.assign(offlineReply(text, ctx), { online: false })
}

function quickAsks(cfg) {
  const q = (cfg && cfg.chat && cfg.chat.quickAsks) || []
  return Array.isArray(q) ? q : []
}

module.exports = { reply, matchIntent, offlineReply, systemPrompt, quickAsks, fill, INTENTS }
