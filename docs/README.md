# 文档索引

用户手册在仓库根目录的 [README](../README.md)。本目录保存设计依据、验收记录、DSH 版本兼容性核对和整改施工计划。

| 文档 | 状态 | 内容 |
| --- | --- | --- |
| [0.7.0 验收记录](./0.7.0-acceptance.md) | 现行 | 双入口交付形态、自动化与组合检查、运行实例证据、验收结论、未覆盖项与回滚 |
| [0.2.2-alpha.3 兼容性核对](./0.2.2-alpha.3-compatibility.md) | 现行 | 0.7.1 / 0.8.0 对 DSH 0.2.2-alpha.3 的契约核对、验证结果与未覆盖项 |
| [0.2.2-rc.2 兼容性核对](./0.2.2-rc.2-compatibility.md) | 现行 | 0.8.0 对 DSH 0.2.2-rc.2 的契约核对与 rc.2 引入的行为变化 |
| [rc.3 之后未发布提交的兼容性核对](./post-rc.3-compatibility.md) | 现行 | 0.8.0 对 DSH rc.3 之后 608 个未发布提交的核对；结论为 WebServer 路由认证门禁构成破坏 |
| [Host / preset 分离施工计划](./preset-separation-upgrade-plan.md) | 历史 | 升级前的设计依据与施工步骤；正文保留计划阶段判断，实际差异以验收记录为准 |
| [DSH 规范整改施工计划](./dsh-doc-remediation-plan.md) | 施工中 | 基于 0.2.2-rc.5 的 Connection 管理路由、usage cache、取消语义和状态文件整改；包含验收、发布与回滚 |
| [0.9.0 验收记录](./0.9.0-acceptance.md) | 草案 | 0.9.0 规范整改基线、0.2.2-rc.5 契约核对、验证边界与验收结果 |

0.7.0 已验收通过。0.7.1 保持 Host / preset 双入口与工具行为不变，补充 0.2.2 版本声明，删除失效的 `./invariant` 出口，并校正卡片位置文案。0.8.0 增加 8 种语言的插件元数据，把两条管理路由默认限制为回环访问，并把开发依赖对齐到 0.2.2-alpha.3。当前 `web` profile 中，`standard-instant`、`ptc-instant`、`cordis-ptc` 三个 preset 挂载 `@moguiyu/dsh-tavily/tools`；`chat-assistant` 已废弃，不挂载；Host 行只提供管理卡片与两条管理路由。
