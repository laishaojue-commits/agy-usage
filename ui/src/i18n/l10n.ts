import zhHansPack from '../../../assets/i18n/zh-Hans.json';

export type ResolvedLocale = 'zh-Hans';

interface RawI18nPack {
  meta?: { code?: string };
  app?: Record<string, string>;
  backend?: Record<string, string>;
}

const pack = zhHansPack as RawI18nPack;

/**
 * Pure local Simplified Chinese MCP App UI strings supplementing assets/i18n/zh-Hans.json.
 */
const UI_STRINGS: Record<string, string> = {
  'win.brand_sub_mcp': '纯本地只读 · 零凭据零外联',
  'win.nav.context': '上下文',
  'win.nav.storage': '存储体检',
  'win.overview.mcp_direct_title': 'agy-usage-tool · 纯本地只读模式',
  'win.overview.mcp_direct_meta': '纯本地只读 · 零凭据零外联 · 仅读取本地 SQLite 对话账本与缓存目录',
  'win.overview.total_tokens_short': '累计 {tokens} Token',
  'win.overview.total_requests_short': '累计 {count} 次',
  'win.overview.view_details': '查看详情',
  'win.usage.cache_saved': '缓存节省约 {saved}',
  'usage.period.session': '本对话',
  'usage.trend_title.session': '本对话趋势',
  'usage.trend_title.scoped_conv': '单对话趋势',
  'win.usage.session_conv_label': '当前统计对话',
  'win.usage.all_conv_label': '对话范围',
  'win.usage.all_conv_option': '全部对话',
  'win.usage.account_filter': '账号筛选',
  'win.usage.dim_tokens': 'Token',
  'win.usage.dim_requests': '请求',
  'win.usage.pricing_title': '内置模型定价基准',
  'win.usage.pricing_meta': '基准版本 {version} · 已收录 {count} 款模型',
  'win.usage.pricing_never': '纯本地内置基准',
  'win.usage.log_title': '请求明细流水',
  'win.usage.log_col_time': '时间',
  'win.usage.log_col_model': '模型',
  'win.usage.log_col_tokens': '输入 / 缓存 / 输出',
  'win.usage.log_col_total': '总 Token',
  'win.usage.log_col_cost': '等效费用',
  'win.usage.log_search': '按模型过滤…',
  'win.usage.log_prev': '上一页',
  'win.usage.log_next': '下一页',
  'win.chart.hover_model_tokens': '{label} · {model} · {tokens} Token',
  'win.chart.hover_model_requests': '{label} · {model} · {count} 次请求',
  'win.chart.hover_zero_tokens': '{label} · 0 Token',
  'win.chart.hover_zero_requests': '{label} · 0 次请求',
  'win.chart.peak_tokens': '峰值：{label} · {tokens} Token',
  'win.chart.peak_requests': '峰值：{label} · {count} 次请求',
  'win.storage.title': '存储体检',
  'win.storage.readonly_banner_title': '纯本地只读模式：清理写入已锁定保护',
  'win.storage.readonly_banner_body': '当前 agy-usage-tool 运行在纯本地只读安全门禁模式：支持安全扫描缓存分布与受保护白名单核验；清理、还原及账号切号等高风险写入操作已在后端安全锁拦截（READ_ONLY_UNSUPPORTED）。',
  'win.storage.scan_btn': '重新扫描',
  'win.storage.scanning_btn': '扫描中…',
  'win.storage.scanning_title': '正在扫描本地缓存与受保护目录…',
  'win.storage.scanning_sub': '只读巡检正在统计各缓存分区与对话留存占用，请稍候。',
  'win.storage.retention_label': '日志观察窗口',
  'win.storage.reclaimable_preview': '可释放预览（已锁定）',
  'win.storage.categories_title': '缓存与日志扫描明细',
  'win.storage.protected_title': '受保护核心数据白名单',
  'win.storage.locked_badge': '只读已锁定',
  'win.storage.running_warn': '检测到 Antigravity 正在运行',
  'win.settings.theme_title': '界面外观主题',
  'win.settings.theme_sub': '支持自动跟随系统浅色/深色主题或手动切换预览',
  'win.settings.theme_system': '跟随系统',
  'win.settings.theme_light': '浅色模式',
  'win.settings.theme_dark': '深色模式',
  'win.settings.general_title': '界面与偏好',
  'win.settings.security_title': '只读安全边界与本地隔离',
  'win.settings.readonly_label': '只读安全门禁',
  'win.settings.readonly_mcp_on': '已开启（纯本地只读 · 不读取 OAuth 凭据、不修改外部文件）',
  'win.settings.readonly_off': '已关闭',
  'win.settings.data_isolation_title': '本地偏好隔离',
  'win.settings.data_isolation_sub': '仅在插件独立数据目录保存外观主题（ui-prefs.json），不暴露本机绝对路径',
  'win.settings.data_isolation_badge': '已隔离',
  'win.about.title': '关于与诊断',
  'win.about.mcp_subtitle': 'agy-usage-tool · 纯本地只读 Antigravity 用量与存储分析插件',
  'win.about.diag_title': '运行环境自检',
  'win.about.mode_label': '运行模式',
  'win.about.mode_mcp_sub': 'MCP App 纯本地只读（仅扫描本地 SQLite 用量账本与缓存目录，零进程探测）',
  'win.about.node_memory_label': 'Node 引擎与内存',
  'win.about.gate_label': '只读安全门禁',
  'win.about.mcp_badge': '纯本地只读',
  'win.about.gate_mcp_enforced': 'READ_ONLY=1 · 不读取 OAuth 凭据、不请求云端配额接口',
  'win.about.gate_disabled': '未强制开启',
  'win.about.license_title': '开源许可与上游致谢',
  'win.about.license_body': '基于 MIT License 开源协议发布。致谢上游项目 Enzoo404/gravitybox（v1.1.3, MIT）提供的本地 SQLite 账本引擎、上下文 HUD 遥测与多模型费率模型。',
  'win.about.copy_diag': '复制诊断摘要',
  'win.about.copied': '已复制诊断摘要',
  'win.common.loading': '正在加载…',
  'win.common.service_offline': '未连接到本机后台服务',
  'win.common.retry': '重试',
  'win.common.enabled': '已开启',
  'win.common.empty': '暂无数据',
  'win.context.title': '上下文监控',
  'win.context.subtitle': '主对话上下文窗口水位与 Swarm 子智能体独立监控',
  'win.context.card_title': '当前对话上下文',
  'win.context.capacity_label': '上下文容量',
  'win.context.avg_cache_hit': '平均缓存命中率',
  'win.context.latest_cache_hit': '最近一步命中率',
  'win.context.ref_capacity_tip': '参考模型上限（底层数据库未显式下发上下文阈值）',
  'win.context.explicit_capacity_tip': '底层数据库显式上报的上下文容量阈值',
  'win.context.compacted_badge': '已压缩 {count} 次',
  'win.context.cached_read': '缓存复用',
  'win.context.new_input': '新增输入',
  'win.context.latest_output': '本步输出',
  'win.context.peak_context': '历史峰值',
  'win.context.total_tokens': '累计 Token',
  'win.context.steps': '步数',
  'win.context.est_cost': '估算费用',
  'win.context.role_planner': '规划',
  'win.context.role_executor': '执行',
  'win.context.role_active': '当前',
  'win.context.role_pending': '待介入',
  'win.context.pending_executor': '待切换执行模型',
  'win.context.pending_planner': '待介入规划模型',
  'win.context.pending_model': '未知模型',
  'win.context.stages_orchestrator': 'Orchestrator 规划 / 执行阶段',
  'win.context.stages_multi': '多模型 / 曾用模型上下文',
  'win.context.select_conversation': '选择对话',
  'win.context.auto_track': '自动追踪最新活跃',
  'win.context.jump_active': '切至最新活跃',
  'win.context.pinned_badge': '已固定本对话',
  'win.context.status_running': '运行中',
  'win.context.status_waiting': '待命中',
  'win.context.status_completed': '已结束',
  'win.context.status_killed': '已关闭',
  'win.context.swarm_title': 'Swarm / 子智能体独立水位',
  'win.context.swarm_count_badge': '{count} 成员',
  'win.context.swarm_running_badge': '{count} 运行中',
  'win.context.swarm_waiting_badge': '{count} 待命',
  'win.context.swarm_completed_toggle': '已结束成员 ({count})',
  'win.context.swarm_no_active': '当前无运行中或待命成员，已结束成员默认折叠收纳在下方。',
  'win.context.swarm_totals_title': '整场协作总消耗汇总',
  'win.context.swarm_totals_note': '上下文水位按成员独立计算，消耗按整场协作汇总',
  'win.context.swarm_members_scale': '协作成员',
  'win.context.swarm_total_steps': '总步数',
  'win.context.swarm_cache_hit': '综合缓存命中率',
  'win.context.empty_title': '暂无本地对话上下文数据',
  'win.context.empty_sub': '当本地存在 Antigravity 对话数据库时，将自动解析主对话与 Swarm 成员上下文水位。',
};

export function getLocale(): ResolvedLocale {
  return 'zh-Hans';
}

export function t(
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
  fallback?: string
): string {
  const template =
    pack.app?.[key] ??
    UI_STRINGS[key] ??
    pack.backend?.[key] ??
    fallback ??
    key;

  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const val = params[name];
    return val === null || val === undefined ? '' : String(val);
  });
}
