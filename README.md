<div align="center">
  <img src="./assets/master-1024.png" width="96" height="96" alt="agy-usage-tool 图标" />
  <h1>agy-usage-tool</h1>
  <p><strong>Antigravity 本地用量、上下文水位与存储体检面板</strong></p>
  <p>纯本地读取 SQLite 对话账本 —— 今天消耗多少 Token、当前上下文剩多少、子智能体各自跑到哪一步，一目了然。</p>
  <p><img src="./assets/readme-badges.svg" width="440" alt="v0.1.0 · 纯本地只读 · Node.js 22.15+ · MIT License" /></p>
  <p>
    <a href="#界面预览">界面预览</a> ·
    <a href="#快速安装">快速安装</a> ·
    <a href="#核心能力">核心能力</a> ·
    <a href="#v010-更新说明">v0.1.0 更新</a> ·
    <a href="https://github.com/laishaojue-commits/agy-usage-tool/releases">Releases</a>
  </p>
</div>

---

## 界面预览

<a href="./assets/screenshots/overview.png">
  <img src="./assets/screenshots/overview.png" width="100%" alt="总览：今日 Token、估算费用、当前对话上下文与活跃模型" />
</a>

<table>
  <tr>
    <th width="50%">上下文与双阶段水位</th>
    <th width="50%">分模型用量与趋势流水</th>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="./assets/screenshots/context.png"><img src="./assets/screenshots/context.png" width="100%" alt="上下文监控面板" /></a>
      <p>独立追踪主对话、Orchestrator 规划/执行阶段与 Swarm 子智能体各自上下文窗口及压缩次数。</p>
    </td>
    <td width="50%" valign="top">
      <a href="./assets/screenshots/usage.png"><img src="./assets/screenshots/usage.png" width="100%" alt="用量分析面板" /></a>
      <p>按今日 / 7 天 / 30 天 / 全部聚合分模型堆叠趋势、缓存命中率、费用占比环形图与单次请求明细。</p>
    </td>
  </tr>
</table>

---

## 核心能力

| 面板视图 | 它帮你看什么 |
| :--- | :--- |
| **总览** | 今日与累计 Token、等效估算费用、请求次数、当前对话水位卡片与 24 小时模型分布 |
| **上下文** | 主对话上下文窗口与缓存命中率、Orchestrator 规划/执行阶段拆解、Swarm 成员独立水位与总消耗 |
| **用量** | 多周期分模型堆叠柱状图（Token / 请求数切换）、费用占比环形图、可搜索翻页的请求流水表 |
| **存储体检** | 只读统计运行缓存与对话历史体积、受保护核心数据白名单（严禁任何删除或修改外部文件） |
| **安全边界** | 零外网请求、零 OAuth 凭据读取、零进程/调试端口探测，仅在插件独立目录保存外观主题 |

> **说明**：所有统计均在本机离线完成，面板中的金额基于公开 API 单价做参考估算，并非实际账单；安全实现细节可查阅 [SECURITY.md](./SECURITY.md)。

---

## 快速安装

> 需要 **Antigravity** 与 **Node.js ≥ 22.15.0**（终端执行 `node -v` 可输出版本号即可，ZIP 与源码安装均依赖本机 Node.js）。

### 方式一：下载 Release 压缩包

1. 前往 [Releases](https://github.com/laishaojue-commits/agy-usage-tool/releases) 下载 **`agy-usage-tool-v0.1.0.zip`**。
2. 解压到对应系统的 Antigravity 插件目录，确保打开该目录就能看到 **`plugin.json`**：

   | 操作系统 | 插件目录 |
   | :--- | :--- |
   | **Windows** | `%USERPROFILE%\.gemini\config\plugins\agy-usage-tool\` |
   | **macOS / Linux** | `~/.gemini/config/plugins/agy-usage-tool/` |

3. 打开 Antigravity 插件管理页启用 **agy-usage-tool**，随后可在左侧导航栏或辅助侧栏 **`+`** 菜单打开面板。

<details>
<summary><strong>方式二：从源码构建并安装到本机</strong></summary>

```sh
git clone https://github.com/laishaojue-commits/agy-usage-tool.git
cd agy-usage-tool
npm ci --ignore-scripts
npm run plugin:install
```

同一插件暂存目录下请勿并发执行多个安装命令；安装完成后在 Antigravity 插件页启用即可。

</details>

<details>
<summary><strong>升级与 Windows 目录占用处理</strong></summary>

1. 先在 Antigravity 插件管理页 **停用**旧插件（从旧名 `agy-usage` 升级时建议先停用并删除旧目录），让 MCP `node` 进程释放文件锁。
2. **不要直接覆盖解压**：请将旧插件目录整体移出 `plugins/` 备份后再放入新版，避免旧模块残留。
3. 若 Windows 仍提示文件被占用，完全退出 Antigravity 后完成目录替换再重新打开。
4. 主题偏好保存在独立数据目录（`ui-prefs.json`），替换程序目录不会影响个人偏好。

</details>

---

## v0.1.0 更新说明

- **统一插件命名与版本**：项目、插件清单、MCP 服务/工具入口（`open_agy_usage_tool` / `agy_usage_tool_ipc`）与发布包统一更名为 **`agy-usage-tool`**，版本号定为 **`v0.1.0`**，安装器会自动清理旧版 `agy-usage` / `gravitybox` 目录或摘除其清单。
- **修复 Orchestrator 规划/执行阶段识别与幽灵 `—` 槽位**：
  - 改为升序折叠全部 `executor_metadata` 记录，避免进入执行阶段后丢失初始规划模型配对；
  - 引入 `exit_plan_mode` / `enter_plan_mode` 阶段状态机，准确区分同轮内的规划模型与执行模型；
  - 增加纯本地 `modelEnum` 自学习注册并补齐内置枚举映射表，彻底消除未识别执行模型时多出的 `—` 占位行，未启动阶段改用清晰中文提示。
- **纯简体中文轻量化精简**：移除英文包、设置页语言切换及上游桌面端残留的千余条无效词条，大幅缩减单文件 `mcp-app.html` 体积，同时将设置页无效的 `--` 路径占位替换为清晰的本地隔离说明。
- **工程与目录清理**：移除过时历史备份目录与冗余文档，补充上下文阶段与跨版本升级自动化回归测试。

---

## 本地开发与许可

<details>
<summary><strong>构建、测试与打包命令</strong></summary>

```sh
npm ci --ignore-scripts
npm --prefix ui ci --ignore-scripts
npm --prefix plugin ci --omit=dev --ignore-scripts
npm test
npm run plugin:zip -- --rebuild
npm run check:privacy -- --include-build
```

打包产物与校验摘要输出在 `artifacts/`（含 `agy-usage-tool-v0.1.0.zip` 与 `SHA256SUMS.txt`）。

</details>

本项目基于 [MIT License](./LICENSE)（Copyright © 2026 Enzoo404）开源。致谢上游项目 [Enzoo404/gravitybox](https://github.com/Enzoo404/gravitybox)（`v1.1.3`）提供的本地 SQLite 用量分析、上下文统计与定价核心模块，第三方署名与免责说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
