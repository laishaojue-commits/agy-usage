import enPack from '../../../assets/i18n/en.json';
import zhHansPack from '../../../assets/i18n/zh-Hans.json';

export type ResolvedLocale = 'zh-Hans' | 'en';
export type ConfiguredLanguage = 'system' | 'zh-Hans' | 'en';

interface RawI18nPack {
  meta?: { code?: string };
  app?: Record<string, string>;
  backend?: Record<string, string>;
}

const packs: Record<ResolvedLocale, RawI18nPack> = {
  'zh-Hans': zhHansPack as RawI18nPack,
  en: enPack as RawI18nPack,
};

/**
 * Pure local MCP App UI strings supplementing assets/i18n/*.json.
 */
const UI_OVERLAY: Record<ResolvedLocale, Record<string, string>> = {
  'zh-Hans': {
    'win.brand_sub_mcp': '纯本地只读 · 零凭据零外联',
    'win.nav.context': '上下文',
    'win.nav.storage': '存储体检',
    'win.overview.mcp_direct_title': 'agy-usage · 纯本地只读模式',
    'win.overview.mcp_direct_meta': '纯本地只读 · 零凭据零外联 · 仅读取本地 SQLite 对话账本与缓存目录',
    'win.overview.total_tokens_short': '累计 {tokens} Token',
    'win.overview.total_requests_short': '累计 {count} 次',
    'win.overview.view_details': '查看详情',
    'win.usage.cache_saved': '缓存节省约 {saved}',
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
    'win.storage.readonly_banner_body': '当前 agy-usage 运行在纯本地只读安全门禁模式：支持安全扫描缓存分布与受保护白名单核验；清理、还原及账号切号等高风险写入操作已在后端安全锁拦截（READ_ONLY_UNSUPPORTED）。',
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
    'win.settings.language_local_sub': '决定 agy-usage 插件面板的显示语言',
    'win.settings.security_title': '只读安全边界与本地目录',
    'win.settings.readonly_label': '只读安全门禁',
    'win.settings.readonly_mcp_on': '已开启（纯本地只读 · 不读取 OAuth 凭据、不修改外部文件）',
    'win.settings.readonly_off': '已关闭',
    'win.settings.plugin_data_dir': 'agy-usage 数据目录',
    'win.about.title': '关于与诊断',
    'win.about.mcp_subtitle': 'agy-usage · 纯本地只读 Antigravity 用量与存储分析插件（基于 GravityBox 引擎）',
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
    'win.context.stages_orchestrator': 'Orchestrator 规划 / 执行阶段',
    'win.context.stages_multi': '多模型 / 曾用模型上下文',
    'win.context.select_conversation': '选择对话',
    'win.context.auto_track': '自动追踪最新活跃',
    'win.context.jump_active': '回到最新活跃',
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
  },
  en: {
    'win.brand_sub_mcp': 'Pure Local Read-Only',
    'win.nav.context': 'Context',
    'win.nav.storage': 'Storage',
    'win.overview.mcp_direct_title': 'agy-usage · Pure Local Read-Only',
    'win.overview.mcp_direct_meta': 'Pure local read-only · Zero credentials & zero outbound calls · Reads local SQLite & cache dirs only',
    'win.overview.total_tokens_short': 'Total {tokens} tokens',
    'win.overview.total_requests_short': 'Total {count}',
    'win.overview.view_details': 'Details',
    'win.usage.cache_saved': 'Est. {saved} saved by cache',
    'win.usage.account_filter': 'Account',
    'win.usage.dim_tokens': 'Tokens',
    'win.usage.dim_requests': 'Requests',
    'win.usage.pricing_title': 'Built-in Pricing Baseline',
    'win.usage.pricing_meta': 'Baseline {version} · {count} models indexed',
    'win.usage.pricing_never': 'Local Built-in Baseline',
    'win.usage.log_title': 'Request Log',
    'win.usage.log_col_time': 'Time',
    'win.usage.log_col_model': 'Model',
    'win.usage.log_col_tokens': 'Input / Cached / Output',
    'win.usage.log_col_total': 'Total',
    'win.usage.log_col_cost': 'Est. Cost',
    'win.usage.log_search': 'Filter by model…',
    'win.usage.log_prev': 'Previous',
    'win.usage.log_next': 'Next',
    'win.chart.hover_model_tokens': '{label} · {model} · {tokens} tokens',
    'win.chart.hover_model_requests_one': '{label} · {model} · {count} request',
    'win.chart.hover_model_requests_other': '{label} · {model} · {count} requests',
    'win.chart.hover_zero_tokens': '{label} · 0 tokens',
    'win.chart.hover_zero_requests': '{label} · 0 requests',
    'win.chart.peak_tokens': 'Peak: {label} · {tokens} tokens',
    'win.chart.peak_requests_one': 'Peak: {label} · {count} request',
    'win.chart.peak_requests_other': 'Peak: {label} · {count} requests',
    'win.storage.title': 'Storage Check',
    'win.storage.readonly_banner_title': 'Pure Local Read-Only Mode: Cleanup writes are locked for safety',
    'win.storage.readonly_banner_body': 'Pure local read-only inspection is active: cache breakdown and protected allowlists are scanned safely, while destructive clean/restore and account switching remain blocked (READ_ONLY_UNSUPPORTED).',
    'win.storage.scan_btn': 'Rescan',
    'win.storage.scanning_btn': 'Scanning…',
    'win.storage.scanning_title': 'Scanning local caches & protected directories…',
    'win.storage.scanning_sub': 'Read-only inspection is measuring cache buckets and protected storage.',
    'win.storage.retention_label': 'Log Window',
    'win.storage.reclaimable_preview': 'Reclaimable Preview (Locked)',
    'win.storage.categories_title': 'Cache & Log Inspection',
    'win.storage.protected_title': 'Protected Core Data Allowlist',
    'win.storage.locked_badge': 'Read-Only Locked',
    'win.storage.running_warn': 'Antigravity is currently running',
    'win.settings.theme_title': 'Appearance Theme',
    'win.settings.theme_sub': 'Automatically follows host/system Light/Dark mode or preview manually',
    'win.settings.theme_system': 'Follow System',
    'win.settings.theme_light': 'Light',
    'win.settings.theme_dark': 'Dark',
    'win.settings.general_title': 'Preferences',
    'win.settings.language_local_sub': 'Sets display language for the agy-usage plugin panel',
    'win.settings.security_title': 'Read-Only Boundary & Directories',
    'win.settings.readonly_label': 'Read-Only Gate',
    'win.settings.readonly_mcp_on': 'Enforced (pure local read-only · no OAuth credential reads or file writes)',
    'win.settings.readonly_off': 'Disabled',
    'win.settings.plugin_data_dir': 'agy-usage Data Dir',
    'win.about.title': 'About & Diagnostics',
    'win.about.mcp_subtitle': 'agy-usage · Pure Local Read-Only Usage & Storage Plugin (GravityBox Engine)',
    'win.about.diag_title': 'Runtime Self-Check',
    'win.about.mode_label': 'Runtime Mode',
    'win.about.mode_mcp_sub': 'MCP App pure local read-only (scans local SQLite ledger & cache dirs only, zero process probing)',
    'win.about.node_memory_label': 'Node Engine & Memory',
    'win.about.gate_label': 'Read-Only Gate',
    'win.about.mcp_badge': 'Local Read-Only',
    'win.about.gate_mcp_enforced': 'READ_ONLY=1 · Does not read OAuth credentials or call cloud quota APIs',
    'win.about.gate_disabled': 'Not enforced',
    'win.about.license_title': 'License & Upstream Attribution',
    'win.about.license_body': 'Released under the MIT License. Built on top of upstream Enzoo404/gravitybox (v1.1.3, MIT) local SQLite usage ledger, context HUD telemetry, and pricing engine.',
    'win.about.copy_diag': 'Copy Diagnostics',
    'win.about.copied': 'Diagnostics copied',
    'win.common.loading': 'Loading…',
    'win.common.service_offline': 'Local backend service offline',
    'win.common.retry': 'Retry',
    'win.common.enabled': 'Enabled',
    'win.common.empty': 'No data',
    'win.context.title': 'Context Window',
    'win.context.subtitle': 'Main conversation context watermark & independent Swarm subagent monitors',
    'win.context.card_title': 'Current Conversation Context',
    'win.context.capacity_label': 'Context Capacity',
    'win.context.avg_cache_hit': 'Average Cache Hit Rate',
    'win.context.latest_cache_hit': 'Latest Step Cache',
    'win.context.ref_capacity_tip': 'Reference model capacity (no explicit context limit reported in DB)',
    'win.context.explicit_capacity_tip': 'Explicit context capacity reported by local DB',
    'win.context.compacted_badge': '{count}x compacted',
    'win.context.cached_read': 'Cached Read',
    'win.context.new_input': 'New Uncached',
    'win.context.latest_output': 'Latest Output',
    'win.context.peak_context': 'Peak Context',
    'win.context.total_tokens': 'Total Tokens',
    'win.context.steps': 'Steps',
    'win.context.est_cost': 'Est. Cost',
    'win.context.role_planner': 'Planner',
    'win.context.role_executor': 'Executor',
    'win.context.role_active': 'Active',
    'win.context.stages_orchestrator': 'Orchestrator Plan & Execute Stages',
    'win.context.stages_multi': 'Multi-Model / Prior Contexts',
    'win.context.select_conversation': 'Conversation',
    'win.context.auto_track': 'Auto-track Active',
    'win.context.jump_active': 'Jump to Active',
    'win.context.status_running': 'Running',
    'win.context.status_waiting': 'Waiting',
    'win.context.status_completed': 'Completed',
    'win.context.status_killed': 'Killed',
    'win.context.swarm_title': 'Swarm / Subagent Independent Watermarks',
    'win.context.swarm_count_badge': '{count} members',
    'win.context.swarm_running_badge': '{count} running',
    'win.context.swarm_waiting_badge': '{count} waiting',
    'win.context.swarm_completed_toggle': 'Completed Members ({count})',
    'win.context.swarm_no_active': 'No running or waiting members right now; completed members are collapsed below.',
    'win.context.swarm_totals_title': 'Swarm Collaboration Totals',
    'win.context.swarm_totals_note': 'Context window levels are tracked independently per member; total usage and cost are summed across the swarm.',
    'win.context.swarm_members_scale': 'Members',
    'win.context.swarm_total_steps': 'Total Steps',
    'win.context.swarm_cache_hit': 'Combined Cache Hit',
    'win.context.empty_title': 'No Local Conversation Context Yet',
    'win.context.empty_sub': 'Main conversation and Swarm member context watermarks will appear once local Antigravity conversation DBs exist.',
  },
};

export function resolveConfiguredLocale(configured: string | undefined | null): ResolvedLocale {
  const norm = String(configured ?? '').trim().toLowerCase();
  if (norm === 'en' || norm.startsWith('en-')) return 'en';
  if (norm === 'zh' || norm === 'zh-hans' || norm.startsWith('zh-cn') || norm.startsWith('zh-sg') || norm.startsWith('zh-')) {
    return 'zh-Hans';
  }
  const navList =
    typeof navigator !== 'undefined'
      ? [...(navigator.languages ?? []), navigator.language].filter(Boolean)
      : [];
  for (const item of navList) {
    const low = item.toLowerCase();
    if (low.startsWith('zh')) return 'zh-Hans';
    if (low.startsWith('en')) return 'en';
  }
  return 'en';
}

let activeLocale: ResolvedLocale = resolveConfiguredLocale('system');
let configuredLang: ConfiguredLanguage = 'system';

export function getLocale(): ResolvedLocale {
  return activeLocale;
}

export function getConfiguredLanguage(): ConfiguredLanguage {
  return configuredLang;
}

export function setLocalePreference(nextConfigured: string | undefined | null): ResolvedLocale {
  const raw = String(nextConfigured ?? '').trim().toLowerCase();
  if (raw === 'zh-hans' || raw === 'zh' || raw === 'zh-cn') configuredLang = 'zh-Hans';
  else if (raw === 'en' || raw.startsWith('en-')) configuredLang = 'en';
  else configuredLang = 'system';
  activeLocale = resolveConfiguredLocale(configuredLang);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = activeLocale;
  }
  return activeLocale;
}

export function t(
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
  fallback?: string
): string {
  const pack = packs[activeLocale];
  const enBase = packs.en;
  const template =
    pack.app?.[key] ??
    UI_OVERLAY[activeLocale][key] ??
    pack.backend?.[key] ??
    enBase.app?.[key] ??
    UI_OVERLAY.en[key] ??
    enBase.backend?.[key] ??
    fallback ??
    key;

  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const val = params[name];
    return val === null || val === undefined ? '' : String(val);
  });
}
