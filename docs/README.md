# 文档索引

用户手册在仓库根目录的 [README](../README.md)。本目录保存 0.7.0 的设计依据、验收记录与 0.7.1 的版本兼容性核对。

| 文档 | 状态 | 内容 |
| --- | --- | --- |
| [0.7.0 验收记录](./0.7.0-acceptance.md) | 现行 | 双入口交付形态、自动化与组合检查、运行实例证据、验收结论、未覆盖项与回滚 |
| [0.2.2-alpha.3 兼容性核对](./0.2.2-alpha.3-compatibility.md) | 现行 | 0.7.1 对 DSH 0.2.2-alpha.3 的契约核对、验证结果与未覆盖项 |
| [Host / preset 分离施工计划](./preset-separation-upgrade-plan.md) | 历史 | 升级前的设计依据与施工步骤；正文保留计划阶段判断，实际差异以验收记录为准 |

0.7.0 已验收通过。0.7.1 保持 Host / preset 双入口与工具行为不变，补充 0.2.2 版本声明，删除失效的 `./invariant` 出口，并校正卡片位置文案。当前 `web` profile 中，`standard-instant`、`ptc-instant`、`cordis-ptc` 三个 preset 挂载 `@moguiyu/dsh-tavily/tools`；`chat-assistant` 已废弃，不挂载；Host 行只提供管理卡片与两条管理路由。
