# @moguiyu/dsh-tavily 0.7.0：Host / Preset 分离架构升级施工计划

> 状态：历史施工计划（已完成）。0.7.0 于 2026-11-02 验收通过，最终结果见 [验收记录](./0.7.0-acceptance.md)。
> 编写日期：2026-11-02
> 当前版本：0.6.0（编写时）
> 目标版本：0.7.0
> 完成版本：0.7.0
> DSH 基线：0.2.1-rc.5（当前 web profile）
> 目标环境：web profile
> 默认目标 preset：standard-instant、ptc-instant、cordis-ptc、chat-assistant（施工中调整为前三项）
>
> 阅读说明：本文保留计划阶段的判断与步骤，不按实施结果改写正文。文中 `docs/verification.md` 已整理为 [0.7.0 验收记录](./0.7.0-acceptance.md)；施工中将目标 preset 从四个调整为三个，§2、§4.4、§12 中“四个 preset”的表述按此历史语境阅读。

## 1. 背景与问题定义

@moguiyu/dsh-tavily 0.6.0 通过 web profile 的 cordis.patch.yml 在 Host 层插入一行 id 与 name 均为 dsh-tavily 的插件行，src/index.js 在被挂载时无条件执行两件事：调用 installTavilyTool 注册 tavily_search、tavily_extract、tavily_map、tavily_crawl 四个模型工具与 tool:tavily_search、tool:tavily_direct 两段系统提示；调用 installBackend 注册 /api/tavily-usage 与 /api/tavily-manager 两条 exact 路由。同一次挂载还承担 Plugins 页管理卡片（key 为 @moguiyu/dsh-tavily）的 Host Loader 载体。

Host 全局工具会被 web profile 下所有 preset 继承，minimal 与官方 standard、ptc、cordis 一并包括。本会话自身的观察即可印证这一点：当前 preset 是 cordis-ptc，其 config.plugins 中没有任何 Tavily 行，但 run_code 的 SDK 绑定里已经出现四个 Tavily 工具，来源只能是 Host 全局注册。需要的形态与此相反：模型能力归属于明确选择它的 preset，密钥与路由管理仍留在 Plugins 页。

把现有根入口整体移入 preset 不可行，原因有三个，且都在本机可验证的源码里。

第一，多个 standing preset 会同时激活。每个 preset 的 config.plugins 会被挂载成同一进程内的子条目，installBackend 里的 ctx.webServer.register 在第二次注册同一 exact 路径时抛错，错误模板见 @deepseek-ai/dsh-host-webserver 的 lib 第 328 行，文本形如 webserver: duplicate exact route "<path>"，后续 preset 会被标记为 broken。

第二，Client 模块发现只扫描 Host Loader 的条目。@deepseek-ai/dsh-client-modules 的 Node 半侧注释写明它只扫描 Host Loader entries 中声明了 dsh.client 的包，因此删除 Host 行会让 Plugins 页的管理卡片一并消失，preset 中的行无法补位。

第三，installTavilyTool 尾部现在带有一次“未配置 key”的启动检查（src/tools.js 第 728 至 737 行）。若根入口被多个 preset 各挂载一次，同一条警告会按 preset 数量重复打印。

还有一处与 dsh-exa 先例不同的事实需要在本次一并处理。round-robin 游标目前是 src/state.js 的模块级变量（第 187 至 200 行的 cursor、getCursor、setCursor、resetCursor）。同一进程内多次 import 同一模块拿到的是同一份实例，实测两次独立导入可以互相读到对方写入的游标值，所以拆分之后，无论多少个 preset 各挂载一次 tools 入口，它们都会共享同一个游标。这与“每个 preset 独立计数”的目标相悖，必须在拆分时把游标改成按安装实例持有。

chat-assistant 的处境需要单独说明。它的描述（web profile cordis.patch.yml 第 396 行起）明确承诺“Tavily 联网搜索”，而它当前的 Tavily 能力完全来自 Host 继承。若按 dsh-exa 的先例只给 standard-instant、ptc-instant、cordis-ptc 三处挂载，chat-assistant 的对外描述会与实际能力不符，因此本次目标 preset 定为四个。

## 2. 升级目标

本次升级完成后，应同时满足以下条件：

1. 仍然只发布、安装和维护一个 @moguiyu/dsh-tavily 包。
2. 包根入口只承担 Host 管理面：两条 /api 路由、管理卡片载体、一次性的缺 key 启动检查。
3. 新增 @moguiyu/dsh-tavily/tools 子路径入口，只承担四个工具与两段系统提示。
4. standard-instant、ptc-instant、cordis-ptc、chat-assistant 显式引用 @moguiyu/dsh-tavily/tools。
5. minimal、官方 standard、ptc、cordis 以及其他未配置 preset 不再继承 Tavily 工具。
6. Plugins 页 dsh-tavily 卡片与两条 /api 路由保持可用，且每条路由在整个 Host 中只注册一次。
7. 四个工具的参数、canonical output、render、错误映射、凭据读取、432/433 熔断与恢复逻辑保持不变。
8. 内置 web_search、web_fetch 与 ctx.web 不受影响；本包始终不注册 web search provider。
9. round-robin 游标按 preset revision 独立推进，priority 模式与共享状态文件的行为不变。
10. 卸载、禁用、重载和版本回滚步骤有明确顺序，不留下导致 preset broken 的引用。

## 3. 非目标

本次不做以下扩展：

- 不修改 dsh-exa；两个包各自独立升级，不共享代码或配置。
- 不新增或删除 Tavily 工具，不改变工具名称、参数 schema 与输出 schema。
- 不引入 per-preset API key、per-preset 策略或 per-preset 状态文件。
- 不实现 Plugins 页的一键 preset 安装器。
- 不让 bundle 自动修改任意 preset 的 config.plugins。
- 不新增 Host 服务、RPC 桥或凭据转发层。
- 不承诺 preset 内运行的插件模块热重载。
- 未获得费用许可时，不调用真实 Tavily Search/Extract/Map/Crawl API，也不调用真实 usage 接口。
- 不调整 DSH peer 范围与 compatibility.dshReleases 矩阵。该矩阵目前列到 0.2.0-rc.2，与运行中的 0.2.1-rc.5 之间的差异是独立审计事项，不与本次行为变更混在一起。

## 4. 已确定的架构决策

### 4.1 单包双入口

采用一个包、两个按运行位置分离的入口：

| 入口 | 运行位置 | 职责 |
| --- | --- | --- |
| @moguiyu/dsh-tavily | Host Loader | /api/tavily-usage、/api/tavily-manager、Client 卡片载体、一次性的缺 key 启动检查 |
| @moguiyu/dsh-tavily/tools | 各目标 preset 的 PresetTree | 四个工具、两段系统提示、该安装实例的 round-robin 游标 |

不引入 tools/backend 布尔 Config。入口本身表达职责，避免出现 Host 与 preset 配置组合错误，也避免 tools 入口静态依赖 webServer 而在 preset 作用域内解析失败。

### 4.2 根入口直接转为管理面

0.7.0 的包根入口不再保留 0.6.0 的全局工具注册兼容模式。这是一次有意的行为变更，因此：

- 版本从 0.6.0 升为 0.7.0；
- README 与安装说明必须写明：只升级包而未在 preset 中挂载 tools 行时，任何 preset 都不会获得 Tavily 工具；
- 当前 web profile 采用停服迁移，在一次重启中同时更新包与四个 preset 声明；
- 回滚时同时恢复旧包并删除 tools 行。

### 4.3 Host 行继续保留

cordis.patch.yml 仍插入 id 与 name 均为 dsh-tavily 的 Host 行。该行必须保持启用，才能被 dsh-client-modules 发现并加载管理卡片，也才能提供两条管理路由。

preset 中的 @moguiyu/dsh-tavily/tools 行不承担 Client 发现职责，也不注册任何路由。

### 4.4 目标 preset 固定为四个

> 施工结果：`chat-assistant` 已废弃，最终未挂载 `tavily-tools` 行，实际目标 preset 为 `standard-instant`、`ptc-instant`、`cordis-ptc` 三个。本节保留计划阶段的判断，差异见 [验收记录](./0.7.0-acceptance.md)。

| Preset | 升级后的 Tavily 能力 | 呈现方式 | 理由 |
| --- | --- | --- | --- |
| standard-instant | 有 | 原生工具 | 完整编码 Agent，需要 Tavily 检索 |
| ptc-instant | 有 | run_code 的 TypeScript SDK 绑定 | 同上 |
| cordis-ptc | 有 | run_code 的 TypeScript SDK 绑定 | 同上 |
| chat-assistant | 有 | PTC 呈现（该 preset 已配置 tool-presentation mode: ptc） | 描述明确承诺 Tavily 联网搜索 |
| minimal | 无 | 不适用 | 精简 preset，不承诺联网检索 |
| 官方 standard / ptc / cordis | 无 | 不适用 | 保持官方模板原貌 |

子代理省略 preset 时继承父代理当时的 composition，因此是否获得 Tavily 由父 preset 决定；显式选择其他 preset 时由新 preset 决定。

chat-assistant 有两个可选处理：为其补上 tools 行，或改写它的描述。选择补行，因为它现在确实通过 Host 继承拥有该能力，改写描述等于在本用户已经选用的预设上削减能力，并且要让用户额外做一次措辞审查。

### 4.5 round-robin 游标改为按安装实例计数

当前实现把游标放在 src/state.js 的模块级变量里，拆分后会变成全进程共享。改造方式是把游标移入 installTavilyTool 的局部闭包，与 dsh-exa 0.4.0 的 rotation 对象同一形态。由此得到以下语义：

- 同一个 preset revision 下的会话与继承它的子代理共享游标；
- 不同 preset 独立计数，首次调用可能选择同一个 key；
- preset 重建或 Harness 重启会重置对应游标；
- routing strategy、key 顺序、active 状态与 432/433 停用记录仍由共享凭据与 ~/.dsh/tavily-manager.json 提供，不随 preset 分片。

priority 模式不读游标，因此该模式下行为与 0.6.0 完全一致。

### 4.6 凭据、状态文件与用量缓存仍全局共享

凭据来自 credentials 服务（TAVILY_API_KEYS 优先，TAVILY_API_KEY 兜底），路由状态与 key 可用性记录在 ~/.dsh/tavily-manager.json，用量样本缓存是 backend 模块级 Map。这三者都不随 preset 分片：在卡片里改策略、改 key 顺序、开关某个 key，所有 preset 的下一次调用立即按新状态执行。该共享是设计意图，不是遗留耦合。

### 4.7 与 dsh-exa 0.4.0 先例的差异

| 维度 | dsh-exa 0.4.0 | 本包 0.7.0 |
| --- | --- | --- |
| 目标 preset 数 | 3 | 4（多 chat-assistant，因其描述承诺 Tavily） |
| 工具数 | 3 | 4 |
| 系统提示段 | 1 段（tool:exa） | 2 段（tool:tavily_search、tool:tavily_direct） |
| 管理路由 | 1 条（/api/exa-manager） | 2 条（/api/tavily-usage、/api/tavily-manager） |
| 游标来源 | 已是 installTools 内的局部 rotation | 需从 state.js 模块级移入安装闭包 |
| 缺 key 检查落点 | key-manager.js 的 warnIfNoKeys | backend.js 的 warnIfNoKeys（复用已有 collectStoredKeys） |
| 文案载体 | locale/en.json、locale/zh.json | 无 locale 目录，卡片文案硬编码在 src/client.js |
| 卡片 key | dsh-exa | @moguiyu/dsh-tavily（沿用包名） |

## 5. 包结构与代码修改

### 5.1 src/index.js：改为 Host 管理入口

修改内容：

1. 保留 name = 'dsh-tavily'。
2. inject 改为 ['webServer', 'credentials']，去掉 'tools' 与 'systemPrompt'。
3. 删除 import { installTavilyTool } from './tools.js'。
4. 从 backend.js 引入 installBackend 与 warnIfNoKeys。
5. apply(ctx) 只做两件事：installBackend(ctx)、warnIfNoKeys(ctx)。
6. 重写文件头注释：说明该入口不注册模型工具与系统提示，工具在 dsh-tavily/tools 中由 preset 挂载。

预期结果：Host 行挂载后只产生两条路由，全局工具目录与全局 system prompt 都不出现 Tavily 内容。

### 5.2 新增 src/tools-entry.js：preset 工具入口

文件职责保持单一：

- 导出 name = 'dsh-tavily-tools'；
- 导出 inject = ['tools', 'credentials', 'systemPrompt']；
- 从 src/tools.js 引入 installTavilyTool；
- apply(ctx) 通过 ctx.effect(() => installTavilyTool(ctx), 'dsh-tavily: tools') 注册工具与提示；
- 不引入 src/backend.js，不读取 webServer，不注册任何 HTTP 路由。

预期结果：该入口可放入多个 preset，每个 standing composition 各有一套工具注册与独立游标，路由数量为零。

### 5.3 src/tools.js：保留工具实现，移出全局启动检查，内置游标

保留不动的内容：四个 defineTool 定义与全部参数校验、请求映射、响应投影与 render；canonical output schema；两段 systemPrompt.section；每次调用重新读取凭据与 manager state；installTavilyTool 返回的统一 disposer；432/433 记录与 all-off 探针逻辑。

需要修改的七处：

1. 在 installTavilyTool 顶部（disposers 声明附近）增加 const rotation = { cursor: null }。
2. attemptOrder 的游标读取由 getCursor() 改为 rotation.cursor；光标查找逻辑仍以 id 比对，不用索引，保持重排不漂移。
3. requestWithFailover 中 setCursor(item.id) 改为 rotation.cursor = item.id；probeOldestBlocked 成功分支同理。
4. 删除从 state.js 导入 getCursor、setCursor 的两行。
5. 删除 installTavilyTool 尾部的缺 key 启动检查（第 728 至 737 行），该职责移到 Host 入口。
6. 请求头里的 user-agent 由 dsh-tool-tavily-search/0.6.0 改为 /0.7.0，并在新增测试里断言它与 package.json 的 version 一致。
7. 文件头注释中“没有工具级开关，Plugins 页开关是唯一的总开关”一段改写为：Host 开关只控制管理面，工具可见性由各 preset 的 tools 行决定。

### 5.4 src/state.js：删除游标存储

删除模块级 let cursor = null 以及 getCursor、setCursor、resetCursor 三个导出（第 187 至 200 行），并把文件头中关于“round-robin 游标只存在内存”的说明移到 tools.js 的 rotation 声明处。其余导出（mode、keys 记录、quotaBlock、recoveryRatio、pruneKeys 等）保持不变。

删除导出会牵动两处测试导入（test/state.test.js 与 test/priority.test.js），第 9 节给出对应改法。

### 5.5 src/backend.js：导出 warnIfNoKeys，路由行为不变

新增一个小函数并导出：

- 复用现成的 collectStoredKeys(credentials)（第 156 至 161 行），不新增凭据读取路径；
- 在 keys 为空时打一条 warn，文本与 0.6.0 相同，便于既有排障文档继续成立；
- 捕获异常并降级为一条 warn，不缓存 secret，不输出完整 key；
- 由 Host 入口调用，因此每次 Harness 启动最多打印一次。

/api/tavily-usage 与 /api/tavily-manager 的 exact route、全部 key 管理 action、no-store 响应、错误映射与 owning-fiber disposer 一律不变。usageCache、fetchUsageDetailsFor、refWritable、syncPrimary 等辅助函数不动。

### 5.6 package.json：增加子路径出口并升级版本

修改项：

1. version 改为 0.7.0。
2. exports 增加 "./tools": "./src/tools-entry.js"；保留 "."、"./invariant"、"./client"、"./icon"、"./src/*"、"./package.json"。
3. main 与 exports["."] 继续指向 ./src/index.js。
4. files 已包含整个 src，无需为 tools-entry.js 增加条目。
5. dsh.bundle.patch 保持 ./cordis.patch.yml；dsh.client 保持现有 platform 与 inject。
6. description 补一句：工具是否可用由 preset 中的 @moguiyu/dsh-tavily/tools 行决定。
7. scripts 增加 check，对 src 下每个文件执行 node --check，作为拆分后结构错误的低成本守门。
8. engines、peerDependencies、compatibility 不因本次拆分改变；不需要新增运行时依赖。

### 5.7 cordis.patch.yml：保持 Host 行

继续使用：

```yaml
- insert:
    - id: dsh-tavily
      name: '@moguiyu/dsh-tavily'
```

该文件不向 preset 写入行，也不覆盖任何 preset 的完整 config。

### 5.8 src/client.js 与 lib/client.js

组件结构与 slot 注册无需改动：仍向 plugins.bundle.config 注册 key 为 @moguiyu/dsh-tavily 的卡片，仍提供 summary 与 page 两个视图。

需要改两处文案，避免用户把 Plugins 开关误解为工具总开关：

- summary（第 529 至 531 行）改为说明该卡片管理全局共享的 key、调用顺序与可用性，工具是否出现在 Agent 中由 preset 的 tools 行决定；
- 卡片顶部说明段（第 357 至 359 行）补一句：禁用 Host 插件行只会移除本卡片与两条管理路由，不会删除任何 preset 的工具。

修改完成后运行 npm run build 重新生成 lib/client.js，不要手改构建产物。现有 test/build.test.js 会断言 lib/client.js 与 src/client.js 完全一致，构建落后会直接失败。

### 5.9 src/invariant.js 与不变项

src/invariant.js 保持原样：本次拆分不改变包对 invariants 服务的注册方式，bundle patch 也没有引入该 companion。src/lib.js、icon.svg、THIRD_PARTY_NOTICES.md、LICENSE 均不动。

## 6. web profile 配置施工

### 6.1 profile package.json

保留 @moguiyu/dsh-tavily 在 dsh.profile.bundles 与 dependencies 中，仍指向现有的 link 目标。单包双入口不需要新增依赖，也不需要把 @moguiyu/dsh-tavily/tools 写入 dependencies。

### 6.2 四个 preset 的 config.plugins

在 standard-instant、ptc-instant、cordis-ptc、chat-assistant 的 config.plugins 中分别加入：

```yaml
- id: tavily-tools
  name: '@moguiyu/dsh-tavily/tools'
```

四处使用相同的局部 id。插入位置统一为 tool-web 行之后、与 exa-tools 相邻。standard-instant、ptc-instant、cordis-ptc 三处的 exa-tools 已紧跟 tool-web（cordis.patch.yml 第 236、374、702 行），Tavily 行接在 exa-tools 之后；chat-assistant 没有 exa-tools 行，其 tool-web 在第 500 行附近，Tavily 行紧随其后即可。四个 preset 保持同一相对位置，工具目录顺序才可预测。

不得加入 config.backend 一类开关；tools 入口不具备 backend 能力，也不需要这种配置。

### 6.3 不修改其他 preset

不向 minimal、官方 standard/ptc/cordis 添加该引用。它们失去 Host 全局继承的 Tavily 工具是本次预期结果。

### 6.4 为什么不能只靠 bundle 自动完成

DSH 0.2.1-rc.5 的 patch insert 只能向 group: true 且 config 为数组的组追加子行；dsh-agent-preset 的子插件位于 config.plugins，且 preset 行本身由 workspace patch 声明。bundle 没有“选择 preset 并追加到 config.plugins”的安装语义。

因此本次需要显式修改 web profile 中的四个 preset 声明。若以后要做一键选择，应另立安装器需求，不在本次插件升级中临时实现。

### 6.5 link 目标的依赖解析预检

本机的安装形态是：~/.dsh/profiles/web/package.json 以 link 指向 ~/.dsh-local-plugins/dsh-tavily，profile 的 node_modules 中再建一个指向该目录的符号链接；该目录本身不带 node_modules。

由此产生一个必须在迁移前确认的细节。以普通 node 从 profile 目录导入包根入口会失败，报 ERR_MODULE_NOT_FOUND（找不到 @deepseek-ai/dsh-tools），因为解析走的是真实路径 /home/andyk/.dsh-local-plugins/dsh-tavily/src，其向上没有可用的 node_modules；加上 --preserve-symlinks 后同一导入成功，因为解析改走 profile 中的符号链接路径，从而落到 ~/.dsh/profiles/node_modules。

dsh 自身的加载器带有自己的解析与路径重定位逻辑，因此运行中的实例能正常解析该包；但这也意味着“本地能 import”不是可靠的预检手段。施工时采用以下顺序：先用 --preserve-symlinks 做结构预检，最终以重启后启动日志中四个 preset 无 broken、路由无重复为准。若希望彻底消除这一形态差异，另一个选项是改用 npm pack 产物安装，让插件落到 profile 的 node_modules 内，代价是每次改动都要重新打包安装。

## 7. 生命周期、开关与运行语义

### 7.1 挂载与卸载

- Host 根行卸载：两条 /api 路由移除，Client 卡片随 Host entry 消失。
- 某个 tavily-tools 行卸载：只移除该 preset 作用域内的四个工具与两段提示。
- 多 preset 同时挂载：不应发生路由冲突，因为 tools 入口不接触 webServer。
- Host 与 preset 同时使用同一个包：共享凭据与 ~/.dsh/tavily-manager.json，共享用量缓存，不共享 round-robin 游标。
- 同一 preset 作用域内不得重复添加两个会注册同名工具的行。

### 7.2 Plugins 页开关的新语义

升级后 Plugins 页的 Host 行开关只直接控制管理面：卡片、两条路由、缺 key 启动检查。它不再是“一键停用全部 Tavily 能力”的总开关。

完全停用 Tavily 需要两步：

1. 禁用或删除四个 preset 中的 tavily-tools 行；
2. 禁用 Host 的 dsh-tavily 行，或取消选择 bundle。

UI 文案与 README 必须写明这一点，避免把“管理面已禁用”误读为“模型已不能调用 Tavily”。

### 7.3 卸载顺序

卸载包前必须先删除所有 preset 中的 @moguiyu/dsh-tavily/tools 引用，再执行插件卸载。否则包依赖消失后，相关 preset 会因模块解析失败而 broken。

推荐顺序：

1. 停止 Harness；
2. 删除四个 tavily-tools 行；
3. 执行插件卸载或从 profile 依赖中移除；
4. 再启动 Harness；
5. 确认没有 tavily-tools 引用残留。

### 7.4 重载边界与 HMR

本次迁移采用完整重启，不依赖 HMR 完成包入口与 preset 声明的原子切换。后续开发按以下边界处理：

- src/index.js、src/backend.js 等 Host 管理面变化，按 Host 插件流程验证；
- src/tools-entry.js、src/tools.js、src/state.js 等被 preset 使用的变化，默认按需要重启处理，不承诺热重载；
- src/client.js 变化必须重建 lib/client.js，并按现有 Web 构建与页面刷新条件验证；
- 不用 Host 卡片或路由正常来推断 preset 工具已经加载。

### 7.5 现有会话与 revision

preset 定义更新后，活跃 Agent 可能保留旧 revision。为避免“当前会话仍看到旧工具、新会话已经使用新组合”的混合状态，本次升级与回滚都在 Harness 停止时修改配置，再统一启动。

重启后会话按当前同 id preset 定义恢复。未配置 Tavily 的 preset 中，历史消息仍可保留旧工具调用记录，但新请求不再提供相应工具。

### 7.6 多 preset 并存的资源账

| 资源 | 数量 | 归属 |
| --- | --- | --- |
| /api/tavily-manager | 1 | Host |
| /api/tavily-usage | 1 | Host |
| Plugins 卡片 | 1 | Host（dsh.client 扫描） |
| 缺 key 启动警告 | 每次启动最多 1 条 | Host |
| tavily_search / tavily_extract / tavily_map / tavily_crawl | 每个挂载 tools 的 preset 各 1 套 | preset revision |
| tool:tavily_search、tool:tavily_direct | 每个挂载 tools 的 preset 各 1 套 | preset revision |
| round-robin 游标 | 每个挂载 tools 的 preset 各 1 个 | preset revision（内存） |
| ~/.dsh/tavily-manager.json | 1 | 进程共享 |
| 凭据 | 1 组 | 进程共享 |

## 8. 实施顺序

### 阶段 A：入口拆分与单元测试

1. 修改 src/index.js 为 Host-only。
2. 新增 src/tools-entry.js。
3. 把缺 key 启动检查移到 backend.js 并从 installTavilyTool 删除。
4. 把 round-robin 游标从 state.js 移入 installTavilyTool 闭包。
5. 修改 package.json 的 version、exports、scripts.check。
6. 新增 test/entries.test.js，更新 test/state.test.js 与 test/priority.test.js。
7. 运行 npm run check 与 npm test。

完成标准：两个入口各自只注册自己的资源，现有工具、路由与状态测试全部通过。

### 阶段 B：文档、卡片文案与构建产物

1. 更新 README 的安装、可见性、开关、卸载、round-robin 与开发说明。
2. 更新 src/client.js 的 summary 与卡片说明段。
3. 重建 lib/client.js。
4. 新建 docs/verification.md，记录本次实际执行的命令与结果。
5. 核对发布文件列表包含 src/tools-entry.js、更新后的 src/index.js 与 lib/client.js。

完成标准：npm 包仍只有一个，@moguiyu/dsh-tavily 与 @moguiyu/dsh-tavily/tools 均可从同一安装物解析。

### 阶段 C：停服迁移当前 web profile

1. 备份 ~/.dsh/profiles/web/cordis.patch.yml 与 package.json，例如 cordis.patch.yml.bak-before-tavily-0.7.0-<时间戳>。
2. 记录当前依赖形态：link 目标为 /home/andyk/.dsh-local-plugins/dsh-tavily。
3. 停止当前 Harness。
4. 把 0.7.0 的 src、lib、package.json、README.md、cordis.patch.yml 同步到该 link 目标，保留其目录结构，不复制 .git、dist、test。
5. 用 --preserve-symlinks 做结构预检，确认两个入口都能解析。
6. 在四个目标 preset 的 tool-web（或 exa-tools）之后各插入一行 tavily-tools。
7. 检查没有任何 preset 使用旧根入口 @moguiyu/dsh-tavily 作为工具行。
8. 启动 Harness，读取启动日志。

完成标准：启动日志没有 preset broken、没有 duplicate route、没有模块解析错误；四个目标 preset 状态正常。

### 阶段 D：Host、Client 与各 preset 验收

按第 9 节执行验证，记录实际结果与未执行项。真实 Tavily 调用仍需单独费用许可。

### 阶段 E：发布与后续维护

1. 把 docs/verification.md 更新为实际结果。
2. 生成并核对发布包（npm pack 产物与 dist 中的 tgz、zip、SHA256SUMS.txt）。
3. 发布 0.7.0。
4. 后续 DSH 升级时，继续同步四个自定义 preset 的官方模板差异；tavily-tools 行作为本地增量保留。

## 9. 测试与验收计划

### 9.1 自动化测试

#### Host 入口

- 挂载后工具数为零、system prompt section 数为零、路由恰为 /api/tavily-usage 与 /api/tavily-manager。
- 卸载后两条路由与相关资源全部清理。
- 用会抛错的 fake webServer 重复挂载两次，第二次应抛出 duplicate exact route，证明该约束确实存在且被测试固定。
- 缺 key 警告每次 Host 挂载最多一次；有 key 时不打印。

#### tools 入口

- 挂载后恰好注册 tavily_search、tavily_extract、tavily_map、tavily_crawl 四个工具与 tool:tavily_search、tool:tavily_direct 两段提示。
- 不注册任何 HTTP 路由，也不读取 webServer。
- 卸载后四个工具与两段提示全部消失。
- 清洁卸载后可重新挂载。
- 两个独立安装实例的 round-robin 游标互不影响，且各自的 priority 行为一致。
- 原有参数、请求、响应、错误与 failover 测试继续通过。

#### 包清单与 Client

- exports["."] 与 exports["./tools"] 均指向存在且语法有效的文件。
- 用 --preserve-symlinks 从 profile 目录分别 import 两个入口，均成功且 name 分别为 dsh-tavily 与 dsh-tavily-tools。
- dsh-tavily/tools 不导入或调用 installBackend。
- cordis.patch.yml 仍只有一个 Host dsh-tavily 行。
- lib/client.js 与 src/client.js 同步（现有 test/build.test.js 覆盖）。
- 发布文件列表包含新增入口。
- src/tools.js 的 user-agent 版本与 package.json 的 version 一致。

#### 状态与游标

- 游标不再从 src/state.js 导出；state 测试只覆盖 mode、enabled、quotaBlock、recoveryRatio、pruneKeys。
- priority 模式下连续调用始终从第一个 active key 开始。
- round-robin 模式下单个安装实例的推进顺序与 0.6.0 一致。

### 9.2 实际组合验收

| 检查项 | 预期结果 |
| --- | --- |
| Host 全局工具目录 | 不含四个 Tavily 工具 |
| standard-instant 新会话 | 原生工具表包含四个 Tavily 工具 |
| ptc-instant 新会话 | run_code SDK 包含四个 Tavily 绑定 |
| cordis-ptc 新会话 | run_code SDK 包含四个 Tavily 绑定 |
| chat-assistant 新会话 | 四个工具以 PTC 呈现，与其描述一致 |
| minimal / 官方 standard / ptc / cordis | 不含 Tavily 工具与两段提示 |
| 四个目标 preset registry 状态 | 均无 broken 诊断 |
| Plugins → dsh-tavily | 管理卡片正常显示 |
| GET /api/tavily-manager | HTTP 200、no-store、masked key 与 primary 标记不变 |
| GET /api/tavily-usage | HTTP 200、no-store、perKey 与 totals 结构不变 |
| 路由注册数量 | 整个 Host 中恰各一条 |
| 内置 web 工具 | schema、provider 与可用性不变 |
| 子代理 | 省略 preset 时继承父能力；显式选择时遵循新 preset |

### 9.3 状态与策略验收

使用 mock fetch 与临时 DSH_HOME，不消耗真实额度：

- 一个 preset 中发生 432 后，另一个 preset 的下一次调用能读到共享的 inactive 状态；
- 两个 preset 的 round-robin 游标独立推进；
- 卡片修改策略后，所有 preset 的下一次调用使用新策略；
- key 增删、排序、active 切换、只读环境行为与 0.6.0 一致；
- 所有 key 都关闭时的探针逻辑与 0.6.0 一致。

### 9.4 开关与卸载验收

在隔离的测试 profile 或已备份的维护窗口中验证：

1. 禁用 Host 行后卡片与两条路由消失，preset 工具按新语义仍存在；
2. 重新启用 Host 行后卡片与路由恢复，不出现重复路由或重复工具；
3. 删除四个 tavily-tools 行后卸载包，不出现 preset broken；
4. 重装包并恢复四行后，所有目标能力恢复。

### 9.5 浏览器验收

- 页面刷新后卡片出现，控制台无模块加载错误；
- 卡片 summary 与说明段均说明 preset 决定工具可见性；
- 亮色、暗色、窄宽布局无新增溢出；
- key 管理、排序、策略切换、可用性开关与用量圆环保持原行为。

### 9.6 真实 API 限制

默认只使用 mock。只有在明确批准费用后，才以最小参数分别执行一次 search 与 extract；未执行时在验证记录中明确标注，不以 schema 检查或 mock 通过替代真实 API 成功验证。

## 10. 文档修改清单

README.md 至少需要更新：

- 当前版本 0.7.0 与安装步骤；
- 单包双入口结构说明；
- 四个目标 preset 的配置示例；
- 各 preset 的工具可见性矩阵；
- Host 开关不再控制全部工具；
- 正确卸载顺序；
- round-robin 游标按 preset revision 独立推进的语义；
- Host/preset/Client 不同的重载边界；
- 0.6.0 → 0.7.0 的停服迁移与回滚说明。

新建 docs/verification.md，记录实际执行命令、组合检查、浏览器检查、未执行的真实 API 测试，以及任何 restart-required 情况。

本计划保存为 docs/preset-separation-upgrade-plan.md，作为本次升级的施工依据；实施完成后不重写为现状文档，实际结果另记于 docs/verification.md。

## 11. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 只升级包，未添加 preset 行 | 0.7.0 明确标记行为变更；停服时同时修改包与四个 preset |
| 误在 preset 中使用包根入口 | 配置审查确保 preset 只使用 /tools 子路径；启动时检查路由重复与 broken 诊断 |
| 删除 Host 行导致卡片消失 | 保留 bundle 与 Host 根行，并将 Host-only 行为纳入测试 |
| Plugins 开关被误解 | 更新卡片文案与 README，验收实际开关语义 |
| 卸载后 preset broken | 卸载前删除全部 tools 引用 |
| 多 preset 重复缺 key 警告 | 启动检查移到唯一 Host 入口 |
| 游标仍被模块级共享 | 移入安装闭包，并用“两个安装互不影响”的测试固定 |
| 轮询负载分配变化 | 明确按 preset 游标语义，并在 README 与测试中记录 |
| 当前会话仍使用旧 revision | 采用完整重启，验收使用重启后的会话或新会话 |
| 误承诺 preset HMR | 文档规定 tools 侧变化默认重启验证 |
| 工具实现意外变化 | 复用 installTavilyTool 与现有全部工具测试，不重写 schema 或请求层 |
| link 目标缺少自身 node_modules，冷启动解析依赖 dsh 加载器的路径处理 | 阶段 C 增加 --preserve-symlinks 结构预检，并以启动日志为最终判据；必要时改用 pack 产物安装 |
| 构建产物落后 | test/build.test.js 已断言 lib/client.js 与源同步 |
| 版本号多处重复 | 增加 user-agent 与 package.json 版本一致性的测试 |

## 12. 回滚方案

回滚必须同时恢复包与配置：

1. 停止 Harness。
2. 从四个 preset 删除 tavily-tools 行。
3. 恢复 @moguiyu/dsh-tavily 0.6.0 到 link 目标，其中包根入口仍注册全局工具、提示与两条路由。
4. 保留 ~/.dsh/tavily-manager.json；0.7.0 不改变其 schema，无需数据回滚。
5. 启动 Harness。
6. 验证所有 preset 恢复 Host 全局 Tavily 工具，卡片与路由正常，未出现重复注册。

若只回滚包而不删除 tools 行，0.6.0 不存在该子路径导出，四个目标 preset 会因解析失败而 broken；若只删除 preset 行而保留 0.7.0，则所有 preset 都没有 Tavily 工具。两种不完整回滚均不允许作为结束状态。

## 13. 完成定义

只有以下条件全部满足，才将升级标记完成：

- 单包双入口已构建、安装并可解析；
- npm run check 与 npm test 通过；
- 四个目标 preset 均无 broken，且工具呈现正确；
- 非目标 preset 不再提供 Tavily 工具；
- Host 两条路由唯一，Plugins 卡片可用；
- 开关与卸载的新语义经过验证并写入文档；
- round-robin 独立游标与共享状态行为有测试；
- README 与 docs/verification.md 反映实际结果；
- 回滚步骤可执行且没有不完整状态；
- 真实 API 调用结果或“未获费用许可、未执行”的限制已明确记录。

## 14. 主要源码依据与探测记录

本计划基于以下证据：

- 本仓库：src/index.js（46 行，installTavilyTool 与 installBackend 双职责）、src/tools.js（755 行，四个工具、两段提示、第 728 至 737 行启动检查、第 125 行 user-agent）、src/backend.js（439 行，两条 exact route 与 collectStoredKeys）、src/state.js（200 行，第 187 至 200 行模块级游标）、src/client.js（551 行，第 357 行说明段、第 529 行 summary、第 541 行 slot 注册）、package.json（exports 无 ./tools）、cordis.patch.yml（单行 Host 插入）。
- 当前 web profile：~/.dsh/profiles/web/package.json（bundles 含 @moguiyu/dsh-tavily，依赖为 link:/home/andyk/.dsh-local-plugins/dsh-tavily）、cordis.patch.yml（四个 preset 的 insert 块分别在第 116、251、390、582 行；chat-assistant 描述第 396 行；三处 exa-tools 行在第 236、374、702 行）。
- @deepseek-ai/dsh-host-webserver：lib 第 328 行 duplicate exact route 抛错。
- @deepseek-ai/dsh-client-modules：Node 半侧注释说明只扫描 Host Loader entries 并读取 dsh.client。
- @deepseek-ai/dsh-agent-preset：AgentPreset 以 EntryGroup 形式挂载 config.plugins 子行。
- @deepseek-ai/dsh-agent-preset-registry：broken 诊断在 lib 第 517 行记录，revision 保留与 diagnostic 接口在第 555 行起。
- cordis-plugin-loader：外部插件名经 ctx.loader.internal.import(name, baseUrl) 解析。
- dsh-exa 0.4.0 本机先例：/home/andyk/.dsh-local-plugins/dsh-exa 的 src/index.js、src/tools-entry.js、package.json exports，以及其 docs/preset-separation-upgrade-plan.md。

本机探测结果：

- 从 profile 目录 import @moguiyu/dsh-tavily/client 成功进入模块（因缺少 window 而抛出浏览器对象错误，属预期），说明本包 scoped 子路径可被解析；
- 同一命令 import @moguiyu/dsh-tavily/tools 返回 ERR_PACKAGE_PATH_NOT_EXPORTED，符合拆分前的预期；
- 同一进程内两次独立导入 src/state.js，任一方写入的游标对另一方可见，确认游标为进程共享；
- 从 profile 目录以普通 node import 包根入口报 ERR_MODULE_NOT_FOUND（找不到 @deepseek-ai/dsh-tools），加 --preserve-symlinks 后成功，说明解析结果取决于符号链接处理方式；
- 本仓库（带 node_modules）import 包根入口成功，返回 name = dsh-tavily。
