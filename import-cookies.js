// 从本机 Chrome 把 ChatGPT 的登录态搬进 Electron 的持久分区。
//
// 为什么需要这个：ChatGPT 账号如果是 Google SSO 创建的，
// 在 Electron 里登录会被 Google 的 disallowed_useragent 策略拦死（"此浏览器或应用可能不安全"），
// 而且邮箱那条路会带着 login_hint 跳回 Google，形成死锁。
// 把已经登录好的 Cookie 直接搬过来，Google 就完全不参与了。
//
// macOS 上 Chrome 的 Cookie 值是加密的：
//   密钥来源  钥匙串条目 "Chrome Safe Storage"（读取会弹一次系统密码框，那是 macOS 的框）
//   派生      PBKDF2-SHA1(密码, salt="saltysalt", 1003 轮, 16 字节)
//   加密      AES-128-CBC，IV = 16 个空格
//   值前缀    "v10"
//   额外      Chrome 127+ 在明文前还加了 32 字节的 SHA256(host_key)，要剥掉

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const CHROME_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

// 只搬这些域名的 Cookie —— 绝不整库搬运
const DOMAIN_LIKE = ['%chatgpt.com', '%openai.com', '%oaistatic.com', '%oaiusercontent.com']

function chromeSafeStorageKey() {
  // 这一步会触发 macOS 钥匙串授权框。密码由系统直接交给 security 命令，不经过这里。
  const password = execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
}

function decryptValue(key, blob, hostKey) {
  if (!blob || blob.length === 0) return ''
  const prefix = blob.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') return blob.toString('utf8') // 未加密的旧格式

  const iv = Buffer.alloc(16, ' ')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
  decipher.setAutoPadding(false)
  let out = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()])

  // 手工去 PKCS#7 填充（自动去填充在明文含 32 字节哈希前缀时容易误判）
  const pad = out[out.length - 1]
  if (pad > 0 && pad <= 16 && pad <= out.length) out = out.subarray(0, out.length - pad)

  // Chrome 127+：明文 = SHA256(host_key) ‖ 真实值
  if (out.length >= 32) {
    const expect = crypto.createHash('sha256').update(hostKey).digest()
    if (out.subarray(0, 32).equals(expect)) out = out.subarray(32)
  }
  return out.toString('utf8')
}

function readChromeCookies(profile) {
  const src = path.join(CHROME_DIR, profile, 'Cookies')
  if (!fs.existsSync(src)) throw new Error(`找不到 Cookie 库: ${src}`)

  // Chrome 运行时会锁库，所以拷贝一份再读（连同 -wal）
  const tmp = path.join(os.tmpdir(), `probe-cookies-${process.pid}.db`)
  fs.copyFileSync(src, tmp)
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, tmp + ext)
  }

  const where = DOMAIN_LIKE.map((d) => `host_key LIKE '${d}'`).join(' OR ')
  const sql =
    `SELECT host_key, name, hex(encrypted_value), path, expires_utc, ` +
    `is_secure, is_httponly, samesite FROM cookies WHERE ${where};`

  let rows
  try {
    rows = execFileSync('/usr/bin/sqlite3', ['-separator', '', tmp, sql], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } finally {
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmp + ext) } catch {}
    }
  }

  return rows
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hostKey, name, hex, cookiePath, expires, secure, httpOnly, samesite] =
        line.split('')
      return {
        hostKey,
        name,
        blob: Buffer.from(hex || '', 'hex'),
        path: cookiePath || '/',
        expires: Number(expires),
        secure: secure === '1',
        httpOnly: httpOnly === '1',
        samesite: Number(samesite),
      }
    })
}

// Chrome 的时间戳是 1601-01-01 起算的微秒
const toUnixSeconds = (chromeUtc) =>
  chromeUtc > 0 ? Math.floor(chromeUtc / 1e6 - 11644473600) : undefined

const SAMESITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' }

async function importChromeCookies(targetSession, profile, log) {
  const key = chromeSafeStorageKey()
  const rows = readChromeCookies(profile)

  const now = Math.floor(Date.now() / 1000)
  let ok = 0
  let skipped = 0
  const failures = []

  for (const row of rows) {
    let value
    try {
      value = decryptValue(key, row.blob, row.hostKey)
    } catch (err) {
      failures.push(`${row.hostKey} ${row.name}: 解密失败 ${err.message}`)
      continue
    }
    if (!value) { skipped += 1; continue }

    const expirationDate = toUnixSeconds(row.expires)
    if (expirationDate !== undefined && expirationDate <= now) { skipped += 1; continue }

    const host = row.hostKey.replace(/^\./, '')

    // __Host- 前缀的 Cookie 有硬性规则：必须 secure、path 必须是 "/"、
    // 而且**不能带 domain 属性**（它天生就是主机独占的）。
    // 照搬 domain 会被 Chromium 以 EXCLUDE_INVALID_PREFIX 拒收。
    const isHostPrefixed = row.name.startsWith('__Host-')
    const cookie = {
      url: `https://${host}${isHostPrefixed ? '/' : row.path}`,
      name: row.name,
      value,
      path: isHostPrefixed ? '/' : row.path,
      secure: isHostPrefixed ? true : row.secure,
      httpOnly: row.httpOnly,
      expirationDate,
      sameSite: SAMESITE[row.samesite] ?? 'unspecified',
    }
    if (!isHostPrefixed) cookie.domain = row.hostKey

    try {
      await targetSession.cookies.set(cookie)
      ok += 1
    } catch (err) {
      failures.push(`${row.hostKey} ${row.name}: 写入失败 ${err.message}`)
    }
  }

  // 只报告名字和数量，绝不打印任何 Cookie 值
  const critical = rows
    .filter((r) => /session-token|cf_clearance|__Secure-oai/.test(r.name))
    .map((r) => `${r.hostKey}/${r.name}`)

  log(`  已导入 ${ok} 条，跳过 ${skipped} 条（空值或已过期），失败 ${failures.length} 条`)
  if (critical.length) log(`  关键 Cookie: ${critical.join(', ')}`)
  for (const f of failures.slice(0, 5)) log(`    ! ${f}`)

  return { ok, skipped, failures: failures.length }
}

module.exports = { importChromeCookies, CHROME_DIR }
