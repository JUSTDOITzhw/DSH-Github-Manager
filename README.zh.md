# dsh-github-manager

把 GitHub 账号绑定到 dsh，然后在**侧边栏底部**管理你的仓库：列出、创建、上传、删除。

面板挂在 `sidebar.footer.action` 槽位，点开是一个完整的管理界面，不需要离开 dsh，也不需要记住任何 git 命令。

另外，绑定后还能在**输入框里 `@` 到某个仓库**，把这个仓库作为上下文引用给模型（见 [在输入框里 `@` 一个仓库](#在输入框里--一个仓库)）。

再进一步：**绑定账号后，插件会自动把官方 GitHub MCP 服务器挂进聊天**，模型于是可以直接创建仓库、写文件、开分支（见 [在聊天里让模型操作仓库](#在聊天里让模型操作仓库)）。解绑、停用或卸载插件，这些工具都会跟着一起消失 —— profile 里不需要任何额外配置。

## 安装

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:JUSTDOITzhw/dsh-github-manager

# 本地开发：源码就在 profiles/web/plugins/ 下，改完刷新即生效
dsh plugin --profile web add "link:C:/Users/Administrator/.dsh/profiles/web/plugins/dsh-github-manager"
```

装完**重启 dsh web**（客户端 bundle 只在启动时读一次）。

## 绑定账号

两种方式，面板「账号」页里都有：

### 1. Personal Access Token（推荐）

在 [github.com/settings/tokens](https://github.com/settings/tokens) 生成一个 classic token，按需要勾权限：

| scope | 用途 |
| --- | --- |
| `repo` | 读取、创建、上传仓库（**必需**） |
| `delete_repo` | 删除仓库（不勾就只能创建和上传） |
| `workflow` | 推送 `.github/workflows/` 下的文件（不勾会被 GitHub 拒绝） |

**一条命令拿到全权限**：[预填好的生成页](https://github.com/settings/tokens/new?scopes=repo,delete_repo,workflow&description=dsh-github-manager)。

粘贴进面板 → 点「绑定」。插件会先拿 `/user` 验证一遍，**验证通过才写盘**，所以粘错不会覆盖掉原来能用的 token。

### 2. OAuth 设备流

不想手动建 token 的话，去 [github.com/settings/developers](https://github.com/settings/developers) 新建一个 **OAuth App**（名称随便，回调地址随便填 `http://127.0.0.1`），把 **Client ID** 填进面板，点「用设备码授权」。面板会显示一个设备码和你需要打开的地址，在浏览器里输码授权，面板会自动完成绑定。

之所以要你自己提供 client id：OAuth 授权必须以**某个 OAuth App 的身份**发起，插件不能借用别人的身份。

## 侧边栏面板

| 页 | 能做什么 |
| --- | --- |
| **账号** | 绑定/解绑、显示当前登录名与权限、重新校验 token |
| **仓库** | 搜索、创建（公开/私有）、切换可见性、删除（需输入 `owner/repo` 二次确认）、点名字直接跳转 GitHub |
| **上传** | 内置本地文件浏览器；**整个目录推送**或**上传单个文件** |

### 整个目录推送

选一个本地目录 → 填目标仓库 → 点推送。它会：

1. 仓库不存在就**自动创建**（按你选的公开/私有）；
2. 递归读取目录，自动跳过 `node_modules`、`.git`、`dist`、`build`、`Binaries`、`Intermediate`、`Saved`、`.DS_Store` 等；
3. 用 GitHub 的 **Git Data API**（blobs → tree → commit → ref）逐文件上传，不依赖系统 git。

跳过和失败的文件会**一条条列出来**，不会静默丢弃。

### 上传单个文件

选中一个本地文件，指定它在仓库里的路径。同名文件会自动更新（插件会先读已有 blob 的 sha，避免冲突报错）。

## 在输入框里 `@` 一个仓库

绑定账号后，输入框里打 `@` 会多出一组候选：**你的仓库**（上面带一行小标题，如 `我的仓库 · 3 个`）。选中即变成一个原子引用块，和 `@文件`、`@会话` 是同一种东西。

```
@ue-bridge        →  草稿里出现 @JUSTDOITzhw/DSH-UE-Bridge（可整体删掉）
```

- 打字直接过滤：同时匹配 `owner/name` 和仓库描述；
- 最多 30 行，每行显示"归属 · 公开/私有 · 默认分支 · 描述"；
- 仓库列表**每 60 秒最多问一次** GitHub，连续打字不会每次都打网络。

### 只要我的仓库：`@github`

`@` 菜单是所有来源共用的（文件、会话、插件……），插件没法把别人的组藏起来。但打上 **`github` 这个限定词**，别的来源都过滤不到东西、自动消失，菜单里就只剩你的仓库：

| 输入 | 结果 |
|---|---|
| `@github` | 我的仓库，全部 |
| `@github/ue` | 只列匹配 `ue` 的（`/`、`:`、空格都算分隔符） |
| `@githubue` | 同上——`@github` 后面接着打字，就当筛选词用 |
| `@gh/ue`、`@repos/`、`@仓库/ue` | 同样的简写 |
| `@"github ue"` | 引号形式（筛选词里要带空格时用） |

小标题会跟着告诉你现在在哪一档：`我的仓库 · 全部 3 个` 或 `我的仓库 · 匹配“ue” · 1 个`。

两条不会把你堵死的规矩：

- **打 `@zzz` 一个仓库都不匹配**时，会给你一行 `github`（描述"按仓库筛选 · 共 N 个"）：**按 Tab 或直接回车**就把草稿改写成 `@github/`，菜单不关，接着打字就是在筛仓库；
- **限定之后仍无匹配**（如 `@github/zzz`）时，显示一行"没有匹配“zzz”的仓库 · 共 N 个 · 删掉筛选词可看全部"，而不是把菜单关掉。

### 引用块发给模型的是什么

引用块对外是 `@owner/repo` 这样的纯文本（复制、粘贴、存草稿都用它），**发给模型时**会展开成一条自带上下文的元素：

```xml
<github-repo owner="JUSTDOITzhw" name="DSH-UE-Bridge" visibility="public" default_branch="main" url="https://github.com/JUSTDOITzhw/DSH-UE-Bridge">JUSTDOITzhw/DSH-UE-Bridge</github-repo>
```

这样模型不必再问"哪个仓库、哪个分支"，一句话就能落到具体仓库上。

**没绑定账号时**这一组会显示一行"未绑定 GitHub 账号"，选中它直接打开侧边栏面板——不会给你一个空菜单。

## 在聊天里让模型操作仓库（内置 MCP）

插件宿主半侧会把官方的 **GitHub MCP 服务器**（`https://api.githubcopilot.com/mcp/`，官方远端，不必本地下载任何东西）挂成自己的**子插件**，于是模型的工具清单里会多出 `mcp__github__*`，比如 `mcp__github__create_repository`、`mcp__github__push_files`、`mcp__github__create_or_update_file`。

| 时机 | 结果 |
| --- | --- |
| 绑好账号 | 工具自动出现（**不用重启 dsh**） |
| 面板里换一个 token | 自动重挂，新 token 立即生效 |
| 解绑账号 | 工具自动消失 |
| 停用 / 卸载插件 | 工具随之移除，不留残留配置 |

**为什么这么做**：MCP 桥（`@deepseek-ai/dsh-mcp-client`）本身就是一个普通 dsh 插件。如果把它单独写进 profile 的 `cordis.patch.yml`，它就成了**另一个安装单位** —— 卸载本插件会留下一条读不到凭据的死配置（token 表达式解析失败，连接不起来但也没人清理）。挂在插件自己的生命周期里，装和卸就是一件事。

面板的「账号」页最下面有一行状态，会直说当前是 `聊天工具已挂载：mcp__github__*（context,repos）` 还是 `绑定账号后，聊天里会出现 mcp__github__* 工具`。

**代价**：工具定义要跟着**每次请求**发出去。默认只开 `context,repos` 两组共 22 个工具，约 **11.7k tokens / 请求**；全开是 44 个、约 30k。只想要面板、不要聊天工具的话，把 `enableMcp` 设成 `false`。

**注意**：官方服务器的工具集里**没有删除仓库**这一项，删仓库仍然只能在面板里做。

## 安全

- token 存在 `<DSH_HOME>/github-manager/auth.json`，权限 `0600`；
- **浏览器侧永远拿不到 token** —— 面板只知道登录名、头像和 scope 列表；
- 路由只接受**本机回环地址 + 同源**请求，跨站请求直接 403；
- 删除仓库要求你把 `owner/repo` 完整打一遍，手滑点不到。

## 配置

写在 profile 的 `cordis.patch.yml` 里（patch 行会**整体替换**该行的 config，要写就写全）：

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

| 字段 | 说明 |
| --- | --- |
| `authPath` | 凭据文件位置，默认 `<DSH_HOME>/github-manager/auth.json` |
| `deviceClientId` | 预填设备流用的 OAuth App client id |
| `maxFiles` | 单次目录推送的文件数上限 |
| `maxBytes` | 单次推送的总字节上限 |
| `maxFileBytes` | 单个文件上限，超过的文件会被跳过并列出 |
| `enableMcp` | 是否把 GitHub 挂成聊天工具，默认 `true`；`false` 就是纯面板 |
| `mcpToolsets` | 要哪几组工具，默认 `context,repos`（22 个）。更省可只写 `repos`（19 个）；要 issue / PR 再加 `issues,pull_requests` |
| `mcpServerName` | 工具前缀，默认 `github` → `mcp__github__*` |
| `mcpUrl` | MCP 端点，默认官方远端 `https://api.githubcopilot.com/mcp/` |
| `mcpToolCallTimeoutMs` | 单次工具调用超时，默认 `120000` |

## 已知限制

- 目录推送走 REST API 逐文件上传，**没有 git 历史**（每次是一个新提交），也不支持 Git LFS；
- 默认限额 600 文件 / 24 MB，超大项目会被截断并列出跳过项 —— 那种规模更适合直接用 `git push`；
- 私有仓库需要 token 有对应权限，组织仓库还可能受组织的第三方应用策略限制；
- `@` 的仓库列表只取令牌可见的**前 100 个仓库**（按最近更新排序），更远的仓库请直接手打 `owner/repo`。

## 许可

MIT
