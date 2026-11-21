# dsh-tavily 规范整改施工计划

- 日期：2026-11-21（施工完成：2026-11-22）
- 状态：已完成（代码与审阅补修后的 89 项自动化测试通过，WP0–WP5 已完成隔离 DSH 0.2.2-rc.5 冒烟；实机安装与浏览器人工验收项见 `0.9.0-acceptance.md`）
- 当前项目版本：0.9.0（由 0.8.0 升级）
- 施工基线：DeepSeek Harness 0.2.2-rc.5（`@deepseek-ai/cordis@4.1.0`）
- 审查依据：用户提供的《dsh-tavily 插件规范审查报告》、当前项目源码、现有测试、当前安装的 DSH 文档与 Cordis Inspect 契约
- 计划范围：管理路由认证与密钥回读、usage cache 生命周期、工具取消语义、状态文件读取错误
- 预计工作量：4–7 人日；不含可选改进、旧 DSH 版本适配和真实代理环境专项测试

## 1. 施工结论

本期采用“标准修复”路线：两条管理接口迁入 `ctx.connection.fetch.register()`，保留 Host 端 Credentials Service 和多密钥写入，删除完整密钥回读；同时完成 cache、取消和状态文件错误处理。

本期不重写 Tavily 搜索、提取、映射和抓取逻辑，不改变四个工具的用途，不改变 Host / preset 双入口，不注册或替换内置 WebSearchProvider / WebFetchProvider。

两项架构建议不进入本期：

1. 不把多密钥编辑整体迁到 `remote.credentials`。当前 `TAVILY_API_KEYS` 是单个逗号分隔的引用，Client 只有掩码和 fingerprint，而 Remote 凭据接口没有 `resolve`，无法独立重建删除、替换或排序后的完整列表。已认证的 Host 管理路由继续使用 Credentials Service，符合秘密不进入配置和 Client 不回读完整值的要求。
2. 不迁移 storageDomain。它会引入 Domain 单一持有者、异步写入、生命周期和旧数据迁移，应另立方案。第一期先用严格读取和原子写入消除静默覆盖。

既有 [rc.3 之后兼容性核对](./post-rc.3-compatibility.md) 记录的是当时未发布提交，只作为历史证据。所有接口名称、参数、返回类型和释放方式，以施工时 0.2.2-rc.5 的 Inspect 与安装源码为最终依据。

## 2. 基线与验收原则

施工开始前应满足以下条件：

- 工作树干净，记录当前提交和插件启用状态。
- `npm run check`、`npm test` 均通过；2026-11-21 基线为 69 项测试通过。
- 当前报告路径、工作区和已安装插件的核心源码哈希一致。
- 默认只承诺 DSH 0.2.2-rc.5。若必须继续支持旧版本，先增加独立兼容任务，不得在未验证 Connection 等接口的情况下保留兼容声明。
- 施工前重新执行 Cordis Inspect，核对 `connection.fetch.register`、`ConnectionFetchRoute`、`requestBody`、异步 disposer、Credentials Service 和工具注册契约。若实际契约与本文不同，先修订计划，再写实现。

施工期间遵守以下约束：

- 不在日志、测试快照、错误消息和文档示例中写入真实 API key。
- 不直接编辑 profile 的 `package.json` 或 `cordis.patch.yml`；安装和升级通过 plugin_manager 完成。
- 不用删除既有测试来掩盖行为破坏。原先把不安全行为当作规格的测试，应替换成新的安全规格并说明原因。
- 每个工作包完成后运行相关测试；合入前运行完整检查。

## 3. 工作包

### WP0：冻结基线和兼容范围（0.25–0.5 人日）

任务：

1. 记录当前 commit、`npm test` 结果、已安装包路径、Host 行和三个 tools preset 的挂载状态。
2. 将测试用 DSH 开发依赖对齐到 0.2.2-rc.5；是否新增直接依赖由实际 import 决定，仅使用 `ctx.connection` 时不额外引入实现包。
3. 审查 `peerDependencies` 和 `dsh.compatibility.dshReleases`。本期发布只声明已验证的 DSH 版本；旧版本继续使用旧插件版本，或另开适配工作。
4. 建立验收记录草案，列出 Web、PTC、native、卸载重载、代理和真实 Tavily 请求的验证边界。

完成条件：依赖和兼容范围明确，基线测试通过，后续实现不再伴随版本目标漂移。

### WP1：管理接口迁入 Connection（1.25–2 人日）

#### WP1.1 路由和生命周期

> **2026-11-22 0.2.2-rc.5 契约核对修订**：查阅已安装 `@deepseek-ai/dsh-client-connection@0.2.2-rc.5`（`src/rpc-host.ts`、`src/http-bridge.ts`）确认：
> 1. `ConnectionFetchRoute` 按 `path` 唯一注册，且 `requestBody`（`'buffered' | 'streaming'`）是路由级而非方法级属性。
> 2. `http-bridge.ts` 在 `bodyMode === 'streaming'` 时无条件把 `Readable.toWeb(req)` 作为 `body` 传入 `new Request(url, { method, ... })`；对 `GET` / `HEAD` 方法在 WHATWG Fetch（Node 24）中会直接抛出 `TypeError: Request with GET/HEAD method cannot have body.`。
> 3. 因此为在 0.2.2-rc.5 上既保证 `GET` 正常，又确保管理写接口在 `http-bridge.ts` 默认 300 MiB 缓冲之前执行 64 KiB 流式上限，将管理写接口拆分为独立流式路径 `/api/tavily-manager/update`（`POST`，`requestBody: 'streaming'`），`GET /api/tavily-manager` 与 `GET /api/tavily-usage` 保持原路径并使用 `requestBody: 'buffered'`。
> 4. 对于不在 `route.methods` 中的方法，Connection 的 `createSharedFetchHandler` 不会进入 `route.fetch`（按共享通道返回 404）；处理器内部仍保留防御性 405 与 `Allow` 头。

1. Host 入口声明 `connection` 依赖；确认不再使用 `webServer` 后移除该注入。
2. 将管理接口迁入 Connection Fetch exact route：
   - `/api/tavily-manager`：`GET`，`requestBody: 'buffered'`。
   - `/api/tavily-manager/update`：`POST`，`requestBody: 'streaming'`。
   - `/api/tavily-usage`：`GET`，`requestBody: 'buffered'`。
3. 使用标准 `Request` / `Response`，保留现有管理卡片所需 JSON 字段，避免无关的 UI 协议变化（Client POST 目标同步指向 `/api/tavily-manager/update`）。
4. 路由仍由 Host 根入口的 `ctx.effect` 持有。Connection 返回异步 disposer（`() => Promise<void>`）时，卸载测试必须等待释放完成。
5. 保留重复注册失败和卸载后重注册测试，确保多个 preset 不会注册管理路由。
6. usage 的上游 Tavily 请求接收页面请求的 `request.signal`，同时保留自己的超时，客户端断开后不继续无主的 usage 请求。

#### WP1.2 请求校验和 body 上限

1. manager POST 使用流式请求体读取，设置 `64 * 1024` 字节上限；不能只在 Connection 完成 300 MiB 默认缓冲后检查长度。
2. 同时检查实际读取字节数和 `Content-Length`，但不得只信任后者。超过上限返回 413，并取消继续读取。
3. JSON 解析失败返回 400；不支持的媒体类型返回 415；不支持的方法返回 405 和 `Allow`。
4. 请求解析或校验失败不得执行任何凭据写入。现有多字段更新的顺序和只读环境变量保护保持不变；跨凭据与状态文件的原子事务不在本期承诺范围内。
5. 统一 JSON 响应的 `content-type`、`cache-control: no-store` 和状态码，不向客户端返回异常栈或秘密内容。

#### WP1.3 删除 reveal 和远程绕过

1. 删除 manager GET 的 `reveal` 分支及完整 key 响应。
2. 删除 Client 的 revealed 状态、`toggleReveal`、眼睛图标和完整 key 渲染；保留“替换密钥”流程。
3. 所有列表、usage 和错误响应只包含掩码、 fingerprint、用量和状态，不包含完整 key。
4. 移除 `TAVILY_MANAGER_ALLOW_REMOTE` 的认证绕过语义。首选直接删除该自定义开关，远程可达性交由 DSH 的监听地址、`trustedHosts`、TLS 和 Connection 所有者认证控制，并在升级说明中记录这一行为变化。
5. 若维护者决定暂时保留该变量，它只能作为额外的远程部署限制，任何取值都不能跳过 Connection 认证；实现前必须说明在标准 Fetch Request 上如何取得可靠的部署信息，不得再依赖不可用的原始 socket 字段。

完成条件：正常卡片可以通过已认证 Connection 工作；匿名、跨站和非所有者请求在业务处理器之前被拒绝；完整 key 没有任何回读路径。

### WP2：usage cache 生命周期（0.25–0.5 人日）

任务：

1. 将 cache 收入 Host install 的所有权域，通过参数传给 usage 查询，不再留下无清理责任的模块级秘密 Map。
2. cache 键改为 `keyId(key)`，值只保存时间戳和 usage details；完整 key 只存在单次调用的局部作用域。
3. 每次 usage 刷新先淘汰过期项，并删除不在当前 key id 集合中的项。
4. manager 新增、删除或替换凭据后清空相关 cache；无法精确判定影响范围时允许清空全部 usage cache。
5. Host effect disposer 清空本实例 cache。若施工时使用 `credentials/reference-updated`，先通过 Event Inspect 核对签名，再注册由 Host effect 持有的监听。
6. 保持 60 秒命中策略、`minFetchedAt` 配额恢复约束和账户/密钥用量字段不变。

完成条件：cache 不以完整秘密为键，过期和移除项可释放，凭据变化与 Host 卸载均能失效对应缓存。

### WP3：保留取消身份并区分超时（0.5–0.75 人日）

任务：

1. 重构 `combineSignals`：调用者取消使用 `exec.signal.reason` 传播；自身计时器使用独立的超时原因。
2. 在 `callOperation` 捕获 `AbortError` 时，先检查 `exec.signal.aborted`。调用者已取消则原样抛出其 reason，不得创建普通 Error。
3. 自身超时必须带稳定代码 `TAVILY_TIMEOUT`，不得伪装成调用者取消。若使用 HarnessError，先核对当前安装的构造签名和错误码投影。
4. 在 `probeOldestBlocked` 的 catch 中执行同样的取消判断；取消和自身超时不得被“quota-blocked probe failed”普通错误覆盖。
5. 每次 failover 尝试前检查 `exec.signal`，取消后不再尝试下一个 key。
6. API 401/429/432/433、其他 HTTP 错误和状态文件错误保持原有业务分类；结构化 HarnessError 改造不扩大到无关错误面。

新增测试：

- 正常请求取消与调用者传入的 reason 一致。
- 自身超时返回 `TAVILY_TIMEOUT`，不归类为调用者 ABORTED。
- 普通 failover 和配额探测两条路径都保留取消。
- 取消后不再发出第二次 Tavily 请求。
- 请求结束后清理计时器和 abort listener。

完成条件：工具管线能把调用者取消识别为 ABORTED，自身超时仍是独立错误，且没有额外 key 尝试。

### WP4：状态文件读取失败不再静默重置（0.5–0.75 人日）

任务：

1. 为 manager state 增加严格读取路径，不再复用“所有错误都返回 fallback”的通用 JSON 读取。
2. 只有 `ENOENT` 返回初始状态；JSON 损坏、根值不是对象、权限错误和其他 I/O 错误必须显式失败。
3. 建议错误码：
   - `TAVILY_STATE_INVALID`：文件存在但内容或根结构无效。
   - `TAVILY_STATE_READ_FAILED`：权限或其他读取失败。
4. 错误消息包含状态文件路径和原始错误码，不包含文件内容或凭据。
5. `setMode`、`setEnabled`、`recordQuotaBlock` 和 `clearQuotaBlock` 在严格读取失败后停止，不得进入 `writeState`。manager POST 必须在任何 `credentials.set/unset` 之前完成状态读取预检；预检失败不得写凭据或状态。
6. 保留现有临时文件加 rename 的原子写入。旧版 `tavily-settings.json` 的日期迁移仍可 best-effort，但不能让旧文件异常重置现行 manager state。
7. 文档说明人工恢复方式：先保留损坏文件，排查权限或格式；确认备份后再移走损坏文件并重建状态。第一期不自动覆盖或删除它。

完成条件：缺失文件行为不变；损坏或不可读文件不会被后续操作静默覆盖，管理界面和工具得到可诊断错误。

### WP5：文档、集成验证和发布（0.75–1.25 人日）

1. 更新根 README：Connection 认证、远程部署、删除 reveal、body 上限、状态错误和最低 DSH 版本。
2. 更新兼容性声明，说明 `TAVILY_MANAGER_ALLOW_REMOTE` 的删除或新语义。
3. 新增整改验收记录，逐项填写测试命令、提交、证据和未覆盖项。
4. 运行 `npm run check`、`npm run build`、`npm test`，确认生成的 `lib/client.js` 与 `src/client.js` 一致。
5. 通过 plugin_manager 安装当前工作区 bundle，检查 `application` 和 warnings；不能只看进程或日志判断成功。
6. 在新会话用 Tool Inspect 核对四个 Tavily 工具，用 Client Slots Inspect 核对插件卡片，再在浏览器验证增删、替换、排序、启停、调用顺序和 usage 刷新。
7. 使用测试凭据完成验证，恢复测试前状态。真实 Tavily 请求若未执行，必须写入未覆盖项。

## 4. 文件级改动清单

| 文件 | 本期改动 |
| --- | --- |
| `src/index.js` | 注入 Connection；调整 Host effect；移除不再需要的 WebServer 依赖 |
| `src/backend.js` | Node req/res 改为 Fetch Request/Response；流式 body 上限；删除 reveal 和远程绕过；cache 所有权与清理；usage 请求取消 |
| `src/client.js` | 删除完整 key 显示功能和对应状态、图标、请求；保持其他管理流程 |
| `src/tools.js` | caller cancellation 与自身超时分离；修复普通和 quota probe 路径；failover 前检查取消 |
| `src/state.js` | manager state 严格读取；非 ENOENT 错误 fail-fast；保留原子写入 |
| `src/lib.js` | 必要时拆分严格 JSON 读取与旧文件 best-effort 读取，避免改变无关调用语义 |
| `test/manager.test.js` | 改为 Fetch route 测试；增加认证边界夹具、413/400/415/405、无 reveal、凭据写入失败保护 |
| `test/entries.test.js` | Connection 注册与异步卸载；更新 Host inject；保持双入口和重挂载验证 |
| `test/priority.test.js` 或新增 `test/cancellation.test.js` | caller reason、timeout、quota probe、停止 failover 和 listener 清理 |
| `test/state.test.js` | 将“损坏文件回退默认”改为“报错且不覆盖”；增加权限/I/O 错误和成功读写回归 |
| `test/build.test.js` | 保持生成 Client 一致性检查 |
| `package.json` | 对齐已验证 DSH 依赖和兼容声明；按实际新增脚本或测试文件调整 |
| `README.md` 与相关文档 | 行为变化、升级步骤、验证结果和未覆盖项 |
| `lib/client.js` | 仅由现有 build 脚本重新生成，不手工编辑 |

## 5. 测试与验收矩阵

### 5.1 安全和协议

- 匿名或无效凭据请求得到 401/403，业务处理器不执行。
- 非所有者 Peer 得到 403。
- 正常已认证卡片可以完成所有保留操作。
- `reveal` 参数不再返回完整 key；所有响应扫描不到测试 key 原文。
- 小于等于 64 KiB 的有效请求正常，超过限制返回 413；固定长度和流式未知长度都覆盖。
- 非法 JSON、错误媒体类型和非法方法分别返回约定状态码。
- 远程开关无论是否存在，都不能绕过 DSH 认证。

### 5.2 cache

- 同一 fingerprint 在 TTL 内复用结果。
- TTL 到期后删除旧项，而不是仅判定未命中。
- 删除、替换凭据和 Host 卸载后，旧项不可继续命中。
- cache 键和值不包含完整 key。

### 5.3 取消

- 普通调用和 quota probe 均保留调用者 reason。
- timeout 与 ABORTED 可区分。
- 取消后没有后续 key 请求，计时器和监听器被释放。
- native 与 PTC 至少各有一条经过实际工具管线的取消验证；无法完成时明确记录。

### 5.4 状态安全

- 文件不存在仍创建默认状态。
- 损坏 JSON、非法根结构、权限和模拟 I/O 错误均显式失败。
- 失败后原文件字节不变，manager POST 不写凭据或部分状态。
- 正常模式、启停、配额阻断和恢复逻辑保持既有行为。

### 5.5 回归和生命周期

- 四个工具仍使用 defineTool 和 canonical output。
- Host / preset 双入口、单份管理路由、多个 preset 独立 round-robin cursor 不变。
- 内置 `web_search` / `web_fetch` 提供方不被修改。
- 卸载和重载后无重复路由、残留 cache 或未结束的 Host 请求；Client 组件卸载取消在后续独立工作包验收。
- 完整语法、构建和测试命令通过。

## 6. 工期与顺序

| 顺序 | 工作包 | 人日 |
| --- | --- | ---: |
| 1 | WP0 基线和兼容范围 | 0.25–0.5 |
| 2 | WP1 Connection、reveal 和 body | 1.25–2 |
| 3 | WP2 usage cache | 0.25–0.5 |
| 4 | WP3 取消和超时 | 0.5–0.75 |
| 5 | WP4 状态文件 | 0.5–0.75 |
| 6 | WP5 文档、集成和发布 | 0.75–1.25 |
| 预留 | 联调、异步释放和浏览器问题缓冲 | 0.5–1 |
| **合计** |  | **4–7** |

WP2、WP3、WP4 可以在 WP1 的接口夹具稳定后并行，但由同一施工者修改共享文件时仍按顺序合入，避免测试夹具和生成文件互相覆盖。

如需保留旧 DSH 版本兼容，另加 1–3 人日，并先提交适配设计；不能把该时间消耗挤入 WP1 而不调整验收范围。

## 7. 发布和回滚

发布前：

1. 保存当前 commit、插件版本、启用状态和 profile 组合。
2. 备份 `~/.dsh/tavily-manager.json`；该文件按现有设计不含秘密。不得把 `.credentials.yaml` 或真实 key 复制到工作区。
3. 说明远程管理行为变化以及 reveal 删除是有意的用户可见变化。
4. 通过 plugin_manager 安装并检查应用结果，在新会话验收。

回滚：

1. 使用 plugin_manager 恢复上一插件版本，不手工编辑 profile 文件。
2. 本期不改变 manager state 文件格式和凭据存储格式，因此正常状态可直接由旧版本读取。
3. 若回滚原因是状态文件损坏或不可读，先保留该文件并修复权限；旧版本存在静默回退行为，不能直接在原文件上启动旧版并执行写操作。
4. 回滚后重新验证管理卡片、四个工具和路由释放；远程认证配置不会随插件回滚自动撤销。

## 8. 后续独立工作包

以下事项不计入本期 4–7 人日：

1. 输出预算：限制 extract/crawl 的 `rawContent` 和总 canonical/render 大小；在结构化值中标记截断，不直接截断 JSON 字符串。
2. Client 请求卸载取消：组件卸载时 abort fetch，并用请求序号避免旧响应覆盖新状态；Host 启动 key 检查同样纳入 effect 取消。
3. Client locale：通过 `ctx.locale` 注册字典并替换全部可见硬编码文本，未翻译语言使用 English fallback。
4. 工具 `when`：无 key 时按 model step 隐藏工具，同时让 prompt 根据已准入工具集变化；条件抛错会导致 `TOOL_ACTIVATION_FAILED`，需单独设计错误策略。
5. storageDomain：先提交 Domain owner、共享 Service、异步写入、数据迁移和回滚设计。
6. Remote 多密钥凭据模型：只有在不再使用单个逗号分隔引用，或有安全的多密钥 Host 协议时再评估。
7. WebSearchProvider / WebFetchProvider：属于产品集成选择，不是本次缺陷修复。

上述后续事项合计可预留 3–5 人日；storageDomain、Remote 多密钥重设计和 Web Provider 不在该估算内。

## 9. Definition of Done

- [x] WP0–WP5 全部完成，偏差（`POST /api/tavily-manager/update` 流式路径拆分）已写入验收记录。
- [x] 管理路由全部经过 Connection 所有者认证，reveal 和认证绕过不存在。
- [x] 64 KiB 实际上限经过流式和固定长度测试。
- [x] usage cache 不持有完整 key，过期、凭据变化和卸载清理有效。
- [x] 普通与 quota probe 路径保留取消，timeout 独立（`TAVILY_TIMEOUT`），并经真实 native 工具管线验证。
- [x] 状态文件非 ENOENT 读取失败不会导致默认状态覆盖原文件。
- [x] 全部自动化检查通过（`npm run build`、`npm run check`、`npm test` 89/89），生成 Client 一致。
- [x] 隔离 DSH `0.2.2-rc.5` 环境已通过 `pluginManager/installBundle` 安装并核对 `application: "applied"` 与零 warnings；实机 `web` profile 安装与新会话 Tool/Slot Inspect 留待发布窗口人工核对（已记入验收记录未覆盖项）。
- [ ] 实机浏览器保留功能人工点击核对（无自动化浏览器控制，已记入验收记录未覆盖项）。
- [x] README、兼容声明、升级说明和验收记录已更新。
- [x] 真实 Tavily、PTC 沙箱取消、代理、桌面端及实机浏览器未覆盖项已明确列出。
- [x] 回滚步骤可执行，工作树只包含预期改动。

## 10. 施工记录

| 工作包 | 提交 / 结果 | 验证证据 | 状态 |
| --- | --- | --- | --- |
| WP0 | `f9f750b`：冻结 `442c99c` 基线，依赖与兼容范围对齐 DSH `0.2.2-rc.5` / Cordis `4.1.0`，修订 WP1.1 路由拆分契约，建立 `0.9.0` 验收草案 | 本机 DSH `0.2.2-rc.5`、8 个核心文件 SHA-256 与 `~/.dsh-local-plugins/dsh-tavily` 一致；`npm run check`、`npm test` 69/69 通过 | 已完成 |
| WP1 | `6372b1a`：管理路由迁入 `ctx.connection.fetch`（`GET /api/tavily-manager`、`POST /api/tavily-manager/update`、`GET /api/tavily-usage`），实施流式 64 KiB body 上限，移除 `reveal` 与 `TAVILY_MANAGER_ALLOW_REMOTE`，重建 `lib/client.js` | `npm run build`、`npm run check`、`npm test` 72/72 通过（含真实 `dsh-client-connection` 认证、非 owner 403、流式 413、异步卸载重挂载测试） | 已完成 |
| WP2 | `ff505ff`：usage cache 收拢至 Host 安装域，改用 `keyId` 指纹键，刷新前淘汰过期与已删除项，凭据变更、`credentials/reference-updated` 与 Host 卸载均清空 | `npm run check`、`npm test` 75/75 通过 | 已完成 |
| WP3 | `cf9507a`：重构 `combineSignals` 传播调用者 `exec.signal.reason`，区分 `HarnessError(..., 'TAVILY_TIMEOUT')`，修复 failover 与 `probeOldestBlocked` 取消路径及资源清理 | `npm run check`、`npm test` 82/82 通过（含真实 `ToolsService` + `NativeToolExecutor` 管线 `ABORTED` vs `TAVILY_TIMEOUT` 验证） | 已完成 |
| WP4 | `90b95c4`：新增严格 JSON 对象读取，非 `ENOENT` 失败抛 `TAVILY_STATE_INVALID` / `TAVILY_STATE_READ_FAILED`，POST 预检阻止写凭据，绝不覆写损坏/不可读原文件 | `npm run check`、`npm test` 86/86 通过 | 已完成 |
| WP5 | 版本号升至 `0.9.0`，更新 `README.md`、`docs/0.9.0-acceptance.md`、`docs/README.md` 与本文，重建 `lib/client.js` | `npm run build`、`npm run check`、`npm test` 86/86、`npm pack --dry-run` 与隔离 DSH `0.2.2-rc.5` `pluginManager/installBundle` 端到端冒烟全部通过 | 已完成 |
| 审阅补修 | 本提交：合并异步凭据写入期间的状态更新，Host 卸载取消在途 usage 并阻止迟到写入，failover 取消可重试响应体；新增 3 项回归 | `npm run build`、`npm run check`、`npm test` 89/89、`npm pack --dry-run`；未重复隔离 DSH 冒烟 | 已完成 |
