// ChatGPT 字幕探针 —— 只回答一个问题：
//
//   ChatGPT 的高级语音模式，是把转写「逐词增量」写进 DOM，
//   还是「整句一次性」写进 DOM？
//
// 这个答案决定了套壳方案里字幕体验的上限，所以值得单独验一次。
//
//   npm start           → 打开 chatgpt.com
//   npm run selftest    → 打开本地 mock 页，先验证探针自己是对的

const path = require('node:path')
const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  systemPreferences,
  shell,
} = require('electron')

// 登录相关的域名。这些页面必须以「顶层浏览器窗口」的身份出现，
// 否则 Google 会按嵌入式 webview 处理并直接拒绝（disallowed_useragent 策略）。
const AUTH_HOSTS = [
  'accounts.google.com',
  'auth.openai.com',
  'auth0.openai.com',
  'login.live.com',
  'appleid.apple.com',
]
const isAuthUrl = (url) => {
  try {
    return AUTH_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

const MOCK = process.argv.includes('--mock')
const IMPORT_COOKIES = process.argv.includes('--import-cookies')
const PROFILE =
  (process.argv.find((a) => a.startsWith('--profile=')) || '--profile=Default').split('=')[1]
const TARGET = MOCK
  ? `file://${path.join(__dirname, 'mock.html')}?auto=1`
  : 'https://chatgpt.com/'

const BAR_HEIGHT = 46

let win
let barView
let pageView
let captionsWin

// ── 实时字幕悬浮窗 ──────────────────────────────────────────────────────────
// 无边框 + 透明 + 置顶，可以盖在任何应用上面。
function createCaptionsWindow() {
  if (captionsWin && !captionsWin.isDestroyed()) {
    captionsWin.show()
    return captionsWin
  }

  const { screen } = require('electron')
  const area = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(1000, Math.round(area.width * 0.7))
  const height = 190

  captionsWin = new BrowserWindow({
    width,
    height,
    x: Math.round((area.width - width) / 2),
    y: area.height - height - 40,      // 贴底部，像播放器字幕
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'captions-preload.js') },
  })

  // 'screen-saver' 是 macOS 上最高的置顶层级，
  // visibleOnFullScreen 让字幕在别的应用全屏时也不消失 —— 否则你全屏看视频字幕就没了。
  captionsWin.setAlwaysOnTop(true, 'screen-saver')
  captionsWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  captionsWin.loadFile(path.join(__dirname, 'captions.html'))
  return captionsWin
}

// ── 终端输出 ────────────────────────────────────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`.padStart(6)

function banner() {
  console.log('')
  console.log(C.bold('  ChatGPT 字幕探针'))
  console.log(C.dim(`  目标: ${TARGET}`))
  console.log(
    C.dim(
      MOCK
        ? '  模式: 自检 —— 点两个按钮各跑一次，确认判定为 INCREMENTAL / SINGLE-SHOT'
        : '  模式: 实测 —— 登录后开一轮语音对话，说几句，然后点「出判定」',
    ),
  )
  console.log(C.dim('  ─────────────────────────────────────────────────────────────'))
}

// ── 探针事件 ────────────────────────────────────────────────────────────────
let lastLenById = new Map()

ipcMain.on('probe:attached', (_e, { url }) => {
  console.log(C.green(`  ✓ 观察器已挂载  ${url}`))
})

ipcMain.on('probe:error', (_e, stack) => {
  console.log(C.red(`  ✗ 页面内异常: ${stack}`))
})

ipcMain.on('probe:ua-patched', (_e, { major }) => {
  console.log(C.dim(`  ✓ 已补 navigator.userAgentData（加上 "Google Chrome";v="${major}" 品牌）`))
})

ipcMain.on('probe:ua-patch-failed', (_e, msg) => {
  console.log(C.red(`  ✗ userAgentData 补丁失败: ${msg}`))
})

ipcMain.on('probe:skipped', (_e, { host }) => {
  console.log(C.dim(`  ○ 非 ChatGPT 页面（${host}），观察器未挂载`))
})

ipcMain.on('probe:sample', (_e, s) => {
  // 实时字幕：每一次 DOM 文本变化都直接推给字幕窗，不做任何缓冲 ——
  // 缓冲会把「逐字增量」这个刚测出来的特性又抹平回去。
  if (captionsWin && !captionsWin.isDestroyed()) {
    captionsWin.webContents.send('caption:update', {
      role: s.role,
      caption: s.caption,
      busy: s.busy,
    })
  }

  const prev = lastLenById.get(s.id) ?? 0
  lastLenById.set(s.id, s.len)
  const delta = s.len - prev
  const roleTag = s.role === 'assistant' ? C.cyan('assistant') : C.dim('user     ')
  const busyTag = s.busy ? C.yellow('●') : ' '
  console.log(
    `  ${C.dim(fmtMs(s.t))} ${busyTag} ${roleTag} ` +
      `s${String(s.sampleIndex).padStart(3)} ` +
      `len ${String(s.len).padStart(5)} ` +
      `${delta >= 0 ? '+' : ''}${String(delta).padStart(4)}  ` +
      C.dim(JSON.stringify(s.tail)),
  )
})

// 健康信号：区分「没挂上」「挂上但页面没动」「有动静但没有对话轮」
let lastHealth = null
let selfTestPassed = false
ipcMain.on('probe:health', (_e, h) => {
  lastHealth = h
  if (barView && !barView.webContents.isDestroyed()) {
    barView.webContents.send('bar:health', h)
  }
})

// ── 判定 ────────────────────────────────────────────────────────────────────
// INCREMENTAL: 采样点 >= 3、时间跨度 > 250ms、长度单调增长
// SINGLE-SHOT: 只有 1 个采样点，或所有采样点挤在 150ms 内
function classify(samples) {
  if (samples.length <= 1) return { verdict: 'SINGLE-SHOT', why: '只有一个采样点，文本一次性出现' }
  const span = samples[samples.length - 1].t - samples[0].t
  if (span <= 150) return { verdict: 'SINGLE-SHOT', why: `${samples.length} 个采样点挤在 ${span}ms 内` }
  const growing = samples.every((s, i) => i === 0 || s.len >= samples[i - 1].len)
  if (samples.length >= 3 && span > 250 && growing) {
    return { verdict: 'INCREMENTAL', why: `${samples.length} 个采样点，跨度 ${span}ms，长度单调增长` }
  }
  return { verdict: 'AMBIGUOUS', why: `${samples.length} 个采样点，跨度 ${span}ms，增长${growing ? '单调' : '非单调'}` }
}

ipcMain.on('probe:dump', (_e, dump) => {
  console.log('')
  console.log(C.bold('  ── 判定 ────────────────────────────────────────────────────────'))
  if (!dump.length) {
    console.log(C.red('  没有捕获到任何对话轮。'))
    console.log(C.dim('  排查顺序：'))
    console.log(C.dim(`    1. 观察器挂上了吗？        attached = ${lastHealth?.attached}`))
    console.log(C.dim(`    2. 页面有 DOM 变化吗？     mutations = ${lastHealth?.mutations}`))
    console.log(C.dim(`    3. 找到对话轮了吗？        turnsSeen = ${lastHealth?.turnsSeen}`))
    console.log(C.dim('  三个数从左到右看，第一个为 0/false 的就是断点所在。'))
    console.log('')
    return
  }

  const assistantTracks = dump.filter((d) => d.role === 'assistant')
  for (const d of dump) {
    const { verdict, why } = classify(d.samples)
    const color =
      verdict === 'INCREMENTAL' ? C.green : verdict === 'SINGLE-SHOT' ? C.yellow : C.red
    const span = d.samples.length > 1 ? d.samples[d.samples.length - 1].t - d.samples[0].t : 0
    console.log(
      `  ${d.role === 'assistant' ? C.cyan('assistant') : C.dim('user     ')} ` +
        `${String(d.samples.length).padStart(3)} 采样  ` +
        `跨度 ${String(span).padStart(5)}ms  ` +
        `终长 ${String(d.finalLen).padStart(5)}  ⇒ ${color(verdict)}`,
    )
    console.log(C.dim(`            ${why}`))
    console.log(C.dim(`            ${JSON.stringify(d.preview)}`))
  }

  console.log('')
  const verdicts = assistantTracks.map((d) => classify(d.samples).verdict)
  const inc = verdicts.filter((v) => v === 'INCREMENTAL').length
  const one = verdicts.filter((v) => v === 'SINGLE-SHOT').length
  console.log(
    C.bold(`  结论：assistant 消息中 ${inc} 条逐词增量 / ${one} 条整句一次性 ` +
      `（共 ${assistantTracks.length} 条）`),
  )
  if (inc > 0 && one === 0) {
    console.log(C.green('  → 字幕可以做到逐词流式，套壳方案的字幕体验没有硬上限。'))
  } else if (one > 0 && inc === 0) {
    console.log(C.yellow('  → 字幕只能整句蹦，套壳方案做不出「边说边出字」的效果。'))
  } else if (inc > 0 && one > 0) {
    console.log(C.yellow('  → 两种行为都出现了，需要看是文字模式 vs 语音模式的差异。'))
  }

  // 自检的通过标准：mock 页刻意重放了一次逐词、一次整句，
  // 探针必须恰好各判出一条。判错了就说明探针本身不可信，
  // 那么它在真实 ChatGPT 上给出的任何结论都不能采信。
  if (MOCK) {
    selfTestPassed = inc === 1 && one === 1
    console.log('')
    console.log(
      selfTestPassed
        ? C.green('  ✓ 自检通过：探针能正确区分逐词增量与整句一次性。')
        : C.red(`  ✗ 自检失败：期望 1 条 INCREMENTAL + 1 条 SINGLE-SHOT，实得 ${inc} / ${one}。`),
    )
  }
  console.log('')
})

ipcMain.on('bar:dump', () => {
  if (pageView && !pageView.webContents.isDestroyed()) {
    pageView.webContents.send('probe:dump-request')
  }
})

ipcMain.on('bar:reset', () => {
  lastLenById = new Map()
  if (pageView && !pageView.webContents.isDestroyed()) {
    pageView.webContents.send('probe:reset')
  }
  if (captionsWin && !captionsWin.isDestroyed()) {
    captionsWin.webContents.send('caption:clear')
  }
  console.log(C.dim('\n  ── 已重置采样 ──\n'))
})

ipcMain.on('bar:toggle-captions', () => {
  if (captionsWin && !captionsWin.isDestroyed() && captionsWin.isVisible()) {
    captionsWin.hide()
    console.log(C.dim('  字幕窗已隐藏'))
  } else {
    createCaptionsWindow()
    console.log(C.green('  ✓ 字幕窗已显示（可拖动，会盖在其他应用上方）'))
  }
})

// ── 窗口 ────────────────────────────────────────────────────────────────────
function layout() {
  if (!win) return
  const { width, height } = win.getContentBounds()
  barView.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT })
  pageView.setBounds({ x: 0, y: BAR_HEIGHT, width, height: height - BAR_HEIGHT })
}

async function createWindow() {
  // 独立的持久化分区：登录状态跨重启保留，且不污染其他 Electron 应用
  const partition = 'persist:chatgpt-probe'
  const pageSession = session.fromPartition(partition)

  // ChatGPT 会对含 "Electron/x.y.z" 的 UA 做拦截。
  // 从 Electron 自带的 UA 上把 Electron 标记和应用名摘掉，
  // 得到与内置 Chromium 版本天然同步的干净 Chrome UA —— 比硬编码更耐用。
  // 还要把 Chrome 版本号缩减成 <major>.0.0.0。
  // 自 UA 缩减策略起，真实 Chrome 发的就是 "Chrome/150.0.0.0" —— 后三段永远是 0。
  // 直接从 Electron UA 上摘标记会留下完整的 "Chrome/150.0.7871.129"，
  // 这是真实 Chrome 从不会发的形态，本身就是一个破绽。
  const cleanUA = pageSession
    .getUserAgent()
    .replace(/\s*Electron\/[\d.]+/i, '')
    .replace(new RegExp(`\\s*${app.getName()}\\/[\\d.]+`, 'i'), '')
    .replace(/Chrome\/(\d+)[\d.]*/i, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim()
  pageSession.setUserAgent(cleanUA)
  console.log(C.dim(`  UA: ${cleanUA}`))

  // 只改 UA 字符串是不够的，而且本身就是破绽：
  // Electron 发出的 sec-ch-ua 客户端提示里只有 "Chromium"/"Not-A.Brand"，没有 "Google Chrome" 品牌。
  // 「UA 自称 Chrome，客户端提示却只有 Chromium」正是 Cloudflare 和 Google 用来识别嵌入式应用的信号。
  const chromeMajor = process.versions.chrome.split('.')[0]
  const brandUA = `"Google Chrome";v="${chromeMajor}", "Chromium";v="${chromeMajor}", "Not?A_Brand";v="24"`
  const fullVersionList =
    `"Google Chrome";v="${process.versions.chrome}", ` +
    `"Chromium";v="${process.versions.chrome}", "Not?A_Brand";v="24.0.0.0"`
  pageSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'sec-ch-ua') headers[key] = brandUA
      else if (lower === 'sec-ch-ua-full-version-list') headers[key] = fullVersionList
    }
    callback({ requestHeaders: headers })
  })
  console.log(C.dim(`  sec-ch-ua: ${brandUA}`))

  // 让内嵌的 ChatGPT 页面能拿到麦克风
  // 除了麦克风，也要放行 persistent-storage —— ChatGPT 用它做本地存储，
  // 拒掉会让站点表现得像个残废的浏览器，反而是个异常信号。
  const ALLOWED = new Set(['media', 'audioCapture', 'persistent-storage', 'clipboard-read'])
  pageSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = ALLOWED.has(permission)
    console.log(C.dim(`  权限请求: ${permission} → ${allow ? '允许' : '拒绝'}`))
    callback(allow)
  })
  if (pageSession.setPermissionCheckHandler) {
    pageSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission))
  }

  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    console.log(C.dim(`  macOS 麦克风权限: ${status}`))
    if (status !== 'granted') {
      const ok = await systemPreferences.askForMediaAccess('microphone')
      console.log(C.dim(`  申请麦克风权限: ${ok ? '已授予' : '被拒绝'}`))
    }
  }

  win = new BaseWindow({ width: 1180, height: 900, title: 'ChatGPT 字幕探针' })

  barView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'bar-preload.js') },
  })
  barView.webContents.loadFile(path.join(__dirname, 'bar.html'))

  pageView = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false, // preload 里要 require('electron')
    },
  })

  win.contentView.addChildView(barView)
  win.contentView.addChildView(pageView)
  layout()
  win.on('resize', layout)

  // ── OAuth 处理 ──────────────────────────────────────────────────────────
  // Google 从 2023 年起按策略硬封嵌入式 webview（"此浏览器或应用可能不安全"）。
  // 关键在于身份：WebContentsView 是「嵌入视图」，而独立的 BrowserWindow 是「顶层浏览器窗口」。
  // 所以把登录导航劫持到一个同分区的独立 BrowserWindow 里去走，Cookie 仍然落在同一个 session。
  //
  // 说明：这个手法是 Axiom 等 Electron 应用在用的，但对 chatgpt.com 是否奏效尚未被证实
  // （agentify-sh/desktop#11 至今未关）。走不通就用邮箱+密码，或按 --external-auth 走系统浏览器。
  const EXTERNAL_AUTH = process.argv.includes('--external-auth')
  const EMAIL_LOGIN = process.argv.includes('--email-login')

  // 绕开 Google 的直通路径：ChatGPT 跳转的 auth.openai.com 链接里带 connection=google-oauth2，
  // 正是这个参数让它直奔 Google。把它摘掉，auth.openai.com 就会显示自家的邮箱+密码表单，
  // 完全不经过 Google 的 webview 检查。
  function stripGoogleConnection(url) {
    try {
      const u = new URL(url)
      if (!u.searchParams.has('connection')) return url
      const was = u.searchParams.get('connection')
      u.searchParams.delete('connection')
      console.log(C.dim(`  已摘掉 connection=${was}，改走邮箱+密码表单`))
      return u.toString()
    } catch {
      return url
    }
  }

  function openAuthWindow(rawUrl) {
    const url = EMAIL_LOGIN ? stripGoogleConnection(rawUrl) : rawUrl
    if (EXTERNAL_AUTH) {
      console.log(C.yellow(`  登录导航 → 系统浏览器: ${url}`))
      console.log(C.dim('  （在系统浏览器里登录不会把 Cookie 带回本应用，仅用于查看报错详情）'))
      shell.openExternal(url)
      return
    }
    console.log(C.yellow(`  登录导航 → 独立顶层窗口（同分区）: ${url}`))
    const authWin = new BrowserWindow({
      width: 520,
      height: 680,
      title: '登录',
      webPreferences: { partition, sandbox: true },
    })
    authWin.webContents.on('did-navigate', (_e, newUrl) => {
      // 登录完成会跳回 chatgpt.com —— 此时关掉登录窗，刷新主视图
      if (!isAuthUrl(newUrl) && newUrl.includes('chatgpt.com')) {
        console.log(C.green('  ✓ 登录流程已跳回 chatgpt.com，关闭登录窗并刷新'))
        authWin.close()
        pageView.webContents.reload()
      }
    })
    authWin.once('ready-to-show', () => {
      authWin.show()
      authWin.focus()
      authWin.moveTop()
      console.log(C.green('  ✓ 登录窗已打开并置顶'))
    })
    authWin.loadURL(url)
  }

  // 弹窗形式的登录
  pageView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url)) {
      openAuthWindow(url)
      return { action: 'deny' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 顶层跳转形式的登录 —— 这是最初版漏掉的情况。
  // ChatGPT 的「使用 Google 登录」是直接跳转当前页面，不开弹窗，
  // 所以只挂 setWindowOpenHandler 拦不住，用户就会在嵌入视图里撞上 Google 的拒绝页。
  pageView.webContents.on('will-navigate', (event, url) => {
    if (!isAuthUrl(url)) return

    // --email-login：摘掉 connection 参数后 Google 完全不参与，
    // 那个独立窗口就失去了存在理由（它唯一的作用是绕过 Google 对嵌入视图的检查）。
    // 直接在主视图里跳，单窗口，不会出现「登录窗跑哪去了」。
    if (EMAIL_LOGIN) {
      const stripped = stripGoogleConnection(url)
      if (stripped !== url) {
        event.preventDefault()
        console.log(C.yellow('  登录导航 → 就在主窗口里打开（无需独立窗口）'))
        pageView.webContents.loadURL(stripped)
        return
      }
      return // 本来就没有 connection 参数，放行即可
    }

    event.preventDefault()
    openAuthWindow(url)
  })

  pageView.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return // ERR_ABORTED，通常是正常的重定向
    console.log(C.red(`  ✗ 加载失败 [${code}] ${desc}  ${url}`))
  })

  // 自检模式：mock 页跑完两段重放后把标题改成 MOCK-DONE，
  // 这里收到信号就出判定并退出，让 selftest 成为一条命令的回归测试。
  if (MOCK) {
    pageView.webContents.on('page-title-updated', (_e, title) => {
      if (title !== 'MOCK-DONE') return
      pageView.webContents.send('probe:dump-request')
      setTimeout(() => {
        console.log(C.dim('  ── 自检完成，退出 ──\n'))
        app.exit(selfTestPassed ? 0 : 1)
      }, 900)
    })
  }

  // ── Cookie 导入 ─────────────────────────────────────────────────────────
  // 把本机 Chrome 已经登录好的 ChatGPT 会话搬进这个分区，绕开 Google SSO 的死锁。
  if (IMPORT_COOKIES && !MOCK) {
    const profile = PROFILE
    console.log(C.bold(`\n  从 Chrome「${profile}」导入 Cookie…`))
    console.log(C.dim('  macOS 会弹一次钥匙串授权框（那是系统的框，密码不经过本程序）'))
    try {
      const { importChromeCookies } = require('./import-cookies')
      await importChromeCookies(pageSession, profile, (line) => console.log(C.dim(line)))

      // Cloudflare 的 cf_clearance 要等站点的 JS 挑战跑完才算数。
      // 先用一个隐藏窗口在同分区把站点加载一遍、静置 2.5 秒让它落定，
      // 再让可见视图跳过去 —— 否则可见视图会撞上挑战页。
      console.log(C.dim('  预热分区（等 Cloudflare 挑战落定）…'))
      const warm = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true } })
      try {
        await warm.webContents.loadURL('https://chatgpt.com/')
        await new Promise((r) => setTimeout(r, 2500))
      } catch (err) {
        console.log(C.dim(`  预热未完成（不致命）: ${err.message}`))
      }
      warm.destroy()
      console.log(C.green('  ✓ 导入完成\n'))
    } catch (err) {
      console.log(C.red(`  ✗ 导入失败: ${err.message}`))
      if (/User interaction is not allowed|SecKeychain/i.test(err.message)) {
        console.log(C.dim('  钥匙串授权被拒或超时 —— 重跑一次，在弹框里点「允许」。'))
      }
      console.log('')
    }
  }

  await pageView.webContents.loadURL(TARGET)
  console.log(C.green(`  ✓ 已加载 ${TARGET}`))

  if (!MOCK) await reportLoginState()
}

// 登录状态自检：有输入框 = 进去了；有登录按钮 = 没进去；都没有 = 可能卡在挑战页。
// 免得靠肉眼判断，也免得把「没登录」误当成「语音模式不写 DOM」。
async function reportLoginState() {
  await new Promise((r) => setTimeout(r, 3000))
  try {
    const state = await pageView.webContents.executeJavaScript(`(() => ({
      composer: Boolean(document.querySelector('#prompt-textarea, [data-testid="composer-speech-button"], form [contenteditable="true"]')),
      loginBtn: Array.from(document.querySelectorAll('button, a')).some(el =>
        /log ?in|sign ?up|登录|注册/i.test((el.textContent || '').trim())),
      challenge: /just a moment|checking your browser|verify you are human|稍等|正在验证/i.test(document.body.innerText || ''),
      title: document.title,
    }))()`)

    if (state.challenge) {
      console.log(C.red('  ✗ 卡在 Cloudflare 挑战页 —— cf_clearance 没被接受（可能 IP 或 UA 不匹配）'))
    } else if (state.composer) {
      console.log(C.green('  ✓ 已登录：检测到输入框，Cookie 导入成功'))
      createCaptionsWindow()
      console.log(C.green('  ✓ 字幕窗已打开（贴在屏幕底部，可拖动，会盖在其他应用上方）'))
      console.log(C.bold('\n  开一轮语音对话，字幕会实时出现在字幕窗里\n'))
    } else if (state.loginBtn) {
      console.log(C.yellow('  ✗ 未登录：页面上仍是登录按钮'))
      console.log(C.dim('  可能原因：Chrome 里选错了 profile（试 --profile="Profile 1"），或会话令牌已失效'))
    } else {
      console.log(C.yellow(`  ? 状态不明（标题: ${state.title}）—— 请看窗口里显示的是什么`))
    }
  } catch (err) {
    console.log(C.dim(`  登录状态自检失败: ${err.message}`))
  }
}

app.whenReady().then(async () => {
  banner()
  await createWindow()
})

app.on('window-all-closed', () => app.quit())
