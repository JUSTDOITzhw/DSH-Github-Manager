/**
 * dsh-github-manager — host half.
 *
 * Binds a GitHub account and exposes repository management to the browser half
 * over same-origin loopback HTTP routes. This half owns the credential, talks
 * to the GitHub REST API, reads the local filesystem when a project is pushed,
 * and never lets the browser see the token.
 *
 *   GET  /api/github-manager/state    credential status + account cache
 *   POST /api/github-manager/action   { action, ...payload }
 *
 * Actions
 *   auth.status / auth.set / auth.clear
 *   auth.device.start / auth.device.poll
 *   repos.list / repos.create / repos.visibility / repos.delete
 *   local.probe    browse the local filesystem for a directory or file to send
 *   upload.project push a whole directory as a repository
 *   upload.file    write one local file to a path inside a repository
 *
 * The credential lives in `<DSH_HOME>/github-manager/auth.json` with mode 0600
 * and is never echoed back: the browser only ever learns the login, the avatar
 * and the OAuth scopes, which is what the panel needs to render.
 *
 * The browser half (`./client`, exported as `lib/client.js`) contributes the
 * panel mounted into the `sidebar.footer.action` slot.
 *
 * While an account is bound this half also mounts the official GitHub MCP server
 * as a child plugin, so the conversation gets `mcp__github__*` tools. See
 * `createMcpMount` for why that lives here rather than in a patch row.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'github-manager'

/** Route registration needs the browser HTTP carrier. */
export const inject = ['webServer']

const API = '/api/github-manager'
const GITHUB = 'https://api.github.com'
const GITHUB_WEB = 'https://github.com'

/** Directories that are never worth pushing and can be enormous. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.venv', 'venv', '__pycache__',
  'target', 'dist', 'build', 'out', '.cache', '.gradle', '.idea', '.vscode',
  'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache',
])

/** Files that are noise in a fresh repository. */
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

const DEFAULTS = {
  authPath: '',
  /** Pin the OAuth app used by the device flow; empty means "ask the panel". */
  deviceClientId: '',
  deviceScopes: 'repo delete_repo workflow',
  /** Guard rails for `upload.project`: a runaway directory must not be sent. */
  maxFiles: 600,
  maxBytes: 24 * 1024 * 1024,
  /** Files larger than this are skipped with a note rather than failing the push. */
  maxFileBytes: 8 * 1024 * 1024,

  /**
   * Chat tools. Mounting the official GitHub MCP server makes the bound account
   * usable from the conversation as `mcp__<mcpServerName>__<tool>`. Turn this off
   * to keep the plugin panel-only (the tool definitions are ~12k tokens of every
   * request with the default toolset, so a user who only wants the panel should
   * not have to pay for it).
   */
  enableMcp: true,
  mcpServerName: 'github',
  mcpUrl: 'https://api.githubcopilot.com/mcp/',
  /**
   * Which tool groups the remote server advertises. `context,repos` = 22 tools
   * (~11.7k tokens/request); `repos` alone = 19 (~10.2k); everything = 44 (~30k).
   */
  mcpToolsets: 'context,repos',
  mcpToolCallTimeoutMs: 120000,
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Run `worker` over `items` with a bounded number of in-flight calls. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return out
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((settle) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        settle(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        settle({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        settle(parsed !== null && typeof parsed === 'object' ? parsed : null)
      } catch {
        settle(null)
      }
    })
    req.on('error', () => settle(null))
  })
}

const isLoopback = (req) => {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === ''
}

/** Reject cross-origin callers: these routes carry a GitHub credential. */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

const guarded = (req) => isLoopback(req) && sameOrigin(req)

/* ------------------------------------------------------------------ *
 * Credential storage
 * ------------------------------------------------------------------ */

function resolveConfig(raw) {
  const merged = { ...DEFAULTS }
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null && value !== '') merged[key] = value
    }
  }
  return merged
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/** Where the credential and the panel's own settings live. */
function authFilePath(config) {
  if (typeof config.authPath === 'string' && config.authPath.trim() !== '') return resolve(config.authPath)
  return join(dshHome(), 'github-manager', 'auth.json')
}

/**
 * The stored record. `token` is the only secret; everything else is a cache of
 * what GitHub reported the last time we verified, so the panel can paint before
 * a round trip finishes.
 */
function readAuth(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    if (typeof raw.token !== 'string' || raw.token === '') return null
    return raw
  } catch {
    return null
  }
}

function writeAuth(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  /* Windows ignores the mode above; chmod is a no-op there but harmless. */
  try {
    chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
}

function clearAuth(file) {
  if (!existsSync(file)) return false
  try {
    writeFileSync(file, '{}\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * GitHub REST
 * ------------------------------------------------------------------ */

/**
 * One request. `token` is passed explicitly so the device flow can probe before
 * anything is persisted.
 *
 * Returns a plain record instead of throwing, because almost every failure here
 * is something the panel should show verbatim: a missing scope, a name that is
 * taken, a rate limit.
 */
async function gh(method, path, { token, body, accept, timeoutMs = 30000 } = {}) {
  const headers = {
    accept: accept ?? 'application/vnd.github+json',
    'user-agent': 'dsh-github-manager',
    'x-github-api-version': '2022-11-28',
  }
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(`${GITHUB}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, status: 0, data: null, text: '', message: `无法连接 api.github.com：${messageOf(error)}` }
  }
  const text = await response.text()
  let data = null
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
    text,
    scopes: response.headers.get('x-oauth-scopes'),
    remaining: response.headers.get('x-ratelimit-remaining'),
    message: describeFailure(response.status, data, text),
  }
}

/** Turn a GitHub error envelope into one line a human can act on. */
function describeFailure(status, data, text) {
  if (status === 0) return ''
  const detail = data !== null && typeof data === 'object' ? data : null
  const base = detail !== null && typeof detail.message === 'string' ? detail.message : ''
  const errors = detail !== null && Array.isArray(detail.errors) ? detail.errors : []
  const extra = errors
    .map((item) => {
      if (item === null || typeof item !== 'object') return typeof item === 'string' ? item : ''
      const where = typeof item.field === 'string' ? `${item.field}: ` : ''
      const why = typeof item.message === 'string' ? item.message : typeof item.code === 'string' ? item.code : ''
      return `${where}${why}`.trim()
    })
    .filter((item) => item !== '')
    .join('；')
  const composed = extra === '' ? base : `${base}（${extra}）`
  if (composed !== '') return composed
  if (text !== '') return text.slice(0, 300)
  return `GitHub 返回 ${status}`
}

/**
 * Call `handler` with the stored token, or short-circuit with a message the
 * panel can render as "not signed in yet".
 */
async function withAuth(file, handler) {
  const record = readAuth(file)
  if (record === null) return { status: 401, body: { ok: false, message: '尚未绑定 GitHub 账号' } }
  return handler(record)
}

/** Verify a token and reduce the answer to what the panel displays. */
async function accountOf(token) {
  const result = await gh('GET', '/user', { token })
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      message: result.status === 401 ? 'token 无效或已过期' : result.message,
    }
  }
  const user = result.data ?? {}
  const scopes = typeof result.scopes === 'string' && result.scopes !== ''
    ? result.scopes.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '')
    : []
  return {
    ok: true,
    account: {
      login: typeof user.login === 'string' ? user.login : '',
      name: typeof user.name === 'string' ? user.name : '',
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
      htmlUrl: typeof user.html_url === 'string' ? user.html_url : '',
      publicRepos: typeof user.public_repos === 'number' ? user.public_repos : 0,
      scopes,
      rateRemaining: result.remaining === null ? null : Number(result.remaining),
    },
  }
}

/* ------------------------------------------------------------------ *
 * Local filesystem
 * ------------------------------------------------------------------ */

/** Resolve a user-supplied path to an existing directory, or explain why not. */
function requireDir(input) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (value === '') return { ok: false, message: '请提供目录路径' }
  const target = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value)
  let stat
  try {
    stat = statSync(target)
  } catch {
    return { ok: false, message: `路径不存在：${target}` }
  }
  if (!stat.isDirectory()) return { ok: false, message: `不是目录：${target}` }
  return { ok: true, dir: target }
}

/**
 * Walk a directory into the file list a repository push needs. Skips the usual
 * build/output trees and anything oversized, and records why so the panel can
 * report what was left behind instead of silently dropping files.
 */
async function collectFiles(root, config) {
  const files = []
  const skipped = []
  let bytes = 0
  const walk = async (dir, prefix) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: prefix === '' ? '.' : prefix, reason: messageOf(error) })
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.name.includes('\n') || entry.name.includes('\r')) {
        skipped.push({ path: rel, reason: '文件名含换行符' })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          skipped.push({ path: rel, reason: '目录已跳过' })
          continue
        }
        await walk(join(dir, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIP_FILES.has(entry.name)) continue
      if (files.length >= config.maxFiles) {
        skipped.push({ path: rel, reason: `超过文件数上限 ${config.maxFiles}` })
        continue
      }
      let stat
      try {
        stat = statSync(join(dir, entry.name))
      } catch {
        skipped.push({ path: rel, reason: '无法读取' })
        continue
      }
      if (stat.size > config.maxFileBytes) {
        skipped.push({ path: rel, reason: `文件超过 ${Math.round(config.maxFileBytes / 1024 / 1024)} MB` })
        continue
      }
      if (bytes + stat.size > config.maxBytes) {
        skipped.push({ path: rel, reason: `超过总大小上限 ${Math.round(config.maxBytes / 1024 / 1024)} MB` })
        continue
      }
      bytes += stat.size
      files.push({ path: rel, size: stat.size, local: join(dir, entry.name) })
    }
  }
  await walk(root, '')
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, skipped, bytes }
}

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

async function listRepos(token, payload) {
  const perPage = Math.max(1, Math.min(100, Number(payload.perPage) || 100))
  const page = Math.max(1, Number(payload.page) || 1)
  const sort = ['updated', 'pushed', 'created', 'full_name'].includes(payload.sort) ? payload.sort : 'updated'
  const affiliation = 'owner,collaborator,organization_member'
  const result = await gh('GET', `/user/repos?per_page=${perPage}&page=${page}&sort=${sort}&affiliation=${encodeURIComponent(affiliation)}`, { token })
  if (!result.ok) return { status: result.status, body: { ok: false, message: result.message } }
  const repos = Array.isArray(result.data) ? result.data : []
  return {
    status: 200,
    body: {
      ok: true,
      repos: repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner?.login ?? '',
        private: repo.private === true,
        description: typeof repo.description === 'string' ? repo.description : '',
        htmlUrl: typeof repo.html_url === 'string' ? repo.html_url : '',
        defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
        updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : '',
        pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : '',
        size: typeof repo.size === 'number' ? repo.size : 0,
        stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
        archived: repo.archived === true,
      })),
    },
  }
}

async function createRepo(token, payload) {
  const repoName = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (repoName === '') return { status: 400, body: { ok: false, message: '请填写仓库名' } }
  const owner = typeof payload.owner === 'string' ? payload.owner.trim() : ''
  const body = {
    name: repoName,
    description: typeof payload.description === 'string' ? payload.description : '',
    private: payload.private !== false,
    /* An initial commit makes the repository usable through the Git Data API
       immediately; an empty repository rejects blob uploads with 409. */
    auto_init: true,
  }
  const result = owner === ''
    ? await gh('POST', '/user/repos', { token, body })
    : await gh('POST', `/orgs/${encodeURIComponent(owner)}/repos`, { token, body })
  if (!result.ok) return { status: result.status, body: { ok: false, message: result.message } }
  const repo = result.data ?? {}
  return {
    status: 200,
    body: {
      ok: true,
      repo: {
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner?.login ?? '',
        private: repo.private === true,
        htmlUrl: typeof repo.html_url === 'string' ? repo.html_url : '',
        defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
      },
    },
  }
}

async function setVisibility(token, payload) {
  const owner = typeof payload.owner === 'string' ? payload.owner.trim() : ''
  const repo = typeof payload.repo === 'string' ? payload.repo.trim() : ''
  if (owner === '' || repo === '') return { status: 400, body: { ok: false, message: '缺少 owner 或 repo' } }
  const result = await gh('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token,
    body: { private: payload.private !== false },
  })
  if (!result.ok) return { status: result.status, body: { ok: false, message: result.message } }
  return { status: 200, body: { ok: true, private: result.data?.private === true } }
}

/**
 * Deleting a repository is irreversible and needs the `delete_repo` scope. The
 * caller must echo the full name back, so a slip in the panel cannot wipe the
 * wrong repository.
 */
async function deleteRepo(token, payload, scopes) {
  const owner = typeof payload.owner === 'string' ? payload.owner.trim() : ''
  const repo = typeof payload.repo === 'string' ? payload.repo.trim() : ''
  if (owner === '' || repo === '') return { status: 400, body: { ok: false, message: '缺少 owner 或 repo' } }
  const expected = `${owner}/${repo}`
  const confirm = typeof payload.confirm === 'string' ? payload.confirm.trim() : ''
  if (confirm !== expected) {
    return { status: 400, body: { ok: false, message: `请在确认框里完整输入 ${expected} 以继续` } }
  }
  if (Array.isArray(scopes) && scopes.length > 0 && !scopes.includes('delete_repo')) {
    return {
      status: 403,
      body: {
        ok: false,
        message: '当前 token 没有 delete_repo 权限，无法删除仓库。请换一个带 delete_repo 的 token。',
      },
    }
  }
  const result = await gh('DELETE', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token })
  if (result.status === 403) {
    return {
      status: 403,
      body: { ok: false, message: '权限不足：删除仓库需要 token 带 delete_repo 权限。' },
    }
  }
  /* 204 is the documented success; 404 means it was already gone. */
  if (!result.ok && result.status !== 404) {
    return { status: result.status, body: { ok: false, message: result.message } }
  }
  return { status: 200, body: { ok: true, deleted: expected } }
}

/* ------------------------------------------------------------------ *
 * Uploads
 * ------------------------------------------------------------------ */

async function repoExists(token, owner, repo) {
  const result = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token })
  if (result.ok) return { exists: true, repo: result.data ?? {} }
  if (result.status === 404) return { exists: false }
  return { exists: false, error: result.message, status: result.status }
}

/** Current tip of a branch, or null when the branch does not exist yet. */
async function branchHead(token, owner, repo, branch) {
  const result = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`, { token })
  if (!result.ok) return null
  const sha = result.data?.object?.sha
  return typeof sha === 'string' ? sha : null
}

/**
 * Upload a directory as the content of a repository, via the Git Data API:
 * blobs -> tree -> commit -> ref. This path needs nothing but `fetch`, so it
 * works even where the git binary or the smart-HTTP transport is unavailable.
 */
async function pushProject(token, payload, config) {
  const target = requireDir(payload.dir)
  if (!target.ok) return { status: 400, body: { ok: false, message: target.message } }
  const owner = typeof payload.owner === 'string' ? payload.owner.trim() : ''
  let repoName = typeof payload.repo === 'string' ? payload.repo.trim() : ''
  if (owner === '') return { status: 400, body: { ok: false, message: '请先绑定账号或填写 owner' } }
  if (repoName === '') repoName = target.dir.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (repoName === '') return { status: 400, body: { ok: false, message: '请填写目标仓库名' } }

  const collected = await collectFiles(target.dir, config)
  if (collected.files.length === 0) {
    return { status: 400, body: { ok: false, message: `目录里没有可上传的文件：${target.dir}` } }
  }

  /* Create the repository when it is missing, exactly like the panel promises. */
  let created = false
  const probe = await repoExists(token, owner, repoName)
  if (probe.error !== undefined) return { status: probe.status ?? 400, body: { ok: false, message: probe.error } }
  if (!probe.exists) {
    const made = await createRepo(token, {
      owner,
      name: repoName,
      description: typeof payload.description === 'string' ? payload.description : '',
      private: payload.private !== false,
    })
    if (!made.body.ok) return made
    created = true
  }

  const branch = typeof payload.branch === 'string' && payload.branch.trim() !== ''
    ? payload.branch.trim()
    : 'main'

  /* Blobs first: one request per file, bounded concurrency. */
  const blobs = await mapLimit(collected.files, 6, async (file) => {
    let content
    try {
      content = await readFile(file.local)
    } catch (error) {
      return { path: file.path, error: messageOf(error) }
    }
    const result = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/blobs`, {
      token,
      body: { content: content.toString('base64'), encoding: 'base64' },
      timeoutMs: 60000,
    })
    if (!result.ok) return { path: file.path, error: result.message }
    return { path: file.path, sha: result.data?.sha }
  })

  const failed = blobs.filter((item) => item.error !== undefined)
  const usable = blobs.filter((item) => typeof item.sha === 'string')
  if (usable.length === 0) {
    return {
      status: 502,
      body: { ok: false, message: `所有文件都上传失败：${failed[0]?.error ?? '未知错误'}` },
    }
  }

  const head = await branchHead(token, owner, repoName, branch)
  const treeEntry = (item) => ({ path: item.path, mode: '100644', type: 'blob', sha: item.sha })

  /* Prefer one nested tree so the request stays small; fall back to a flat
     tree when the paths are shallow (the common case for a small project). */
  const treePayload = head === null
    ? { tree: usable.map(treeEntry) }
    : { tree: usable.map(treeEntry), base_tree: head }
  const treeResult = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/trees`, {
    token,
    body: treePayload,
    timeoutMs: 60000,
  })
  if (!treeResult.ok) {
    return { status: treeResult.status, body: { ok: false, message: `组装目录树失败：${treeResult.message}` } }
  }

  const message = typeof payload.message === 'string' && payload.message.trim() !== ''
    ? payload.message.trim()
    : created ? 'Initial commit from dsh-github-manager' : `Update from dsh-github-manager`

  /* An empty repository has no parent commit; a populated one must keep its
     history, otherwise the push would silently rewrite the branch. */
  let parents = []
  if (head !== null) {
    parents = [head]
  } else {
    const refCheck = await branchHead(token, owner, repoName, branch)
    if (refCheck !== null) parents = [refCheck]
  }

  const commitResult = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/commits`, {
    token,
    body: { message, tree: treeResult.data?.sha, parents },
  })
  if (!commitResult.ok) {
    return { status: commitResult.status, body: { ok: false, message: `创建提交失败：${commitResult.message}` } }
  }
  const commitSha = commitResult.data?.sha

  let refResult
  if (head === null) {
    refResult = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs`, {
      token,
      body: { ref: `refs/heads/${branch}`, sha: commitSha },
    })
    /* A concurrent/auto_init commit can make the ref appear between the read
       and the write; updating it is then the correct move. */
    if (!refResult.ok && refResult.status === 422) {
      refResult = await gh('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs/heads/${encodeURIComponent(branch)}`, {
        token,
        body: { sha: commitSha, force: false },
      })
    }
  } else {
    refResult = await gh('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs/heads/${encodeURIComponent(branch)}`, {
      token,
      body: { sha: commitSha, force: false },
    })
  }
  if (!refResult.ok) {
    return { status: refResult.status, body: { ok: false, message: `更新分支失败：${refResult.message}` } }
  }

  return {
    status: 200,
    body: {
      ok: true,
      owner,
      repo: repoName,
      branch,
      created,
      commit: commitSha,
      url: `${GITHUB_WEB}/${owner}/${repoName}`,
      uploaded: usable.length,
      skipped: collected.skipped,
      bytes: collected.bytes,
      failed,
    },
  }
}

/**
 * Write a single local file to a path inside a repository, through the Contents
 * API. Existing content at that path is updated in place (its blob sha has to
 * be echoed back, which is why we read it first).
 */
async function uploadFile(token, payload) {
  const owner = typeof payload.owner === 'string' ? payload.owner.trim() : ''
  const repo = typeof payload.repo === 'string' ? payload.repo.trim() : ''
  if (owner === '' || repo === '') return { status: 400, body: { ok: false, message: '缺少 owner 或 repo' } }
  const localInput = typeof payload.local === 'string' ? payload.local.trim() : ''
  if (localInput === '') return { status: 400, body: { ok: false, message: '请提供要上传的本地文件路径' } }
  const local = isAbsolute(localInput) ? resolve(localInput) : resolve(process.cwd(), localInput)
  let stat
  try {
    stat = statSync(local)
  } catch {
    return { status: 400, body: { ok: false, message: `文件不存在：${local}` } }
  }
  if (!stat.isFile()) return { status: 400, body: { ok: false, message: `不是文件：${local}` } }
  if (stat.size > 50 * 1024 * 1024) {
    return { status: 400, body: { ok: false, message: '文件超过 50 MB，Contents API 不支持' } }
  }
  const remote = typeof payload.path === 'string' && payload.path.trim() !== ''
    ? payload.path.trim().replace(/^\/+/, '')
    : local.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (remote === '') return { status: 400, body: { ok: false, message: '请提供仓库内的目标路径' } }

  const branch = typeof payload.branch === 'string' && payload.branch.trim() !== '' ? payload.branch.trim() : undefined
  const query = branch === undefined ? '' : `?ref=${encodeURIComponent(branch)}`

  /* Read any existing blob sha, so an update is not rejected as a conflict. */
  let sha
  const existing = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${remote.split('/').map(encodeURIComponent).join('/')}${query}`, { token })
  if (existing.ok && existing.data !== null && typeof existing.data === 'object' && typeof existing.data.sha === 'string') {
    sha = existing.data.sha
  }

  let content
  try {
    content = await readFile(local)
  } catch (error) {
    return { status: 400, body: { ok: false, message: messageOf(error) } }
  }
  const body = {
    message: typeof payload.message === 'string' && payload.message.trim() !== ''
      ? payload.message.trim()
      : `${sha === undefined ? 'Add' : 'Update'} ${remote} from dsh-github-manager`,
    content: content.toString('base64'),
  }
  if (sha !== undefined) body.sha = sha
  if (branch !== undefined) body.branch = branch

  const result = await gh('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${remote.split('/').map(encodeURIComponent).join('/')}`, {
    token,
    body,
    timeoutMs: 60000,
  })
  if (!result.ok) return { status: result.status, body: { ok: false, message: result.message } }
  return {
    status: 200,
    body: {
      ok: true,
      owner,
      repo,
      path: remote,
      replaced: sha !== undefined,
      bytes: stat.size,
      url: `${GITHUB_WEB}/${owner}/${repo}/blob/${branch ?? result.data?.commit?.branch ?? 'main'}/${remote}`,
    },
  }
}

/* ------------------------------------------------------------------ *
 * OAuth device flow
 * ------------------------------------------------------------------ */

/**
 * Ask GitHub for a user code. The panel shows it and opens the verification
 * page; polling then turns it into a token.
 */
async function deviceStart(config, payload) {
  const clientId = typeof payload.clientId === 'string' && payload.clientId.trim() !== ''
    ? payload.clientId.trim()
    : config.deviceClientId
  if (clientId === '') {
    return {
      status: 400,
      body: {
        ok: false,
        message: '设备流需要一个 OAuth App 的 client id。请在面板里填入，或用 Personal Access Token 绑定。',
        needsClientId: true,
      },
    }
  }
  const scopes = typeof payload.scopes === 'string' && payload.scopes.trim() !== '' ? payload.scopes.trim() : config.deviceScopes
  let response
  try {
    response = await fetch(`${GITHUB_WEB}/login/device/code`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'dsh-github-manager' },
      body: JSON.stringify({ client_id: clientId, scope: scopes }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    return { status: 502, body: { ok: false, message: `无法连接 github.com：${messageOf(error)}` } }
  }
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  if (!response.ok || data === null || typeof data.device_code !== 'string') {
    return {
      status: response.status === 200 ? 502 : response.status,
      body: { ok: false, message: describeFailure(response.status, data, text) || '设备流启动失败' },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      clientId,
      userCode: data.user_code,
      deviceCode: data.device_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: typeof data.interval === 'number' ? data.interval : 5,
    },
  }
}

/**
 * One poll tick. `authorization_pending` is the normal answer until the user
 * finishes in the browser, so it is returned as `pending` rather than an error.
 */
async function devicePoll(config, payload, file) {
  const clientId = typeof payload.clientId === 'string' && payload.clientId.trim() !== '' ? payload.clientId.trim() : config.deviceClientId
  const deviceCode = typeof payload.deviceCode === 'string' ? payload.deviceCode : ''
  if (clientId === '' || deviceCode === '') {
    return { status: 400, body: { ok: false, message: '缺少 client id 或 device code' } }
  }
  let response
  try {
    response = await fetch(`${GITHUB_WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'dsh-github-manager' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    return { status: 502, body: { ok: false, message: `无法连接 github.com：${messageOf(error)}` } }
  }
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  const error = typeof data?.error === 'string' ? data.error : ''
  if (error === 'authorization_pending') return { status: 200, body: { ok: true, pending: true } }
  if (error === 'slow_down') return { status: 200, body: { ok: true, pending: true, slowDown: true } }
  if (error === 'expired_token') return { status: 400, body: { ok: false, message: '设备码已过期，请重新开始' } }
  if (error === 'access_denied') return { status: 403, body: { ok: false, message: '你在浏览器里拒绝了这个授权' } }
  const token = typeof data?.access_token === 'string' ? data.access_token : ''
  if (token === '') {
    return { status: 502, body: { ok: false, message: describeFailure(response.status, data, text) || '授权未返回 token' } }
  }
  const verified = await accountOf(token)
  if (!verified.ok) return { status: 401, body: { ok: false, message: verified.message } }
  writeAuth(file, {
    token,
    source: 'device',
    clientId,
    savedAt: new Date().toISOString(),
    account: verified.account,
  })
  return { status: 200, body: { ok: true, pending: false, account: verified.account } }
}

/* ------------------------------------------------------------------ *
 * Chat tools — the GitHub MCP server as a child plugin
 * ------------------------------------------------------------------ */

/** Loaded lazily so a missing package degrades into a state instead of a crash. */
const defaultLoadMcpClient = () => import('@deepseek-ai/dsh-mcp-client')

/**
 * Mount `@deepseek-ai/dsh-mcp-client` as a *child* of this plugin.
 *
 * The MCP bridge is itself an ordinary dsh plugin, and the profile patch row that
 * used to carry it was a separate install unit: uninstalling this plugin left an
 * orphan behind whose `!!js` token expression resolved to nothing, and a token
 * bound in the panel only took effect after a restart. Mounting it here ties both
 * to this plugin's fiber — removing or disabling the plugin takes the tools away
 * with it — and lets a freshly bound token be picked up immediately.
 *
 * Everything is injected so the state machine is unit-testable without a live
 * cordis context.
 */
export function createMcpMount({ ctx, config, file, readAuth: read = readAuth, loadClient = defaultLoadMcpClient }) {
  const enabled = config.enableMcp !== false
  const snapshot = {
    enabled,
    state: enabled ? 'idle' : 'disabled',
    serverName: config.mcpServerName,
    toolsets: config.mcpToolsets,
    message: '',
  }
  let fiber = null
  let mountedToken = ''
  let pending = null

  const release = () => {
    mountedToken = ''
    if (fiber === null) return
    const target = fiber
    fiber = null
    try {
      target.dispose()
    } catch {
      /* a teardown race must never break the caller */
    }
  }

  const sync = async () => {
    if (!enabled) return snapshot
    const record = read(file)
    if (record === null) {
      release()
      snapshot.state = 'unbound'
      snapshot.message = '绑定 GitHub 账号后，聊天里会出现 mcp__github__* 工具'
      return snapshot
    }
    /* Same token and still mounted: nothing to do. A re-bind changes the token
       and falls through to the remount below. */
    if (fiber !== null && mountedToken === record.token) return snapshot
    release()
    let client
    try {
      client = await loadClient()
    } catch (error) {
      snapshot.state = 'missing'
      snapshot.message = `无法加载 @deepseek-ai/dsh-mcp-client：${messageOf(error)}`
      return snapshot
    }
    try {
      const started = ctx.plugin(client, {
        serverName: config.mcpServerName,
        transport: 'streamable-http',
        url: config.mcpUrl,
        headers: {
          Authorization: `Bearer ${record.token}`,
          'X-MCP-Toolsets': config.mcpToolsets,
        },
        toolCallTimeoutMs: config.mcpToolCallTimeoutMs,
      })
      fiber = started
      mountedToken = record.token
      snapshot.state = 'mounted'
      snapshot.message = ''
      /* The fiber is thenable; a startup failure has to surface as state rather
         than as an unhandled rejection. */
      Promise.resolve(started).catch((error) => {
        if (fiber !== started) return
        snapshot.state = 'error'
        snapshot.message = messageOf(error)
      })
    } catch (error) {
      fiber = null
      mountedToken = ''
      snapshot.state = 'error'
      snapshot.message = messageOf(error)
    }
    return snapshot
  }

  /** Serialize concurrent syncs — a device poll and a bind can land together. */
  const refresh = () => {
    if (pending !== null) return pending
    pending = sync().finally(() => {
      pending = null
    })
    return pending
  }

  return { snapshot, refresh, release }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const file = authFilePath(config)
  const runtime = { lastError: '', note: '' }
  const mcp = createMcpMount({ ctx, config, file })

  /** Every credential change re-evaluates whether the tools should be mounted. */
  const syncTools = () => {
    void mcp.refresh()
  }

  const note = (text) => {
    runtime.note = text
  }

  const state = async () => {
    const record = readAuth(file)
    if (record === null) {
      return { status: 200, body: { ok: true, bound: false, authPath: file, mcp: { ...mcp.snapshot } } }
    }
    return {
      status: 200,
      body: {
        ok: true,
        bound: true,
        authPath: file,
        source: typeof record.source === 'string' ? record.source : 'pat',
        savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
        account: record.account ?? null,
        deviceClientId: config.deviceClientId,
        limits: {
          maxFiles: config.maxFiles,
          maxBytes: config.maxBytes,
          maxFileBytes: config.maxFileBytes,
        },
        mcp: { ...mcp.snapshot },
        lastError: runtime.lastError,
      },
    }
  }

  /** `auth.set`: verify before persisting, so a bad paste never replaces a good token. */
  const authSet = async (payload) => {
    const token = typeof payload.token === 'string' ? payload.token.trim() : ''
    if (token === '') return { status: 400, body: { ok: false, message: '请粘贴 token' } }
    const verified = await accountOf(token)
    if (!verified.ok) return { status: 401, body: { ok: false, message: verified.message } }
    writeAuth(file, {
      token,
      source: 'pat',
      savedAt: new Date().toISOString(),
      account: verified.account,
    })
    return {
      status: 200,
      body: { ok: true, source: 'pat', account: verified.account, authPath: file },
    }
  }

  /** `auth.status`: re-verify the stored token on demand. */
  const authStatus = async () => withAuth(file, async (record) => {
    const verified = await accountOf(record.token)
    if (!verified.ok) return { status: 401, body: { ok: false, message: verified.message } }
    writeAuth(file, { ...record, account: verified.account })
    return {
      status: 200,
      body: { ok: true, source: record.source ?? 'pat', account: verified.account },
    }
  })

  const dispatch = {
    'auth.status': () => authStatus(),

    /* Any credential change re-evaluates the chat tools: a fresh token mounts
       them, a cleared one takes them down, and the user sees the effect without
       restarting dsh. */
    'auth.set': async (payload) => {
      const result = await authSet(payload)
      if (result.body?.ok === true) syncTools()
      return result
    },
    'auth.clear': () => {
      const existed = clearAuth(file)
      syncTools()
      return { status: 200, body: { ok: true, cleared: existed } }
    },
    'auth.device.start': (payload) => deviceStart(config, payload),
    'auth.device.poll': async (payload) => {
      const result = await devicePoll(config, payload, file)
      if (result.body?.ok === true && result.body.pending !== true) syncTools()
      return result
    },

    'repos.list': (payload) => withAuth(file, (record) => listRepos(record.token, payload)),
    'repos.create': (payload) => withAuth(file, (record) => createRepo(record.token, payload)),
    'repos.visibility': (payload) => withAuth(file, (record) => setVisibility(record.token, payload)),
    'repos.delete': (payload) => withAuth(file, async (record) => {
      const verified = await accountOf(record.token)
      const scopes = verified.ok ? verified.account.scopes : []
      return deleteRepo(record.token, payload, scopes)
    }),

    'local.probe': (payload) => {
      const dir = typeof payload.dir === 'string' && payload.dir.trim() !== '' ? payload.dir.trim() : homedir()
      const target = isAbsolute(dir) ? resolve(dir) : resolve(process.cwd(), dir)
      return (async () => {
        let entries
        try {
          entries = await readdir(target, { withFileTypes: true })
        } catch (error) {
          return { status: 400, body: { ok: false, message: `无法读取目录：${messageOf(error)}` } }
        }
        const dirs = []
        const files = []
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
          if (entry.isDirectory()) dirs.push(entry.name)
          else if (entry.isFile()) files.push(entry.name)
        }
        dirs.sort((a, b) => a.localeCompare(b))
        files.sort((a, b) => a.localeCompare(b))
        const parent = dirname(target)
        return {
          status: 200,
          body: {
            ok: true,
            path: target,
            parent: parent === target ? null : parent,
            sep,
            dirs,
            files,
            home: homedir(),
            cwd: process.cwd(),
          },
        }
      })()
    },

    'upload.project': (payload) => withAuth(file, (record) => pushProject(record.token, payload, config)),
    'upload.file': (payload) => withAuth(file, (record) => uploadFile(record.token, payload)),
  }

  const getState = async (req, res) => {
    const result = await state()
    sendJson(res, result.status, result.body)
  }

  const action = async (req, res) => {
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
    const handler = dispatch[body.action]
    if (handler === undefined) return sendJson(res, 400, { ok: false, message: `未知动作：${String(body.action)}` })
    try {
      const result = await handler(body)
      if (result.ok === false || result.body?.ok === false) {
        runtime.lastError = result.body?.message ?? ''
      }
      sendJson(res, result.status ?? 200, result.body)
    } catch (error) {
      const message = messageOf(error)
      runtime.lastError = message
      sendJson(res, 409, { ok: false, message })
    }
  }

  const forbidden = (res) => sendJson(res, 403, { ok: false, message: '仅允许本机同源访问' })
  const asGet = (handler) => (req, res) => (guarded(req) ? handler(req, res) : forbidden(res))

  const routes = [
    { kind: 'exact', path: `${API}/state`, handler: asGet(getState) },
    {
      kind: 'exact',
      path: `${API}/action`,
      handler: (req, res) => {
        if (!guarded(req)) return forbidden(res)
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '请使用 POST' })
        return action(req, res)
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    note(readAuth(file) === null
      ? 'github-manager 已就绪，等待绑定账号'
      : 'github-manager 已就绪，账号已绑定')
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* a route may already be gone if the carrier is tearing down */
        }
      }
    }
  })

  /* The chat tools ride this plugin's own fiber: mounting starts here, and the
     teardown is implicit — the child fiber goes away with its parent. That is
     what makes the MCP bridge follow the plugin through install, disable and
     uninstall instead of lingering as an orphan patch row. */
  ctx.effect(() => {
    syncTools()
    return () => mcp.release()
  })
}

export const internals = {
  DEFAULTS,
  SKIP_DIRS,
  SKIP_FILES,
  createMcpMount,
  resolveConfig,
  authFilePath,
  readAuth,
  writeAuth,
  clearAuth,
  describeFailure,
  collectFiles,
  requireDir,
  mapLimit,
  guarded,
  sameOrigin,
  isLoopback,
  accountOf,
  repoExists,
  branchHead,
}
