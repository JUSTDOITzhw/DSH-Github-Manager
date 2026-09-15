/**
 * dsh-github-manager — smoke test.
 *
 * Hermetic: it builds its own scratch directory tree, never touches the real
 * DSH_HOME, and never calls GitHub. The browser half is materialised through a
 * stubbed module loader so the pure helpers and the injected stylesheet can be
 * asserted without a DOM.
 *
 *   node test/smoke.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`ok   ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  check(label, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/**
 * Read a single declaration out of the injected stylesheet.
 *
 * The footer geometry is a contract with a slot this plugin does not own, and
 * that contract has already been broken once by a substring that happened to
 * look right, so it is asserted property by property.
 *
 * @param css - the stylesheet text.
 * @param selector - exact selector of the rule, e.g. `.dsh-gm-layer`.
 * @param property - the declaration to read.
 * @returns the value, or undefined when the rule or declaration is absent.
 */
function decl(css, selector, property) {
  const quoted = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|\\n)${quoted}\\{([^}]*)\\}`).exec(css)
  if (rule === null) return undefined
  const found = new RegExp(`(?:^|;)${property}:([^;]+)`).exec(rule[1])
  return found === null ? undefined : found[1]
}

const root = mkdtempSync(join(tmpdir(), 'gh-manager-smoke-'))

try {
  /* ---------------------------------------------------------------- *
   * Host half
   * ---------------------------------------------------------------- */
  const host = await import('../index.js')

  check('host half exports a name', host.name === 'github-manager', host.name)
  eq('host half injects webServer', host.inject, ['webServer'])
  check('host half exports apply()', typeof host.apply === 'function')

  const { internals } = host
  eq('internals exposes resolveConfig', typeof internals.resolveConfig, 'function')
  eq('internals exposes createMcpMount', typeof internals.createMcpMount, 'function')

  /* Config merge: an empty patch row must still yield every default, because
     cordis does not backfill schemastery defaults. */
  const defaults = internals.resolveConfig(undefined)
  eq('resolveConfig fills maxFiles', defaults.maxFiles, 600)
  eq('resolveConfig fills maxBytes', defaults.maxBytes, 25165824)
  eq('resolveConfig ignores empty strings', internals.resolveConfig({ authPath: '' }).authPath, '')
  eq('resolveConfig keeps real values', internals.resolveConfig({ maxFiles: 5 }).maxFiles, 5)
  eq('resolveConfig ignores null', internals.resolveConfig({ maxFiles: null }).maxFiles, 600)
  check('resolveConfig ignores undefined', internals.resolveConfig({ maxFiles: undefined }).maxFiles === 600)

  /* Credential file resolution */
  const authDefault = internals.authFilePath(internals.resolveConfig(undefined))
  check('auth path defaults under DSH_HOME', authDefault.endsWith(join('github-manager', 'auth.json')), authDefault)
  const authCustom = internals.authFilePath({ authPath: join(root, 'custom.json') })
  check('auth path honours an override', authCustom === join(root, 'custom.json'), authCustom)

  /* Credential round trip */
  const authFile = join(root, 'auth', 'auth.json')
  check('readAuth returns null when absent', internals.readAuth(authFile) === null)
  internals.writeAuth(authFile, { token: 't0ken', source: 'pat' })
  const stored = internals.readAuth(authFile)
  check('writeAuth then readAuth round-trips the token', stored !== null && stored.token === 't0ken')
  eq('stored record keeps its source', stored.source, 'pat')
  writeFileSync(authFile, '{"token":""}')
  check('readAuth rejects an empty token', internals.readAuth(authFile) === null)
  writeFileSync(authFile, 'not json at all')
  check('readAuth survives malformed JSON', internals.readAuth(authFile) === null)
  internals.writeAuth(authFile, { token: 'again' })
  check('clearAuth reports work done', internals.clearAuth(authFile) === true)
  check('clearAuth makes readAuth return null', internals.readAuth(authFile) === null)
  check('clearAuth on a missing file is false', internals.clearAuth(join(root, 'nope.json')) === false)

  /* GitHub error envelopes */
  eq('describeFailure reads the message field', internals.describeFailure(422, { message: 'Validation Failed' }, ''), 'Validation Failed')
  check('describeFailure folds in field errors',
    internals.describeFailure(422, { message: 'Validation Failed', errors: [{ field: 'name', message: 'already exists' }] }, '')
      === 'Validation Failed（name: already exists）')
  eq('describeFailure falls back to the body', internals.describeFailure(500, null, 'boom'), 'boom')
  eq('describeFailure falls back to the status', internals.describeFailure(500, null, ''), 'GitHub 返回 500')
  eq('describeFailure is silent for status 0', internals.describeFailure(0, null, ''), '')

  /* requireDir */
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  check('requireDir rejects an empty path', internals.requireDir('').ok === false)
  check('requireDir rejects a missing path', internals.requireDir(join(root, 'ghost')).ok === false)
  check('requireDir rejects a file', internals.requireDir(join(root, 'auth', 'auth.json')).ok === false)
  check('requireDir accepts a directory', internals.requireDir(project).ok === true)

  /* collectFiles: the skip rules are the whole point of this walker */
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, 'node_modules', 'left-pad'), { recursive: true })
  mkdirSync(join(project, '.hidden'), { recursive: true })
  writeFileSync(join(project, 'README.md'), '# hi\n')
  writeFileSync(join(project, '.gitignore'), 'node_modules\n')
  writeFileSync(join(project, 'src', 'main.js'), 'console.log(1)\n')
  writeFileSync(join(project, '.git', 'config'), '[core]\n')
  writeFileSync(join(project, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(project, '.hidden', 'secret.txt'), 'nope\n')
  writeFileSync(join(project, '.DS_Store'), 'junk')
  writeFileSync(join(project, 'chunky.bin'), 'x'.repeat(4096))

  const walk = await internals.collectFiles(project, internals.resolveConfig({ maxFileBytes: 1024 }))
  const paths = walk.files.map((file) => file.path)
  check('collectFiles keeps nested sources', paths.includes('src/main.js'), paths.join(','))
  check('collectFiles keeps README.md', paths.includes('README.md'))
  check('collectFiles keeps .gitignore', paths.includes('.gitignore'))
  check('collectFiles skips .git', paths.some((p) => p.startsWith('.git/')) === false)
  check('collectFiles skips node_modules', paths.some((p) => p.startsWith('node_modules/')) === false)
  check('collectFiles skips dot directories', paths.some((p) => p.startsWith('.hidden/')) === false)
  check('collectFiles skips .DS_Store', paths.includes('.DS_Store') === false)
  check('collectFiles skips an oversized file', paths.includes('chunky.bin') === false)
  check('collectFiles records why it skipped the big file',
    walk.skipped.some((item) => item.path === 'chunky.bin' && typeof item.reason === 'string' && item.reason !== ''))
  eq('collectFiles reports the exact file count', walk.files.length, 3)
  check('collectFiles sums bytes', walk.bytes === 5 + 13 + 15, String(walk.bytes))

  /* A hard file cap has to hold even when every file is legal. */
  const capped = await internals.collectFiles(project, internals.resolveConfig({ maxFiles: 1, maxFileBytes: 1024 }))
  eq('collectFiles honours maxFiles', capped.files.length, 1)

  /* mapLimit: results must line up with their inputs and never exceed the cap. */
  let inFlight = 0
  let peak = 0
  const seen = []
  const limited = await internals.mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    seen.push(value)
    await new Promise((settle) => setTimeout(settle, 5))
    inFlight -= 1
    return value * 2
  })
  eq('mapLimit preserves order', limited, [2, 4, 6, 8, 10, 12, 14])
  eq('mapLimit visits every item', seen.length, 7)
  check('mapLimit never exceeds its concurrency', peak <= 3, `peak ${peak}`)

  /* Request guards: these routes carry a credential. */
  eq('isLoopback accepts 127.0.0.1', internals.isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true)
  eq('isLoopback accepts ::1', internals.isLoopback({ socket: { remoteAddress: '::1' } }), true)
  eq('isLoopback rejects a LAN address', internals.isLoopback({ socket: { remoteAddress: '192.168.1.5' } }), false)
  eq('sameOrigin allows a matching host', internals.sameOrigin({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true)
  eq('sameOrigin rejects a foreign host', internals.sameOrigin({ headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' } }), false)
  eq('sameOrigin allows a request with no Origin header', internals.sameOrigin({ headers: {} }), true)
  eq('sameOrigin survives a malformed origin', internals.sameOrigin({ headers: { origin: 'not a url', host: 'h' } }), false)

  /* ---------------------------------------------------------------- *
   * Assembly: apply() against a stub carrier
   * ---------------------------------------------------------------- */
  const registered = []
  let disposed = false
  const ctx = {
    webServer: {
      register: (route) => {
        registered.push(route)
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      return () => {
        disposed = true
        if (typeof dispose === 'function') dispose()
      }
    },
  }

  /* Point the credential at the scratch directory: the real DSH_HOME must never
     be read or written by a test. */
  const scratchAuth = join(root, 'assembly-auth.json')
  host.apply(ctx, { authPath: scratchAuth })

  eq('apply registers two routes', registered.length, 2)
  eq('the state route is exact', registered[0].path, '/api/github-manager/state')
  eq('state is served over GET', registered[0].kind, 'exact')
  eq('the action route is exact', registered[1].path, '/api/github-manager/action')

  const callRoute = async (route, request) => {
    const out = { status: 0, headers: null, body: '' }
    const res = {
      writeHead: (status, headers) => { out.status = status; out.headers = headers },
      end: (payload) => { out.body = payload ?? '' },
    }
    await route.handler(request, res)
    let parsed = null
    try {
      parsed = JSON.parse(out.body)
    } catch {
      parsed = null
    }
    return { ...out, json: parsed }
  }

  const localRequest = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }

  const stateAnswer = await callRoute(registered[0], localRequest)
  eq('state answers 200', stateAnswer.status, 200)
  eq('state reports the scratch auth path', stateAnswer.json.authPath, scratchAuth)
  eq('state reports "not bound" with no credential', stateAnswer.json.bound, false)
  /* The chat tools ride the plugin's lifecycle, so the panel can only report what
     the host observed — it must always be told, even before anything is bound. */
  eq('state reports the chat-tool status', stateAnswer.json.mcp.state, 'unbound')
  eq('state names the MCP server', stateAnswer.json.mcp.serverName, 'github')
  eq('state names the toolset in use', stateAnswer.json.mcp.toolsets, 'context,repos')

  /* Once a credential exists the state route must say so, without leaking the
     token itself. */
  internals.writeAuth(scratchAuth, { token: 'secret-token', source: 'pat', account: { login: 'octocat', scopes: ['repo'] } })
  const boundAnswer = await callRoute(registered[0], localRequest)
  eq('state reports "bound" once a credential exists', boundAnswer.json.bound, true)
  eq('state surfaces the login', boundAnswer.json.account.login, 'octocat')
  check('state never echoes the token', boundAnswer.body.includes('secret-token') === false, boundAnswer.body)

  const remoteRequest = { method: 'GET', socket: { remoteAddress: '192.168.1.9' }, headers: {} }
  const denied = await callRoute(registered[0], remoteRequest)
  eq('a non-loopback caller is refused', denied.status, 403)
  eq('the refusal is machine-readable', denied.json.ok, false)

  const crossOrigin = await callRoute(registered[0], {
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' },
  })
  eq('a foreign origin is refused', crossOrigin.status, 403)

  /* The action route must reject a wrong method before reading a body. */
  const wrongMethod = await callRoute(registered[1], localRequest)
  eq('GET on the action route is refused', wrongMethod.status, 405)
  eq('the action route names the right method', wrongMethod.json.message, '请使用 POST')

  /* ---------------------------------------------------------------- *
   * Chat tools: the MCP bridge as this plugin's child
   * ---------------------------------------------------------------- */

  const mcpAuth = join(root, 'mcp-tools-auth.json')
  const mcpConfig = internals.resolveConfig(undefined)

  /** A stub carrier that records `ctx.plugin()` calls and fiber disposals. */
  const makeMount = ({ client, refuse } = {}) => {
    const mounts = []
    const disposals = []
    const mount = internals.createMcpMount({
      ctx: {
        plugin: (pluginModule, config) => {
          if (refuse === true) throw new Error('the current fiber is already disposed')
          mounts.push({ pluginModule, config })
          let alive = true
          return {
            dispose: () => {
              if (alive === false) throw new Error('already disposed')
              alive = false
              disposals.push(true)
            },
          }
        },
      },
      config: mcpConfig,
      file: mcpAuth,
      loadClient: async () => {
        if (client === undefined) throw new Error("Cannot find package '@deepseek-ai/dsh-mcp-client'")
        return client
      },
    })
    return { mount, mounts, disposals }
  }

  const fakeClient = { name: 'mcp-client', inject: ['tools'], apply: () => {} }

  /* Nothing bound: no mount at all, and the state says why. */
  const unbound = makeMount({ client: fakeClient })
  const unboundSnapshot = await unbound.mount.refresh()
  eq('an unbound account mounts no chat tools', unbound.mounts.length, 0)
  eq('the unbound state is reported', unboundSnapshot.state, 'unbound')
  check('the unbound hint names the tool prefix', unboundSnapshot.message.includes('mcp__'), unboundSnapshot.message)

  /* Bound: mounted with the documented transport, headers and timeout. */
  internals.writeAuth(mcpAuth, { token: 'tok-1' })
  const bound = makeMount({ client: fakeClient })
  const mountedSnapshot = await bound.mount.refresh()
  eq('a bound account mounts the bridge once', bound.mounts.length, 1)
  eq('the bridge is mounted as a child plugin', bound.mounts[0].pluginModule, fakeClient)
  eq('the mount uses streamable-http', bound.mounts[0].config.transport, 'streamable-http')
  eq('the mount points at the official endpoint', bound.mounts[0].config.url, 'https://api.githubcopilot.com/mcp/')
  eq('the mount carries the bound token', bound.mounts[0].config.headers.Authorization, 'Bearer tok-1')
  eq('the mount narrows the toolset', bound.mounts[0].config.headers['X-MCP-Toolsets'], 'context,repos')
  eq('the mount sets a tool-call timeout', bound.mounts[0].config.toolCallTimeoutMs, 120000)
  eq('the mounted state is reported', mountedSnapshot.state, 'mounted')

  /* An unchanged token is not a reason to tear the connection down. */
  await bound.mount.refresh()
  eq('an unchanged token does not remount', bound.mounts.length, 1)
  eq('an unchanged token does not dispose', bound.disposals.length, 0)

  /* Re-binding replaces the mount so the new token takes effect immediately. */
  internals.writeAuth(mcpAuth, { token: 'tok-2' })
  const reboundSnapshot = await bound.mount.refresh()
  eq('a new token remounts the bridge', bound.mounts.length, 2)
  eq('the previous fiber is disposed first', bound.disposals.length, 1)
  eq('the new mount carries the new token', bound.mounts[1].config.headers.Authorization, 'Bearer tok-2')
  eq('the remount is reported as mounted', reboundSnapshot.state, 'mounted')

  /* Unbinding has to take the tools back down. */
  internals.clearAuth(mcpAuth)
  const clearedSnapshot = await bound.mount.refresh()
  eq('unbinding disposes the fiber', bound.disposals.length, 2)
  eq('unbinding reports the unbound state', clearedSnapshot.state, 'unbound')

  /* A dsh without the MCP client package degrades into a state, not a crash. */
  internals.writeAuth(mcpAuth, { token: 'tok-3' })
  const missing = makeMount()
  const missingSnapshot = await missing.mount.refresh()
  eq('a missing client package is reported', missingSnapshot.state, 'missing')
  check('the missing-state message names the package',
    missingSnapshot.message.includes('dsh-mcp-client'), missingSnapshot.message)
  eq('a missing package mounts nothing', missing.mounts.length, 0)

  /* A carrier that refuses plugin creation must not break the panel. */
  const refused = makeMount({ client: fakeClient, refuse: true })
  const refusedSnapshot = await refused.mount.refresh()
  eq('a refused mount is reported as an error', refusedSnapshot.state, 'error')
  check('the refusal is explained', refusedSnapshot.message.includes('disposed'), refusedSnapshot.message)

  /* `enableMcp: false` keeps the plugin panel-only. */
  const offMount = internals.createMcpMount({
    ctx: { plugin: () => { throw new Error('a disabled bridge must never mount') } },
    config: internals.resolveConfig({ enableMcp: false }),
    file: mcpAuth,
  })
  const offSnapshot = await offMount.refresh()
  eq('a disabled bridge reports disabled', offSnapshot.state, 'disabled')
  eq('a disabled bridge cannot be re-enabled by a credential', offSnapshot.enabled, false)

  /* Two syncs landing together (a device poll plus a bind) must mount once. */
  const racing = makeMount({ client: fakeClient })
  await Promise.all([racing.mount.refresh(), racing.mount.refresh()])
  eq('concurrent syncs mount once', racing.mounts.length, 1)

  /* `release()` is the teardown hook and has to be safe to call twice. */
  racing.mount.release()
  racing.mount.release()
  eq('release() disposes exactly once', racing.disposals.length, 1)

  /* ---------------------------------------------------------------- *
   * Browser half
   * ---------------------------------------------------------------- */
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    Fragment: Symbol('Fragment'),
  }

  let loaded = null
  globalThis.window = {
    __ModuleLoader__: {
      load: (spec) => {
        loaded = { id: spec.id, exports: spec.factory((request) => {
          if (request === 'react') return reactStub
          throw new Error(`unexpected require: ${request}`)
        }) }
      },
    },
  }

  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  /* The loader contract: a lazy-CJS factory product, not an ES module. */
  check('client registers itself with the module loader', clientSource.includes('window.__ModuleLoader__.load'))
  check('client declares its loader id', clientSource.includes('id: "dsh-github-manager"'))
  check('client never uses import syntax', clientSource.includes('\nimport ') === false)

  await import('../lib/client.js')

  check('client factory ran', loaded !== null)
  const client = loaded?.exports ?? {}
  check('client exports apply()', typeof client.apply === 'function')
  eq('client injects slots', client.inject, ['slots'])

  const ci = client.internals ?? {}
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  eq('client VERSION matches package.json', ci.VERSION, pkg.version)
  eq('package exports the client half', pkg.exports['./client'], './lib/client.js')
  eq('package declares the web platform', pkg.dsh.client.platform, 'web')
  check('the MCP client is declared as an optional peer',
    pkg.peerDependenciesMeta?.['@deepseek-ai/dsh-mcp-client']?.optional === true,
    JSON.stringify(pkg.peerDependenciesMeta ?? null))

  /* The panel reports the chat-tool state verbatim: every state the host can emit
     needs a sentence, because a blank line reads as a bug. */
  eq('an unbound account explains when the tools appear',
    ci.mcpSummary({ state: 'unbound', serverName: 'github' }),
    '绑定账号后，聊天里会出现 mcp__github__* 工具')
  eq('a mounted bridge names the toolset',
    ci.mcpSummary({ state: 'mounted', serverName: 'github', toolsets: 'context,repos' }),
    '聊天工具已挂载：mcp__github__*（context,repos）')
  eq('a disabled bridge says so',
    ci.mcpSummary({ state: 'disabled' }), '聊天工具已关闭（配置 enableMcp: false）')
  eq('a missing package is surfaced',
    ci.mcpSummary({ state: 'missing', message: '找不到包' }), '聊天工具未启动：找不到包')
  eq('a failed mount is surfaced',
    ci.mcpSummary({ state: 'error', message: 'boom' }), '聊天工具启动失败：boom')
  eq('an unknown state falls back to a neutral line', ci.mcpSummary(null), '聊天工具：准备中…')
  eq('a non-object payload stays safe', ci.mcpSummary('nonsense'), '聊天工具：准备中…')
  eq('package points at the bundle patch', pkg.dsh.bundle.patch, './cordis.patch.yml')
  check('package ships no lifecycle scripts', pkg.scripts.prepare === undefined && pkg.scripts.postinstall === undefined)
  eq('package files whitelist drops the test directory', pkg.files.includes('test'), false)

  eq('TABS lists three views', ci.TABS.length, 3)
  eq('tab ids are stable', ci.TABS.map((tab) => tab.id), ['account', 'repos', 'upload'])

  /* The slot contract has to match what the sidebar actually exposes. */
  check('client registers into sidebar.footer.action', clientSource.includes('"sidebar.footer.action"'))
  check('client registers an id for the slot', clientSource.includes('id: "github-manager"'))

  /* The sidebar foot hands its occupant the column state (wide | 56px rail).
     The rail variant has to exist or the badge overflows a folded sidebar. */
  check('client reads the owner wide prop', clientSource.includes('props.wide === false'))
  check('client renders a rail layer', clientSource.includes('dsh-gm-rail'))
  check('client defaults to the wide presentation', clientSource.includes('dsh-gm-layer'))

  /* `sidebar.footer.action` is a list slot rendered into ONE flex row, and
     dsh-cost-meter parks its balance card in the same row while the shell clips
     the column (`.sidebarCol{overflow:hidden}`). An action that claims the row
     therefore does not crowd its neighbour, it pushes the neighbour out of the
     column: the balance icon disappears. Our badge has to share the row. */
  eq('the wide layer shares the row', decl(ci.CSS, '.dsh-gm-layer', 'flex'), '0 1 auto')
  eq('the wide layer can shrink to nothing', decl(ci.CSS, '.dsh-gm-layer', 'min-width'), '0')
  eq('the wide layer never claims the row', decl(ci.CSS, '.dsh-gm-layer', 'width'), 'auto')
  eq('the wide layer centres against a taller neighbour', decl(ci.CSS, '.dsh-gm-layer', 'align-self'), 'center')
  eq('the badge is content sized', decl(ci.CSS, '.dsh-gm-badge', 'width'), 'auto')
  eq('the badge can shrink', decl(ci.CSS, '.dsh-gm-badge', 'min-width'), '0')
  eq('the badge label can shrink', decl(ci.CSS, '.dsh-gm-badgeLabel', 'flex'), '0 1 auto')
  check('the label truncates rather than pushing the row',
    decl(ci.CSS, '.dsh-gm-badgeLabel', 'text-overflow') === 'ellipsis')
  check('nothing asks for a full-width track',
    /\.dsh-gm-(?:layer|badge)[^{}]*\{[^}]*width:calc\(100% \+/.test(ci.CSS) === false)
  check('the badge does not fight the row with negative margins',
    decl(ci.CSS, '.dsh-gm-badge', 'margin') === '0')

  /* The folded rail is 56px wide with 10px of inline padding, so 36px of track
     — and the balance chip already occupies 40px of it. Anything wider than an
     icon gets clipped, which is why the rail variant is a 16px mark. */
  eq('the rail layer is icon sized', decl(ci.CSS, '.dsh-gm-layer.dsh-gm-rail', 'width'), '16px')
  eq('the rail layer never exceeds its track', decl(ci.CSS, '.dsh-gm-layer.dsh-gm-rail', 'max-width'), '16px')
  eq('the rail badge matches the rail layer', decl(ci.CSS, '.dsh-gm-rail .dsh-gm-badge', 'width'), '16px')
  eq('the rail badge drops the label', decl(ci.CSS, '.dsh-gm-rail .dsh-gm-badge', 'padding'), '0')

  /* One shrinkable text run: a label plus a trailing hint split a tight budget
     into two unreadable slivers. */
  eq('badge label shows the account when bound', ci.badgeLabel(true, 'JUSTDOITzhw'), '@JUSTDOITzhw')
  eq('badge label stands in when the login is unknown', ci.badgeLabel(true, ''), '已绑定')
  eq('badge label falls back to GitHub when unbound', ci.badgeLabel(false, 'JUSTDOITzhw'), 'GitHub')
  check('the badge renders one shrinkable text run',
    clientSource.includes('badgeLabel(bound, login)') && clientSource.includes('"dsh-gm-badgeLabel"'))
  check('the status dot is the only trailing mark',
    clientSource.includes('bound ? null : h("span", { className: "dsh-gm-dot"'))
  check('the redundant trailing hint is gone', clientSource.includes('dsh-gm-badgeHint') === false)

  /* Render shape, exercised through the stubbed React: a tree rather than a
     string, so a stray extra node cannot hide behind a substring match. */
  const shapeOf = (wide) => {
    const tree = ci.Badge({ wide })
    const button = tree.children.filter((child) => child !== null && child.type === 'button')[0]
    return button.children.filter((child) => child !== null && child !== undefined)
      .map((child) => child.props?.className
        ?? (typeof child.type === 'function' ? child.type.name : child.type))
  }
  eq('the wide badge is mark + label + status dot', shapeOf(true), ['GitHubMark', 'dsh-gm-badgeLabel', 'dsh-gm-dot'])
  eq('the rail badge drops the label', shapeOf(false), ['GitHubMark', 'dsh-gm-dot'])

  eq('formatBytes prints bytes', ci.formatBytes(512), '512 B')
  eq('formatBytes prints kilobytes', ci.formatBytes(2048), '2.0 KB')
  eq('formatBytes prints megabytes', ci.formatBytes(3 * 1024 * 1024), '3.0 MB')
  eq('formatBytes survives nonsense', ci.formatBytes(undefined), '0 B')

  const now = Date.parse('2026-09-15T10:00:00Z')
  eq('formatWhen renders minutes', ci.formatWhen('2026-09-15T09:35:00Z', now), '25 分钟前')
  eq('formatWhen renders days', ci.formatWhen('2026-09-12T10:00:00Z', now), '3 天前')
  eq('formatWhen is empty for a missing date', ci.formatWhen('', now), '')
  eq('formatWhen is empty for garbage', ci.formatWhen('not a date', now), '')

  /* A row that cannot state what it is must not be rendered. */
  const normalized = ci.normalizeRepos([
    { name: 'alpha', fullName: 'me/alpha', owner: 'me', private: false, updatedAt: '2026-09-01T00:00:00Z' },
    { fullName: 'me/beta', owner: 'me', private: true },
    { description: 'no name at all' },
    null,
    'nonsense',
  ])
  eq('normalizeRepos drops nameless rows', normalized.length, 2)
  eq('normalizeRepos keeps the first name', normalized[0].name, 'alpha')
  eq('normalizeRepos derives a name from fullName', normalized[1].name, 'me/beta')
  eq('normalizeRepos defaults the branch', normalized[0].defaultBranch, 'main')
  eq('normalizeRepos keeps the private flag', normalized[1].private, true)

  const repos = ci.normalizeRepos([
    { name: 'alpha', fullName: 'me/alpha', description: 'first' },
    { name: 'beta', fullName: 'me/beta', description: 'second' },
  ])
  eq('filterRepos matches the name', ci.filterRepos(repos, 'alph').length, 1)
  eq('filterRepos matches the description', ci.filterRepos(repos, 'second').length, 1)
  eq('filterRepos is case-insensitive', ci.filterRepos(repos, 'BETA').length, 1)
  eq('filterRepos returns everything for an empty query', ci.filterRepos(repos, '  ').length, 2)
  eq('filterRepos returns nothing for a miss', ci.filterRepos(repos, 'zzz').length, 0)

  eq('scopeHas finds a scope', ci.scopeHas(['repo', 'delete_repo'], 'delete_repo'), true)
  eq('scopeHas misses cleanly', ci.scopeHas(['repo'], 'delete_repo'), false)
  eq('scopeHas survives a non-array', ci.scopeHas(undefined, 'repo'), false)
  check('canDelete allows an unknown scope set', ci.canDelete([]) === true)
  check('canDelete blocks without delete_repo', ci.canDelete(['repo']) === false)
  check('canDelete allows with delete_repo', ci.canDelete(['repo', 'delete_repo']) === true)

  eq('devicePhase reports an idle flow', ci.devicePhase(null), 'idle')
  eq('devicePhase reports a started flow', ci.devicePhase({ ok: true, userCode: 'ABCD-1234' }), 'waiting')
  eq('devicePhase reports a pending poll', ci.devicePhase({ ok: true, pending: true }), 'pending')
  eq('devicePhase reports a finished flow', ci.devicePhase({ ok: true, account: { login: 'me' } }), 'done')

  eq('remotePathFor keeps the basename', ci.remotePathFor('C:\\a\\b\\logo.png'), 'logo.png')
  eq('remotePathFor handles posix paths', ci.remotePathFor('/a/b/c.txt'), 'c.txt')
  eq('remotePathFor survives an empty path', ci.remotePathFor(''), '')
  eq('baseName reads a Windows directory', ci.baseName('C:\\work\\my-project'), 'my-project')
  eq('baseName reads a posix directory', ci.baseName('/home/me/site/'), 'site')

  /* ---------------------------------------------------------------- *
   * The `@` composer source
   *
   * The draft's `@` menu is a registry of sources; this half contributes the
   * bound account's repositories. Two things have to hold: the projections
   * (what the chip copies vs what the model receives) and the degradation
   * rules (an empty or unavailable listing must never empty the menu).
   * ---------------------------------------------------------------- */

  check('client registers an @ trigger', clientSource.includes('trigger: "@"'))
  check('client names its @ group from the constant', clientSource.includes('name: AT_SOURCE'))
  check('client waits for the trigger service', clientSource.includes('ctx.inject(["inputTriggers"]'))
  check('client does not hard-inject the trigger service', client.inject.includes('inputTriggers') === false)
  eq('the @ group is called github', ci.AT_SOURCE, 'github')

  eq('ownerOf splits the owner half', ci.ownerOf('me/alpha'), 'me')
  eq('ownerOf is empty for a bare name', ci.ownerOf('alpha'), '')
  eq('nameOf splits the name half', ci.nameOf('me/alpha'), 'alpha')
  eq('nameOf keeps a bare name whole', ci.nameOf('alpha'), 'alpha')

  eq('xmlAttr escapes an ampersand', ci.xmlAttr('a&b'), 'a&amp;b')
  eq('xmlAttr escapes a quote', ci.xmlAttr('a"b'), 'a&quot;b')
  eq('xmlText escapes an angle bracket', ci.xmlText('a<b'), 'a&lt;b')

  eq('repoSummary leads with the owner', ci.repoSummary(normalized[0]), 'me · 公开 · 默认 main')
  eq('repoSummary marks a private repository', ci.repoSummary({ owner: 'me', private: true, defaultBranch: 'dev' }), 'me · 私有 · 默认 dev')
  eq('repoSummary survives nonsense', ci.repoSummary(null), '公开')
  const longSummary = ci.repoSummary({ private: false, defaultBranch: 'main', description: 'x'.repeat(200) })
  check('repoSummary clips a long description', longSummary.endsWith('…') && longSummary.length < 100)

  eq('repoClipboardText prefixes the handle', ci.repoClipboardText('me/alpha'), '@me/alpha')
  eq('repoClipboardText survives nonsense', ci.repoClipboardText(undefined), '@')

  eq('repoSerialization spells the row out',
    ci.repoSerialization('me/alpha', normalized[0]),
    '<github-repo owner="me" name="alpha" visibility="public" default_branch="main">me/alpha</github-repo>')
  eq('repoSerialization falls back to the path',
    ci.repoSerialization('me/beta', undefined),
    '<github-repo owner="me" name="beta">me/beta</github-repo>')
  eq('repoSerialization escapes a hostile name',
    ci.repoSerialization('me/a"b<c', undefined),
    '<github-repo owner="me" name="a&quot;b&lt;c">me/a"b&lt;c</github-repo>')

  const mentionRequest = (query, extra) => ({
    query,
    position: 'inline',
    drilled: false,
    signal: new AbortController().signal,
    ...(extra ?? {}),
  })
  const mentionPick = (value) => ({
    candidate: { value },
    session: { sessionId: 's1' },
    position: 'inline',
    via: 'menu',
    action: 'pick',
    span: { start: 0, end: 3, draftRev: 1 },
  })
  const repoListing = {
    status: 200,
    ok: true,
    body: {
      ok: true,
      repos: [
        { name: 'alpha', fullName: 'me/alpha', owner: 'me', private: false, defaultBranch: 'main', description: 'first' },
        { name: 'beta', fullName: 'me/beta', owner: 'me', private: true, defaultBranch: 'dev', description: 'second' },
      ],
    },
  }

  const source = ci.createRepoSource({ listRepos: async () => repoListing, openPanel: () => {} })
  eq('the @ source binds the at trigger', source.trigger, '@')
  eq('the @ source takes the github group name', source.name, 'github')
  eq('the @ source sits after the shell groups', source.order, 2)
  eq('the @ source ships a codec', typeof source.codec.serialize, 'function')

  const atRows = await source.candidates({ sessionId: 's1' }, mentionRequest(''))
  eq('the @ source lists every repository', atRows.length, 2)
  eq('a row is named after the repository', atRows[0].name, 'alpha')
  eq('a row describes the repository', atRows[0].description, 'me · 公开 · 默认 main · first')
  eq('a row carries the full name', atRows[0].value, 'me/alpha')

  const filteredRows = await source.candidates({ sessionId: 's1' }, mentionRequest('bet'))
  eq('the query filters the rows', filteredRows.map((row) => row.value), ['me/beta'])
  eq('the query matches the owner too', (await source.candidates({ sessionId: 's1' }, mentionRequest('me/a'))).length, 1)
  eq('the quoted file form yields no repository rows', (await source.candidates({ sessionId: 's1' }, mentionRequest('me', { quoted: true }))).length, 0)

  const inserted = source.onPick(mentionPick('me/alpha'))
  eq('a pick inserts a reference owned by the github source', inserted.insert.source, 'github')
  eq('a pick references the full name', inserted.insert.ref, 'me/alpha')
  eq('a pick labels the chip with the full name', inserted.insert.label, 'me/alpha')
  eq('a pick copies as an @ handle', inserted.insert.clipboardText, '@me/alpha')
  eq('a pick claims no appearance it does not have', 'appearance' in inserted.insert, false)

  eq('the codec copies the same handle', source.codec.clipboardText('me/alpha'), '@me/alpha')
  eq('the codec serializes the cached row', await source.codec.serialize('me/alpha'),
    '<github-repo owner="me" name="alpha" visibility="public" default_branch="main">me/alpha</github-repo>')
  eq('the codec still serializes an uncached row', await source.codec.serialize('me/ghost'),
    '<github-repo owner="me" name="ghost">me/ghost</github-repo>')

  /* An unbound account, an empty account and a dead host half each have to
     leave a row behind: a group that silently disappears reads as a bug. */
  const unboundOpens = []
  const unboundSource = ci.createRepoSource({
    listRepos: async () => ({ status: 401, ok: false, body: { ok: false, message: '尚未绑定 GitHub 账号' } }),
    openPanel: () => unboundOpens.push(true),
  })
  const unboundRows = await unboundSource.candidates({ sessionId: 's1' }, mentionRequest(''))
  eq('an unbound account renders one row', unboundRows.length, 1)
  eq('the unbound row names the reason', unboundRows[0].name, '未绑定 GitHub 账号')
  eq('the unbound row is a prompt, not a reference', unboundRows[0].value, ci.AT_ROW_PANEL)
  check('the prompt sentinel can never be a repository path', unboundRows[0].value.includes('/') === false)
  const unboundOutcome = unboundSource.onPick(mentionPick(ci.AT_ROW_PANEL))
  eq('the unbound row raises the panel', unboundOpens.length, 1)
  eq('the unbound row clears the half-typed token', unboundOutcome.text, '')

  const emptySource = ci.createRepoSource({
    listRepos: async () => ({ status: 200, ok: true, body: { ok: true, repos: [] } }),
    openPanel: () => {},
  })
  eq('an empty account explains itself',
    (await emptySource.candidates({ sessionId: 's1' }, mentionRequest('')))[0].name,
    '这个账号下还没有仓库')

  const deadSource = ci.createRepoSource({ listRepos: async () => { throw new Error('boom') }, openPanel: () => {} })
  eq('a dead host half keeps the group alive',
    (await deadSource.candidates({ sessionId: 's1' }, mentionRequest('')))[0].name,
    '无法连接宿主')

  const abortedFetch = new AbortController()
  abortedFetch.abort()
  eq('an aborted keystroke yields no rows',
    (await source.candidates({ sessionId: 's1' }, mentionRequest('', { signal: abortedFetch.signal }))).length,
    0)

  let listingCalls = 0
  const countedSource = ci.createRepoSource({
    listRepos: async () => { listingCalls += 1; return repoListing },
    openPanel: () => {},
  })
  await countedSource.candidates({ sessionId: 's1' }, mentionRequest(''))
  await countedSource.candidates({ sessionId: 's1' }, mentionRequest('a'))
  eq('the listing is fetched once per ttl', listingCalls, 1)

  let clock = 0
  let ttlCalls = 0
  const clockedSource = ci.createRepoSource({
    listRepos: async () => { ttlCalls += 1; return repoListing },
    openPanel: () => {},
    now: () => clock,
  })
  await clockedSource.candidates({ sessionId: 's1' }, mentionRequest(''))
  clock += ci.AT_TTL_MS + 1
  await clockedSource.candidates({ sessionId: 's1' }, mentionRequest(''))
  eq('the listing is refetched after the ttl', ttlCalls, 2)

  const crowdedSource = ci.createRepoSource({
    listRepos: async () => ({
      status: 200,
      ok: true,
      body: { ok: true, repos: Array.from({ length: 60 }, (_, index) => ({ name: `r${index}`, fullName: `me/r${index}` })) },
    }),
    openPanel: () => {},
  })
  eq('the menu row count is capped',
    (await crowdedSource.candidates({ sessionId: 's1' }, mentionRequest(''))).length,
    ci.AT_MAX_ROWS)

  /* ---------------------------------------------------------------- *
   * Scoping: `@github` narrows the `@` menu to the repositories
   *
   * Typing the scope word has to keep this group alive on its own. The menu
   * auto-closes when every group settles empty, so a query that matches
   * nothing would close it under the user's fingers — which is exactly what
   * a bare `@git` used to do.
   * ---------------------------------------------------------------- */

  eq('the scope list leads with the longest alias', ci.AT_SCOPES[0], 'github')
  check('the scope list carries the shorthand', ci.AT_SCOPES.includes('gh'))
  check('the scope list carries the Chinese word', ci.AT_SCOPES.includes('仓库'))

  const scopeOf = (query) => JSON.stringify(ci.parseRepoQuery(query))
  eq('an empty query is not a scope', scopeOf(''), '{"scoped":false,"term":""}')
  eq('a plain term is not a scope', scopeOf('alph'), '{"scoped":false,"term":"alph"}')
  eq('the scope word alone means everything', scopeOf('github'), '{"scoped":true,"term":""}')
  eq('the bare scope word is case-insensitive', scopeOf('GitHub'), '{"scoped":true,"term":""}')
  eq('the slash form means everything', scopeOf('github/'), '{"scoped":true,"term":""}')
  eq('the term after a slash is the filter', scopeOf('github/ue'), '{"scoped":true,"term":"ue"}')
  eq('a colon separates too', scopeOf('github:ue'), '{"scoped":true,"term":"ue"}')
  eq('a space separates the quoted form', scopeOf('github ue'), '{"scoped":true,"term":"ue"}')
  eq('typing on after the scope word keeps filtering', scopeOf('githubue'), '{"scoped":true,"term":"ue"}')
  eq('an owner path is the term', scopeOf('github/me/'), '{"scoped":true,"term":"me/"}')
  eq('the plural alias beats the singular', scopeOf('repos/x'), '{"scoped":true,"term":"x"}')
  eq('the Chinese scope works bare', scopeOf('仓库'), '{"scoped":true,"term":""}')
  eq('the Chinese scope takes a term', scopeOf('我的仓库/ue'), '{"scoped":true,"term":"ue"}')
  eq('the shorthand stays a word of its own', scopeOf('ghost'), '{"scoped":false,"term":"ghost"}')
  eq('the shorthand scopes behind a slash', scopeOf('gh/repo'), '{"scoped":true,"term":"repo"}')

  eq('an unscoped heading counts the account', ci.repoSection({ scoped: false, term: '' }, 2, 2, 2), '我的仓库 · 2 个')
  eq('a bare scope heading says everything', ci.repoSection({ scoped: true, term: '' }, 2, 2, 2), '我的仓库 · 全部 2 个')
  eq('a filtered heading names the term', ci.repoSection({ scoped: true, term: 'ue' }, 1, 1, 12), '我的仓库 · 匹配“ue” · 1 个')
  eq('a truncated heading admits it', ci.repoSection({ scoped: false, term: '' }, 30, 60, 60), '我的仓库 · 显示前 30 个（共 60）')
  eq('a truncated filter counts the matches', ci.repoSection({ scoped: true, term: 'r' }, 30, 45, 60), '我的仓库 · 匹配“r” · 显示前 30 个（共 45）')
  check('a long term is clipped in the heading', ci.repoSection({ scoped: true, term: 'x'.repeat(40) }, 1, 1, 2).length < 60)

  const scopedRows = await source.candidates({ sessionId: 's1' }, mentionRequest('github'))
  eq('the scope word lists every repository', scopedRows.length, 2)
  eq('a scoped row carries the heading', scopedRows[0].section, '我的仓库 · 全部 2 个')
  eq('a scoped row is still a reference', scopedRows[0].value, 'me/alpha')
  const bareRows = await source.candidates({ sessionId: 's1' }, mentionRequest(''))
  eq('an unscoped row carries the heading too', bareRows[0].section, '我的仓库 · 2 个')
  check('every repository row carries a heading',
    scopedRows.concat(bareRows).every((row) => typeof row.section === 'string' && row.section !== ''))
  eq('the heading label is the shared constant', ci.AT_SECTION, '我的仓库')
  eq('a prompt row carries the heading too', unboundRows[0].section, ci.AT_SECTION)

  const scopedFiltered = await source.candidates({ sessionId: 's1' }, mentionRequest('github/alph'))
  eq('the scoped term filters the rows', scopedFiltered.map((row) => row.value), ['me/alpha'])
  eq('the filtered heading names the term', scopedFiltered[0].section, '我的仓库 · 匹配“alph” · 1 个')
  eq('typing straight on filters without a separator',
    (await source.candidates({ sessionId: 's1' }, mentionRequest('githubbet'))).map((row) => row.value),
    ['me/beta'])
  eq('the quoted scope form filters',
    (await source.candidates({ sessionId: 's1' }, mentionRequest('github bet', { quoted: true }))).map((row) => row.value),
    ['me/beta'])
  eq('a quoted non-scope still belongs to the file group',
    (await source.candidates({ sessionId: 's1' }, mentionRequest('my docs', { quoted: true }))).length,
    0)

  /* A miss is the one dead end; it offers the scope instead of nothing. */
  const rescueRows = await source.candidates({ sessionId: 's1' }, mentionRequest('zzz'))
  eq('a miss renders one row', rescueRows.length, 1)
  eq('the rescue row is named after the group', rescueRows[0].name, 'github')
  eq('the rescue row is drillable', rescueRows[0].drill, true)
  eq('the rescue row carries the scope sentinel', rescueRows[0].value, ci.AT_ROW_SCOPE)
  eq('the rescue row carries the heading', rescueRows[0].section, ci.AT_SECTION)
  const rescueOutcome = source.onPick(mentionPick(ci.AT_ROW_SCOPE))
  eq('the rescue writes the scope into the draft', rescueOutcome.text, '@github/')
  eq('the rescue keeps the menu open', rescueOutcome.continue, true)
  eq('the rescue claims no reference', 'insert' in rescueOutcome, false)

  const scopedMiss = await source.candidates({ sessionId: 's1' }, mentionRequest('github/zzz'))
  eq('a scoped miss keeps one row', scopedMiss.length, 1)
  eq('the miss names the term it could not match', scopedMiss[0].name, '没有匹配“zzz”的仓库')
  eq('the miss carries no reference', scopedMiss[0].value, '')
  eq('the miss carries the heading', scopedMiss[0].section, ci.AT_SECTION)
  check('the miss is not drillable', scopedMiss[0].drill === undefined)

  const quietOpens = []
  const quietSource = ci.createRepoSource({ listRepos: async () => repoListing, openPanel: () => quietOpens.push(true) })
  await quietSource.candidates({ sessionId: 's1' }, mentionRequest('github/zzz'))
  const missOutcome = quietSource.onPick(mentionPick(''))
  eq('an informational row clears the token', missOutcome.text, '')
  eq('an informational row does not open the panel', quietOpens.length, 0)
  quietSource.onPick(mentionPick(ci.AT_ROW_PANEL))
  eq('the bind prompt still opens the panel', quietOpens.length, 1)

  /* Assembly: apply() against a carrier whose trigger registry is already live. */
  const slotKeys = []
  const registeredSources = []
  const injectedNames = []
  const liveCarrier = {
    slots: {
      inject: (key, factory) => { slotKeys.push(key); factory() },
      register: () => () => {},
    },
    effect: (fn) => fn(),
    get: (name) => (name === 'inputTriggers'
      ? { registerSource: (src) => { registeredSources.push(src); return () => {} } }
      : undefined),
    inject: (names, callback) => { injectedNames.push(names); callback(liveCarrier) },
  }
  client.apply(liveCarrier)
  eq('assembly injects the sidebar slot', slotKeys, ['sidebar.footer.action'])
  eq('assembly registers exactly one @ source', registeredSources.length, 1)
  eq('a live trigger service needs no waiting', injectedNames, [])
  eq('the registered source binds @', registeredSources[0].trigger, '@')
  eq('the registered source is the github group', registeredSources[0].name, 'github')

  /* …and against a carrier where the shell provides it only later. */
  let lateReady = false
  const lateSources = []
  const lateWaits = []
  const lateCarrier = {
    slots: { inject: () => () => {} },
    effect: (fn) => fn(),
    get: () => (lateReady
      ? { registerSource: (src) => { lateSources.push(src); return () => {} } }
      : undefined),
    inject: (names, callback) => {
      lateWaits.push(names)
      lateReady = true
      callback(lateCarrier)
    },
  }
  client.apply(lateCarrier)
  eq('a late trigger service is waited for', lateWaits, [['inputTriggers']])
  eq('the source lands once the service arrives', lateSources.length, 1)
  eq('the late source is the github group', lateSources[0].name, 'github')

  /* The panel bus is what makes the unbound row reach the sidebar badge. */
  let raised = 0
  const raise = () => { raised += 1 }
  ci.panelBus.listeners.add(raise)
  ci.panelBus.open()
  eq('the panel bus raises its listeners', raised, 1)
  ci.panelBus.listeners.delete(raise)
  ci.panelBus.open()
  eq('the panel bus forgets a removed listener', raised, 1)

  /* A host that refuses plugin creation must still get the sidebar badge: the
     composer group is a bonus, the panel is the product. */
  const hostileSlotKeys = []
  let hostileThrew = false
  try {
    client.apply({
      slots: { inject: (key, factory) => { hostileSlotKeys.push(key); factory() }, register: () => () => {} },
      effect: (fn) => fn(),
      get: () => { throw new Error('no services here') },
      inject: () => { throw new Error('plugin creation unsupported') },
    })
  } catch (error) {
    hostileThrew = true
  }
  eq('a carrier without a trigger service still gets the sidebar slot', hostileSlotKeys, ['sidebar.footer.action'])
  eq('a hostile carrier never breaks apply()', hostileThrew, false)

  /* Styling rules: semantic aliases only, no colour literals, no theme forks. */
  check('CSS is injected', typeof ci.CSS === 'string' && ci.CSS.length > 100)
  check('CSS uses no hex colours', /#[0-9a-fA-F]{3,8}\b/.test(ci.CSS) === false)
  check('CSS uses no rgb()/hsl() literals', /(?:rgb|hsl)a?\(/.test(ci.CSS) === false)
  check('CSS uses semantic aliases', ci.CSS.includes('--dsw-alias-'))
  check('CSS does not branch on a theme attribute', /\[data-theme/.test(ci.CSS) === false)
  check('the panel is positioned fixed', ci.CSS.includes('position:fixed'))
  check('a delete confirmation input exists', clientSource.includes('confirm'))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? `all ${passed} checks passed` : `${failed} of ${passed + failed} check(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
