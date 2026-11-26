import type {
  ContextCapacitySource,
  ConversationContextSnapshot,
  ConversationRunStatus,
  SwarmMemberContextSnapshot,
} from '../api/types';
import { t } from '../i18n/l10n';
import {
  escapeHtml,
  formatContextPercent,
  formatContextTokens,
  formatInt,
  formatRelativeAgeShort,
  renderModelIcon,
} from '../utils/format';

export function contextBarTone(usedRatio: number): 'normal' | 'warn' | 'danger' {
  if (!Number.isFinite(usedRatio) || usedRatio < 0.7) return 'normal';
  if (usedRatio <= 0.88) return 'warn';
  return 'danger';
}

export function formatCapacityDisplay(
  capacityTokens: number,
  capacityTokensCompact: string | undefined,
  capacitySource: ContextCapacitySource | undefined
): string {
  const base = capacityTokensCompact?.trim() || formatContextTokens(capacityTokens);
  if (capacitySource && capacitySource !== 'explicit') {
    return base.startsWith('~') ? base : `~${base}`;
  }
  return base.replace(/^~/, '');
}

export function statusLabelKey(status: ConversationRunStatus, killed = false): string {
  if (status === 'running') return 'win.context.status_running';
  if (status === 'waiting') return 'win.context.status_waiting';
  if (killed) return 'win.context.status_killed';
  return 'win.context.status_completed';
}

export function statusBadgeTone(status: ConversationRunStatus): 'accent' | 'warn' | 'neutral' {
  if (status === 'running') return 'accent';
  if (status === 'waiting') return 'warn';
  return 'neutral';
}

function activeRoleLabel(snapshot: ConversationContextSnapshot): string {
  const activeStage = snapshot.main.modelStages?.find((s) => s.isActive);
  if (activeStage?.role === 'planner') return t('win.context.role_planner');
  if (activeStage?.role === 'executor') return t('win.context.role_executor');
  return '';
}

function renderCapacityReadout(opts: {
  usedTokens: number;
  usedTokensCompact?: string;
  capacityTokens: number;
  capacityTokensCompact?: string;
  capacitySource?: ContextCapacitySource;
  usedRatio: number;
  usedRatioFormatted?: string;
}): { readoutHtml: string; capacityTip: string } {
  const usedStr = opts.usedTokensCompact?.trim() || formatContextTokens(opts.usedTokens);
  const capStr = formatCapacityDisplay(
    opts.capacityTokens,
    opts.capacityTokensCompact,
    opts.capacitySource
  );
  const ratioStr = opts.usedRatioFormatted?.trim() || formatContextPercent(opts.usedRatio);
  const isRef = opts.capacitySource !== 'explicit';
  const capacityTip = t(
    isRef ? 'win.context.ref_capacity_tip' : 'win.context.explicit_capacity_tip'
  );
  const capHtml = isRef
    ? `<span class="gb-ctx-cap-ref" title="${escapeHtml(capacityTip)}">${escapeHtml(capStr)}</span>`
    : `<span>${escapeHtml(capStr)}</span>`;
  return {
    readoutHtml: `<span class="gb-ctx-readout gb-num">${escapeHtml(usedStr)} / ${capHtml} <span class="gb-ctx-pct">(${escapeHtml(ratioStr)})</span></span>`,
    capacityTip,
  };
}

export function renderContextWindowCard(
  snapshot: ConversationContextSnapshot | null | undefined,
  options?: { compact?: boolean; loading?: boolean }
): string {
  const compact = options?.compact === true;
  const loading = options?.loading === true;

  if (!snapshot || !snapshot.available) {
    if (compact) {
      return `
        <div class="gb-card gb-ctx-card gb-ctx-card-compact" data-context-card="compact">
          <div class="gb-card-header" style="margin-bottom:8px">
            <div class="gb-ctx-title-wrap">
              <span class="gb-card-title">${escapeHtml(t('win.context.card_title'))}</span>
            </div>
            <button class="gb-btn sm ghost" data-nav="context">${escapeHtml(t('win.overview.view_details'))} →</button>
          </div>
          <div class="gb-muted-text">${escapeHtml(loading ? t('win.common.loading') : t('win.context.empty_sub'))}</div>
        </div>
      `;
    }
    return `
      <div class="gb-card gb-ctx-card" data-context-card="full">
        <div class="gb-empty-box">
          <div style="font-weight:600;color:var(--text-primary);margin-bottom:4px">${escapeHtml(
            loading ? t('win.common.loading') : t('win.context.empty_title')
          )}</div>
          <div>${escapeHtml(t('win.context.empty_sub'))}</div>
        </div>
      </div>
    `;
  }

  const m = snapshot.main;
  const tone = contextBarTone(m.usedRatio);
  const fillPct = m.hasUsageData ? Math.min(100, Math.max(2, m.usedRatio * 100)) : 0;
  const roleTag = activeRoleLabel(snapshot);
  const modelLabel = m.modelShortLabel || m.modelDisplayName;
  const showModelBadge = Boolean(modelLabel && modelLabel !== '—');
  const { readoutHtml } = renderCapacityReadout({
    usedTokens: m.usedTokens,
    usedTokensCompact: m.usedTokensCompact,
    capacityTokens: m.capacityTokens,
    capacityTokensCompact: m.capacityTokensCompact,
    capacitySource: m.capacitySource,
    usedRatio: m.usedRatio,
    usedRatioFormatted: m.usedRatioFormatted,
  });

  const compactionBadgeHtml =
    m.compactionCount > 0
      ? `<span class="gb-badge warn">${escapeHtml(
          t('win.context.compacted_badge', { count: m.compactionCount })
        )}</span>`
      : '';

  const swarmSummaryPill =
    snapshot.swarmTotals && Number.isSafeInteger(snapshot.swarmTotals.memberCount) && snapshot.swarmTotals.memberCount > 0
      ? `<span class="gb-badge ${
          snapshot.swarmTotals.runningCount > 0
            ? ''
            : snapshot.swarmTotals.waitingCount > 0
              ? 'warn'
              : 'neutral'
        }">Swarm · ${escapeHtml(snapshot.swarmTotals.memberCount)}</span>`
      : '';

  const compactHeaderHtml = compact
    ? `
      <div class="gb-ctx-compact-header">
        <div class="gb-ctx-title-wrap">
          <span class="gb-ctx-dot ${escapeHtml(snapshot.status)}"></span>
          <span class="gb-card-title">${escapeHtml(t('win.context.card_title'))}</span>
          <span class="gb-ctx-conv-pill" title="${escapeHtml(snapshot.title)}">${escapeHtml(snapshot.title)}</span>
          ${swarmSummaryPill}
        </div>
        <button class="gb-btn sm ghost" data-nav="context">${escapeHtml(t('win.overview.view_details'))} →</button>
      </div>
    `
    : '';

  const fullBreakdownHtml = !compact
    ? `
      <div class="gb-ctx-breakdown-grid">
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.cached_read'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(m.breakdown.cachedContextCompact)}</span>
        </div>
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.new_input'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(m.breakdown.uncachedContextCompact)}</span>
        </div>
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.latest_output'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(m.breakdown.latestOutputCompact)}</span>
        </div>
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.peak_context'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(m.peakContextCompact)}</span>
        </div>
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.latest_cache_hit'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(m.latestStepCacheHitRateFormatted)}</span>
        </div>
      </div>
      <div class="gb-ctx-main-footer-meta">
        <span>${escapeHtml(t('win.context.total_tokens'))}: <strong class="gb-num">${escapeHtml(
          snapshot.mainTokens.totalTokensCompact
        )}</strong></span>
        <span>${escapeHtml(t('win.context.steps'))}: <strong class="gb-num">${escapeHtml(
          formatInt(snapshot.steps)
        )}</strong></span>
        ${
          snapshot.mainTokens.estimatedCostFormatted
            ? `<span>${escapeHtml(t('win.context.est_cost'))}: <strong class="gb-num">${escapeHtml(
                snapshot.mainTokens.estimatedCostFormatted
              )}</strong></span>`
            : ''
        }
      </div>
    `
    : '';

  return `
    <div class="gb-card gb-ctx-card ${compact ? 'gb-ctx-card-compact' : ''}" data-context-card="${
      compact ? 'compact' : 'full'
    }">
      ${compactHeaderHtml}
      <div class="gb-ctx-meter-head">
        <div class="gb-ctx-meter-label-group">
          <span class="gb-ctx-meter-label">${escapeHtml(t('win.context.capacity_label'))}</span>
          ${
            showModelBadge
              ? `<span class="gb-badge neutral gb-ctx-model-badge" title="${escapeHtml(m.modelDisplayName)}">
                  ${renderModelIcon(m.modelId || m.modelDisplayName, 14)}
                  <span>${escapeHtml(compact ? modelLabel : m.modelDisplayName)}</span>
                </span>`
              : ''
          }
          ${roleTag ? `<span class="gb-badge">${escapeHtml(roleTag)}</span>` : ''}
          ${compactionBadgeHtml}
        </div>
        ${readoutHtml}
      </div>

      <div class="gb-ctx-track ${compact ? 'sm' : ''}">
        <div class="gb-ctx-fill ${tone}" style="width:${fillPct}%"></div>
      </div>

      <div class="gb-ctx-cache-row">
        <span class="gb-ctx-cache-label">${escapeHtml(t('win.context.avg_cache_hit'))}</span>
        <span class="gb-ctx-cache-val gb-num">${escapeHtml(m.averageCacheHitRateFormatted)}</span>
      </div>

      ${fullBreakdownHtml}
    </div>
  `;
}

export function renderModelStagesCard(
  snapshot: ConversationContextSnapshot | null | undefined
): string {
  const stages = snapshot?.main.modelStages;
  if (!snapshot?.available || !stages || stages.length < 2) return '';

  const title = snapshot.main.isOrchestrator
    ? t('win.context.stages_orchestrator')
    : t('win.context.stages_multi');

  return `
    <div class="gb-card">
      <div class="gb-card-header">
        <span class="gb-card-title">${escapeHtml(title)}</span>
      </div>
      <div class="gb-ctx-stages-list">
        ${stages
          .map((stage) => {
            const roleLabel =
              stage.role === 'planner'
                ? t('win.context.role_planner')
                : stage.role === 'executor'
                  ? t('win.context.role_executor')
                  : '';
            const tone = contextBarTone(stage.usedRatio);
            const fillPct = stage.hasUsageData
              ? Math.min(100, Math.max(2, stage.usedRatio * 100))
              : 0;
            const capStr = formatCapacityDisplay(
              stage.capacityTokens,
              stage.capacityTokensCompact,
              stage.capacitySource
            );
            const stageUsed = stage.hasUsageData
              ? stage.usedTokensCompact || formatContextTokens(stage.usedTokens)
              : '0';
            const isPendingPlaceholder =
              stage.modelId === 'pending' ||
              stage.modelId === 'unknown' ||
              stage.modelDisplayName === '—' ||
              !(stage.modelDisplayName || stage.shortLabel);
            const stageLabel = isPendingPlaceholder
              ? stage.role === 'executor'
                ? t('win.context.pending_executor')
                : stage.role === 'planner'
                  ? t('win.context.pending_planner')
                  : t('win.context.pending_model')
              : stage.modelDisplayName || stage.shortLabel;
            return `
              <div class="gb-ctx-stage-row ${stage.isActive ? 'active' : ''}">
                <div class="gb-ctx-stage-top">
                  <div class="gb-ctx-stage-name">
                    ${renderModelIcon(stage.modelId || stage.modelDisplayName || stageLabel, 15)}
                    <span>${escapeHtml(stageLabel)}</span>
                    ${roleLabel ? `<span class="gb-badge neutral">${escapeHtml(roleLabel)}</span>` : ''}
                    ${stage.isActive ? `<span class="gb-badge">${escapeHtml(t('win.context.role_active'))}</span>` : ''}
                    ${!stage.hasUsageData && !isPendingPlaceholder ? `<span class="gb-badge neutral">${escapeHtml(t('win.context.role_pending'))}</span>` : ''}
                    ${
                      stage.compactionCount && stage.compactionCount > 0
                        ? `<span class="gb-badge warn">${escapeHtml(
                            t('win.context.compacted_badge', { count: stage.compactionCount })
                          )}</span>`
                        : ''
                    }
                  </div>
                  <span class="gb-ctx-stage-readout gb-num">${escapeHtml(stageUsed)} / ${escapeHtml(
                    capStr
                  )} (${escapeHtml(stage.usedRatioFormatted)})</span>
                </div>
                <div class="gb-ctx-track sm">
                  <div class="gb-ctx-fill ${tone}" style="width:${fillPct}%"></div>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderSwarmMemberRow(
  member: SwarmMemberContextSnapshot,
  expanded: boolean
): string {
  const c = member.context;
  const tone = contextBarTone(c.usedRatio);
  const fillPct = c.hasUsageData ? Math.min(100, Math.max(2, c.usedRatio * 100)) : 0;
  const { readoutHtml } = renderCapacityReadout({
    usedTokens: c.usedTokens,
    usedTokensCompact: c.usedTokensCompact,
    capacityTokens: c.capacityTokens,
    capacityTokensCompact: c.capacityTokensCompact,
    capacitySource: c.capacitySource,
    usedRatio: c.usedRatio,
    usedRatioFormatted: c.usedRatioFormatted,
  });
  const statusText = t(statusLabelKey(member.status, member.killed));
  const badgeTone = statusBadgeTone(member.status);
  const badgeCls = badgeTone === 'accent' ? '' : badgeTone;
  const modelText = c.modelDisplayName && c.modelDisplayName !== '—'
    ? c.modelShortLabel || c.modelDisplayName
    : '';

  const detailsHtml = expanded
    ? `
      <div class="gb-ctx-member-detail">
        <div class="gb-ctx-member-detail-grid">
          <div class="gb-ctx-stat">
            <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.cached_read'))}</span>
            <span class="gb-ctx-stat-val gb-num">${escapeHtml(formatContextTokens(member.tokens.cachedReadTokens))}</span>
          </div>
          <div class="gb-ctx-stat">
            <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.new_input'))}</span>
            <span class="gb-ctx-stat-val gb-num">${escapeHtml(formatContextTokens(member.tokens.uncachedInputTokens))}</span>
          </div>
          <div class="gb-ctx-stat">
            <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.peak_context'))}</span>
            <span class="gb-ctx-stat-val gb-num">${escapeHtml(c.peakContextCompact)}</span>
          </div>
          <div class="gb-ctx-stat">
            <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.total_tokens'))}</span>
            <span class="gb-ctx-stat-val gb-num">${escapeHtml(member.tokens.totalTokensCompact)}</span>
          </div>
          <div class="gb-ctx-stat">
            <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.steps'))}</span>
            <span class="gb-ctx-stat-val gb-num">${escapeHtml(formatInt(member.steps))}</span>
          </div>
          <div class="gb-ctx-stat">
            <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.est_cost'))}</span>
            <span class="gb-ctx-stat-val gb-num">${escapeHtml(member.tokens.estimatedCostFormatted || '--')}</span>
          </div>
        </div>
      </div>
    `
    : '';

  return `
    <div class="gb-ctx-member-item ${expanded ? 'expanded' : ''}" data-context-member-row="${escapeHtml(
      member.conversationId
    )}">
      <button
        type="button"
        class="gb-ctx-member-btn"
        data-context-member="${escapeHtml(member.conversationId)}"
        aria-expanded="${expanded ? 'true' : 'false'}"
      >
        <div class="gb-ctx-member-top">
          <div class="gb-ctx-member-ident">
            <span class="gb-ctx-dot ${escapeHtml(member.status)}"></span>
            <span class="gb-ctx-member-name">${escapeHtml(member.displayName)}</span>
            <span class="gb-badge ${badgeCls}">${escapeHtml(statusText)}</span>
            ${
              modelText
                ? `<span class="gb-badge neutral" title="${escapeHtml(c.modelDisplayName)}">
                    ${renderModelIcon(c.modelId || c.modelDisplayName, 13)}
                    <span>${escapeHtml(modelText)}</span>
                  </span>`
                : ''
            }
            ${
              member.compactionCount > 0
                ? `<span class="gb-badge warn">${escapeHtml(
                    t('win.context.compacted_badge', { count: member.compactionCount })
                  )}</span>`
                : ''
            }
          </div>
          <div class="gb-ctx-member-right">
            ${readoutHtml}
            <span class="gb-badge neutral gb-num" title="${escapeHtml(t('win.context.avg_cache_hit'))}">
              ${escapeHtml(member.tokens.cacheHitRateFormatted)}
            </span>
            <span class="gb-ctx-chevron">${expanded ? '▾' : '▸'}</span>
          </div>
        </div>
        <div class="gb-ctx-track sm">
          <div class="gb-ctx-fill ${tone}" style="width:${fillPct}%"></div>
        </div>
        <div class="gb-ctx-member-sub">
          <span>${escapeHtml(formatRelativeAgeShort(member.lastActiveAt))}</span>
          <span class="gb-num">${escapeHtml(member.tokens.totalTokensCompact)} tok · ${escapeHtml(
            formatInt(member.steps)
          )} ${escapeHtml(t('win.context.steps'))}</span>
        </div>
      </button>
      ${detailsHtml}
    </div>
  `;
}

export function renderSwarmMembersSection(
  snapshot: ConversationContextSnapshot | null | undefined,
  options?: { showCompleted?: boolean; expandedMemberId?: string | null }
): string {
  const members = snapshot?.members ?? [];
  if (!snapshot?.available || members.length === 0) return '';

  const showCompleted = options?.showCompleted === true;
  const expandedMemberId = options?.expandedMemberId ?? null;
  const activeMembers = members.filter(
    (m) => m.status === 'running' || m.status === 'waiting'
  );
  const completedMembers = members.filter((m) => m.status === 'completed');

  const runningCount = activeMembers.filter((m) => m.status === 'running').length;
  const waitingCount = activeMembers.filter((m) => m.status === 'waiting').length;

  return `
    <div class="gb-card" data-context-swarm>
      <div class="gb-card-header">
        <div class="gb-ctx-title-wrap">
          <span class="gb-card-title">${escapeHtml(t('win.context.swarm_title'))}</span>
          <span class="gb-badge neutral">${escapeHtml(
            t('win.context.swarm_count_badge', { count: snapshot.swarmTotals?.memberCount ?? members.length })
          )}</span>
        </div>
        <div class="gb-header-actions">
          ${
            runningCount > 0
              ? `<span class="gb-badge">${escapeHtml(
                  t('win.context.swarm_running_badge', { count: runningCount })
                )}</span>`
              : ''
          }
          ${
            waitingCount > 0
              ? `<span class="gb-badge warn">${escapeHtml(
                  t('win.context.swarm_waiting_badge', { count: waitingCount })
                )}</span>`
              : ''
          }
        </div>
      </div>

      ${
        activeMembers.length > 0
          ? `<div class="gb-ctx-members-list">
              ${activeMembers
                .map((m) => renderSwarmMemberRow(m, expandedMemberId === m.conversationId))
                .join('')}
            </div>`
          : `<div class="gb-muted-text" style="margin-bottom:10px">${escapeHtml(
              t('win.context.swarm_no_active')
            )}</div>`
      }

      ${
        completedMembers.length > 0
          ? `
            <div class="gb-ctx-completed-wrap">
              <button
                type="button"
                class="gb-btn sm ghost gb-ctx-completed-toggle"
                data-action="context-toggle-completed"
                aria-expanded="${showCompleted ? 'true' : 'false'}"
              >
                <span>${escapeHtml(
                  t('win.context.swarm_completed_toggle', { count: completedMembers.length })
                )}</span>
                <span>${showCompleted ? '▾' : '▸'}</span>
              </button>
              ${
                showCompleted
                  ? `<div class="gb-ctx-members-list" style="margin-top:8px">
                      ${completedMembers
                        .map((m) => renderSwarmMemberRow(m, expandedMemberId === m.conversationId))
                        .join('')}
                    </div>`
                  : ''
              }
            </div>
          `
          : ''
      }
    </div>
  `;
}

export function renderSwarmTotalsBar(
  snapshot: ConversationContextSnapshot | null | undefined
): string {
  const totals = snapshot?.swarmTotals;
  if (!snapshot?.available || !totals) return '';

  return `
    <div class="gb-card gb-ctx-totals-card" data-context-swarm-totals>
      <div class="gb-card-header" style="margin-bottom:10px">
        <span class="gb-card-title">${escapeHtml(t('win.context.swarm_totals_title'))}</span>
        <span class="gb-muted-text">${escapeHtml(t('win.context.swarm_totals_note'))}</span>
      </div>
      <div class="gb-ctx-totals-grid">
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.total_tokens'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(totals.totalTokensCompact)}</span>
        </div>
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.swarm_total_steps'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(formatInt(totals.totalSteps))}</span>
        </div>
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.swarm_cache_hit'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(totals.cacheHitRateFormatted)}</span>
        </div>
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.est_cost'))}</span>
          <span class="gb-ctx-stat-val gb-num">${escapeHtml(totals.estimatedCostFormatted || '--')}</span>
        </div>
        <div class="gb-ctx-stat">
          <span class="gb-ctx-stat-label">${escapeHtml(t('win.context.swarm_members_scale'))}</span>
          <span class="gb-ctx-stat-val gb-num">1 + ${escapeHtml(formatInt(totals.memberCount))}</span>
        </div>
      </div>
    </div>
  `;
}
