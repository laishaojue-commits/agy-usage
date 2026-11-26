# agy-usage-tool Plugin for Antigravity

纯本地、100% 只读的 Antigravity MCP App 插件（支持 `SEP-1865` 与 `com.google.antigravity/ui` 双入口：辅助侧栏 `+` 菜单与左侧主导航），基于本地 SQLite 对话账本与缓存目录进行轻量分析。

## 核心特性（L0 纯本地只读模式）

- **零进程探测 & 零凭据读取**：仅通过 MCP stdio（`node`）在本地只读解析 Antigravity 对话 SQLite 数据库与缓存目录；不启动外置进程探测、不读取 OAuth 凭据、不连接本地调试端口、不发起任何云端请求。
- **6 个核心视图**：`总览`、`上下文`、`用量`、`存储体检`、`设置`、`关于`，聚焦今日 Token、估算费用、请求次数、主对话与 Swarm 子智能体上下文水位（含 Orchestrator 规划/执行双阶段解析）、24 小时分模型趋势与存储分布预览。
- **严格只读门禁**：任何清理或账号变更命令都会被只读门禁直接拦截（`READ_ONLY_UNSUPPORTED` / `PURE_LOCAL_READ_ONLY`）。

## 打开方式

- 辅助侧栏（`aux_pane`）：点击 Antigravity 辅助侧栏的 **`+`**，选择 **agy-usage-tool**。
- 左侧导航（`global`）：在左侧栏点击 **agy-usage-tool** 打开完整面板。

## 从发布 ZIP 升级

1. 先在 Antigravity 插件管理页面 **停用** `agy-usage-tool`（若从旧版 `agy-usage` 升级，请先停用并移除旧版），使运行中的 MCP `node` 进程释放目录占用。
2. 将旧的插件目录整体备份移出插件目录，不要直接覆盖解压，以免旧模块残留在磁盘上。
3. 将新版 ZIP 解压到干净的 `plugins/agy-usage-tool/` 目录（确保 `plugin.json` 位于该目录第一层）。
4. 重新启用 **agy-usage-tool**；界面主题偏好（`ui-prefs.json`）保存在独立数据目录，升级不会丢失。
