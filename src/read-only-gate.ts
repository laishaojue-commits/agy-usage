import { bt } from './i18n.js';

export const READ_ONLY_BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  'account_switch',
  'account_switch_rollback',
  'account_recovery_clear',
  'account_save_current',
  'account_import_json',
  'account_export_backup',
  'account_upsert',
  'account_rename',
  'account_delete',
  'account_reorder',
  'account_oauth_begin',
  'account_oauth_status',
  'account_oauth_cancel',
  'account_add_token_start',
  'auto_switch_set',
  'auto_switch_execute',
  'maintenance_smart_clear',
  'maintenance_clear',
  'maintenance_restore',
  'api_pricing_revalue',
  'api_pricing_revalue_rollback',
]);

export function resolveReadOnlyMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  const raw = env.GRAVITYBOX_READ_ONLY?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return platform === 'win32';
}

export function isReadOnlyBlockedRequest(
  parsed: { command?: unknown; execute?: unknown } | null | undefined,
  readOnlyMode: boolean
): boolean {
  if (!readOnlyMode || !parsed) return false;
  const command = typeof parsed.command === 'string' ? parsed.command.trim() : '';
  if (READ_ONLY_BLOCKED_COMMANDS.has(command)) return true;
  if (command === 'auto_switch_best' && parsed.execute === true) return true;
  return false;
}

export function readOnlyBlockedError(command: string): {
  ok: false;
  code: 'READ_ONLY_UNSUPPORTED';
  error: string;
} {
  return {
    ok: false,
    code: 'READ_ONLY_UNSUPPORTED',
    error: bt('main.read_only_unsupported', { command }),
  };
}
