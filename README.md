# ChatGPT 字幕探针

给 ChatGPT 网页版的语音对话加上**实时悬浮字幕**——你说的、它说的，都逐字打在屏幕上。

用你自己已有的 ChatGPT 订阅，不调 API、不额外花钱。macOS / Electron。

它一开始只是个测量工具，用来回答一个问题：

> ChatGPT 的 Live 语音模式，是把转写「逐字增量」写进 DOM，还是「整句一次性」写进 DOM？

答案是**逐字增量**（实测数据见下），所以字幕功能就顺理成章地长了出来。测量的那套仪表盘保留着，因为 ChatGPT 改版时它是唯一能快速定位问题的东西。

## 用法

```bash
npm install
```

**第一步，自检**（不需要登录，全自动，约 6 秒）：

```bash
npm run selftest
```

用一个复刻真实 ChatGPT DOM 结构的本地页面，重放「逐字流式」和「整句蹦」两种行为，探针必须恰好各判出一条，否则以退出码 1 失败。

**自检不过，真实测量的任何结论都不能采信。**

**第二步，导入登录态**：

```bash
npm run import
```

从本机 Chrome 把已登录的 ChatGPT 会话搬进 Electron 的持久分区。会弹一次 macOS 钥匙串授权框。

用别的 Chrome profile：

```bash
npm start -- --import-cookies --profile="Profile 1"
```

**之后日常启动**（登录态已持久化，不用再导）：

```bash
npm start
```

登录成功后字幕窗会自动出现在屏幕底部。顶栏的「💬 字幕」按钮可以随时开关。

## 为什么要导入 Cookie 而不是直接登录

如果 ChatGPT 账号是 **Google SSO** 创建的，在 Electron 里没法登录：

1. 点「使用 Google 登录」→ Google 按 `disallowed_useragent` 策略拒绝嵌入式浏览器，显示"此浏览器或应用可能不安全"
2. 改用邮箱 → OpenAI 识别出是 Google 关联账号，带着 `login_hint` 把你转回 Google
3. 死锁

本项目试过三层伪装（清洗 UA + 改 `sec-ch-ua` 请求头 + 补 `navigator.userAgentData` 品牌），Google 依然拒绝。继续猜它查什么信号是无底洞——还有 TLS 指纹这类 JS 层根本碰不到的东西。

Cookie 导入让 Google 完全不参与，一次就通。相关代码保留在 `main.js` 里（`--email-login` / `openAuthWindow`），因为对**非** Google SSO 的账号仍然可能有用。

## 实测结论

在 GPT-Live 模式下用真实账号跑了 8 轮对话：

| | 结果 |
|---|---|
| assistant 消息 | 8 条，**8 条全部逐字增量** |
| 增量步长 | 中位数 **1 字符/次**，平均 1.3 |
| 首次出现长度 / 最终长度 | 3% – 40% |
| **用户自己的语音** | **也实时写入**（8 条里 4 条有多个采样点） |

用户语音实时写入这条尤其重要——它意味着**你能实时看见自己被识别成了什么**，这是练口语最直接的反馈。

```
"What am I doing"      9 → 15 字符      跨 399ms
"What are you doing"   8 → 12 → 18 字符  跨 299ms
```

## 实现要点

**观察器跑在 preload 的隔离世界里。** 隔离世界与页面主世界共享同一份 DOM，只有 JS 上下文隔离——所以 `MutationObserver` 能完整看到页面变化，不需要注入主世界，也不需要主进程轮询。

这一点是关键：常见做法是「注入脚本 + 页面内队列 + 主进程定时轮询」，而**任何轮询都会以轮询间隔为粒度模糊掉逐字与整句的区别**。这里改成 `MutationObserver` → `requestAnimationFrame` 合帧 → `ipcRenderer` 直推，时间分辨率约 16ms。合帧是因为 `innerText` 会触发强制布局。

**从消息正文层取文本，不是从对话轮容器取。** 轮容器里还有操作栏和"语音聊天已结束 / 20秒"这类每秒刷新的计时器，会制造大量假的文本变化，甚至让长度回退、把单调增长的消息误判成 AMBIGUOUS。正文在 `[data-message-author-role]` 那一层，计时器是它的兄弟节点。

**选择器对标签名不敏感。** chatgpt.com 在 2026-06 把轮容器从 `<article>` 换成了 `<section>`，只保留 `data-testid="conversation-turn-N"`。写死标签名会在改版当天全盘失效。

**观察器只在 chatgpt.com 上挂载。** 登录流程会途经 `accounts.google.com` / `auth.openai.com`——一个扫描页面文本的东西不该出现在登录页上，哪怕它当下只匹配 ChatGPT 的选择器、什么也采不到。

**UA 要缩减成 `Chrome/<major>.0.0.0`。** 自 UA 缩减策略起真实 Chrome 就是这么发的，后三段永远是 0。从 Electron UA 上摘掉标记会留下完整的 `Chrome/150.0.7871.129`，这是真实 Chrome 从不会发的形态。

**字幕不做缓冲。** 既然实测确认了是逐字增量，任何缓冲都会把这个特性抹平。

## 出问题时看哪里

顶栏三个计数器，**从左到右看，第一个不对劲的就是断点**：

| 顶栏状态 | 含义 | 下一步 |
|---|---|---|
| `未挂载 · 观察器没装上` | preload 没跑起来 | 看终端有没有 `✗ 页面内异常` |
| `已挂载 · 页面无 DOM 变化` | 观察器在，页面静止 | 页面没加载出来 / 卡在登录 |
| `有变化 · 但没找到对话轮` | 有变化但选择器没匹配上 | ChatGPT 改了 DOM，更新 `preload.js` 的选择器 |
| `正常采样中` | 一切正常 | |

点「出判定」时如果一条都没有，终端会把这三个数打出来。

启动时还会自动做一次登录状态自检，区分「已登录」「未登录」「卡在 Cloudflare 挑战页」——免得把"没登录"误当成"语音模式不写 DOM"。

## 已知的不精确之处

- 取的是 `innerText`，会把消息节点内部的界面文字算进去。这会让长度数字略微偏大，但不影响增量与整句的判定——判定看的是变化模式，不是绝对长度。
- ChatGPT 用了虚拟列表（实测约 105 个槽位只有 5 个填充），滚动时旧消息会被移出 DOM 导致采样中断。**测的时候别滚动。**
- `cf_clearance` 绑定 UA 和 IP。换网络或改 UA 会让导入的通行票失效，重新 `npm run import` 即可。

## 文件

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：建窗口、清 UA、权限、收采样、出判定、字幕窗 |
| `preload.js` | 注入 ChatGPT 页面的观察器（核心） |
| `import-cookies.js` | 从 Chrome 导入登录态（AES-128-CBC 解密 + 写入分区） |
| `captions.html` / `captions-preload.js` | 悬浮字幕窗 |
| `bar.html` / `bar-preload.js` | 顶栏：健康计数器 + 按钮 |
| `mock.html` | 自检用的假 ChatGPT DOM，复刻真实结构 |

## 说明

这是个跑在自己机器上、用自己账号的个人工具。抓取 ChatGPT 网页界面很可能不符合 OpenAI 的服务条款，自用和公开分发在这件事上的暴露程度不一样。
