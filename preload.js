// 运行在 preload 的「隔离世界」里。
// 隔离世界与页面主世界共享同一份 DOM，只有 JS 上下文是隔离的 ——
// 所以 MutationObserver 在这里能完整看到页面的 DOM 变化，
// 不需要把脚本注入主世界，也不需要主进程轮询。
//
// 这一点对本探针至关重要：任何轮询都会以轮询间隔为粒度模糊掉
// 「逐词增量」和「整句蹦」的区别，而这恰恰是我们要测的东西。

const { ipcRenderer, contextBridge } = require('electron')

// ── UA Client Hints 补丁 ────────────────────────────────────────────────────
// session.setUserAgent() 只改 UA 字符串，完全不碰 UA Client Hints。
// 实测结果：即使 UA 自称 Chrome/150，页面里读到的仍然是
//   navigator.userAgentData.brands = [{Not;A=Brand,8},{Chromium,150}]   ← 没有 "Google Chrome"
//   getHighEntropyValues(['fullVersionList'])                           ← 泄露真实 Electron Chromium 版本
// 真实 Chrome 一定会报 "Google Chrome" 品牌，所以这是一行 JS 就能做的识别。
// 主进程那边补的是 HTTP 头，这里补的是 JS API —— 两边都补上才自洽。
//
// 必须打在「主世界」：页面自己的 JS 读的是主世界的 navigator。
function patchUserAgentData() {
  const chrome = process.versions.chrome            // 如 150.0.7871.129
  const major = chrome.split('.')[0]
  try {
    contextBridge.executeInMainWorld({
      func: (major, full) => {
        const real = navigator.userAgentData
        if (!real) return
        const brands = [
          { brand: 'Not;A=Brand', version: '8' },
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
        ]
        const fullVersionList = [
          { brand: 'Not;A=Brand', version: '8.0.0.0' },
          { brand: 'Chromium', version: full },
          { brand: 'Google Chrome', version: full },
        ]
        const shim = {
          brands,
          mobile: real.mobile,
          platform: real.platform,   // 保持真实平台：在 macOS 上谎称 Windows 比不改更容易露馅
          getHighEntropyValues: async (hints) => {
            const base = await real.getHighEntropyValues(hints)
            if (hints.includes('brands')) base.brands = brands
            if (hints.includes('fullVersionList')) base.fullVersionList = fullVersionList
            return base
          },
          toJSON: () => ({ brands, mobile: real.mobile, platform: real.platform }),
        }
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => shim,
          configurable: true,
        })
      },
      args: [major, chrome],
    })
    ipcRenderer.send('probe:ua-patched', { major, chrome })
  } catch (err) {
    ipcRenderer.send('probe:ua-patch-failed', String((err && err.message) || err))
  }
}

patchUserAgentData()

// ---- 选择器：与 ChatGPT 当前 DOM 对齐，全部带兜底 ----------------------------
// 必须对标签名不敏感：chatgpt.com 在 2026-06 把对话轮容器从 <article> 换成了 <section>，
// 但保留了 data-testid="conversation-turn-N"。写死 article 会在改版当天全盘失效。
const TURN_SELECTOR = '[data-testid^="conversation-turn-"]'
const ROLE_SELECTOR = '[data-message-author-role]'
const STOP_SELECTOR =
  'button[data-testid*="stop" i], button[aria-label*="stop" i], button[aria-label*="停止"]'

// ---- 状态 --------------------------------------------------------------------
/** messageId -> { role, samples: [{t, len}], text } */
const tracks = new Map()

const health = {
  attached: false,
  mutations: 0,      // MutationObserver 回调触发次数
  scans: 0,          // 实际扫描 DOM 的次数（受节流影响，会少于 mutations）
  turnsSeen: 0,      // 当前 DOM 里找到的对话轮数
  samples: 0,        // 累计记录的文本采样点
  lastMutationAt: 0,
}

const t0 = performance.now()
const now = () => Math.round(performance.now() - t0)

// ---- 核心扫描 ----------------------------------------------------------------
// 注意 innerText 会触发一次强制布局（reflow），在高频 mutation 下很贵。
// 我们用 rAF 合并同一帧内的多次 mutation，保证每帧最多扫一次。
// 这不是轮询：rAF 由真实的 DOM 变化驱动，时间分辨率约 16ms，
// 足以分辨逐词流式（典型 40-120ms 一个词）。

function scan() {
  health.scans += 1

  let nodes = document.querySelectorAll(TURN_SELECTOR)
  if (nodes.length === 0) nodes = document.querySelectorAll(ROLE_SELECTOR)
  health.turnsSeen = nodes.length

  const busy = Boolean(document.querySelector(STOP_SELECTOR))
  const t = now()

  nodes.forEach((node, index) => {
    const attributed = node.getAttribute('data-message-author-role')
      ? node
      : node.querySelector(ROLE_SELECTOR)
    const role = attributed && attributed.getAttribute('data-message-author-role')
    if (!role) return

    const id =
      node.getAttribute('data-message-id') ||
      (attributed && attributed.getAttribute('data-message-id')) ||
      node.id ||
      `turn-${index}`

    // 从「消息内容节点」取文本，而不是整个对话轮容器。
    //
    // 实测教训：读整个 turn 容器会把界面文字一并算进去，语音模式下抓到过
    //   "...还是只是随便问问?\n\n语音聊天已结束\n20秒"
    // 那个倒计时每秒刷新、结束后又被移除，会制造出大量假的「文本变化」，
    // 甚至让长度回退、把一条本来单调增长的消息误判成 AMBIGUOUS。
    //
    // 消息正文在带 data-message-author-role 的那一层，操作栏和计时器是它的兄弟节点，
    // 所以取 attributed 而非 node 就能天然排除掉。
    //
    // 仍用 innerText 而非 textContent：它反映渲染后的可见文本（会排除隐藏元素），
    // 更接近用户真正看到的字幕。代价是触发布局，但 rAF 合帧已经把它压到每帧最多一次，
    // 而且现在读的是更小的子树。
    const text = (attributed.innerText || '').trim()
    if (!text) return

    let track = tracks.get(id)
    if (!track) {
      track = { role, samples: [], text: '' }
      tracks.set(id, track)
    }
    if (track.text === text) return // 没变化，不记点

    track.text = text
    track.samples.push({ t, len: text.length })
    health.samples += 1

    ipcRenderer.send('probe:sample', {
      id,
      role,
      t,
      len: text.length,
      sampleIndex: track.samples.length,
      busy,
      // 终端日志用：只回传尾部，避免把整段对话反复刷屏
      tail: text.slice(-60),
      // 字幕窗用：回传尾部一段完整文本。上限 400 字，
      // 字幕本来就只显示最近这一截，没必要把整段对话按字符搬运。
      caption: text.slice(-400),
    })
  })
}

let frameQueued = false
function schedule() {
  if (frameQueued) return
  frameQueued = true
  requestAnimationFrame(() => {
    frameQueued = false
    try {
      scan()
    } catch (err) {
      ipcRenderer.send('probe:error', String((err && err.stack) || err))
    }
  })
}

// ---- 启动 --------------------------------------------------------------------
function attach() {
  if (health.attached) return
  const observer = new MutationObserver(() => {
    health.mutations += 1
    health.lastMutationAt = now()
    schedule()
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  health.attached = true
  scan() // 记录初始状态
  ipcRenderer.send('probe:attached', { url: location.href })
}

// ── 挂载闸门 ──────────────────────────────────────────────────────────────
// 观察器只在 ChatGPT 自己的页面上挂载。
// 这个 WebContentsView 在登录流程里会途经 accounts.google.com / auth.openai.com，
// 一个扫描页面文本的东西不该出现在登录页上 —— 哪怕它当下只匹配 ChatGPT 的选择器、
// 什么也采不到。这类代码只要存在，将来改一行选择器就可能变成另一回事。
const OBSERVE_HOSTS = /(^|\.)chatgpt\.com$/i

function shouldObserve() {
  // file:// 是自检用的 mock 页，放行
  if (location.protocol === 'file:') return true
  return OBSERVE_HOSTS.test(location.hostname)
}

if (!shouldObserve()) {
  ipcRenderer.send('probe:skipped', { host: location.hostname })
} else if (document.body) {
  attach()
} else {
  document.addEventListener('DOMContentLoaded', attach, { once: true })
}

// 心跳：让主进程能区分「观察器没装上」「装上了但页面没动静」「有动静但没有对话轮」
setInterval(() => ipcRenderer.send('probe:health', { ...health, url: location.href }), 1000)

// 主进程要求出总结时，把完整的采样时间线交回去
ipcRenderer.on('probe:dump-request', () => {
  const dump = [...tracks.entries()].map(([id, track]) => ({
    id,
    role: track.role,
    samples: track.samples,
    finalLen: track.text.length,
    preview: track.text.slice(0, 80),
  }))
  ipcRenderer.send('probe:dump', dump)
})

ipcRenderer.on('probe:reset', () => {
  tracks.clear()
  health.samples = 0
  health.mutations = 0
  health.scans = 0
})
