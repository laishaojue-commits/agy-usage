import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteReadSnapshot } from './sqlite-read.js';
import {
  BROWSER_PROFILE_SAFE_SUBDIRS,
  BROWSER_TOP_SAFE_SUBDIRS,
  CACHE_NAMES,
  EXTENDED_CACHE_NAMES,
  PARTITION_SAFE_SUBDIRS,
  UUID_REGEX,
  getCacheMetadata,
  isStrictSubpath,
  type CacheItemMetadata,
  type CacheMaintenanceOptions,
  type ConversationIndexSnapshot,
  type InspectedCacheEntry,
  type SubTargetSpec,
} from './maintenance-catalog.js';
import { bt } from './i18n.js';

export interface MaintenanceDiscoveryContext {
  profile: string;
  options: CacheMaintenanceOptions;
  officialAgentDir: () => string | undefined;
  allowedRootDirs: () => string[];
  ensureSafeAncestors: (rootDir: string, targetPath: string) => Promise<void>;
}

export async function inspectPathTree(root: string, deadline: number, counter: { count: number }): Promise<{
  bytes: number;
  fileCount: number;
  lastModifiedAt: number;
  items: string[];
}> {
  const rawItems: Array<{ rel: string; line: string }> = [];
  let bytes = 0;
  let fileCount = 0;
  let lastModifiedAt = 0;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const batch = queue.splice(0, 32);
    await Promise.all(batch.map(async (currentPath) => {
      if (++counter.count > 250000 || Date.now() > deadline) throw Error(bt('maintenance.err.dir_too_large'));
      const s = await lstat(currentPath);
      if (s.isSymbolicLink()) throw Error(bt('maintenance.err.symlink_skipped'));
      if (!s.isDirectory() && !s.isFile()) throw Error(bt('maintenance.err.irregular_file_skipped'));
      const rel = currentPath.slice(root.length);
      rawItems.push({
        rel,
        line: JSON.stringify([rel, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]),
      });
      if (s.mtimeMs > lastModifiedAt) lastModifiedAt = s.mtimeMs;
      if (s.isDirectory()) {
        const children = await readdir(currentPath);
        for (const n of children) queue.push(join(currentPath, n));
      } else {
        bytes += s.size;
        fileCount++;
      }
    }));
  }
  rawItems.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { bytes, fileCount, lastModifiedAt, items: rawItems.map(item => item.line) };
}

export async function inspectSingleProfileItem(ctx: MaintenanceDiscoveryContext, name: string): Promise<InspectedCacheEntry> {
  const meta: CacheItemMetadata = getCacheMetadata(name) ?? {
    title: name,
    subtitle: bt('maintenance.catalog.default.sub', { name }),
    icon: 'folder',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  };
  const root = join(ctx.profile, name);
  const deadline = Date.now() + 8000;
  try {
    const base = await lstat(ctx.profile);
    if (base.isSymbolicLink() || !base.isDirectory()) throw Error(bt('maintenance.err.path_link_skipped'));
    const tree = await inspectPathTree(root, deadline, { count: 0 });
    return {
      name,
      title: meta.title,
      subtitle: meta.subtitle,
      icon: meta.icon,
      category: meta.category,
      section: meta.section ?? 'runtime',
      defaultSelected: meta.defaultSelected,
      ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
      bytes: tree.bytes,
      fileCount: tree.fileCount,
      lastModifiedAt: tree.lastModifiedAt > 0 ? Math.floor(tree.lastModifiedAt / 1000) : 0,
      exists: true,
      clearable: true,
      fingerprint: createHash('sha256').update(tree.items.join('\n')).digest('hex'),
      isSingleLegacyRoot: true,
      subTargets: [{ path: root }],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        name,
        title: meta.title,
        subtitle: meta.subtitle,
        icon: meta.icon,
        category: meta.category,
        section: meta.section ?? 'runtime',
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes: 0,
        fileCount: 0,
        lastModifiedAt: 0,
        exists: false,
        clearable: true,
        fingerprint: 'missing',
        isSingleLegacyRoot: true,
        subTargets: [],
      };
    }
    return {
      name,
      title: meta.title,
      subtitle: meta.subtitle,
      icon: meta.icon,
      category: meta.category,
      section: meta.section ?? 'runtime',
      defaultSelected: meta.defaultSelected,
      ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
      bytes: 0,
      fileCount: 0,
      lastModifiedAt: 0,
      exists: true,
      clearable: false,
      fingerprint: 'blocked',
      reason: (error as Error).message,
      isSingleLegacyRoot: true,
      subTargets: [],
    };
  }
}

export async function inspectMultiTargetItem(
  ctx: MaintenanceDiscoveryContext,
  name: string,
  candidates: SubTargetSpec[],
  options?: { dynamicSubtitle?: string; itemCount?: number }
): Promise<InspectedCacheEntry> {
  const meta: CacheItemMetadata = getCacheMetadata(name) ?? {
    title: name,
    subtitle: name,
    icon: 'folder',
    category: 'safe',
    section: 'runtime',
    defaultSelected: false,
  };
  const subtitle = options?.dynamicSubtitle ?? meta.subtitle;
  if (candidates.length === 0) {
    return {
      name,
      title: meta.title,
      subtitle,
      icon: meta.icon,
      category: meta.category,
      section: meta.section ?? (meta.category === 'stateful' ? 'history' : 'runtime'),
      defaultSelected: meta.defaultSelected,
      ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
      bytes: 0,
      fileCount: 0,
      ...(options?.itemCount !== undefined ? { itemCount: options.itemCount } : {}),
      lastModifiedAt: 0,
      exists: false,
      clearable: true,
      fingerprint: 'missing',
      isSingleLegacyRoot: false,
      subTargets: [],
    };
  }

  const deadline = Date.now() + 12000;
  const counter = { count: 0 };
  const hash = createHash('sha256');
  const activeTargets: SubTargetSpec[] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  let lastModifiedAt = 0;

  try {
    const sorted = [...candidates].sort((a, b) => a.path.localeCompare(b.path));
    for (const spec of sorted) {
      const rootOwner = ctx.allowedRootDirs().find(r => isStrictSubpath(r, spec.path));
      if (!rootOwner) throw Error(bt('maintenance.err.out_of_bounds_skipped'));
      await ctx.ensureSafeAncestors(rootOwner, spec.path);
      try {
        const tree = await inspectPathTree(spec.path, deadline, counter);
        let sidecarBytes = 0;
        let sidecarFiles = 0;
        const sidecarMarks: string[] = [];
        for (const suffix of ['-journal', '-wal', '-shm']) {
          try {
            const sideStat = await lstat(`${spec.path}${suffix}`);
            if (sideStat.isSymbolicLink()) throw Error(bt('maintenance.err.symlink_skipped'));
            if (sideStat.isFile()) {
              sidecarBytes += sideStat.size;
              sidecarFiles += 1;
              if (sideStat.mtimeMs > lastModifiedAt) lastModifiedAt = sideStat.mtimeMs;
              // SQLite readers update SHM read marks. That coordination timestamp is
              // not a change to DB/WAL content; still bind its identity, owner and size.
              sidecarMarks.push(JSON.stringify([suffix, sideStat.dev, sideStat.ino, sideStat.uid,
                sideStat.size, suffix === '-shm' ? null : sideStat.mtimeMs]));
            }
          } catch (sideErr) {
            if ((sideErr as NodeJS.ErrnoException).code !== 'ENOENT') throw sideErr;
          }
        }
        totalBytes += tree.bytes + sidecarBytes;
        totalFiles += tree.fileCount + sidecarFiles;
        if (tree.lastModifiedAt > lastModifiedAt) lastModifiedAt = tree.lastModifiedAt;
        hash.update(`TARGET:${spec.path}\n${tree.items.join('\n')}\nSIDE:${sidecarMarks.join(',')}\n`);
        activeTargets.push(spec);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }

    if (activeTargets.length === 0) {
      return {
        name,
        title: meta.title,
        subtitle,
        icon: meta.icon,
        category: meta.category,
        section: meta.section ?? (meta.category === 'stateful' ? 'history' : 'runtime'),
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes: 0,
        fileCount: 0,
        ...(options?.itemCount !== undefined ? { itemCount: options.itemCount } : {}),
        lastModifiedAt: 0,
        exists: false,
        clearable: true,
        fingerprint: 'missing',
        isSingleLegacyRoot: false,
        subTargets: [],
      };
    }

    return {
      name,
      title: meta.title,
      subtitle,
      icon: meta.icon,
      category: meta.category,
      section: meta.section ?? (meta.category === 'stateful' ? 'history' : 'runtime'),
      defaultSelected: meta.defaultSelected,
      ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
      bytes: totalBytes,
      fileCount: totalFiles,
      ...(options?.itemCount !== undefined ? { itemCount: options.itemCount } : {}),
      lastModifiedAt: lastModifiedAt > 0 ? Math.floor(lastModifiedAt / 1000) : 0,
      exists: totalBytes > 0 || totalFiles > 0,
      clearable: true,
      fingerprint: hash.digest('hex'),
      isSingleLegacyRoot: false,
      subTargets: activeTargets,
    };
  } catch (error) {
    return {
      name,
      title: meta.title,
      subtitle,
      icon: meta.icon,
      category: meta.category,
      section: meta.section ?? (meta.category === 'stateful' ? 'history' : 'runtime'),
      defaultSelected: meta.defaultSelected,
      ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
      bytes: 0,
      fileCount: 0,
      lastModifiedAt: 0,
      exists: true,
      clearable: false,
      fingerprint: 'blocked',
      reason: (error as Error).message,
      isSingleLegacyRoot: false,
      subTargets: [],
    };
  }
}

export async function collectPartitionsCandidates(ctx: MaintenanceDiscoveryContext): Promise<SubTargetSpec[]> {
  const partRoot = join(ctx.profile, 'Partitions');
  const targets: SubTargetSpec[] = [];
  try {
    const st = await lstat(partRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
    const partitions = await readdir(partRoot);
    for (const part of partitions) {
      const partDir = join(partRoot, part);
      const pst = await lstat(partDir).catch(() => null);
      if (!pst || pst.isSymbolicLink() || !pst.isDirectory()) continue;
      for (const sub of PARTITION_SAFE_SUBDIRS) {
        const candidate = join(partDir, sub);
        const cst = await lstat(candidate).catch(() => null);
        if (cst && !cst.isSymbolicLink()) targets.push({ path: candidate });
      }
    }
  } catch {}
  return targets;
}

export async function collectBrowserProfileCandidates(ctx: MaintenanceDiscoveryContext): Promise<SubTargetSpec[]> {
  const agentDir = ctx.officialAgentDir();
  if (!agentDir) return [];
  const bpRoot = join(agentDir, 'browser_profile');
  const targets: SubTargetSpec[] = [];
  try {
    const st = await lstat(bpRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];

    for (const topSub of BROWSER_TOP_SAFE_SUBDIRS) {
      const candidate = join(bpRoot, topSub);
      const cst = await lstat(candidate).catch(() => null);
      if (cst && !cst.isSymbolicLink()) {
        targets.push({ path: candidate });
      }
    }

    const entries = await readdir(bpRoot);
    for (const entry of entries) {
      const isProfileDir =
        entry === 'Default' ||
        entry === 'Guest Profile' ||
        entry === 'System Profile' ||
        /^Profile \d+$/.test(entry);
      if (!isProfileDir) continue;
      const profPath = join(bpRoot, entry);
      const pst = await lstat(profPath).catch(() => null);
      if (!pst || pst.isSymbolicLink() || !pst.isDirectory()) continue;
      for (const sub of BROWSER_PROFILE_SAFE_SUBDIRS) {
        const candidate = join(profPath, sub);
        const cst = await lstat(candidate).catch(() => null);
        if (cst && !cst.isSymbolicLink()) {
          targets.push({ path: candidate });
        }
      }
    }
  } catch {}
  return targets;
}

export async function loadConversationIndex(agentDir: string): Promise<ConversationIndexSnapshot> {
  const summaryMap = new Map<string, { parentId: string; status: string }>();
  const runningTreeIds = new Set<string>();
  const archivedTreeIds = new Set<string>();
  const dbPath = join(agentDir, 'conversation_summaries.db');

  const dbStat = await lstat(dbPath).catch(() => null);
  if (!dbStat || !dbStat.isFile() || dbStat.isSymbolicLink()) {
    return { available: false, summaryMap, runningTreeIds, archivedTreeIds };
  }

  const reader = new SqliteReadSnapshot(dbPath);
  try {
    const sumRes = await reader.query(
      'SELECT conversation_id, parent_conversation_id, status FROM conversation_summaries;'
    );
    if (!sumRes.ok) {
      return { available: false, summaryMap, runningTreeIds, archivedTreeIds };
    }
    for (const row of sumRes.rows) {
      const cid = typeof row.conversation_id === 'string' ? row.conversation_id.trim() : '';
      if (!cid) continue;
      summaryMap.set(cid, {
        parentId: typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.trim() : '',
        status: typeof row.status === 'string' ? row.status.trim() : '',
      });
    }

    const directArchived = new Set<string>();
    const ftsRes = await reader.query(
      'SELECT DISTINCT conversation_id FROM conversations_fts WHERE archived = 1;'
    );
    if (!ftsRes.ok) return { available: false, summaryMap, runningTreeIds, archivedTreeIds };
    if (ftsRes.ok) {
      for (const row of ftsRes.rows) {
        if (typeof row.conversation_id === 'string' && row.conversation_id.trim()) {
          directArchived.add(row.conversation_id.trim());
        }
      }
    }

    // 向上查找祖先链，确保只要树上任一节点处于运行中或已归档，整棵树受保护
    const ancestorsOf = (cid: string): string[] => {
      const chain: string[] = [cid];
      const visited = new Set<string>([cid]);
      let cur = summaryMap.get(cid)?.parentId ?? '';
      while (cur && !visited.has(cur)) {
        visited.add(cur);
        chain.push(cur);
        cur = summaryMap.get(cur)?.parentId ?? '';
      }
      return chain;
    };

    const safeStatuses = new Set(['CASCADE_RUN_STATUS_IDLE', 'CASCADE_RUN_STATUS_DONE', 'CASCADE_RUN_STATUS_COMPLETED', 'CASCADE_RUN_STATUS_CLEARED', 'CASCADE_RUN_STATUS_ERROR', 'CASCADE_RUN_STATUS_CANCELLED', 'CASCADE_RUN_STATUS_CANCELED', 'CASCADE_RUN_STATUS_KILLED']);
    const protectedTree = (seeds: Iterable<string>): Set<string> => {
      const ancestors = new Set<string>();
      for (const seed of seeds) for (const id of ancestorsOf(seed)) ancestors.add(id);
      const protectedIds = new Set<string>();
      for (const cid of summaryMap.keys()) {
        const chain = ancestorsOf(cid);
        if (chain.some(id => ancestors.has(id)) || chain.some(id => !summaryMap.has(id))) {
          for (const id of chain) protectedIds.add(id);
        }
      }
      return protectedIds;
    };
    for (const id of protectedTree([...summaryMap].filter(([, info]) => !safeStatuses.has(info.status)).map(([id]) => id))) runningTreeIds.add(id);
    for (const id of protectedTree(directArchived)) archivedTreeIds.add(id);

    return { available: await reader.verifyUnchanged(), summaryMap, runningTreeIds, archivedTreeIds };
  } catch {
    return { available: false, summaryMap, runningTreeIds, archivedTreeIds };
  } finally {
    await reader.close();
  }
}

export async function checkRunningConversation(agentDir: string | undefined): Promise<boolean> {
  if (!agentDir) return false;
  const index = await loadConversationIndex(agentDir);
  if (!index.available || index.runningTreeIds.size === 0) return false;
  const recentThresholdMs = Date.now() - 180_000;
  const convDir = join(agentDir, 'conversations');
  const brainDir = join(agentDir, 'brain');
  for (const cid of index.runningTreeIds) {
    if (!UUID_REGEX.test(cid)) continue;
    const dbPath = join(convDir, `${cid}.db`);
    const [dbSt, walSt, bSt] = await Promise.all([
      lstat(dbPath).catch(() => null),
      lstat(`${dbPath}-wal`).catch(() => null),
      lstat(join(brainDir, cid)).catch(() => null),
    ]);
    const latest = Math.max(dbSt?.mtimeMs ?? 0, walSt?.mtimeMs ?? 0, bSt?.mtimeMs ?? 0);
    if (latest >= recentThresholdMs) return true;
  }
  return false;
}

export type AgentConversationTargetsResult = {
  orphanTargets: SubTargetSpec[];
  taskStepTargets: SubTargetSpec[];
  verboseTranscriptTargets: SubTargetSpec[];
  subagentDbTargets: SubTargetSpec[];
  subagentCount: number;
  uncertainCount: number;
};

export async function collectAgentConversationTargets(ctx: MaintenanceDiscoveryContext, retentionDays: number): Promise<{
  orphanTargets: SubTargetSpec[];
  taskStepTargets: SubTargetSpec[];
  verboseTranscriptTargets: SubTargetSpec[];
  subagentDbTargets: SubTargetSpec[];
  subagentCount: number;
  uncertainCount: number;
}> {
  const empty = {
    orphanTargets: [] as SubTargetSpec[],
    taskStepTargets: [] as SubTargetSpec[],
    verboseTranscriptTargets: [] as SubTargetSpec[],
    subagentDbTargets: [] as SubTargetSpec[],
    subagentCount: 0,
    uncertainCount: 0,
  };
  const agentDir = ctx.officialAgentDir();
  if (!agentDir) return empty;
  const agentStat = await lstat(agentDir).catch(() => null);
  if (!agentStat || !agentStat.isDirectory() || agentStat.isSymbolicLink()) return empty;

  const nowMs = Date.now();
  const quietThresholdMs = nowMs - 60_000; // 排除 60 秒内刚写入的瞬态会话文件
  const cutoffMs = retentionDays > 0 ? nowMs - retentionDays * 86_400_000 : quietThresholdMs;

  const index = await loadConversationIndex(agentDir);
  const convDir = join(agentDir, 'conversations');
  const brainDir = join(agentDir, 'brain');

  const uncertainIds = new Set<string>();
  for (const name of await readdir(convDir).catch(() => [] as string[])) {
    if (!name.endsWith('.db')) continue;
    const id = name.slice(0, -3), info = index.summaryMap.get(id);
    if (UUID_REGEX.test(id) && (!index.available || !info || info.parentId && !index.summaryMap.has(info.parentId))) uncertainIds.add(id);
  }
  const orphanTargets: SubTargetSpec[] = [];

  // 1. 崩溃日志与全局 tempmediaStorage
  const crashesDir = join(agentDir, 'crashes');
  const crashesStat = await lstat(crashesDir).catch(() => null);
  if (crashesStat && !crashesStat.isSymbolicLink() && crashesStat.isDirectory()) {
    const crashFiles = await readdir(crashesDir).catch(() => [] as string[]);
    for (const f of crashFiles) {
      orphanTargets.push({ path: join(crashesDir, f) });
    }
  }
  const globalTempMedia = join(brainDir, 'tempmediaStorage');
  const gtmStat = await lstat(globalTempMedia).catch(() => null);
  if (gtmStat && !gtmStat.isSymbolicLink() && gtmStat.isDirectory()) {
    const gtmFiles = await readdir(globalTempMedia).catch(() => [] as string[]);
    for (const f of gtmFiles) {
      orphanTargets.push({ path: join(globalTempMedia, f) });
    }
  }

  // An absent summary/parent is not a deletion receipt. Conversation DBs and brain
  // directories with unknown ownership are protected, never classified as safe cache.

  // 3. 收集非孤儿会话的 brain 派生运行日志（与孤儿集合严格互不相交）
  const taskStepTargets: SubTargetSpec[] = [];
  const verboseTranscriptTargets: SubTargetSpec[] = [];
  const brainDirs = await readdir(brainDir).catch(() => [] as string[]);

  for (const cid of brainDirs) {
    if (!index.available || !index.summaryMap.has(cid) || !UUID_REGEX.test(cid) || index.runningTreeIds.has(cid) || index.archivedTreeIds.has(cid)) continue;
    const bPath = join(brainDir, cid);
    const bSt = await lstat(bPath).catch(() => null);
    if (!bSt || !bSt.isDirectory() || bSt.isSymbolicLink()) continue;

    // .tempmediaStorage 属于纯临时缓存（只要该会话未运行且静止 >60s，归入无损孤儿/临时残留）
    const dotTemp = join(bPath, '.tempmediaStorage');
    const dotTempSt = await lstat(dotTemp).catch(() => null);
    if (dotTempSt && !dotTempSt.isSymbolicLink() && dotTempSt.mtimeMs <= quietThresholdMs) {
      orphanTargets.push({ path: dotTemp });
    }

    // 判断会话最后活跃时间是否早于保留窗口 cutoffMs
    // 优先以会话库 (.db / -wal) 与紧凑转录文件 (transcript.jsonl) 的修改时间为准，
    // 避免移走 scratch 等同级子目录时因父目录 brain/<cid> mtime 刷新而误判为刚活跃。
    const dbPath = join(convDir, `${cid}.db`);
    const compactLogPath = join(bPath, '.system_generated', 'logs', 'transcript.jsonl');
    const [dbSt, walSt, logSt] = await Promise.all([
      lstat(dbPath).catch(() => null),
      lstat(`${dbPath}-wal`).catch(() => null),
      lstat(compactLogPath).catch(() => null),
    ]);
    const anchorMtime = Math.max(dbSt?.mtimeMs ?? 0, walSt?.mtimeMs ?? 0, logSt?.mtimeMs ?? 0);
    const sessionLastMtime = anchorMtime > 0 ? anchorMtime : bSt.mtimeMs;
    if (sessionLastMtime > cutoffMs || sessionLastMtime > quietThresholdMs) continue;

    for (const rel of [
      join('.system_generated', 'tasks'),
      join('.system_generated', 'steps'),
      'scratch',
    ]) {
      const candidate = join(bPath, rel);
      const st = await lstat(candidate).catch(() => null);
      if (st && !st.isSymbolicLink()) {
        taskStepTargets.push({ path: candidate });
      }
    }

    for (const rel of [
      join('.system_generated', 'logs', 'chunks'),
      join('.system_generated', 'logs', 'transcript_full.jsonl'),
    ]) {
      const candidate = join(bPath, rel);
      const st = await lstat(candidate).catch(() => null);
      if (st && !st.isSymbolicLink()) {
        verboseTranscriptTargets.push({ path: candidate });
      }
    }
  }

  // 4. 收集超期非活跃 Subagent 数据库（仅收集 conversations/<sub-cid>.db，与 brain 派生日志严格互不相交）
  const subagentDbTargets: SubTargetSpec[] = [];
  let subagentCount = 0;
  if (index.available) {
    for (const [cid, info] of index.summaryMap.entries()) {
      if (!UUID_REGEX.test(cid) || !info.parentId) continue;
      if (!index.summaryMap.has(info.parentId)) continue;
      if (index.runningTreeIds.has(cid) || index.archivedTreeIds.has(cid)) continue;

      const dbFile = join(convDir, `${cid}.db`);
      const dbSt = await lstat(dbFile).catch(() => null);
      if (!dbSt || !dbSt.isFile() || dbSt.isSymbolicLink()) continue;
      const walSt = await lstat(`${dbFile}-wal`).catch(() => null);
      const latestMtime = Math.max(dbSt.mtimeMs, walSt?.mtimeMs ?? 0);
      if (latestMtime > cutoffMs || latestMtime > quietThresholdMs) continue;

      subagentDbTargets.push({ path: dbFile, isUsageDb: true });
      subagentCount++;
    }
  }

  return {
    orphanTargets,
    taskStepTargets,
    verboseTranscriptTargets,
    subagentDbTargets,
    subagentCount,
    uncertainCount: uncertainIds.size,
  };
}

export async function inspectNamedEntry(
  ctx: MaintenanceDiscoveryContext,
  name: string,
  retentionDays: number,
  cachedAgentTargets?: AgentConversationTargetsResult
): Promise<InspectedCacheEntry> {
  if (
    (CACHE_NAMES as readonly string[]).includes(name) ||
    (EXTENDED_CACHE_NAMES as readonly string[]).includes(name)
  ) {
    return await inspectSingleProfileItem(ctx, name);
  }
  if (name === 'PartitionsCache') {
    const candidates = await collectPartitionsCandidates(ctx);
    return await inspectMultiTargetItem(ctx, name, candidates);
  }
  if (name === 'AgentBrowserCache') {
    const candidates = await collectBrowserProfileCandidates(ctx);
    return await inspectMultiTargetItem(ctx, name, candidates);
  }
  const agentTargets = cachedAgentTargets ?? await collectAgentConversationTargets(ctx, retentionDays);
  const windowDesc = retentionDays > 0 ? bt('maintenance.window.days_ago', { days: retentionDays }) : bt('maintenance.window.inactive');
  if (name === 'OrphanAgentData') {
    return await inspectMultiTargetItem(ctx, name, agentTargets.orphanTargets);
  }
  if (name === 'AgentTaskStepLogs') {
    return await inspectMultiTargetItem(ctx, name, agentTargets.taskStepTargets, {
      dynamicSubtitle: bt('maintenance.dynamic.task_step_sub', { windowDesc }),
    });
  }
  if (name === 'AgentVerboseTranscripts') {
    return await inspectMultiTargetItem(ctx, name, agentTargets.verboseTranscriptTargets, {
      dynamicSubtitle: bt('maintenance.dynamic.verbose_sub', { windowDesc }),
    });
  }
  if (name === 'AgentSubagentDatabases') {
    const sub = agentTargets.subagentCount > 0
      ? bt('maintenance.dynamic.subagent_sub', { windowDesc, count: agentTargets.subagentCount })
      : (getCacheMetadata('AgentSubagentDatabases')?.subtitle ?? 'AgentSubagentDatabases');
    return await inspectMultiTargetItem(ctx, name, agentTargets.subagentDbTargets, {
      dynamicSubtitle: sub,
      itemCount: agentTargets.subagentCount,
    });
  }
  return await inspectSingleProfileItem(ctx, name);
}

export async function inspectReadOnlyPaths(paths: string[], limitCount = 80000, budgetMs = 2800, excludePaths?: ReadonlySet<string>) {
  let bytes = 0, fileCount = 0, count = 0, exists = false, truncated = false;
  const deadline = Date.now() + budgetMs;
  const normalizedExclude = excludePaths && excludePaths.size > 0
    ? new Set(Array.from(excludePaths, p => resolve(p)))
    : undefined;
  const queue: string[] = [...paths];
  while (queue.length > 0) {
    if (count > limitCount || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, 32);
    await Promise.all(batch.map(async (currentPath) => {
      if (normalizedExclude?.has(resolve(currentPath))) return;
      if (++count > limitCount || Date.now() > deadline) {
        truncated = true;
        return;
      }
      try {
        const s = await lstat(currentPath);
        if (s.isSymbolicLink()) return;
        exists = true;
        if (s.isDirectory()) {
          const names = await readdir(currentPath);
          names.sort((a, b) => (a.startsWith('conversation') ? 0 : 1) - (b.startsWith('conversation') ? 0 : 1));
          for (const n of names) {
            queue.push(join(currentPath, n));
          }
        } else if (s.isFile()) {
          bytes += s.size;
          fileCount++;
        }
      } catch {}
    }));
  }
  return { bytes, fileCount, exists, truncated };
}
