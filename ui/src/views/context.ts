import type {
  ConversationContextSnapshot,
  ConversationContextSummaryItem,
} from '../api/types';
import {
  renderContextWindowCard,
  renderModelStagesCard,
  renderSwarmMembersSection,
  renderSwarmTotalsBar,
  statusBadgeTone,
  statusLabelKey,
} from '../components/context-card';
import { t } from '../i18n/l10n';
import { escapeHtml, formatRelativeAgeShort } from '../utils/format';

export function renderContextView(state: {
  conversations: ConversationContextSummaryItem[];
  recommendedId: string | null;
  selectedConversationId: string | null;
  autoTrack: boolean;
  snapshot: ConversationContextSnapshot | null;
  showCompleted: boolean;
  expandedMemberId: string | null;
  loading: boolean;
  busyAction: string | null;
}): string {
  const {
    conversations,
    recommendedId,
    selectedConversationId,
    autoTrack,
    snapshot,
    showCompleted,
    expandedMemberId,
    loading,
    busyAction,
  } = state;

  const activeConvId = selectedConversationId || snapshot?.conversationId || recommendedId || '';
  const showJumpToActive = Boolean(
    recommendedId && activeConvId && recommendedId !== activeConvId
  );

  const optionsHtml =
    conversations.length > 0
      ? conversations
          .map((conv) => {
            const dot = conv.status === 'running' ? '●' : conv.status === 'waiting' ? '◐' : '○';
            const age = formatRelativeAgeShort(conv.lastActiveAt);
            const swarmPart =
              conv.childCount > 0
                ? ` · ${t('win.context.swarm_count_badge', { count: conv.childCount })}`
                : '';
            return `<option value="${escapeHtml(conv.conversationId)}" ${
              conv.conversationId === activeConvId ? 'selected' : ''
            }>${escapeHtml(`${dot} ${conv.title} · ${age}${swarmPart}`)}</option>`;
          })
          .join('')
      : `<option value="">${escapeHtml(t('win.common.empty'))}</option>`;

  const currentStatus = snapshot?.status ?? 'completed';
  const statusBadgeCls = statusBadgeTone(currentStatus);
  const statusBadgeClassName =
    statusBadgeCls === 'accent' ? 'gb-badge' : `gb-badge ${statusBadgeCls}`;

  return `
    <div class="gb-view-header">
      <div>
        <h1 class="gb-view-title">${escapeHtml(t('win.context.title'))}</h1>
        <p class="gb-view-sub">${escapeHtml(t('win.context.subtitle'))}</p>
      </div>
      <div class="gb-header-actions">
        ${
          showJumpToActive
            ? `<button class="gb-btn sm" data-action="context-jump-active">${escapeHtml(
                t('win.context.jump_active')
              )}</button>`
            : ''
        }
        <button
          class="gb-btn sm ${autoTrack ? 'primary' : ''}"
          data-action="context-toggle-auto"
          aria-pressed="${autoTrack ? 'true' : 'false'}"
        >
          ${escapeHtml(t('win.context.auto_track'))}
        </button>
        <button
          class="gb-btn sm"
          data-action="context-refresh"
          ${busyAction === 'context' ? 'disabled' : ''}
        >
          ${escapeHtml(t('common.refresh'))}
        </button>
      </div>
    </div>

    <div class="gb-card gb-ctx-toolbar">
      <div class="gb-ctx-toolbar-select-wrap">
        <label class="gb-muted-text" for="gb-ctx-conv-select">${escapeHtml(
          t('win.context.select_conversation')
        )}</label>
        <select
          id="gb-ctx-conv-select"
          class="gb-select gb-ctx-select"
          data-context-conversation
          aria-label="${escapeHtml(t('win.context.select_conversation'))}"
        >
          ${optionsHtml}
        </select>
      </div>
      ${
        snapshot?.available
          ? `<div class="gb-ctx-toolbar-meta">
              <span class="${statusBadgeClassName}">
                <span class="gb-ctx-dot ${escapeHtml(currentStatus)}"></span>
                <span>${escapeHtml(t(statusLabelKey(currentStatus)))}</span>
              </span>
              <span class="gb-muted-text">${escapeHtml(
                formatRelativeAgeShort(snapshot.lastActiveAt)
              )}</span>
            </div>`
          : ''
      }
    </div>

    ${renderContextWindowCard(snapshot, { compact: false, loading })}

    ${renderModelStagesCard(snapshot)}

    ${renderSwarmMembersSection(snapshot, { showCompleted, expandedMemberId })}

    ${renderSwarmTotalsBar(snapshot)}
  `;
}
