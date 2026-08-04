# 技术说明

整个项目 **零运行时依赖**——`package.json` 里只有 `electron` 一个 devDependency。所有加解密、数据库读取都用 Node 内置模块或 macOS 自带的命令行工具。

---

## 一、运行时与窗口架构

**Electron 43.2.0**（Chromium 150 / Node 24.18）

窗口用的是 2026 年的推荐形态，而不是老教程里的写法：

```js
BaseWindow  +  WebContentsView  +  win.contentView.addChildView(view)
```

- `BrowserView` 自 Electron 30 起已废弃（仍存在，但不该用于新项目）
- `<webview>` 标签官方明确建议不要用，而且默认关闭
- 有实测记录显示：同样的 Cookie、同样的 UA，`<webview>` 会被 chatgpt.com 这类站点拒绝，而 `BrowserWindow` / `WebContentsView` 能过

窗口里挂了两个子视图（顶栏 + ChatGPT 页面），`WebContentsView` 没有 `setAutoResize()`，所以要手动监听 `resize` 事件重新布局。

**持久化会话分区**

```js
session.fromPartition('persist:chatgpt-probe')
```

`persist:` 前缀是关键——没有它就是内存会话，进程退出即失效。落盘在 `~/Library/Application Support/<appName>/Partitions/<name>/`。

⚠️ 有个坑：分区路径以**应用名**为根。用 `electron .` 和 `electron main.js` 启动会解析到不同目录，登录态会"莫名其妙消失"。所以永远用 `npm start`。

---

## 二、DOM 实时观测（核心）

**MutationObserver 跑在 preload 的隔离世界里**

这是整个项目最关键的一个判断：**隔离世界与页面主世界共享同一份 DOM，只有 JS 全局对象是隔离的**。所以 `MutationObserver` 直接在 preload 里就能完整看到页面的 DOM 变化——不需要把脚本注入主世界，也不需要主进程轮询。

```js
observer.observe(document.body, {
  childList: true, subtree: true, characterData: true,
})
```

常见做法是「`executeJavaScript` 注入脚本 + 页面内攒队列 + 主进程每 350ms 轮询取走」。对本项目**不能这么做**：任何轮询都会以轮询间隔为粒度，把「逐字增量」和「整句一次性」模糊成同一个东西——而这恰恰是要测的。

**requestAnimationFrame 合帧**

`innerText` 会触发一次强制布局（reflow），在高频 mutation 下很贵。所以 MutationObserver 回调只置一个标志位，真正的 DOM 扫描推迟到下一帧：

```
DOM 变化 → MutationObserver → 置标志 → rAF → 每帧最多扫一次 → ipcRenderer 直推
```

时间分辨率约 16ms，足以分辨逐字流式（实测中位步长 1 字符、间隔 300ms 量级），同时把布局开销压到每帧一次。

这不是轮询——rAF 由真实的 DOM 变化驱动，页面静止时一次都不跑。

**选择器策略**

```js
const TURN_SELECTOR = '[data-testid^="conversation-turn-"]'   // 不绑定标签名
const ROLE_SELECTOR = '[data-message-author-role]'
```

chatgpt.com 在 2026-06 把轮容器从 `<article>` 换成了 `<section>`，但保留了 `data-testid`。写死标签名会在改版当天全盘失效。

**取文本的层级**

从 `[data-message-author-role]`（消息正文层）取，**不是**从轮容器取。轮容器里还有操作栏、以及"语音聊天已结束 / 20秒"这类每秒刷新的计时器——从容器取会把它们算进文本，制造大量假的"文本变化"，还会让长度回退。

`innerText` vs `textContent`：选了前者。`textContent` 便宜约 18 倍，但 `innerText` 反映渲染后的可见文本（会排除隐藏元素），更接近用户真正看到的字幕。合帧 + 缩小读取子树之后，开销可以接受。

---

## 三、浏览器指纹伪装

站点识别 Electron 有三个独立的层，**必须同时补，只补一层反而更像破绽**。

**1. UA 字符串**

```js
session.getUserAgent()
  .replace(/\s*Electron\/[\d.]+/i, '')          // 摘掉 Electron 标记
  .replace(/\s*<appName>\/[\d.]+/i, '')         // 摘掉应用名
  .replace(/Chrome\/(\d+)[\d.]*/i, 'Chrome/$1.0.0.0')   // 缩减版本号
```

最后那步容易漏：自 UA 缩减策略起，**真实 Chrome 发的是 `Chrome/150.0.0.0`，后三段永远是 0**。只摘标记会留下完整的 `Chrome/150.0.7871.129`，这是真实 Chrome 从不会发的形态，本身就是识别特征。

**2. HTTP 请求头（UA Client Hints）**

`setUserAgent()` **完全不碰** Client Hints。Electron 发出的 `sec-ch-ua` 里只有 `"Chromium"` 和 `"Not-A.Brand"`，没有 `"Google Chrome"` 品牌——真实 Chrome 一定有。

```js
session.webRequest.onBeforeSendHeaders((details, callback) => {
  // 改写 sec-ch-ua 和 sec-ch-ua-full-version-list
})
```

⚠️ 不要硬编码 `sec-ch-ua-platform`。在 macOS 上谎称 `"Windows"` 会和 UA 里的 `Macintosh` 直接矛盾，比什么都不改更容易露馅。

**3. JavaScript API**

页面里的 JS 直接读 `navigator.userAgentData` 就能看穿——它同样只报 Chromium，而且 `getHighEntropyValues(['fullVersionList'])` 会泄露真实的 Chromium 版本号。

必须打在**主世界**（页面自己的 JS 读的是主世界的 `navigator`）：

```js
contextBridge.executeInMainWorld({ func: (major, full) => { /* 覆盖 navigator.userAgentData */ }, args: [...] })
```

**结论**：三层都补齐了，Google 的 `disallowed_useragent` 检查**依然拒绝**。所以有第四条路——见下一节。

---

## 四、Chrome 登录态导入

绕开 Google SSO 死锁的方案：把本机 Chrome 已登录的会话直接搬过来。

**macOS 上 Chrome Cookie 的加密方式**

| 环节 | 做法 |
|---|---|
| 密钥来源 | 钥匙串条目 `Chrome Safe Storage`，用 `/usr/bin/security find-generic-password` 读（弹一次系统授权框） |
| 密钥派生 | `PBKDF2-SHA1(密码, salt="saltysalt", 1003 轮, 16 字节)` |
| 加密算法 | `AES-128-CBC`，IV = **16 个空格字符** |
| 值前缀 | `v10` / `v11`，解密前要剥掉 |
| 额外前缀 | **Chrome 127+** 在明文前加了 32 字节的 `SHA256(host_key)`，也要剥掉 |

判断是否有那 32 字节前缀，靠对比而不是猜：

```js
const expect = crypto.createHash('sha256').update(hostKey).digest()
if (out.subarray(0, 32).equals(expect)) out = out.subarray(32)
```

PKCS#7 去填充是手工做的（`setAutoPadding(false)`）——自动去填充在明文含二进制哈希前缀时容易误判。

**读取数据库**

用 macOS 自带的 `/usr/bin/sqlite3`，不引入任何 npm 依赖。Chrome 运行时会锁库，所以先把 `Cookies` 连同 `-wal` / `-shm` 拷贝一份再读。二进制值用 `hex()` 取出。

**写入 Electron**

- Chrome 时间戳是 **1601-01-01 起算的微秒**，转 Unix 秒：`utc / 1e6 - 11644473600`
- `samesite` 字段：`0=None / 1=Lax / 2=Strict`
- **`__Host-` 前缀的 Cookie 有硬性规则**：必须 secure、path 必须是 `/`、而且**不能带 domain 属性**。照搬 domain 会被 Chromium 以 `EXCLUDE_INVALID_PREFIX` 拒收

**Cloudflare 预热**

`cf_clearance` 要等站点的 JS 挑战跑完才算数。所以导入后先用一个**隐藏窗口**在同分区把站点加载一遍、静置 2.5 秒让它落定，再让可见视图跳过去——否则可见视图会撞上挑战页。

`cf_clearance` 绑定 UA 和 IP，这也是为什么第三节里 UA 必须和真实 Chrome 完全一致。

只导入 `chatgpt.com` / `openai.com` 相关域名，不整库搬运；日志只打印 Cookie 名字和数量，不打印任何值。

---

## 五、悬浮字幕窗

```js
new BrowserWindow({ frame: false, transparent: true, hasShadow: false })
captionsWin.setAlwaysOnTop(true, 'screen-saver')
captionsWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
```

- `'screen-saver'` 是 macOS 上最高的置顶层级
- `visibleOnFullScreen` 是关键——不加的话，别的应用一进全屏字幕就消失了
- 拖动靠 CSS 的 `-webkit-app-region: drag`，不需要写任何 JS
- 毛玻璃用 `-webkit-backdrop-filter: blur(20px)`

字幕**不做任何缓冲**，每次 DOM 文本变化直推。既然实测确认了是逐字增量，加缓冲就把这个特性抹平了。

---

## 六、麦克风权限

三个地方都要处理，少一个就会静默失败：

```js
session.setPermissionRequestHandler(...)   // 页面主动请求时
session.setPermissionCheckHandler(...)     // 页面用 navigator.permissions.query() 预检时
systemPreferences.askForMediaAccess('microphone')   // macOS 系统层 TCC
```

第二个最容易漏：站点常常先 `query()` 检查一下，发现是 denied 就直接放弃，根本不会走到请求那步。

另外放行了 `persistent-storage`——拒掉会让站点表现得像个残废的浏览器，反而是个异常信号。

好消息：Electron 官方分发的 `Electron.app` 已经带了 `NSMicrophoneUsageDescription`，所以 `npm start` 开发模式下不会因为缺少 Info.plist 键而硬崩。

---

## 七、测量方法学

这部分不是"技术栈"，但是这个项目能得出可信结论的原因。

**Ground truth 校准页**

`mock.html` 复刻真实 ChatGPT 的 DOM 结构，重放两种已知行为（逐字流式 / 整句一次性），并且故意挂一个每 300ms 刷新的计时器作为干扰。探针必须恰好判出 1 条 INCREMENTAL + 1 条 SINGLE-SHOT，否则退出码 1。

**自检不过，真实测量的任何结论都不能采信。** 这条防的是最阴险的失败模式:探针自己坏了,却被读成"语音模式不流式写 DOM"。

**三档健康信号**

`mutations` / `turns` / `samples` 三个独立计数器，区分三种完全不同的"看起来没反应"：

| 读数 | 含义 |
|---|---|
| `mutations = 0` | 观察器没挂上，或页面完全静止 |
| `mutations > 0, turns = 0` | 有 DOM 变化但选择器没匹配上（ChatGPT 改版了） |
| `turns > 0, samples = 0` | 找到轮次但文本没变化 |

**分类器**

| 判定 | 条件 |
|---|---|
| `INCREMENTAL` | ≥3 采样点、跨度 >250ms、长度单调增长 |
| `SINGLE-SHOT` | 只有 1 个采样点，或全部挤在 150ms 内 |
| `AMBIGUOUS` | 其余 |

实测中 `AMBIGUOUS` 全部来自界面噪声破坏了单调性——这个发现直接导致了第二节里"从消息正文层取文本"的修改。

---

## 技术栈一览

| 领域 | 用到的东西 |
|---|---|
| 运行时 | Electron 43 / Chromium 150 / Node 24 |
| 窗口 | BaseWindow, WebContentsView, BrowserWindow, 透明置顶窗 |
| 进程通信 | contextBridge, ipcRenderer/ipcMain, executeInMainWorld |
| DOM 观测 | MutationObserver, requestAnimationFrame |
| 网络层 | webRequest.onBeforeSendHeaders, session 分区, Cookie API |
| 加密 | PBKDF2-SHA1, AES-128-CBC, SHA-256（全部 `node:crypto`） |
| 数据 | SQLite（系统自带 `sqlite3` CLI）, macOS Keychain（`security`） |
| 系统集成 | systemPreferences 权限 API, TCC, 全空间置顶 |
| 前端 | 原生 HTML/CSS/JS，无框架，`-webkit-app-region`, `backdrop-filter` |
| 依赖数 | **0 个运行时依赖** |
