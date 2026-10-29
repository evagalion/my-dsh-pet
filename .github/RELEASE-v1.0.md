# 大肥鱼 v1.0 🐟

一只住在你桌面右下角的肥鱼，盯着本机 **WorkBuddy / Cursor / CodeBuddy** 在干什么 —— 它们一忙起来，鱼就跟着换动作、冒气泡、开口说话。

## 核心能力

**三路只读探测**
- WorkBuddy 读 `~/.workbuddy/workbuddy.db` 的 sessions 表
- Cursor 读 `~/.cursor/projects/*/agent-transcripts/*/*.jsonl`
- CodeBuddy 读 `~/.codebuddy/projects/*/*.jsonl`
- 全部只读，绝不回写、不注入 hooks；`fs.watch` 250ms 去抖即时触发 + 1s 轮询打底

**六档状态机**：`thinking → working → organizing → waiting → success / error`，外加 `idle`。多源按优先级仲裁，三家同时忙时显示最忙的那个。

**步骤流**：气泡下方实时显示「它在做这一步」——读文件 / 改代码 / 跑命令 / 搜网页 / 问你…… 每个 agent 各自一份。

**语音播报**（默认开）
- Edge 神经网络音色（晓伊），语速 +10% / 音调 +10Hz
- 台词只有 6 句，**首次联网合成后缓存到 `~/Library/Caches/dafeiyu-tts/`，之后完全离线播放**
- 断网自动回退系统 `say`，不会哑掉

**点击音效**：点了鱼身（没拖动才算）随机播一个 Q 弹音效 + 一段「点击回应」动画。`assets/sfx/click/` 是音效包，往里丢 wav/mp3 就能扩展，不用改代码。

**交互**：按住拖走、松手带速度就抛物线飞出去（撞边缘反弹、落地摩擦停稳）；右键菜单点播 106 段动画；托盘常驻显示当前状态；鼠标穿透可开关。

## 安装

```bash
git clone git@github.com:evagalion/my-dsh-pet.git
cd my-dsh-pet
npm install
npm start
```

打包成 .app：

```bash
npm run icon && npm run dist     # 产出 dist/大肥鱼.app（约 307MB）
```

> 桌宠的动画素材来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（CC BY-NC-SA 4.0，禁商用、须署名），仓库里随代码一起分发。

## 这一版之前踩过的坑（都修了）

- **右键菜单整个弹不出来**：菜单 `label` 传了 Promise（`async` 函数返回值），Electron 抛类型转换错误，而异常被 `.catch(() => {})` 静默吞掉。已改成同步函数 + `console.error` + 自检里真实构建一次菜单模板
- **Retina 下拖动崩溃**：`movementX/Y` 是小数，Electron `setPosition` 只吃整数。改成把零头攒够 1px 再发
- **语音不好听**：本地小模型（Kokoro / Theresa / MeloTTS）试遍了都停在「能听出是 TTS」，换 Edge 神经网络音色后是另一档
- **打包版找不到 python**：从 Finder 启动时 PATH 只有 `/usr/bin`，而系统 python 没装 `edge-tts`。配置里写绝对路径 + 运行时探测回退

## 已知限制

- 只做 macOS（音效走 `afplay`、语音回退走 `say`）
- 语音播报首次需要联网一次（之后永久离线）
- 打包版是 adhoc 签名，首次启动可能要在「系统设置 → 隐私与安全性」点允许
