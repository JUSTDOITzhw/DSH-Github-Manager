# dsh-github-manager

Bind a GitHub account to dsh and manage your repositories from a **sidebar panel**: list, create, upload projects or single files, and delete.

The panel mounts into the `sidebar.footer.action` slot — the foot of the dsh sidebar. No terminal, no git commands.

A bound account also unlocks **`@`-mentioning a repository in the composer**, so a repository can be handed to the model as context (see [Mention a repository](#mention-a-repository-in-the-composer)).

And it turns on the **built-in GitHub MCP bridge**: the official GitHub MCP server is mounted as a child of this plugin, so the conversation gets `mcp__github__*` tools and the model can create repositories, write files and open branches (see [Control repositories from the conversation](#control-repositories-from-the-conversation-built-in-mcp)). Unbind, disable or uninstall the plugin and those tools go away with it — no profile configuration involved.

> 中文说明见 [README.zh.md](README.zh.md)。

## Install

```sh
dsh plugin --profile web add github:JUSTDOITzhw/DSH-Github-Manager
```

Restart `dsh web` afterwards — the client bundle is read once at activation.

## Sign in

Two ways, both in the panel's **账号 / Account** tab:

**Personal access token** — generate one at [github.com/settings/tokens](https://github.com/settings/tokens). Required scope: `repo`. Add `delete_repo` to delete repositories and `workflow` to push files under `.github/workflows/`. Paste it in; the token is verified against `/user` **before** it is stored, so a bad paste never replaces a working one.

**OAuth device flow** — create an OAuth App at [github.com/settings/developers](https://github.com/settings/developers), paste its **Client ID** into the panel, and authorize with the device code it shows. You supply the client id because an OAuth authorization has to be made in *someone's* name, and the plugin will not borrow another app's identity.

## What the panel does

| Tab | Actions |
| --- | --- |
| **Account** | bind / unbind, show login and scopes, re-verify the token |
| **Repos** | search, create (public/private), flip visibility, delete (typed `owner/repo` confirmation), open on GitHub |
| **Upload** | built-in local file browser; push a **whole directory** or a **single file** |

Pushing a directory creates the repository when it does not exist, skips `node_modules` / `.git` / build output and friends, and uploads file by file through the **Git Data API** (blobs → tree → commit → ref) — no git binary required. Anything skipped or failed is listed explicitly rather than dropped silently.

## Mention a repository in the composer

Once an account is bound, typing `@` in the composer adds one more candidate group: **your repositories**, under a heading of its own (`我的仓库 · 3 个`). Picking a row inserts an atomic reference chip, exactly like `@file` and `@session`.

```
@ue-bridge        ->  the draft shows @JUSTDOITzhw/DSH-UE-Bridge (deletable as one unit)
```

- Typing filters immediately, matching both `owner/name` and the repository description.
- Up to 30 rows, each reading "owner · public/private · default branch · description".
- The repository listing is fetched from GitHub **at most once per 60 seconds**; typing never re-hits the network.

### Only my repositories: `@github`

The `@` menu is shared by every source (files, sessions, plugins …) and no plugin can hide another's group. Typing the **scope word** `github` gets the same effect: every other source filters against that text, matches nothing and drops out, leaving only your repositories.

| Typed | Listed |
|---|---|
| `@github` | every repository |
| `@github/ue` | only those matching `ue` (`/`, `:` and a space all separate) |
| `@githubue` | the same — typing on after `@github` is read as the filter |
| `@gh/ue`, `@repos/`, `@仓库/ue` | the same, shorter |
| `@"github ue"` | the quoted form, for a filter containing spaces |

The heading states which scope you are in: `我的仓库 · 全部 3 个` or `我的仓库 · 匹配“ue” · 1 个`.

Two rules keep this from dead-ending:

- **`@zzz` matches no repository**: the group offers a `github` row ("按仓库筛选 · 共 N 个") — **Tab or Enter** rewrites the draft to `@github/` with the menu still open, so the next keystroke filters.
- **No match even inside the scope** (`@github/zzz`): one row saying so, rather than a menu that closes.

### What the model receives

The chip copies, pastes and persists as plain `@owner/repo` text. What the model receives is an element carrying the context, so a tool call can aim at the repository without a lookup:

```xml
<github-repo owner="JUSTDOITzhw" name="DSH-UE-Bridge" visibility="public" default_branch="main" url="https://github.com/JUSTDOITzhw/DSH-UE-Bridge">JUSTDOITzhw/DSH-UE-Bridge</github-repo>
```

With **no account bound** the group shows a single row naming that fact; picking it opens the sidebar panel instead of leaving an empty menu.

## Control repositories from the conversation (built-in MCP)

The host half mounts the official **GitHub MCP server** (`https://api.githubcopilot.com/mcp/` — a hosted endpoint, nothing is downloaded) as a **child plugin** of this one. The model's tool list then grows `mcp__github__*` entries such as `mcp__github__create_repository`, `mcp__github__push_files` and `mcp__github__create_or_update_file`.

| When | What happens |
| --- | --- |
| An account is bound | the tools appear — **no dsh restart needed** |
| The token is changed in the panel | the bridge is remounted, the new token takes effect at once |
| The account is unbound | the tools disappear |
| The plugin is disabled or removed | the tools go with it, leaving no orphan configuration |

**Why it lives here**: the MCP bridge (`@deepseek-ai/dsh-mcp-client`) is itself an ordinary dsh plugin. Declared as its own row in the profile's `cordis.patch.yml` it becomes a *separate install unit* — uninstalling this plugin would leave a dead row behind whose token expression resolves to nothing. Hanging it off this plugin's own fiber keeps install and uninstall as one operation.

The **Account** tab ends with a line stating which of these is true, e.g. `聊天工具已挂载：mcp__github__*（context,repos）`.

**The cost**: tool definitions are re-sent with *every* request. The default `context,repos` toolset is 22 tools, roughly **11.7k tokens per request**; the full 44-tool server is about 30k. Set `enableMcp: false` if you want the panel without the chat tools.

**Note**: the toolset has **no delete-repository tool** — deleting stays in the panel.

## Security

- The token lives in `<DSH_HOME>/github-manager/auth.json` with mode `0600`.
- The browser half **never sees the token** — it only learns the login, the avatar and the scope list.
- Routes accept loopback, same-origin requests only; cross-origin callers get 403.
- Deleting a repository requires typing its full `owner/repo` name.

## Configuration

Patch rows replace the whole `config` object, so restate every field you care about:

```yaml
- id: github-manager
  config:
    authPath: ''
    deviceClientId: ''
    deviceScopes: 'repo delete_repo workflow'
    maxFiles: 600
    maxBytes: 25165824
    maxFileBytes: 8388608
    enableMcp: true
    mcpToolsets: 'context,repos'
```

| Field | Meaning |
| --- | --- |
| `authPath` | credential location, default `<DSH_HOME>/github-manager/auth.json` |
| `deviceClientId` | OAuth App client id pre-filled into the device flow |
| `maxFiles` / `maxBytes` / `maxFileBytes` | guard rails for a directory push |
| `enableMcp` | mount GitHub as chat tools, default `true`; `false` keeps it panel-only |
| `mcpToolsets` | which tool groups, default `context,repos` (22 tools); `repos` alone is 19 and cheaper |
| `mcpServerName` | tool prefix, default `github` → `mcp__github__*` |
| `mcpUrl` | MCP endpoint, default the hosted `https://api.githubcopilot.com/mcp/` |
| `mcpToolCallTimeoutMs` | per-call timeout, default `120000` |

## Limits

- Directory pushes go through the REST API, one request per file: there is no git history and no Git LFS support.
- The default ceiling is 600 files / 24 MB; larger trees are truncated with the skipped entries listed. That scale is better served by a plain `git push`.
- The `@` group lists the first 100 repositories visible to the token (sorted by last update); anything past that is easier to type as `owner/repo`.

## License

MIT
