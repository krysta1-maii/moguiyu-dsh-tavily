# @moguiyu/dsh-tavily 0.8.0 与 DSH rc.3 之后未发布提交的兼容性核对

- 基线：DSH tag `dsh-v0.2.2-rc.3`，commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`，2026-11-13 13:26:07 +0800
- 目标：本地 `deepseek-harness` 检出的 `master`，commit `39163dd30f`（`git describe` = `dsh-v0.2.2-rc.3-608-g39163dd30f`），2026-11-13 15:37:50 +0800
- 区间规模：608 个提交、3309 个文件，+104100 / -36870 行
- 本机安装：DSH `0.2.2-rc.3`，Node `v24.22.1`；本轮不升级本机安装
- 核对日期：2026-11-13（Asia/Hong_Kong）
- 结论：在本插件实际使用的接口面中，有一处破坏性变更——WebServer 路由的认证门禁改为默认 `required`。两条管理路由没有声明 `auth`，在新版本上会返回 503 或 401。其余接口面（工具定义与执行、提示段、凭据服务、主目录解析、客户端声明与装配、卡片槽位、设计令牌、语言元数据、bundle 补丁）与 rc.3 完全一致。

## 1 区间界定与版本状态

### 1.1 提交区间

`dsh-v0.2.2-rc.3` 是 `master` 的祖先（`git merge-base --is-ancestor` 返回成功），所以 `git diff dsh-v0.2.2-rc.3..HEAD` 给出的就是从已发布版本到当前检出的全部差异。区间内的 author date 从 2026-09-21 跨到 2026-11-13，原因是 rc.3 从一条较早切出的发布分支上打了 tag，之后的 master 工作经同步 PR（#8422）合回；提交时间戳因此不是判断"是否已发布"的依据，tag 拓扑才是。

按包统计的改动集中在这些位置：`packages/experimental`（730 个文件）、`packages/client`（436 个）、`packages/ptc-runtime`（59 个）、`packages/core`（96 个）、`packages/host`（53 个）。其中的新包是 `client/script-realm`、`client/script-realm-iframe`、`client/ui-session-status`、`host/authentication-desktop`、`host/authentication-token`、`util/text-search` 与三个 `experimental` 包；被删除的是 `experimental/ptc-runtime-python`。

### 1.2 下一版本号仍然是未知量

仓库没有在区间内提升版本号，根 `package.json` 与所有 workspace 包仍写 `0.2.2-rc.3`。升级指南目录给出的是相反方向的信号：rc.3 检出时最新的目录是 `docs/upgrade-guide/v0.2.2-rc.1`，区间内新增了整个 `v0.2.2-rc.2/` 目录以及 `v0.2.2-rc.1/` 下的 5 个条目，合计 18 个 `guide.md`（另有对应的 `.zh.md` 与 `.i18n.yaml`），它们在 rc.3 中全部不存在。这些目录名与已经存在的 rc.2、rc.3 tag 冲突，因此目录名只能当作归档习惯，不能当作发布号依据。

本次核对因此以"rc.3 之后的 master"为对象，不假设下一个 tag 叫什么。凡是依赖版本号才能判断的事项（兼容门禁、peer 范围）在第 1.3 节按多种候选版本分别求值。

### 1.3 版本声明与兼容门禁

门禁函数 `evaluatePluginCompatibility`（`packages/boot/app-boot/src/plugin-compatibility.ts:87`）在区间内没有任何改动，`git diff` 为空。以本包的 `package.json` 求值，结果如下：

| 运行时版本 | 门禁结果 |
| --- | --- |
| `0.2.2-rc.1` / `0.2.2-rc.2` / `0.2.2-rc.3` | compatible |
| `0.2.2-rc.4` | compatible |
| `0.2.2` / `0.2.3` / `0.2.9` | compatible |
| `0.3.0-alpha.1` / `0.3.0` / `1.0.0` | 拒绝，列出 `@deepseek-ai/dsh-home-paths` 与 `@deepseek-ai/dsh-tools` 两项未满足 |

peer 范围在默认 semver 规则与 `includePrerelease: true` 两种模式下结论一致：`^0.2.2-0` 接受 rc.3、rc.4、0.2.2、0.2.9，拒绝 0.3.0；`^4.0.1 || ^4.0.6-alpha.2` 接受 4.1.0 与 4.2.0。

这里有一处需要单独记录：`@deepseek-ai/cordis` 的包版本在区间内仍然是 4.1.0，但内容有破坏性变更（见第 6 节）。peer 范围按版本号判断，因此无法发现这类改动。`dsh.compatibility.dshReleases` 依旧没有任何读取点（`git grep dshReleases` 在 rc.3 与 HEAD 上都没有结果），补条目只影响文档一致性。

### 1.4 与本插件相关的关键提交

区间内与本包有关联的提交如下，其余改动（Team 模式、CUA、Office kit、会话状态表、时间线视图等）不触及本包使用的接口。

| 提交 | 日期 | 内容 | 与本包的关系 |
| --- | --- | --- | --- |
| `71753fdf91` | 11-12 | `refactor(connection): add connection auth provider`（#8266） | 本轮唯一的破坏源，见第 3 节 |
| `695f640063` | 11-13 | 客户端 module metadata、静态库清单与 iframe realm（#8133） | 客户端装配方式变化，`meta` 保持可选，本包不受影响 |
| `1511a6ed44` | 11-05 | `chore(cordis): upgrade core to 4.0.0-rc.12` | `ctx.root` 移除等领域变更，本包未使用 |
| `d1cf1dede1` | 11-11 | 删除实验性 Python PTC 运行时 | PTC 只支持 TypeScript，本包工具与语言无关 |
| `a2ea3970fd` | 11-09 | PTC 改为返回有序文本与图像输出 | `PtcRunResult.logs` 改为 `output`，本包不受影响 |
| `724e56b286` | 11-09 | PTC 统一显式 `inspect` 输出 | 模型侧展示方式变化，本包不受影响 |
| `5e7206f6c6` | 11-11 | 退役陈旧子路径导出（#8215） | 移除 `dsh-tools/presentation` 等，本包未使用 |
| `eab6beacb9` | 11-11 | Session 状态移入新的 `ui-session-status` 包 | `web-app` 的必需客户端条目增加，本包不受影响 |
| `1c94f3ad57` | 11-13 | 主目录新增 `dshPath` 分类助手 | 状态文件位置约定，见第 4.6 节 |

## 2 结论

| 面 | 结果 | 说明 |
| --- | --- | --- |
| 两条管理路由 | **破坏** | 未声明 `auth`，新版本默认要求认证，返回 503 或 401 |
| 四个模型工具 | 不受影响 | `defineTool`、`tools.register`、schema 编译、`exec.signal` 均未变 |
| 两段提示 | 不受影响 | `systemPrompt.section` 与 `packages/core/system-prompt` 未变 |
| 凭据读写 | 不受影响 | `credentials` 接口包零差异，`resolve`/`describe`/`set`/`unset` 与 `writable` 不变 |
| 主目录 | 不受影响 | `resolveDshHome` 未变；新增 `dshPath` 属附加能力 |
| 客户端声明 | 不受影响 | `parseDshClient` 未变，`platform`/`inject` 规则相同 |
| 客户端装配 | 不受影响 | `window.__ModuleLoader__.load({ id, factory })` 仍是受支持的注册形式，`meta` 可选 |
| 卡片槽位 | 不受影响 | `plugins.bundle.config` 仍是 keyed、root 作用域，页面仍以 `{ view: 'page' }` 渲染 |
| 设计令牌 | 不受影响 | 卡片使用的 9 个 `--dsw-alias-*` 全部存在，`design-platform.css` 零差异 |
| 语言元数据 | 不受影响 | `packages/util/plugin-detail` 零差异 |
| bundle 补丁 | 不受影响 | YAML 方言未变，`insert` 语义未变 |
| 状态文件位置 | 约定层面有变化 | `~/.dsh/tavily-manager.json` 仍可用，新路径约定建议改用分类目录 |

## 3 破坏性变更：WebServer 路由的认证门禁

### 3.1 机制

区间内提交 `71753fdf91`（`refactor(connection): add connection auth provider for remote connection`，#8266，2026-11-12）重做了浏览器认证。改动分布在 `packages/host/webserver`（分发路径改写 207 行）、`packages/client/connection`（21 个文件、增 687 行删 1127 行）与两个新包 `host/authentication-token`、`host/authentication-desktop`。

路由类型新增可选字段 `auth`（`packages/host/webserver/src/index.ts:124`、`:142`、`:155`，分别对应 `WebRoute`、`WebResourceRoute`、`WebUpgradeRoute`），取值是 `'anonymous'`、`'required'`、`'deny'` 或一个同步选择函数。分发路径在调用处理器之前先求一次授权策略：

```ts
private authPolicy(auth: WebAuthenticationRule | undefined, request: WebAuthRequest): WebAuthPolicy {
  return typeof auth === 'function' ? auth(request) : auth ?? 'required'
}

private authorize(request: WebAuthRequest, auth: WebAuthenticationRule | undefined): WebAdmission {
  const policy = this.authPolicy(auth, request)
  if (policy === 'deny') return { kind: 'deny', status: 403 }
  const admission: WebAdmission = this.ctx.bail(this, 'webserver/authorize', request, policy)
    ?? (policy === 'anonymous' ? { kind: 'allow' } : { kind: 'deny', status: 503 })
  if (admission.kind === 'allow') {
    if (policy === 'required' && admission.peer === undefined) return { kind: 'deny', status: 503 }
    if (admission.peer?.signal.aborted) return { kind: 'deny', status: 401 }
  }
  return admission
}
```

（`packages/host/webserver/src/index.ts:780-796`）

省略 `auth` 等于 `'required'`。`required` 要求 `webserver/authorize` 这一 bail 事件给出一个带 Peer 的 allow 决定：

- 没有监听者时 `ctx.bail` 返回 undefined，直接 503，响应体 `authentication unavailable`（`:639`）。
- 有监听者但拒绝时，由监听者给出 401 或 403。仓内的监听者只有一个，位于 `packages/client/connection/src/rpc-host.ts:87`：先做来源围栏（Host 必须是回环、监听绑定 IP 或 `trustedHosts` 中的权威，`sec-fetch-site: cross-site` 拒绝，Origin 与 Host 同权威），再调用 `ctx.connection.authentication.authenticate` 逐个尝试已注册的认证提供方，全部失败返回 401。
- `'anonymous'` 跳过凭据验证，但仍走来源围栏；没有监听者时直接放行。

标准 `web` profile 在 `packages/bundle/web-app/cordis.patch.yml:246` 新增了 `authentication-token` 行，所以默认组合里存在监听者；`packages/host/frontend-static/src/index.ts:133` 把首页声明为 `required`、其余静态资源声明为 `anonymous`。这两处保证了"页面能打开时浏览器一定持有 Token Cookie"。

### 3.2 对本插件两条路由的实际后果

本包在 `src/backend.js` 中注册的两条路由只写了 `{ kind: 'exact', path, handler }`，没有 `auth`。在新版本上按情形分三种：

| 情形 | 结果 |
| --- | --- |
| 标准 `dsh web`，卡片在浏览器页面内调用 | 仍然可用。页面打开时已通过首页的 `required` 交换拿到 Cookie，同源 `fetch` 默认携带 Cookie，Token 提供方承认并给出共享的浏览器 Peer |
| 标准 `dsh web`，用脚本或 `curl` 从回环地址直接调用 | **401**。rc.3 返回 JSON 载荷，新版本在 Connection 的认证处就被拒绝，插件处理器不会执行 |
| 组合中有 `webServer` 但没有 `connection`，或用户禁用了 `connection` 行 | **503**。两条路由整体失效，浏览器卡片也无法读取数据 |

第三种情形值得强调：在本包的 `cordis.patch.yml` 里，本插件只 inject `webServer` 与 `credentials`，与 `connection` 没有声明依赖。rc.3 上这不成问题，因为分发不经过任何认证层；新版本上路由是否可用却隐式取决于另一个插件是否在位。这是本次区间引入的真实耦合。

### 3.3 证据

三条相互独立的依据：

1. 源码：上面引用的 `authPolicy` 默认值与 `authorize` 的三条分支。
2. 仓内测试：`packages/host/webserver/tests/webserver.spec.ts:278` 注册一条不带 `auth` 的 exact 路由，`:281` 断言在没有监听者时得到 `{ status: 503, body: 'authentication unavailable' }`；同文件 `:279` 用 `auth: 'anonymous'` 声明的前缀路由得到 200。`:310` 另有对裸 fallback 处理器的同样断言。
3. 升级指南：`docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer/guide.md` 写明"WebServer registrations now accept `auth` …, defaulting to `required`. Previously public handlers, resources, fallbacks, and upgrades need explicit anonymous declarations."

同一区间内，仓内所有第三方形态的路由都补了声明：`packages/client/modules/src/index.ts:705`（插件 bundle 的 `/plugins/*` 资源路由）与 `packages/client/hmr/src/index.ts:184` 都加了 `auth: 'anonymous'`，`packages/host/frontend-static`、`packages/host/open-in-app`、`packages/host/authentication-token`、`packages/experimental/webhook-github` 各自按用途声明。

### 3.4 为什么 rc.3 上没有这个现象

rc.3 的分发代码是逐分支直接调用：

```ts
if (typeof responder === 'function') await responder(req, res)
else if ('resource' in responder) await this.serveResource(req, res, target, responder.resource)
else await responder.handler(req, res)
```

`WebAuthPolicy` 这个类型在 rc.1、rc.2、rc.3 三个 tag 上都不存在（`git show <tag>:packages/host/webserver/src/index.ts` 中检索计数均为 0）。本插件在 rc.3 上只靠自己的回环检查 `mayManage`（`src/backend.js:67`）把关，这条路径本轮没有被修改，所以现状确实没有问题。

### 3.5 修法

给两条路由各加一行 `auth: 'anonymous'`，把准入交回本插件已有的回环检查与 `TAVILY_MANAGER_ALLOW_REMOTE` 开关：

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: '/api/tavily-usage',
  // DSH 在 rc.3 之后把 WebServer 路由的认证默认值改为 required。
  // 显式声明匿名，保留本插件自身的回环检查；旧版本忽略该字段。
  auth: 'anonymous',
  handler: async (req, res) => { /* ... */ },
}), 'tavily-backend: route /api/tavily-usage')
```

`/api/tavily-manager` 同样处理。这个写法对 rc.3 及更早版本是安全的：`register` 只把路由对象存进表里，分发时忽略未知字段，`auth` 只是一条多余属性。

选择 `'anonymous'` 而不是 `'required'` 的理由有三条。第一，本插件的管理接口本来就是给本机脚本和浏览器共用的，`'required'` 会让所有非浏览器调用变成 401，属于功能回退。第二，桌面端的 `dsh-desktop-session` 凭据按设计不进浏览器 Cookie 罐（`packages/host/authentication-desktop/README.md`），卡片用的是原生 `fetch`，`'required'` 下能否通过取决于桌面载体是否代为附加凭据，这一点本轮没有验证。第三，`'anonymous'` 仍然经过 Connection 的来源围栏，DNS 重绑定与跨站请求照样被 403 拒绝，安全姿态与 rc.3 持平。

若将来希望接入新身份模型，可以改成 `auth: 'required'` 并在处理器里检查 `peer.principal.kind !== 'owner'` 时返回 403，像 `packages/host/open-in-app/src/index.ts:170` 那样。这条路线需要同时改 README、放弃 `TAVILY_MANAGER_ALLOW_REMOTE` 的远程语义，并确认桌面端的凭据传递路径。

## 4 需要留意但不构成破坏的行为变化

### 4.1 远程管理开关的实际效力收窄

`TAVILY_MANAGER_ALLOW_REMOTE=1` 原本把"是否接受非回环请求"的决定权完全交给本插件。新版本上，只要 `connection` 在位，来源围栏先于本插件执行：Host 必须是回环、监听绑定 IP 的字面量或 `trustedHosts` 中列出的权威。局域网客户端访问监听绑定 IP 时能过围栏，随后仍由本插件的 `mayManage` 决定，因此开关在 `'anonymous'` 下继续有效。语义变化出现在两处：`dsh web --host 0.0.0.0` 依旧不支持；本插件自己的回环判断不再是唯一的准入条件，DNS 重绑定类请求会被 DSH 直接 403。

### 4.2 请求分发多了 waterfall 拦截点

分发现在包在 `webserver/request` waterfall 里（`packages/host/webserver/src/index.ts:654`），监听者在调用 `next()` 之前可以整体短路一个请求。仓内现有的监听者（`host/authentication-token` 的 `/?token=` 交换、`credentials/deepseek-account` 的 `/oauth/callback`）都按路径判断后调用 `next()`，对 `/api/tavily-*` 没有干扰。风险是组合层面的：任何新增的监听者若漏掉 `next()`，两条管理路由会一起失效，而本插件无从感知。

### 4.3 事件 subject 改为 WebServer 实例

五个 `webserver/*` 事件现在以 WebServer 实例作为 Cordis 分发主体，普通监听者跟随 `webServer` 服务的隔离，`global: true` 的监听者例外。本插件不监听也不触发这些事件，无影响；若将来需要监听，注册方式要按新的 subject 约定写。

### 4.4 桌面端的凭据不经过浏览器 Cookie 罐

`packages/host/authentication-desktop` 用 `dsh-desktop-session` Cookie 的值做认证，且明确说明该凭据"never into the browser cookie jar"，由桌面主进程在转发时附加。本插件卡片用的是相对路径的裸 `fetch`，不经过 `ctx.connection` 的 RPC 客户端。这一条在 `'anonymous'` 下无关紧要，在 `'required'` 下会成为未知数，是本轮列入未覆盖项的原因。

### 4.5 客户端注册 id 不再剥离 `/client` 后缀

`ClientModuleSystem.register` 在 rc.3 上先把注册 id 过一遍 `stripClientSuffix`（`<包名>/client` 归一为 `<包名>`），区间内改为直接使用 `registration.id`（`packages/client/modules/src/client/system.ts:162`），归一化挪到了解析侧 `resolveModuleId`（`:156`）。手写 bundle 若把 id 写成 `<包名>/client`，新旧两版会落到不同的记录键上：旧版与启动图中同名的一行合并，新版会多出一条独立记录。本包 `src/client.js` 的 `id` 是裸包名 `@moguiyu/dsh-tavily`，两种行为等价。

### 4.6 状态文件的位置约定

`~/.dsh/tavily-manager.json` 仍然可以读写，`resolveDshHome` 与 `dshHomePath` 在区间内没有语义变化。区间内新增了 `dshPath(category, ...segments)` 与 `DshHomeCategory`（`packages/util/home-paths/src/index.ts:193`、`:211`），并附带一份仍处于 proposed 状态的分类约定（`.agents/notes/proposed/architecture/2026-11-04-dsh-home-path-categories.md`）。该约定的表述是：既有顶层条目保持原位，新增路径应落到 `config`/`data`/`state`/`cache`/`backup` 分类目录下，首段用所有者名。按此约定，本插件的密钥顺序与可用性记录属于 `state`。这是一条迁移建议，不是本轮的破坏。

## 5 已核对且未变化的接口面

下表每一行都对 `dsh-v0.2.2-rc.3..HEAD` 做过定向 `git diff`。

| 检查面 | 依据 | 结果 |
| --- | --- | --- |
| Host 入口 | 插件导出 `name`/`inject`/`apply`；`webServer`、`credentials` 服务名与 `Context` 声明未变 | 一致 |
| 管理路由注册 | `webServer.register(route)` 签名与重复路径抛错行为未变（`index.ts:520`） | 一致（认证门禁除外，见第 3 节） |
| 凭据读写 | `packages/credentials/credentials/src` 零差异；`describe().writable` 仍可用 | 一致 |
| 主目录 | `resolveDshHome` 未变，仅补文档并新增 `dshPath` | 一致 |
| 工具定义 | `packages/core/tools/src/index.ts`、`schema.ts`、`json-schema.ts` 全部零差异，`defineTool`（`schema.ts:555`）签名未变 | 一致 |
| 工具执行 | `pipeline.ts` 只改了取消分类（`wrapperFailureResult`），`execute(args, exec)` 与 `exec.signal` 未变 | 一致 |
| 提示段 | `packages/core/system-prompt/src` 零差异，`section({ name, order, text })` 未变 | 一致 |
| Client 声明 | `parseDshClient` 与 `DshClientManifest`（`packages/util/package-manifest/src/types.ts`）零差异 | 一致 |
| Client 装配 | `ClientBundleRegistration` 现在是 `DshClientModuleManifest`，形状为 `{ id, chunk?, factory, meta? }`，`meta` 可选；默认执行环境仍是同源 classic script（`packages/client/modules/src/client/main-realm.ts`）；`react` 仍是平台模块 | 一致 |
| 卡片槽位 | `packages/client/ui-slots/src` 零差异；`slot-contract.ts` 与 `ui-plugin-manager/src/client/index.ts:143` 的 keyed/root 声明未变；`PluginManagerPage.tsx:825` 仍以 `{ view: 'page' }` 加 `entryKey: pkg.name` 渲染 | 一致 |
| 设计令牌 | `packages/client/ui-theme/src/styles/design-platform.css` 零差异；卡片用到的 9 个令牌全部存在，`--dsw-alias-state-warning-primary` 依旧缺席（卡片已带本地回退色） | 一致 |
| 语言元数据 | `packages/util/plugin-detail` 零差异；Plugins 页面改用了 `@deepseek-ai/dsh-util-text-search` 做模糊匹配，仍读 `row.meta?.title`/`description` | 一致 |
| bundle 补丁 | `dsh.bundle.patch` 的解析改走 `parseEntryYaml`（`vendor/include/src/index.ts:39`），YAML 方言仍是 `JSON_SCHEMA` 加 `!!js` 标签；`insert` 语义未变 | 一致 |
| PTC 绑定 | 四个工具仍按 `projectToolSchema` 与 `output.schema` 生成 SDK 声明；`jsonSchemaToTs` 未变 | 一致（见第 6 节的其他 PTC 变化） |

## 6 区间内被移除或改名的公共 API

这些改动对本插件没有影响（本插件只从 `@deepseek-ai/dsh-tools` 取 `defineTool`、从 `@deepseek-ai/dsh-home-paths` 取 `resolveDshHome`），但对同生态的插件作者是破坏性的，记录在此以便对照。

| 变更 | 位置 | 对本插件 |
| --- | --- | --- |
| `ctx.root` 移除，改用 `ctx[Context.root]` | `vendor/cordis/src/context.ts:18`、`:44` | 未使用 |
| `Service.config` → `Service.metadata`；`[Service.resolveConfig](base, head)` → `[Service.resolveIntercept]()`；`Config.merge` 不再被调用 | `vendor/cordis/src/service.ts` | 未使用 |
| `symbols.metadata` 改为装饰器元数据键 `symbols.decorator` | `vendor/cordis/src/utils.ts` | 未使用 |
| 对象形式 `inject` 的元数据优先级降为最低；`ctx.isolate(name)` 不再回退到外层插件的 `name` | `vendor/cordis/src/fiber.ts`、`context.ts` | 插件用的是数组形式 `inject` |
| `ctx.parallel()` 失败时的 AggregateError 消息带事件名 | `vendor/cordis/src/events.ts` | 未使用 |
| `@deepseek-ai/cordis-plugin-include` 移除 `entryListSchema` 导出，改为 `parseEntryYaml`/`stringifyEntryYaml`/`entryYamlErrorPosition` | `vendor/include/src/index.ts` | 未使用 |
| `@deepseek-ai/dsh-tools` 移除 `./presentation` 子路径；`@deepseek-ai/dsh-brand` 从 dependencies 移到 devDependencies | `packages/core/tools/package.json` | 未使用 |
| PTC：删除 Python 后端与 `py-types`；`PtcRunResult.logs` 改为 `output`；新增 `inspect(...)`、`Image`、`scoped-repl`、`discardCompletion` | `packages/ptc-runtime`、`packages/core/tool-executor-ptc` | 工具签名不变；模型在 PTC 下需要用 `inspect()` 展示结果 |
| 客户端样式改由 `meta().stylesheets` 交付；`<style data-plugin>` 不再带 `data-plugin-css`，且 Modules 不再回收旧形态插件注入的样式 | `packages/client/modules`、`packages/client/ui-renderer` | 卡片的 `<style>` 在 React 子树内，生命周期随组件卸载 |
| 新增 `host/authentication-token`、`host/authentication-desktop`、`client/script-realm`、`client/script-realm-iframe`、`util/text-search`、`client/ui-session-status` 六个包 | 见第 1.1 节 | 只涉及第 3 节的认证门禁 |

## 7 实际执行的检查

`npm run check` 通过，七个源文件语法检查无误。

`npm test` 69 项全部通过。测试运行在 `node_modules/@deepseek-ai/{dsh-tools,dsh-home-paths}` 上，两者符号链接到本机安装的 `0.2.2-rc.3`。这一步验证的是"当前代码在 rc.3 上没有回归"，对上表第 5 节中零差异的包同样成立，因为被测代码与 HEAD 的同名源文件一致。

兼容门禁按第 1.3 节的矩阵求值，用的是 HEAD 上的 `plugin-compatibility.ts` 源码：复制到临时目录，把 `semver` 的导入改成绝对路径、去掉相对导入的 `.ts` 后缀，其余逐字保留，再以 `node --experimental-strip-types` 执行。peer 范围用本机 semver 在两种模式下求值。

源码级 diff 覆盖 `packages/core/tools`、`packages/core/system-prompt`、`packages/core/agent-loop`、`packages/core/agent-tool-presentation`、`packages/credentials/*`、`packages/util/home-paths`、`packages/util/plugin-detail`、`packages/util/package-manifest`、`packages/host/webserver`、`packages/host/authentication-*`、`packages/host/frontend-static`、`packages/client/modules`、`packages/client/web`、`packages/client/ui-slots`、`packages/client/ui-plugin-manager`、`packages/client/ui-renderer`、`packages/client/ui-theme`、`packages/client/connection`、`packages/boot/app-boot`、`packages/boot/plugin-manager`、`packages/preset/agent-preset-registry`、`packages/bundle/{base,web-app}`、`packages/ptc-runtime`、`packages/core/tool-executor-ptc` 以及 `vendor/{cordis,include,loader}`。

有一项检查未能执行：DSH 检出目录在当前会话的文件策略下是只读的，vitest 加载配置时要写 `node_modules/.vite-temp`，报 `EROFS: read-only file system`，因此仓内 `webserver.spec.ts` 没有实际跑起来。第 3.3 节的证据来自该测试的断言文本，不是执行结果。

## 8 建议改动

改动本身只有两处，落在 `src/backend.js` 的两个 `ctx.webServer.register` 调用上，各加一行 `auth: 'anonymous'`，并补一条注释说明原因。这一改动对 rc.3 与更早版本是空操作，不需要提升 peer 范围，也不需要新增 `engines.dsh`。

配套建议：

1. 测试侧把 `test/entries.test.js` 的 `fakeWebServer` 改为记录完整路由对象，断言两条路由都带 `auth: 'anonymous'`。现在的伪造只取 `route.handler`，看不到这个字段，回归会漏检。
2. README 第 111 至 115 行关于"两条路由只接受回环请求"的说明需要补充一句：自 DSH rc.3 之后的版本起，请求还要先通过 Host 的认证与来源围栏，脚本调用需要 DSH 的 Token 或对应提供方签发的凭据（使用 `'anonymous'` 时则只需来源围栏）。
3. `package.json` 的 `dsh.compatibility.dshReleases` 可以等下一个版本号确定后再补条目；该字段不参与判定。

## 9 未覆盖

没有启动真实的 rc.3 之后实例，因此未验证：认证门禁在标准 `web` profile 下对浏览器卡片的实际表现；桌面端裸 `fetch` 能否通过 `dsh-desktop-session` 校验；`webserver/request` waterfall 在真实组合中的拦截顺序；PTC 模式下四个工具的 SDK 声明与 `inspect()` 输出；真实 Tavily 请求；包安装、升级、卸载链路。

本轮也没有验证"下一个 tag 会是 0.2.2-rc.4 还是 0.3.0"。如果是后者，第 1.3 节的 peer 范围需要追加 `^0.3.0-0`，否则门禁会拒绝加载。
