# 大肥鱼桌宠 🐳

一只住在你桌面右下角的大肥鱼（鲸鱼娘）。它会自己待机呼吸、随机做八十多种小动作，也会**看你本地的 WorkBuddy 和 Cursor 在干什么**，然后切成对应的工作状态动画，头顶冒泡告诉你现在在跑哪个项目。

技术栈：**Electron + 原生 HTML/CSS/JS**（参考 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的桌宠本体设计，去掉了它的插件宿主层，换成直连本机 AI 工具的探测层）。

---

## 快速开始

```bash
cd ~/WorkBuddy/大肥鱼
npm install
npm start
```

> 如果你是在某个 Electron 应用（WorkBuddy / Cursor / VS Code）的内嵌终端里跑，环境变量 `ELECTRON_RUN_AS_NODE` 会让 Electron 退化成普通 Node 而启动失败。启动脚本里已经用 `env -u ELECTRON_RUN_AS_NODE` 规避掉了。

其它命令：

```bash
npm run selftest   # 无头自检：窗口是否创建、素材是否加载、视频是否解码，结果写 /tmp/pet-selftest.json
npm run probe      # 只测探测层，不弹窗，打印 WorkBuddy / Cursor 当前状态
npm run icon       # 重新生成托盘图标 assets/tray.png
```

---

## 联动原理

桌宠不连网、不改你的任何配置，只读本机已经存在的文件。

| 工具 | 读什么 | 拿到什么 |
| --- | --- | --- |
| **WorkBuddy** | `~/.workbuddy/workbuddy.db` 的 `sessions` 表 | **`status`（working / completed / error —— 判定以它为准）**、`cwd`（当前项目）、`title`（会话标题）、`updated_at` + `last_activity_at`（两者取更近的当活性） |
| | `~/.workbuddy/changes-index/<sessionId>.json` 的 mtime | 最近一次改文件的时间 → 区分「在想」还是「在写」 |
| **Cursor** | `~/.cursor/projects/<项目>/agent-transcripts/<会话>/*.jsonl` | 会话是否在跑 + **第一条用户消息**（正在处理哪个问题）+ `cwd` |
| | `~/.cursor/ai-tracking/ai-code-tracking.db` 的 `ai_code_hashes` 表 | 最近一次 AI 落文件的时间与文件名（作为兜底信号 + 气泡里显示「在改哪个文件」） |
| **CodeBuddy Code（CLI）** | `~/.codebuddy/projects/<项目>/*.jsonl` | 同上：mtime 判断是否在跑，第一条用户消息当「问题」 |

三个源共用一套会话解析（`src/main/watcher/transcript.js`），Cursor 的字段是 `role:"user"` + `message.content`，CodeBuddy 是 `type:"message"` + `role:"user"` + 顶层 `content`（文本块叫 `input_text`），两种都认；自动跳过 `<system-reminder>`、`<timestamp>` 这些注入块和纯斜杠命令。

**响应延迟**：1 秒轮询打底，再叠一层 `fs.watch` 文件事件（对上述目录监听），文件一改 250ms 内立刻重算，所以体感是亚秒级的。全部只读本地文件，不联网、不改任何配置。

> 踩过的坑：`~/.workbuddy/sessions/*.json` 里的 `lastHeartbeat` **只在会话启动时写一次**，不是心跳，拿它判断存活会得到「永远空闲」。
> 第二个坑：只看 `updated_at` / `last_activity_at` 也会误判——跑一条长命令时这两个字段几十秒不动是常态，结果明明在跑却显示「等你确认」。所以判定改成**以 `status` 为准**：`status=working` 就一定还在跑（改着文件 = working，没改 = thinking），只有当它静默超过 2.5 分钟才怀疑是在等你。

### 六档状态机

| 档位 | 动画 | 触发条件 |
| --- | --- | --- |
| 思考 `thinking` | 工作状态-思考冒泡 | WorkBuddy `status=working` 但最近没改文件（在想 / 在跑长命令） |
| 工作 `working` | 工作状态-忙碌点按 | 20s 内有文件变更，或会话还在写 |
| 整理 `organizing` | 工作状态-清点归档 | 停笔了但还没看到结束标记，最多再算 30s（收尾/等工具返回） |
| 等你 `waiting` | 工作状态-原地踱步张望 | `status=working` 却静默超过 **2.5 分钟**（多半真卡在等你点确认） |
| 搞定 `success` | 工作状态-雀跃庆祝 | **看到结束标记**（Cursor `turn_ended`/status:success、CodeBuddy `turn-metrics`），或 WorkBuddy 会话 `status` 翻到 completed —— 庆祝 35s 后转为摸鱼 |
| 出错 `error` | 工作状态-垂头叹气冒汗 | 结束标记里 status 是 error/fail/abort，或 WorkBuddy 会话状态出错 |
| 摸鱼 `idle` | 待机 + 77 段随机动画 | 没有任何活跃会话 |

多个来源同时活跃时按优先级取一个：出错 > 等你 > 工作中 > 整理 > 思考 > 搞定 > 空闲。

> 完成判定不靠「多久没写文件」——那样跑完了还会挂着"整理中"两分钟。两个工具都会在一轮结束时往会话文件里打标记：
> Cursor 写 `{"type":"turn_ended","status":"success"}`，CodeBuddy 写 `turn-metrics`。看到标记就算跑完，立刻庆祝，35s 后直接转摸鱼，**不会**退回收尾档。
> 另外还会看最后一条消息是不是 assistant、以及它是不是只在发起 tool 调用（是的话说明还在跑，不算完）。

### 气泡：告诉你「哪个 agent 在处理哪个问题」

气泡是三段式的，颜色徽章区分 agent：

```
[WorkBuddy] 规划开发大肥鱼桌面宠物      ← 徽章（agent）+ 问题（会话标题/首条用户消息）
手上这摊马上就好                        ← 该 agent 专属口吻的文案
工作中                                  ← 档位 · 正在改的文件（Cursor 有）
```

- 徽章颜色：**WorkBuddy 蓝 / Cursor 橙 / CodeBuddy 紫**，在 `pet.config.json` 的 `agents` 里改
- 「问题」优先用会话标题，拿不到就退回项目名（最长 26 字，超出截断）
- 每个 agent 有一套自己的说法（见 `textsBySource`）：WorkBuddy 偏小助理、Cursor 偏「改代码」、CodeBuddy 偏「终端跑命令」。查不到就退回通用 `texts`
- 托盘悬停提示也是同样的「agent · 档位 · 问题」

**右键 → `各 agent 状态`** 会列出三路各自的实时状态（哪个在忙、忙哪个项目/问题），点某一路可以让鱼立刻切过去显示它——不会只看得到「最忙的那个」。

### 提示音 / 提示语音

默认 **语音播报**（可爱萝莉音）：状态一变就用系统 TTS 念一句，**每个 agent 音色不同**，不用看屏幕也知道是谁在动。

| 事件 | 什么时候响 | 声音 |
| --- | --- | --- |
| `start` | 某个 agent 开始干活 | 短促上扬的「叮咚」 |
| `done` | 一轮跑完（看到结束标记） | 三音上行 |
| `error` | 出错 | 两音下行 |
| `waiting` | 真卡在等你确认 | 门铃式两声 |

音色按 agent 区分：**WorkBuddy 620Hz 温和 / Cursor 760Hz 偏亮 / CodeBuddy 500Hz 低沉**（`scripts/make-sfx.js` 里改基频和泛音配比）。

**语音模式**（默认）用 macOS 自带的 `say`，不装任何东西：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `voice.name` | `Meijia` | 音色。系统里可选：`Meijia`（美佳，最甜最年轻，推荐）、`Tingting`（婷婷，字正腔圆的大陆普通话）、`Sinji`（粤语）、`Sandy` / `Shelley` / `Flo` 等。想看全量列表：`say -v '?' \| grep zh_` |
| `voice.rate` | `205` | 语速（字/分钟），调小更慢更软 |
| `voice.pitch` | `90` | **音调抬高的量**，越大越稚嫩 —— 萝莉感主要靠它（实测 `[[pbas +90]]` 让过零率从 4145Hz 升到 4956Hz，音调确实抬上去了） |
| `voice.lines` | 见下 | 台词，`{agent}` 换成 agent 名、`{what}` 换成正在处理的问题 |

默认台词：

```json
"lines": {
  "start":   "{agent}开始干活啦~",
  "done":    "这一轮搞定啦，真棒！",
  "error":   "诶呀，好像出错了呢",
  "waiting": "主人，等你确认一下下~"
}
```

> 想要更可爱：把 `pitch` 调到 110~130、`rate` 调到 190；想要正经一点：换 `Tingting` 并把 `pitch` 降到 30。系统设置 → 辅助功能 → 朗读内容 → 声音 里还能下载更多中文音色（比如下了 `Tianyi` 之类的高级音色，直接填进 `voice.name` 即可）。

**音效模式**是手写合成的（基频 + 二次/三次泛音 + 指数衰减包络，直接写 WAV 头），`npm run sfx` 生成 12 个文件共 600KB —— 不引音频库、不用第三方素材，也就没有版权问题。语音不可用时（比如非 macOS）会自动退回音效。

几个防吵的设计：

- 只在**状态真的变化**时响，「在想 / 收尾」这两个档位默认不响
- 从「在想」回到「开工」不算新一轮，不重复响
- 6 秒节流（连续变化只响一次）
- **刚启动那一下不响**，免得每次开桌宠都「叮」
- 播放走系统 `afplay`、不经过渲染层：窗口没焦点也响，也不受 Chromium 自动播放策略限制

右键菜单的 **「提示音：语音 / 音效 / 关」** 是三态循环，切完立刻念一句让你听效果，选择会记住。音量和事件映射在 `pet.config.json` 的 `sound` 字段里改：

```json
"sound": { "enabled": true, "mode": "voice", "volume": 0.35, "minGapMs": 6000,
  "voice": { "name": "Meijia", "rate": 205, "pitch": 90, "lines": { ... } },
  "on": { "working": "start", "success": "done", "error": "error",
          "waiting": "waiting", "thinking": false, "organizing": false } }
```

---

## 交互

- **点播任意动画** —— 右键 → `动作`，106 段动画按「工作状态 / 待机 / 走路 / 点击回应 / 碎碎念 / 余额 / 转身 / 趣味 1~4」分组全在菜单里，点哪段播哪段。点播「走路」类时它会**真的在屏幕上走一段**（130~300px，会被屏幕边界夹住），走完落地 Q 弹一下。手动点播后 9 秒内屏蔽状态机，不会被工作状态当场抢回去
- **点击** —— 五段「点击回应」随机播一个，附带 Q 弹挤压和一句碎碎念
- **拖拽** —— 按住拖走，松手时带速度就抛物线飞出去，撞屏幕边缘反弹、落地摩擦停稳
- **右键** —— 菜单：摸一下 / 它在干嘛 / **各 agent 状态** / 打开 WorkBuddy / 打开 Cursor / 用 Cursor 打开当前项目 / 在终端打开当前项目 / 在访达中显示 / 回到右下角 / 鼠标穿透开关 / 退出
- **托盘** —— 菜单栏常驻，悬停显示「大肥鱼 · agent：档位 · 问题」
- **鼠标穿透** —— 默认**关闭**（整窗可点、可拖）。开着更优雅（只有鱼身上才接收事件），但一旦 hover 判定失灵就完全点不动，所以默认关，需要时右键打开

> 踩过的坑：`~/Library/Application Support/dafeiyu-pet/pet.config.json` 只存**位置**和**穿透开关**两样。窗口尺寸、动画映射等一律以 `src/shared/pet.config.json` 为准——早期把整个配置都持久化了，结果改了默认尺寸，旧文件把它盖回去，窗口一直是 240×240，鱼小到抓不住。

---

## 目录结构

```
├── assets/
│   ├── webm/            # 106 段透明动画（52MB，来自 dsh-pet）
│   ├── sfx/             # 12 个提示音（600KB，make-sfx.js 合成）
│   ├── tray.png         # 托盘图标，scripts/make-icon.js 生成
│   └── icon.icns        # app 图标
├── scripts/
│   ├── make-icon.js     # 手写 zlib 生成 PNG，不引图形库
│   ├── make-sfx.js      # 手写 WAV 合成提示音，不引音频库
│   └── probe.js         # 探测层命令行验证
└── src/
    ├── shared/
    │   ├── pet.config.json   # 窗口尺寸、档位动画映射、agent 徽章、气泡文案、权重
    │   ├── physics.js        # 抛掷/反弹/摩擦的纯函数
    │   └── animations.js     # 素材分类（主进程和渲染层共用，菜单和动画链同一套）
    ├── main/
    │   ├── index.js          # 窗口、自定义 pet:// 协议、右键菜单、飞行
    │   ├── sfx.js            # 提示音：状态变化 → 系统 afplay 播一段
    │   ├── tray.js
    │   ├── config.js         # 配置读写（存到 app userData）
    │   └── watcher/          # 三个探测源 → 聚合成一个状态
    │       ├── transcript.js # 共用：找最新会话 + 抠出「在处理哪个问题」
    ├── preload.js
    └── renderer/             # 动画链 + 状态机 + 气泡 + 拖拽
```

改 `src/shared/pet.config.json` 就能换档位动画、改气泡文案、调整各类动作的随机权重。改完右键「重载配置」即时生效。

---

## 打包成 .app

```bash
npm run icon       # 重新生成图标：assets/tray.png(64) + icon-1024.png + icon.icns
npm run dist       # 产出 dist/大肥鱼.app（约 305MB：Electron 框架 250MB + 素材 52MB）
npm run dist:dmg   # 顺带打一个 dmg 安装包
```

打包配置写在 `package.json` 的 `build` 字段：`appId=com.danghaoyu.dafeiyu-pet`、显示名「大肥鱼」、图标 `assets/icon.icns`、跳过签名（`identity: null`，本地自用不需要开发者证书）。两个脚本都走 npmmirror 镜像拉 Electron，避免 GitHub 下载超时。

> 如果你的终端环境禁止删除文件（某些带安全代理的 shell 会拦 `fs.unlink`），electron-builder 会在释放 lockfile 那一步失败。可以手工组装，效果和 electron-packager 一样：
> ```bash
> mkdir -p dist && cp -R node_modules/electron/dist/Electron.app dist/大肥鱼.app
> mkdir -p dist/大肥鱼.app/Contents/Resources/app
> cp -R src assets package.json dist/大肥鱼.app/Contents/Resources/app/
> cp assets/icon.icns dist/大肥鱼.app/Contents/Resources/electron.icns
> plutil -replace CFBundleDisplayName -string "大肥鱼" dist/大肥鱼.app/Contents/Info.plist
> plutil -replace CFBundleName       -string "大肥鱼" dist/大肥鱼.app/Contents/Info.plist
> plutil -replace CFBundleIdentifier -string "com.danghaoyu.dafeiyu-pet" dist/大肥鱼.app/Contents/Info.plist
> codesign --force --deep --sign - dist/大肥鱼.app
> ```
> Electron 的加载顺序是 `app.asar` → `app/` → `default_app.asar`，所以放进 `Contents/Resources/app/` 就会优先加载我们的应用，不用去动 `default_app.asar`。

打包后首次启动注意两点：**先退出 `npm start` 那个实例**（否则桌面上会有两条鱼）；**窗口位置会回到默认右下角**，因为 bundle id 变了，配置存在新的 userData 目录里。

---

## 已知限制 & 后续可做

1. **状态是推断的，不是事件**。现在靠轮询文件时间戳，粒度到「秒」。想要「这一步 Bash 跑完了」这种精确事件，需要给 CodeBuddy Code 的 `~/.codebuddy/settings.json` 配 hooks，在 `UserPromptSubmit` / `Stop` 时 POST 给桌宠——这是侵入式改动，等你想要再说。
2. **素材是复用的**，授权见下。想彻底自有化，可以走 dsh-pet 的素材链（AI 生成 + 绿幕抠像 + 转 VP9-Alpha webm），需要 brew 装 ffmpeg。
3. 只打了 **macOS arm64**（你本机架构）。要出 Intel 版或 Windows / Linux 版，改 `build.mac.target` 并加对应平台配置即可。
4. 余额/对话/语音没做（dsh-pet 有，但依赖 DSH 的模型和接口，跟本机联动关系不大）。

---

## 许可与署名

- **代码**：本项目自身代码 MIT。
- **动画素材**：来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，采用 **CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享），**禁止商用**。
- **形象出处**：大肥鱼（鲸鱼娘）为社区二创形象，原型「溟月」出自 B 站 [@上善无形](https://space.bilibili.com/)，DeepSeek 版女仆鲸鱼娘设计出自 B 站 [@ZipZipPipe](https://space.bilibili.com/)，**非 DeepSeek 官方形象**。
- 在 GitHub 仓库、产品官网等公开渠道发布衍生作品时，须附上原作者地址：<https://github.com/PC2005-cloud/dsh-pet>
