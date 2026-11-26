import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConversationContextService } from '../dist/conversation-context.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const esbuildEntry = join(repoRoot, 'ui', 'node_modules', 'esbuild', 'lib', 'main.js');
const mcpServerEntry = join(repoRoot, 'plugin', 'bin', 'server.mjs');

function encodeTimestamp(fieldNum, sec) {
  return W.encodeLengthDelimited(fieldNum, W.encodeVarintField(1, sec));
}

function encodeModelUsage(rawIn, cachedRead, cacheWrite, out) {
  const parts = [];
  if (rawIn > 0) parts.push(W.encodeVarintField(2, rawIn));
  if (out > 0) parts.push(W.encodeVarintField(3, out));
  if (cacheWrite > 0) parts.push(W.encodeVarintField(4, cacheWrite));
  if (cachedRead > 0) parts.push(W.encodeVarintField(5, cachedRead));
  return Buffer.concat(parts);
}

function encodeChatToolCall(name) {
  return W.encodeLengthDelimited(4, W.encodeString(2, name));
}

function encodeStepMeta({ sec, usage, toolCallName }) {
  const parts = [encodeTimestamp(1, sec), encodeTimestamp(8, sec + 1)];
  if (usage) {
    parts.push(
      W.encodeLengthDelimited(
        9,
        encodeModelUsage(usage.rawIn, usage.cachedRead, usage.cacheWrite ?? 0, usage.out)
      )
    );
  }
  if (toolCallName) {
    parts.push(encodeChatToolCall(toolCallName));
  }
  return Buffer.concat(parts);
}

function encodeExecutorMeta({ planModelEnum, executionModelEnum, plannerModelName, maxTokenLimit }) {
  const plannerParts = [];
  if (planModelEnum) plannerParts.push(W.encodeVarintField(1, planModelEnum));
  if (plannerModelName) plannerParts.push(W.encodeString(28, plannerModelName));
  if (executionModelEnum) {
    plannerParts.push(W.encodeLengthDelimited(60, W.encodeVarintField(1, executionModelEnum)));
  }
  const cascadeParts = [W.encodeLengthDelimited(1, Buffer.concat(plannerParts))];
  if (maxTokenLimit) {
    cascadeParts.push(W.encodeLengthDelimited(2, W.encodeVarintField(5, maxTokenLimit)));
  }
  return W.encodeLengthDelimited(10, Buffer.concat(cascadeParts));
}

function encodeGenMeta({
  model,
  modelEnum,
  modelDisplayName,
  planModelEnum,
  executionModelEnum,
  plannerModelName,
  maxContextTokens,
  stepIndices,
  usage,
  sec,
}) {
  const ctxMetaParts = [];
  if (maxContextTokens) {
    ctxMetaParts.push(W.encodeVarintField(4, maxContextTokens));
  }
  const chatStart = ctxMetaParts.length > 0
    ? W.encodeLengthDelimited(
        9,
        Buffer.concat([
          encodeTimestamp(4, sec),
          W.encodeLengthDelimited(10, Buffer.concat(ctxMetaParts)),
        ])
      )
    : W.encodeLengthDelimited(9, encodeTimestamp(4, sec));

  const chatModelParts = [
    ...(modelEnum ? [W.encodeVarintField(3, modelEnum)] : []),
    ...(usage
      ? [
          W.encodeLengthDelimited(
            4,
            encodeModelUsage(usage.rawIn, usage.cachedRead, usage.cacheWrite ?? 0, usage.out)
          ),
        ]
      : []),
    ...(model ? [W.encodeString(19, model)] : []),
    ...(modelDisplayName ? [W.encodeString(21, modelDisplayName)] : []),
    chatStart,
  ];
  const rootParts = [
    W.encodeLengthDelimited(1, Buffer.concat(chatModelParts)),
  ];
  if (planModelEnum || executionModelEnum || plannerModelName) {
    const plannerParts = [];
    if (planModelEnum) plannerParts.push(W.encodeVarintField(1, planModelEnum));
    if (plannerModelName) plannerParts.push(W.encodeString(28, plannerModelName));
    if (executionModelEnum) {
      plannerParts.push(W.encodeLengthDelimited(60, W.encodeVarintField(1, executionModelEnum)));
    }
    rootParts.push(W.encodeLengthDelimited(3, Buffer.concat(plannerParts)));
  }
  for (const idx of stepIndices ?? []) {
    rootParts.push(W.encodeVarintField(2, idx));
  }
  return Buffer.concat(rootParts);
}

function createConvDb(dbPath, opts) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 0)').run(opts.id, opts.id);
    const insStep = db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)');
    for (const s of opts.steps) {
      insStep.run(s.idx, s.stepType, s.status, s.metadata);
    }
    const insGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
    for (const g of opts.gens ?? []) {
      insGen.run(g.idx, g.data);
    }
    const insExec = db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)');
    for (const e of opts.executorMetas ?? []) {
      insExec.run(e.idx, e.data);
    }
  } finally {
    db.close();
  }
}

function createStdioMcpClient(serverScript, args, env = {}) {
  const child = spawn(process.execPath, [serverScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();

  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    while (true) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      }
    }
  });

  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  function request(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timeout (${method}): stderr=${stderr}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async function close() {
    try {
      child.stdin.end();
    } catch {}
    return await Promise.race([
      closed,
      new Promise((resolve) =>
        setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve({ code: null, signal: 'SIGKILL' });
        }, 4000)
      ),
    ]);
  }

  return { request, notify, close };
}

async function bundleContextFrontendModules(sandboxDir) {
  assert.equal(existsSync(esbuildEntry), true, `Missing ui esbuild at ${esbuildEntry}`);
  const esbuild = await import(pathToFileURL(esbuildEntry).href);

  const entrySource = `
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'components', 'context-card.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'views', 'context.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'views', 'overview.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'ui', 'capabilities.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'ui', 'shell.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'i18n', 'l10n.ts'))};
  `;

  const outFile = join(sandboxDir, 'context-ui-bundle.mjs');
  await esbuild.build({
    stdin: {
      contents: entrySource,
      resolveDir: join(repoRoot, 'ui', 'src'),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    loader: {
      '.png': 'dataurl',
      '.css': 'empty',
    },
    logLevel: 'silent',
  });

  return import(pathToFileURL(outFile).href);
}

function buildSyntheticAntigravityFixture(geminiDir) {
  const agyDir = join(geminiDir, 'antigravity');
  const convDir = join(agyDir, 'conversations');
  const nowSec = Math.floor(Date.now() / 1000);

  const mainSwarmId = '11111111-1111-4111-8111-111111111111';
  const mainCompletedId = '22222222-2222-4222-8222-222222222222';
  const otherAppId = '33333333-3333-4333-8333-333333333333';
  const workerRunningId = 'aaaa1111-1111-4111-8111-aaaaaaaa1111';
  const workerWaitingId = 'bbbb2222-2222-4222-8222-bbbbbbbb2222';
  const workerKilledId = 'cccc3333-3333-4333-8333-cccccccc3333';

  const summariesDbPath = join(agyDir, 'conversation_summaries.db');
  const sdb = new DatabaseSync(summariesDbPath);
  try {
    sdb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        not_fully_idle numeric NOT NULL DEFAULT false,
        killed numeric NOT NULL DEFAULT false,
        last_user_input_time datetime NOT NULL,
        app_data_dir TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE conversation_parents (
        conversation_id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL
      );
    `);

    const insSum = sdb.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, agent_name, parent_conversation_id,
        nesting_depth, not_fully_idle, killed, last_user_input_time, app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const olderIso = new Date((nowSec - 120) * 1000).toISOString();
    const newerIso = new Date((nowSec - 20) * 1000).toISOString();

    insSum.run(
      mainSwarmId,
      'Swarm Context Monitor Design',
      'Coordinating workers',
      4,
      olderIso,
      'file:///workspace/agy-usage',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
      0,
      1,
      0,
      olderIso,
      'antigravity'
    );

    insSum.run(
      mainCompletedId,
      'Completed Audit Session',
      'All checks finished',
      2,
      newerIso,
      'file:///workspace/agy-usage',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
      0,
      0,
      0,
      newerIso,
      'antigravity'
    );

    insSum.run(
      otherAppId,
      'External App Session',
      'Should not appear',
      1,
      newerIso,
      '',
      'CASCADE_RUN_STATUS_RUNNING',
      '',
      '',
      0,
      1,
      0,
      newerIso,
      'other-ide'
    );

    insSum.run(
      workerRunningId,
      'Backend Context Task',
      '',
      2,
      newerIso,
      '',
      'CASCADE_RUN_STATUS_RUNNING',
      'backend-porter',
      mainSwarmId,
      1,
      1,
      0,
      olderIso,
      'antigravity'
    );
    insSum.run(
      workerWaitingId,
      'Wait for Peer Task',
      '',
      3,
      new Date((nowSec - 40) * 1000).toISOString(),
      '',
      'CASCADE_RUN_STATUS_RUNNING',
      'context-verifier',
      mainSwarmId,
      1,
      1,
      0,
      olderIso,
      'antigravity'
    );
    insSum.run(
      workerKilledId,
      'Retired Worker Task',
      '',
      2,
      new Date((nowSec - 90) * 1000).toISOString(),
      '',
      'CASCADE_RUN_STATUS_IDLE',
      'legacy-worker',
      '',
      1,
      0,
      1,
      olderIso,
      'antigravity'
    );
    sdb.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(workerKilledId, mainSwarmId);
  } finally {
    sdb.close();
  }

  const u1 = { rawIn: 20_000, cachedRead: 180_000, out: 2_000 };
  const u2 = { rawIn: 19_000, cachedRead: 300_000, out: 4_000 };
  createConvDb(join(convDir, `${mainSwarmId}.db`), {
    id: mainSwarmId,
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: nowSec - 120 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: nowSec - 110, usage: u1 }) },
      { idx: 2, stepType: 23, status: 3, metadata: encodeStepMeta({ sec: nowSec - 90 }) },
      { idx: 3, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: nowSec - 60, usage: u2 }) },
    ],
    gens: [
      { idx: 0, data: encodeGenMeta({ model: 'gemini-4-neon', maxContextTokens: 200_000, stepIndices: [1], usage: u1, sec: nowSec - 110 }) },
      { idx: 1, data: encodeGenMeta({ model: 'gemini-4-neon', maxContextTokens: 200_000, stepIndices: [3], usage: u2, sec: nowSec - 60 }) },
    ],
  });

  const wrU = { rawIn: 3_800, cachedRead: 60_000, out: 1_200 };
  createConvDb(join(convDir, `${workerRunningId}.db`), {
    id: workerRunningId,
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: nowSec - 100 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: nowSec - 20, usage: wrU }) },
    ],
    gens: [
      { idx: 0, data: encodeGenMeta({ model: 'gemini-4-hydrogen', stepIndices: [1], usage: wrU, sec: nowSec - 20 }) },
    ],
  });

  const wwU = { rawIn: 5_000, cachedRead: 40_000, out: 1_000 };
  createConvDb(join(convDir, `${workerWaitingId}.db`), {
    id: workerWaitingId,
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: nowSec - 100 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: nowSec - 45, usage: wwU }) },
      { idx: 2, stepType: 132, status: 2, metadata: encodeStepMeta({ sec: nowSec - 40, toolCallName: 'default_api:swarm_wait' }) },
    ],
    gens: [
      { idx: 0, data: encodeGenMeta({ model: 'gemini-4-hydrogen', stepIndices: [1], usage: wwU, sec: nowSec - 45 }) },
    ],
  });

  const wkU = { rawIn: 2_000, cachedRead: 80_000, out: 1_500 };
  createConvDb(join(convDir, `${workerKilledId}.db`), {
    id: workerKilledId,
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: nowSec - 110 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: nowSec - 90, usage: wkU }) },
    ],
    gens: [
      { idx: 0, data: encodeGenMeta({ model: 'claude-sonnet-4-6', maxContextTokens: 200_000, stepIndices: [1], usage: wkU, sec: nowSec - 90 }) },
    ],
  });

  const c2U = { rawIn: 2_000, cachedRead: 10_000, out: 500 };
  createConvDb(join(convDir, `${mainCompletedId}.db`), {
    id: mainCompletedId,
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: nowSec - 30 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: nowSec - 20, usage: c2U }) },
    ],
    gens: [
      { idx: 0, data: encodeGenMeta({ model: 'gemini-4-neon', maxContextTokens: 200_000, stepIndices: [1], usage: c2U, sec: nowSec - 20 }) },
    ],
  });

  createConvDb(join(convDir, `${otherAppId}.db`), {
    id: otherAppId,
    steps: [{ idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: nowSec - 10 }) }],
  });

  return {
    mainSwarmId,
    mainCompletedId,
    otherAppId,
    workerRunningId,
    workerWaitingId,
    workerKilledId,
  };
}

test('ConversationContextService filtering, sorting, Swarm watermarks, and summaries fallback', { timeout: 30000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agy-ctx-service-'));
  const geminiDir = join(tempRoot, 'gemini');
  const stateDir = join(tempRoot, 'state');
  await mkdir(join(geminiDir, 'antigravity', 'conversations'), { recursive: true });
  await mkdir(stateDir, { recursive: true });

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const ids = buildSyntheticAntigravityFixture(geminiDir);
  const service = new ConversationContextService({ geminiDir, stateDir });

  const list = await service.listRecentConversations();
  assert.equal(list.conversations.length, 2);
  assert.equal(list.recommendedId, ids.mainSwarmId);
  assert.deepEqual(
    list.conversations.map((c) => c.conversationId),
    [ids.mainSwarmId, ids.mainCompletedId]
  );
  const top = list.conversations[0];
  assert.equal(top.title, 'Swarm Context Monitor Design');
  assert.equal(top.status, 'running');
  assert.equal(top.childCount, 3);
  assert.equal(top.runningChildCount, 2);
  assert.equal(top.waitingChildCount, 0);
  assert.equal(top.activeChildCount, 2);

  const snap = await service.getConversationContextSnapshot();
  assert.equal(snap.available, true);
  assert.equal(snap.conversationId, ids.mainSwarmId);
  assert.equal(snap.main.usedTokens, 319_000);
  assert.equal(snap.main.usedTokensCompact, '319K');
  assert.equal(snap.main.capacityTokens, 200_000);
  assert.equal(snap.main.capacityTokensCompact, '200K');
  assert.equal(snap.main.capacitySource, 'explicit');
  assert.equal(snap.main.usedRatioFormatted, '160%');
  assert.equal(snap.main.compactionCount, 1);

  assert.ok(Math.abs(snap.main.averageCacheHitRate - 480_000 / 519_000) < 1e-6);
  assert.equal(snap.main.averageCacheHitRateFormatted, '92.5%');
  assert.equal(snap.mainTokens.totalTokens, 525_000);

  assert.equal(snap.members.length, 3);
  assert.deepEqual(
    snap.members.map((m) => [m.conversationId, m.status, m.displayName]),
    [
      [ids.workerRunningId, 'running', 'backend-porter'],
      [ids.workerWaitingId, 'waiting', 'context-verifier'],
      [ids.workerKilledId, 'completed', 'legacy-worker'],
    ]
  );

  const runningMember = snap.members[0];
  assert.equal(runningMember.context.usedTokens, 63_800);
  assert.equal(runningMember.context.usedTokensCompact, '63.8K');
  assert.equal(runningMember.context.capacityTokensCompact, '~200K');
  assert.equal(runningMember.context.capacitySource, 'reference');
  assert.equal(runningMember.context.usedRatioFormatted, '31.9%');

  assert.ok(snap.swarmTotals);
  assert.equal(snap.swarmTotals.memberCount, 3);
  assert.equal(snap.swarmTotals.runningCount, 1);
  assert.equal(snap.swarmTotals.waitingCount, 1);
  assert.equal(snap.swarmTotals.completedCount, 1);
  const expectedTotalTokens = 525_000 + 65_000 + 46_000 + 83_500;
  assert.equal(snap.swarmTotals.totalTokens, expectedTotalTokens);
  assert.equal(snap.swarmTotals.totalTokensCompact, '720K');
  assert.equal(snap.swarmTotals.totalSteps, 4 + 2 + 3 + 2);

  const noSumGemini = join(tempRoot, 'no-sum-gemini');
  const noSumConv = join(noSumGemini, 'antigravity', 'conversations');
  await mkdir(noSumConv, { recursive: true });
  const idOld = 'dddd4444-4444-4444-8444-dddddddd4444';
  const idNew = 'eeee5555-5555-4555-8555-eeeeeeee5555';
  const nowSec = Math.floor(Date.now() / 1000);
  createConvDb(join(noSumConv, `${idOld}.db`), {
    id: idOld,
    steps: [{ idx: 0, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: nowSec - 300, usage: { rawIn: 1000, cachedRead: 9000, out: 100 } }) }],
  });
  createConvDb(join(noSumConv, `${idNew}.db`), {
    id: idNew,
    steps: [{ idx: 0, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: nowSec - 10, usage: { rawIn: 2000, cachedRead: 18000, out: 200 } }) }],
  });
  const oldDate = new Date(Date.now() - 120_000);
  const newDate = new Date(Date.now() - 5_000);
  await utimes(join(noSumConv, `${idOld}.db`), oldDate, oldDate);
  await utimes(join(noSumConv, `${idNew}.db`), newDate, newDate);

  const noSumSvc = new ConversationContextService({ geminiDir: noSumGemini, stateDir });
  const fallbackList = await noSumSvc.listRecentConversations();
  assert.equal(fallbackList.recommendedId, idNew);
  assert.deepEqual(fallbackList.conversations.map((c) => c.conversationId), [idNew, idOld]);
});

test('MCP Server context_conversations_list, context_conversation_detail, and conversationId routing', { timeout: 30000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agy-ctx-mcp-'));
  const dataDir = join(tempRoot, 'plugin-data');
  const geminiDir = join(tempRoot, 'gemini');
  await mkdir(join(geminiDir, 'antigravity', 'conversations'), { recursive: true });

  const ids = buildSyntheticAntigravityFixture(geminiDir);

  const client = createStdioMcpClient(
    mcpServerEntry,
    [
      '--data-dir', dataDir,
      '--gemini-dir', geminiDir,
      '--app', join(tempRoot, 'missing-app'),
      '--profile', join(tempRoot, 'missing-profile'),
    ],
    {
      GRAVITYBOX_HOME_DIR: tempRoot,
      GRAVITYBOX_APP_SUPPORT_DIR: tempRoot,
    }
  );
  t.after(async () => {
    await client.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  await client.request('initialize', {
    protocolVersion: '2025-11-21',
    capabilities: {},
    clientInfo: { name: 'ctx-mcp-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized', {});

  const tools = await client.request('tools/list', {});
  const openTool = tools.tools.find((tool) => tool.name === 'open_agy_usage_tool');
  assert.deepEqual(openTool.inputSchema.properties.view.enum, [
    'overview', 'context', 'usage', 'storage', 'settings', 'about',
  ]);
  assert.equal(openTool.inputSchema.properties.conversationId.type, 'string');

  const openCtx = await client.request('tools/call', {
    name: 'open_agy_usage_tool',
    arguments: { view: 'context', conversationId: ids.mainCompletedId },
  });
  assert.equal(openCtx.structuredContent.initialView, 'context');
  assert.equal(openCtx.structuredContent.initialConversationId, ids.mainCompletedId);

  const listRes = await client.request('tools/call', {
    name: 'agy_usage_tool_ipc',
    arguments: { payload: { command: 'context_conversations_list' } },
  });
  const listData = listRes.structuredContent;
  assert.equal(listData.ok, true);
  assert.equal(listData.recommendedId, ids.mainSwarmId);
  assert.equal(listData.conversations.length, 2);

  const detailRes = await client.request('tools/call', {
    name: 'agy_usage_tool_ipc',
    arguments: { payload: { command: 'context_conversation_detail', conversationId: ids.mainSwarmId } },
  });
  const detailData = detailRes.structuredContent;
  assert.equal(detailData.ok, true);
  assert.equal(detailData.snapshot.main.usedTokensCompact, '319K');
  assert.equal(detailData.snapshot.members.length, 3);
  assert.equal(detailData.snapshot.swarmTotals.memberCount, 3);

  const exitRes = await client.close();
  assert.equal(exitRes.code, 0);
});

test('UI context cards, K/M formatting, Swarm collapse, and overview compact card', { timeout: 30000 }, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'agy-ctx-fe-'));
  const geminiDir = join(sandbox, 'gemini');
  const stateDir = join(sandbox, 'state');
  await mkdir(join(geminiDir, 'antigravity', 'conversations'), { recursive: true });
  await mkdir(stateDir, { recursive: true });

  t.after(async () => {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const ids = buildSyntheticAntigravityFixture(geminiDir);
  const service = new ConversationContextService({ geminiDir, stateDir });
  const list = await service.listRecentConversations();
  const snapshot = await service.getConversationContextSnapshot(ids.mainSwarmId);

  const ui = await bundleContextFrontendModules(sandbox);

  const fullCard = ui.renderContextWindowCard(snapshot, { compact: false });
  assert.equal(fullCard.includes('万'), false);
  assert.ok(fullCard.includes('上下文容量'));
  assert.ok(fullCard.includes('319K'));
  assert.ok(fullCard.includes('200K'));
  assert.ok(fullCard.includes('160%'));
  assert.ok(fullCard.includes('平均缓存命中率'));
  assert.ok(fullCard.includes('92.5%'));
  assert.ok(fullCard.includes('已压缩 1 次'));

  const swarmCollapsed = ui.renderSwarmMembersSection(snapshot, {
    showCompleted: false,
    expandedMemberId: null,
  });
  assert.equal(swarmCollapsed.includes('万'), false);
  assert.ok(swarmCollapsed.includes('backend-porter'));
  assert.ok(swarmCollapsed.includes('63.8K'));
  assert.ok(swarmCollapsed.includes('~200K'));
  assert.ok(swarmCollapsed.includes('31.9%'));
  assert.ok(swarmCollapsed.includes('context-verifier'));
  assert.ok(swarmCollapsed.includes('已结束成员 (1)'));
  assert.equal(swarmCollapsed.includes('legacy-worker'), false);

  const swarmExpanded = ui.renderSwarmMembersSection(snapshot, {
    showCompleted: true,
    expandedMemberId: ids.workerRunningId,
  });
  assert.ok(swarmExpanded.includes('legacy-worker'));
  assert.ok(swarmExpanded.includes('gb-ctx-member-detail'));

  const contextViewHtml = ui.renderContextView({
    conversations: list.conversations,
    recommendedId: list.recommendedId,
    selectedConversationId: ids.mainSwarmId,
    autoTrack: true,
    snapshot,
    showCompleted: false,
    expandedMemberId: null,
    loading: false,
    busyAction: null,
  });
  assert.equal(contextViewHtml.includes('万'), false);
  assert.ok(contextViewHtml.includes('Swarm Context Monitor Design'));
  assert.ok(contextViewHtml.includes('整场协作总消耗汇总'));
  assert.ok(contextViewHtml.includes('720K'));

  const mcpCaps = ui.getUiCapabilities('mcp-app');
  const overviewHtml = ui.renderOverviewView({
    status: { mode: 'mcp-direct', message: '纯本地只读模式已就绪', windows: 0, readOnlyMode: true },
    dashboard: {
      ok: true,
      accounts: null,
      usage: {
        todayTokens: 1000,
        totalTokens: 2000,
        estimatedUsd: 0.1,
        allTimeEstimatedUsd: 0.2,
        requestCount: 2,
        totalRequestCount: 4,
        pricingModels: 10,
        todayPricedModels: 1,
        todayUnpricedModels: 0,
        unpricedModels: 0,
        pricedModels: 1,
        databasesScanned: 1,
        databasesDiscovered: 1,
        scanScopeDescription: '1 DB',
        hasError: false,
        availability: 'complete',
        todayHourly: [],
        todayByModel: [],
      },
      accountsError: '',
      usageError: '',
    },
    contextSnapshot: snapshot,
    loading: false,
    busyAction: null,
    capabilities: mcpCaps,
  });
  const bannerIdx = overviewHtml.indexOf('gb-banner');
  const ctxCardIdx = overviewHtml.indexOf('data-context-card="compact"');
  const metricsGridIdx = overviewHtml.indexOf('gb-grid-3');
  assert.ok(bannerIdx >= 0 && ctxCardIdx > bannerIdx && metricsGridIdx > ctxCardIdx);
  assert.ok(overviewHtml.includes('data-nav="context"'));
  assert.ok(overviewHtml.includes('319K'));
  assert.ok(overviewHtml.includes('92.5%'));
});

test('Orchestrator folds multi-row executor_metadata, tracks exit_plan_mode, and avoids phantom dash row', { timeout: 30000 }, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'agy-orch-fix-'));
  const geminiDir = join(sandbox, 'gemini');
  const stateDir = join(sandbox, 'state');
  const convDir = join(geminiDir, 'antigravity', 'conversations');
  await mkdir(convDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  t.after(async () => {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const baseSec = Math.floor(Date.now() / 1000) - 300;
  const seedId = '11111111-1111-4111-8111-111111111111';
  const orchId = '22222222-2222-4222-8222-222222222222';
  const planningKnownId = '33333333-3333-4333-8333-333333333333';
  const planningUnknownId = '44444444-4444-4444-8444-444444444444';

  // Seed DB teaches enum 1528 -> Gemini 4 Hydrogen (XHigh) across the scan
  createConvDb(join(convDir, `${seedId}.db`), {
    id: seedId,
    steps: [
      { idx: 0, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: baseSec - 120, usage: { rawIn: 1000, cachedRead: 0, out: 100 } }) },
    ],
    gens: [
      {
        idx: 0,
        data: encodeGenMeta({
          model: 'gemini-4-hydrogen',
          modelEnum: 1528,
          modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
          maxContextTokens: 512_000,
          stepIndices: [0],
          usage: { rawIn: 1000, cachedRead: 0, out: 100 },
          sec: baseSec - 120,
        }),
      },
    ],
  });

  // Case 1: Plan & Execute after exit_plan_mode where later executor_metadata row overwrote planModelEnum 1427 -> 1528
  createConvDb(join(convDir, `${orchId}.db`), {
    id: orchId,
    executorMetas: [
      { idx: 0, data: encodeExecutorMeta({ planModelEnum: 1427, executionModelEnum: 1528, maxTokenLimit: 512_000 }) },
      { idx: 1, data: encodeExecutorMeta({ planModelEnum: 1528, executionModelEnum: 1528, maxTokenLimit: 512_000 }) },
    ],
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: baseSec + 5 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: baseSec + 10, usage: { rawIn: 40_900, cachedRead: 0, out: 500 } }) },
      { idx: 2, stepType: 132, status: 3, metadata: encodeStepMeta({ sec: baseSec + 20, toolCallName: 'exit_plan_mode' }) },
      { idx: 3, stepType: 15, status: 2, metadata: encodeStepMeta({ sec: baseSec + 30, usage: { rawIn: 3_040, cachedRead: 96_200, out: 234 } }) },
    ],
    gens: [
      {
        idx: 0,
        data: encodeGenMeta({
          model: 'gemini-4-carbon',
          modelEnum: 1427,
          modelDisplayName: 'Gemini 4 Carbon (High)',
          planModelEnum: 1427,
          executionModelEnum: 1528,
          maxContextTokens: 512_000,
          stepIndices: [1],
          usage: { rawIn: 40_900, cachedRead: 0, out: 500 },
          sec: baseSec + 10,
        }),
      },
      {
        idx: 1,
        data: encodeGenMeta({
          model: 'gemini-4-hydrogen',
          modelEnum: 1528,
          modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
          planModelEnum: 1528,
          executionModelEnum: 1528,
          maxContextTokens: 512_000,
          stepIndices: [3],
          usage: { rawIn: 3_040, cachedRead: 96_200, out: 234 },
          sec: baseSec + 30,
        }),
      },
    ],
  });

  // Case 2: Still in planning phase, executor enum 1528 known via local enum self-learning -> resolved Hydrogen [执行] [待介入]
  createConvDb(join(convDir, `${planningKnownId}.db`), {
    id: planningKnownId,
    executorMetas: [
      { idx: 0, data: encodeExecutorMeta({ planModelEnum: 1427, executionModelEnum: 1528, maxTokenLimit: 512_000 }) },
    ],
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: baseSec + 35 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: baseSec + 40, usage: { rawIn: 12_000, cachedRead: 0, out: 200 } }) },
    ],
    gens: [
      {
        idx: 0,
        data: encodeGenMeta({
          model: 'gemini-4-carbon',
          modelEnum: 1427,
          modelDisplayName: 'Gemini 4 Carbon (High)',
          planModelEnum: 1427,
          executionModelEnum: 1528,
          maxContextTokens: 512_000,
          stepIndices: [1],
          usage: { rawIn: 12_000, cachedRead: 0, out: 200 },
          sec: baseSec + 40,
        }),
      },
    ],
  });

  // Case 3: Still in planning phase with unseen future enum 999999 -> pending label instead of "—"
  createConvDb(join(convDir, `${planningUnknownId}.db`), {
    id: planningUnknownId,
    executorMetas: [
      { idx: 0, data: encodeExecutorMeta({ planModelEnum: 1427, executionModelEnum: 999999, maxTokenLimit: 512_000 }) },
    ],
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: baseSec + 45 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: baseSec + 50, usage: { rawIn: 8_000, cachedRead: 0, out: 150 } }) },
    ],
    gens: [
      {
        idx: 0,
        data: encodeGenMeta({
          model: 'gemini-4-carbon',
          modelEnum: 1427,
          modelDisplayName: 'Gemini 4 Carbon (High)',
          planModelEnum: 1427,
          executionModelEnum: 999999,
          maxContextTokens: 512_000,
          stepIndices: [1],
          usage: { rawIn: 8_000, cachedRead: 0, out: 150 },
          sec: baseSec + 50,
        }),
      },
    ],
  });

  const service = new ConversationContextService({ geminiDir, stateDir });
  await service.listRecentConversations();
  const ui = await bundleContextFrontendModules(sandbox);

  const orchSnap = await service.getConversationContextSnapshot(orchId);
  assert.equal(orchSnap.main.isOrchestrator, true);
  assert.equal(orchSnap.main.modelStages?.length, 2);
  assert.equal(orchSnap.main.modelStages[0].role, 'planner');
  assert.ok(orchSnap.main.modelStages[0].modelDisplayName.includes('Carbon'));
  assert.equal(orchSnap.main.modelStages[1].role, 'executor');
  assert.equal(orchSnap.main.modelStages[1].isActive, true);
  assert.ok(orchSnap.main.modelStages[1].modelDisplayName.includes('Hydrogen'));
  const orchStagesCard = ui.renderModelStagesCard(orchSnap);
  assert.equal(orchStagesCard.includes('—'), false);
  assert.ok(orchStagesCard.includes('规划'));
  assert.ok(orchStagesCard.includes('执行'));
  assert.ok(orchStagesCard.includes('当前'));

  const knownSnap = await service.getConversationContextSnapshot(planningKnownId);
  assert.equal(knownSnap.main.modelStages?.length, 2);
  assert.equal(knownSnap.main.modelStages[0].role, 'planner');
  assert.equal(knownSnap.main.modelStages[0].isActive, true);
  assert.equal(knownSnap.main.modelStages[1].role, 'executor');
  assert.equal(knownSnap.main.modelStages[1].hasUsageData, false);
  assert.ok(knownSnap.main.modelStages[1].modelDisplayName.includes('Hydrogen'));
  const knownStagesCard = ui.renderModelStagesCard(knownSnap);
  assert.ok(knownStagesCard.includes('待介入'));
  assert.equal(knownStagesCard.includes('—'), false);

  const unknownSnap = await service.getConversationContextSnapshot(planningUnknownId);
  assert.equal(unknownSnap.main.modelStages?.length, 2);
  assert.equal(unknownSnap.main.modelStages[1].modelId, 'pending');
  const unknownStagesCard = ui.renderModelStagesCard(unknownSnap);
  assert.ok(unknownStagesCard.includes('待切换执行模型'));
  assert.equal(unknownStagesCard.includes('—'), false);

  // Case 4: Same-model Planner & Executor (1528 === 1528) across Turn 1 Plan->Exit->Execute and Turn 2 Continuation
  const sameModelId = '55555555-5555-4555-8555-555555555555';
  createConvDb(join(convDir, `${sameModelId}.db`), {
    id: sameModelId,
    executorMetas: [
      { idx: 0, data: encodeExecutorMeta({ planModelEnum: 1528, executionModelEnum: 1528, maxTokenLimit: 512_000 }) },
    ],
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: baseSec + 60 }) },
      { idx: 1, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: baseSec + 65, usage: { rawIn: 30_000, cachedRead: 0, out: 300 } }) },
      { idx: 2, stepType: 132, status: 3, metadata: encodeStepMeta({ sec: baseSec + 70, toolCallName: 'exit_plan_mode' }) },
      { idx: 3, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: baseSec + 75, usage: { rawIn: 55_000, cachedRead: 0, out: 400 } }) },
      { idx: 4, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: baseSec + 80 }) },
      { idx: 5, stepType: 15, status: 2, metadata: encodeStepMeta({ sec: baseSec + 85, usage: { rawIn: 2_000, cachedRead: 60_000, out: 250 } }) },
    ],
    gens: [
      {
        idx: 0,
        data: encodeGenMeta({
          model: 'gemini-4-hydrogen',
          modelEnum: 1528,
          modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
          planModelEnum: 1528,
          executionModelEnum: 1528,
          maxContextTokens: 512_000,
          stepIndices: [1],
          usage: { rawIn: 30_000, cachedRead: 0, out: 300 },
          sec: baseSec + 65,
        }),
      },
      {
        idx: 1,
        data: encodeGenMeta({
          model: 'gemini-4-hydrogen',
          modelEnum: 1528,
          modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
          planModelEnum: 1528,
          executionModelEnum: 1528,
          maxContextTokens: 512_000,
          stepIndices: [3],
          usage: { rawIn: 55_000, cachedRead: 0, out: 400 },
          sec: baseSec + 75,
        }),
      },
      {
        idx: 2,
        data: encodeGenMeta({
          model: 'gemini-4-hydrogen',
          modelEnum: 1528,
          modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
          planModelEnum: 1528,
          executionModelEnum: 1528,
          maxContextTokens: 512_000,
          stepIndices: [5],
          usage: { rawIn: 2_000, cachedRead: 60_000, out: 250 },
          sec: baseSec + 85,
        }),
      },
    ],
  });
  const sameSnap = await service.getConversationContextSnapshot(sameModelId);
  assert.equal(sameSnap.main.isOrchestrator, true);
  assert.equal(sameSnap.main.modelStages?.length, 2);
  assert.equal(sameSnap.main.modelStages[0].role, 'planner');
  assert.equal(sameSnap.main.modelStages[0].hasUsageData, true);
  assert.equal(sameSnap.main.modelStages[1].role, 'executor');
  assert.equal(sameSnap.main.modelStages[1].isActive, true);
  assert.ok(sameSnap.main.modelStages[1].usedTokens >= 60_000);
  const sameStagesCard = ui.renderModelStagesCard(sameSnap);
  assert.equal(sameStagesCard.includes('待介入'), false);

  // Case 5: Rejected exit_plan_mode (status 7) must not flip planner steps into executor role
  const rejectedExitId = '66666666-6666-4666-8666-666666666666';
  createConvDb(join(convDir, `${rejectedExitId}.db`), {
    id: rejectedExitId,
    executorMetas: [
      { idx: 0, data: encodeExecutorMeta({ planModelEnum: 1427, executionModelEnum: 1528, maxTokenLimit: 512_000 }) },
    ],
    steps: [
      { idx: 0, stepType: 14, status: 3, metadata: encodeStepMeta({ sec: baseSec + 90 }) },
      { idx: 1, stepType: 132, status: 7, metadata: encodeStepMeta({ sec: baseSec + 95, toolCallName: 'exit_plan_mode' }) },
      { idx: 2, stepType: 15, status: 3, metadata: encodeStepMeta({ sec: baseSec + 100, usage: { rawIn: 20_000, cachedRead: 0, out: 200 } }) },
    ],
    gens: [
      {
        idx: 0,
        data: encodeGenMeta({
          model: 'gemini-4-carbon',
          modelEnum: 1427,
          modelDisplayName: 'Gemini 4 Carbon (High)',
          planModelEnum: 1427,
          executionModelEnum: 1528,
          maxContextTokens: 512_000,
          stepIndices: [2],
          usage: { rawIn: 20_000, cachedRead: 0, out: 200 },
          sec: baseSec + 100,
        }),
      },
    ],
  });
  const rejectedSnap = await service.getConversationContextSnapshot(rejectedExitId);
  assert.equal(rejectedSnap.main.modelStages?.length, 2);
  assert.equal(rejectedSnap.main.modelStages[0].role, 'planner');
  assert.equal(rejectedSnap.main.modelStages[0].isActive, true);
  assert.equal(rejectedSnap.main.modelStages[1].role, 'executor');
  assert.equal(rejectedSnap.main.modelStages[1].hasUsageData, false);

  // Case 6: Unknown modelId fallback renders "未知模型" rather than "—"
  const unknownSlotCard = ui.renderModelStagesCard({
    ...orchSnap,
    main: {
      ...orchSnap.main,
      modelStages: [
        orchSnap.main.modelStages[0],
        {
          ...orchSnap.main.modelStages[1],
          role: 'model',
          modelId: 'unknown',
          modelDisplayName: '—',
          shortLabel: '',
        },
      ],
    },
  });
  assert.ok(unknownSlotCard.includes('未知模型'));
  assert.equal(unknownSlotCard.includes('—'), false);
});
