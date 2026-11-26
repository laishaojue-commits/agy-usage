import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildUsageSummaryReport } from '../dist/usage-report.js';
import { aggregateLedger, formatLocalDate } from '../dist/usage-aggregate.js';
import { UsageLedger } from '../dist/usage-ledger-core.js';
import { LocalUsageStatsManager } from '../dist/usage-core.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';
import { projectAllUsagePeriodSummaries, projectUsagePeriodSummary } from '../dist/usage-projections.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const esbuildEntry = join(repoRoot, 'ui', 'node_modules', 'esbuild', 'lib', 'main.js');

async function bundleUiModules(sandboxDir) {
  assert.equal(existsSync(esbuildEntry), true, `Missing ui esbuild at ${esbuildEntry}`);
  const esbuild = await import(pathToFileURL(esbuildEntry).href);

  const entrySource = `
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'charts', 'palette.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'charts', 'stacked-bar.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'charts', 'cost-donut.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'views', 'usage.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'views', 'overview.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'views', 'settings.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'views', 'about.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'ui', 'capabilities.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'ui', 'shell.ts'))};
    export * from ${JSON.stringify(join(repoRoot, 'ui', 'src', 'i18n', 'l10n.ts'))};
  `;

  const outFile = join(sandboxDir, 'ui-bundle.mjs');
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

function createMockDom() {
  class FakeElement {
    constructor(tagName, id = '', classes = [], attrs = {}) {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = classes.join(' ');
      this.attrs = { ...attrs };
      this.dataset = {};
      this.children = [];
      this.parent = null;
      this._innerHTML = '';
      this._textContent = '';
      this.scrollTop = 0;
      this.scrollLeft = 0;
      this.disabled = false;
      this.hidden = false;
      this.selectionStart = null;
      this.selectionEnd = null;
      this.selectionDirection = null;
      this.focusCalls = [];
      this.innerHTMLWriteCount = 0;
    }

    get innerHTML() {
      return this._innerHTML;
    }

    set innerHTML(val) {
      this.innerHTMLWriteCount++;
      this._innerHTML = String(val);
      this.children = [];
      if (this.id === 'app') {
        this._mountShellChildren();
      } else if (this.id === 'gb-view-host') {
        if (this._innerHTML.includes('data-events-search')) {
          const input = new FakeElement('input', '', ['gb-input']);
          input.dataset.eventsSearch = '';
          input.attrs['data-events-search'] = '';
          this.appendChild(input);
        }
      }
    }

    get textContent() {
      return this._textContent;
    }

    set textContent(val) {
      this._textContent = String(val);
    }

    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    _mountShellChildren() {
      const aside = new FakeElement('aside', '', ['gb-sidebar'], { 'aria-label': 'nav' });
      if (this._innerHTML.includes('gb-brand-sub')) {
        const brandSub = new FakeElement('div', '', ['gb-brand-sub']);
        brandSub.dataset.brandSub = '';
        aside.appendChild(brandSub);
      }
      for (const viewId of ['overview', 'context', 'usage', 'storage', 'settings', 'about']) {
        const btn = new FakeElement('button', '', ['gb-nav-item']);
        btn.dataset.nav = viewId;
        const lbl = new FakeElement('span');
        lbl.dataset.navLabel = viewId;
        btn.appendChild(lbl);
        aside.appendChild(btn);
      }
      const footer = new FakeElement('div', 'gb-sidebar-footer', ['gb-sidebar-footer']);
      footer.hidden = /id="gb-sidebar-footer"[^>]*\bhidden\b/.test(this._innerHTML);
      const chip = new FakeElement('div', 'gb-status-chip', ['gb-status-chip']);
      const dot = new FakeElement('span', 'gb-status-dot', ['gb-dot']);
      const statusText = new FakeElement('span', 'gb-status-text');
      footer.appendChild(chip);
      footer.appendChild(dot);
      footer.appendChild(statusText);
      aside.appendChild(footer);

      const main = new FakeElement('main', 'gb-main', ['gb-main']);
      const alertHost = new FakeElement('div', 'gb-service-alert-host', ['gb-service-alert-host']);
      const viewHost = new FakeElement('div', 'gb-view-host', ['gb-view-host']);
      main.appendChild(alertHost);
      main.appendChild(viewHost);

      const toastHost = new FakeElement('div', 'gb-toast-host', ['gb-toast-host']);
      toastHost.hidden = true;

      this.appendChild(aside);
      this.appendChild(main);
      this.appendChild(toastHost);
    }

    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === 'id') this.id = String(value);
      if (name === 'class') this.className = String(value);
    }

    getAttribute(name) {
      return this.attrs[name] ?? null;
    }

    matches(selector) {
      if (selector === '[data-events-search]') {
        return 'eventsSearch' in this.dataset || 'data-events-search' in this.attrs;
      }
      if (selector === '.gb-sidebar') return this.className.split(/\s+/).includes('gb-sidebar');
      if (selector === '[data-brand-sub]') return 'brandSub' in this.dataset;
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      const navMatch = selector.match(/^\[data-nav="([^"]+)"\]$/);
      if (navMatch) return this.dataset.nav === navMatch[1];
      const lblMatch = selector.match(/^\[data-nav-label="([^"]+)"\]$/);
      if (lblMatch) return this.dataset.navLabel === lblMatch[1];
      return false;
    }

    contains(node) {
      if (node === this) return true;
      return this.children.some((c) => c.contains(node));
    }

    querySelector(selector) {
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }

    focus(opts) {
      this.focusCalls.push(opts ?? null);
      doc.activeElement = this;
      if (!opts?.preventScroll && mainScrollResetOnFocus) {
        const main = app.querySelector('#gb-main');
        if (main) main.scrollTop = 0;
      }
    }

    setSelectionRange(start, end, dir = 'none') {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = dir;
    }
  }

  let mainScrollResetOnFocus = true;
  const app = new FakeElement('div', 'app');
  const docElement = new FakeElement('html');
  const body = new FakeElement('body');
  const doc = {
    documentElement: docElement,
    body,
    activeElement: null,
  };
  const win = {
    scrollX: 0,
    scrollY: 0,
    scrollTo(x, y) {
      this.scrollX = x;
      this.scrollY = y;
    },
  };
  return { app, doc, win, setMainScrollResetOnFocus: (v) => { mainScrollResetOnFocus = v; } };
}

test('Backend buildUsageSummaryReport and aggregateLedger produce per-model by_model breakdowns', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'agy-usage-charts-be-'));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const fixedNoon = new Date(2026, 10, 23, 14, 0, 0, 0);
  const now = Math.floor(fixedNoon.getTime() / 1000);
  const todayStr = formatLocalDate(fixedNoon);
  const hour00 = Math.floor(new Date(2026, 10, 23, 0, 15, 0, 0).getTime() / 1000);
  const hour10 = Math.floor(new Date(2026, 10, 23, 10, 20, 0, 0).getTime() / 1000);
  const twoDaysAgo = Math.floor(new Date(2026, 10, 21, 11, 0, 0, 0).getTime() / 1000);
  const twoDaysAgoStr = formatLocalDate(new Date(twoDaysAgo * 1000));

  const events = [
    {
      event_key: 'a'.repeat(64),
      source_id: 's1',
      model: 'gemini-4-neon',
      input_tokens: 400_000,
      output_tokens: 169_000,
      cached_tokens: 100_000,
      total_tokens: 669_000,
      timestamp_seconds: hour00,
      account_id: 'acc-1',
      account_email: 'one@example.invalid',
    },
    {
      event_key: 'b'.repeat(64),
      source_id: 's1',
      model: 'gemini-4-hydrogen',
      input_tokens: 100_000,
      output_tokens: 50_000,
      cached_tokens: 0,
      total_tokens: 150_000,
      timestamp_seconds: hour00 + 60,
      account_id: 'acc-1',
      account_email: 'one@example.invalid',
    },
    {
      event_key: 'c'.repeat(64),
      source_id: 's1',
      model: 'gemini-4-hydrogen',
      input_tokens: 40_000,
      output_tokens: 10_000,
      cached_tokens: 0,
      total_tokens: 50_000,
      timestamp_seconds: hour00 + 120,
      account_id: 'acc-2',
      account_email: 'two@example.invalid',
    },
    {
      event_key: 'd'.repeat(64),
      source_id: 's1',
      model: 'claude-sonnet-4-6',
      input_tokens: 20_000,
      output_tokens: 10_000,
      cached_tokens: 0,
      total_tokens: 30_000,
      timestamp_seconds: hour10,
      account_id: 'acc-1',
      account_email: 'one@example.invalid',
    },
    {
      event_key: 'e'.repeat(64),
      source_id: 's1',
      model: 'gemini-4-neon',
      input_tokens: 180_000,
      output_tokens: 20_000,
      cached_tokens: 0,
      total_tokens: 200_000,
      timestamp_seconds: twoDaysAgo,
      account_id: 'acc-1',
      account_email: 'one@example.invalid',
    },
  ];

  const report = buildUsageSummaryReport({
    allEvents: events,
    effectiveEvents: events,
    knownReceiptKeys: new Set(events.map((e) => e.event_key)),
    unattributedRequests: 0,
    unattributedTokens: 0,
    accountMap: new Map([['all', { id: 'all', label: 'All', type: 'all', total_tokens: 0, request_count: 0 }]]),
    accountId: 'all',
    accKey: 'all',
    now,
    rawPricing: {},
    pricing: {},
    calKey: todayStr,
    rateLocks: {},
    resolvePricing: () => null,
    lockedCost: () => null,
    dbPathsCount: 1,
    archivedDbCount: 0,
    lastDiscoveredDatabaseCount: 1,
    cachedDatabasesCount: 0,
    liveEventsCount: events.length,
    generationsScanned: events.length,
    skippedLargeRecords: 0,
    failedDatabasesCount: 0,
    diagnostics: [],
    ledgerCorrupt: false,
    archivedUnavailable: false,
    storageWarnings: new Set(),
    pricingWarnings: [],
  });

  const todayHour00 = report.today_hourly.find((h) => h.hour === `${todayStr} 00:00`);
  assert.ok(todayHour00);
  assert.equal(todayHour00.total_tokens, 869_000);
  assert.equal(todayHour00.request_count, 3);
  assert.deepEqual(todayHour00.by_model, [
    { model: 'gemini-4-neon', total_tokens: 669_000, request_count: 1 },
    { model: 'gemini-4-hydrogen', total_tokens: 200_000, request_count: 2 },
  ]);

  const todayDaily = report.daily_trends.find((d) => d.date === todayStr);
  assert.ok(todayDaily);
  assert.deepEqual(todayDaily.by_model, [
    { model: 'gemini-4-neon', total_tokens: 669_000, request_count: 1 },
    { model: 'gemini-4-hydrogen', total_tokens: 200_000, request_count: 2 },
    { model: 'claude-sonnet-4-6', total_tokens: 30_000, request_count: 1 },
  ]);

  const emptyDay = report.daily_trends.find((d) => d.total_tokens === 0 && d.request_count === 0);
  assert.ok(emptyDay);
  assert.equal(emptyDay.by_model, undefined);

  for (const bucket of [...report.daily_trends, ...report.today_hourly]) {
    if (bucket.request_count === 0) continue;
    assert.ok(Array.isArray(bucket.by_model) && bucket.by_model.length > 0);
    assert.equal(bucket.by_model.reduce((s, m) => s + m.total_tokens, 0), bucket.total_tokens);
    assert.equal(bucket.by_model.reduce((s, m) => s + m.request_count, 0), bucket.request_count);
  }

  const ledgerDir = join(sandbox, 'ledger');
  const ledger = new UsageLedger(ledgerDir, async (_path, run) => run());
  await ledger.save(events);
  const agg = await ledger.aggregate({
    prices: {},
    accountId: 'all',
    accounts: [
      { id: 'acc-1', email: 'one@example.invalid' },
      { id: 'acc-2', email: 'two@example.invalid' },
    ],
    now,
  });

  assert.deepEqual(agg.today_hourly.find((h) => h.hour === `${todayStr} 00:00`)?.by_model, todayHour00.by_model);
  assert.deepEqual(agg.daily_trends.find((d) => d.date === todayStr)?.by_model, todayDaily.by_model);
  assert.deepEqual(agg.daily_trends.find((d) => d.date === twoDaysAgoStr)?.by_model, [
    { model: 'gemini-4-neon', total_tokens: 200_000, request_count: 1 },
  ]);

  const db = new DatabaseSync(ledger.path, { readOnly: false });
  try {
    const acc1Agg = aggregateLedger(db, {
      prices: {},
      accountId: 'acc-1',
      accounts: [{ id: 'acc-1', email: 'one@example.invalid' }],
      now,
    });
    assert.deepEqual(acc1Agg.today_hourly.find((h) => h.hour === `${todayStr} 00:00`)?.by_model, [
      { model: 'gemini-4-neon', total_tokens: 669_000, request_count: 1 },
      { model: 'gemini-4-hydrogen', total_tokens: 150_000, request_count: 1 },
    ]);
  } finally {
    db.close();
  }

  const projToday = projectUsagePeriodSummary(agg, 'today', { includeAllPeriods: true });
  assert.deepEqual(projToday.todayHourly.find((h) => h.hour === `${todayStr} 00:00`)?.by_model, todayHour00.by_model);
  assert.deepEqual(projToday.periods['7d'].dailyTrends.find((d) => d.date === todayStr)?.by_model, todayDaily.by_model);

  const allPeriods = projectAllUsagePeriodSummaries(agg);
  assert.deepEqual(allPeriods.today.todayHourly.find((h) => h.hour === `${todayStr} 00:00`)?.by_model, todayHour00.by_model);
  assert.deepEqual(allPeriods['30d'].dailyTrends.find((d) => d.date === todayStr)?.by_model, todayDaily.by_model);

  const convDir = join(sandbox, 'gemini', 'antigravity', 'conversations');
  await mkdir(convDir, { recursive: true });
  const convDbPath = join(convDir, 'multi-model.db');
  const convDb = new DatabaseSync(convDbPath);
  try {
    convDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)');
    const mkBlob = (model, inp, out, ts) =>
      W.encodeLengthDelimited(
        1,
        Buffer.concat([
          W.encodeString(19, model),
          W.encodeLengthDelimited(
            4,
            Buffer.concat([W.encodeVarintField(2, inp), W.encodeVarintField(3, out)])
          ),
          W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, ts))),
        ])
      );
    const liveTs = Math.floor(Date.now() / 1000) - 60;
    const insertStmt = convDb.prepare('INSERT INTO gen_metadata VALUES(?,?)');
    insertStmt.run(0, mkBlob('gemini-4-neon', 500, 100, liveTs));
    insertStmt.run(1, mkBlob('gemini-4-hydrogen', 200, 50, liveTs));
    insertStmt.run(2, mkBlob('gemini-4-hydrogen', 100, 50, liveTs));
  } finally {
    convDb.close();
  }
  const manager = new LocalUsageStatsManager({ stateDir: join(sandbox, 'mgr-state'), geminiDir: join(sandbox, 'gemini') });
  const liveSummary = await manager.getUsageSummary(true);
  assert.equal(liveSummary.today_hourly.length, 1);
  assert.deepEqual(liveSummary.today_hourly[0].by_model, [
    { model: 'gemini-4-neon', total_tokens: 600, request_count: 1 },
    { model: 'gemini-4-hydrogen', total_tokens: 400, request_count: 2 },
  ]);
  assert.deepEqual(liveSummary.daily_trends.at(-1)?.by_model, [
    { model: 'gemini-4-neon', total_tokens: 600, request_count: 1 },
    { model: 'gemini-4-hydrogen', total_tokens: 400, request_count: 2 },
  ]);
});

test('UI charts share model colors, stacked hover tooltips work, and AppShellController preserves scroll & focus', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'agy-usage-charts-fe-'));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const ui = await bundleUiModules(sandbox);

  const byModel = [
    {
      model: 'gemini-4-hydrogen',
      promptTokens: 800_000,
      candidatesTokens: 100_000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 900_000,
      requestCount: 30,
      estimatedUsd: 1.2,
      priced: true,
      partiallyPriced: false,
      unpricedTokens: 0,
    },
    {
      model: 'gemini-4-neon',
      promptTokens: 500_000,
      candidatesTokens: 169_000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 669_000,
      requestCount: 10,
      estimatedUsd: 4.5,
      priced: true,
      partiallyPriced: false,
      unpricedTokens: 0,
    },
  ];
  const hourly = [
    {
      hour: '2026-11-23 00:00',
      input_tokens: 550_000,
      output_tokens: 120_000,
      cached_tokens: 0,
      total_tokens: 670_000,
      request_count: 34,
      by_model: [
        { model: 'gemini-4-neon', total_tokens: 669_000, request_count: 10 },
        { model: 'gemini-4-hydrogen', total_tokens: 1_000, request_count: 24 },
      ],
    },
  ];
  const daily = [
    {
      date: '2026-11-23',
      input_tokens: 550_000,
      output_tokens: 120_000,
      cached_tokens: 0,
      total_tokens: 670_000,
      request_count: 34,
      by_model: [
        { model: 'gemini-4-neon', total_tokens: 669_000, request_count: 10 },
        { model: 'gemini-4-hydrogen', total_tokens: 1_000, request_count: 24 },
      ],
    },
    {
      date: '2026-11-22',
      input_tokens: 40_000,
      output_tokens: 10_000,
      cached_tokens: 0,
      total_tokens: 50_000,
      request_count: 5,
    },
  ];

  const ordered = ui.collectOrderedChartModels(byModel, hourly);
  assert.deepEqual(ordered, ['gemini-4-neon', 'gemini-4-hydrogen']);
  const colorMap = ui.assignModelColors(ordered);
  assert.equal(colorMap.get('gemini-4-neon'), '#4F46E5');
  assert.equal(colorMap.get('gemini-4-hydrogen'), '#0D9488');

  const donutHtml = ui.renderCostDonutSvg(byModel, 5.7, colorMap);
  assert.ok(donutHtml.includes('stroke="#4F46E5"'));
  assert.ok(donutHtml.includes('stroke="#0D9488"'));

  const zhHourlyTokenChart = ui.renderStackedTrendChartSvg(
    ui.buildStackedHourlyBars(hourly, 'tokens', colorMap),
    { width: 720, height: 184, dim: 'tokens', colorMap }
  );
  assert.ok(/<rect[^>]*fill="#4F46E5"[^>]*data-tip="今日 00:00 · gemini-4-neon · 669K Token"/.test(zhHourlyTokenChart.svg));
  assert.ok(/<rect[^>]*fill="#0D9488"[^>]*data-tip="今日 00:00 · gemini-4-hydrogen · 1K Token"/.test(zhHourlyTokenChart.svg));
  for (const m of zhHourlyTokenChart.svg.matchAll(/<rect class="gb-chart-bar active"[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)) {
    assert.ok(Number(m[1]) >= 14);
    assert.ok(Number(m[2]) >= 3);
  }

  const zhHourlyReqChart = ui.renderStackedTrendChartSvg(
    ui.buildStackedHourlyBars(hourly, 'requests', colorMap),
    { width: 720, height: 184, dim: 'requests', colorMap }
  );
  assert.ok(/<rect[^>]*fill="#0D9488"[^>]*data-tip="今日 00:00 · gemini-4-hydrogen · 24 次请求"/.test(zhHourlyReqChart.svg));

  const usageHtml = ui.renderUsageView({
    period: 'today',
    accountId: 'all',
    dim: 'tokens',
    usage: {
      ok: true,
      period: 'today',
      selectedAccountId: 'all',
      availableAccounts: [],
      summary: {
        totalTokens: 670_000,
        promptTokens: 550_000,
        candidatesTokens: 120_000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        requestCount: 34,
        estimatedUsd: 5.7,
        cacheHitRate: 0,
        databasesScanned: 1,
        databasesDiscovered: 1,
        scanScopeDescription: '1 DB',
        pricedModels: 2,
        unpricedModels: 0,
        failedDatabasesCount: 0,
        skippedLargeRecords: 0,
        lastScannedAt: 1700000000,
        hasError: false,
        availability: 'complete',
        unknownTimeRecords: 0,
        unknownTimeTokens: 0,
      },
      byModel,
      dailyTrends: daily,
      todayHourly: hourly,
    },
    events: null,
    eventsQuery: '',
    eventsOffset: 0,
    pricingStatus: { autoSyncEnabled: false, lastSyncAt: 0, lastCheckAt: 0, lastSyncSuccess: false, lastCheckSuccess: false, lastSyncError: null, feedVersion: '2026-11-19-r2', sourceUrl: '', modelCount: 20 },
    busyAction: null,
  });

  assert.equal(usageHtml.includes('模型用量'), false);
  assert.equal(usageHtml.includes('By Model'), false);
  assert.ok(usageHtml.includes('data-usage-period="session"'));
  assert.ok(usageHtml.includes('本对话'));
  assert.ok(usageHtml.includes('data-default-tip='));
  assert.ok(usageHtml.includes('gb-chart-legend'));
  assert.ok(usageHtml.includes('stroke="#4F46E5"') && usageHtml.includes('fill="#4F46E5"'));

  const sessionUsageHtml = ui.renderUsageView({
    period: 'session',
    accountId: 'all',
    dim: 'tokens',
    usage: {
      ok: true,
      period: 'session',
      selectedAccountId: 'all',
      availableAccounts: [],
      sessionSingleDay: true,
      sessionDateLabel: '11-26',
      conversationId: 'conv-1',
      conversationTitle: 'Current Task',
      memberCount: 2,
      summary: {
        totalTokens: 670_000,
        promptTokens: 550_000,
        candidatesTokens: 120_000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        requestCount: 34,
        estimatedUsd: 5.7,
        cacheHitRate: 0,
        databasesScanned: 1,
        databasesDiscovered: 1,
        scanScopeDescription: '1 DB',
        pricedModels: 2,
        unpricedModels: 0,
        failedDatabasesCount: 0,
        skippedLargeRecords: 0,
        lastScannedAt: 1700000000,
        hasError: false,
        availability: 'complete',
        unknownTimeRecords: 0,
        unknownTimeTokens: 0,
      },
      byModel,
      dailyTrends: daily,
      todayHourly: hourly,
    },
    events: null,
    eventsQuery: '',
    eventsOffset: 0,
    pricingStatus: { autoSyncEnabled: false, lastSyncAt: 0, lastCheckAt: 0, lastSyncSuccess: false, lastCheckSuccess: false, lastSyncError: null, feedVersion: '2026-11-19-r2', sourceUrl: '', modelCount: 20 },
    busyAction: null,
    conversations: [
      { conversationId: 'conv-1', title: 'Current Task', status: 'running', lastActiveAt: 1700000000, childCount: 2 },
    ],
  });
  assert.equal(sessionUsageHtml.includes('data-usage-conversation'), false);
  assert.ok(sessionUsageHtml.includes('本对话趋势'));

  const allUsageHtml = ui.renderUsageView({
    period: 'all',
    accountId: 'all',
    dim: 'tokens',
    usage: {
      ok: true,
      period: 'all',
      selectedAccountId: 'all',
      availableAccounts: [],
      summary: {
        totalTokens: 670_000,
        promptTokens: 550_000,
        candidatesTokens: 120_000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        requestCount: 34,
        estimatedUsd: 5.7,
        cacheHitRate: 0,
        databasesScanned: 1,
        databasesDiscovered: 1,
        scanScopeDescription: '1 DB',
        pricedModels: 2,
        unpricedModels: 0,
        failedDatabasesCount: 0,
        skippedLargeRecords: 0,
        lastScannedAt: 1700000000,
        hasError: false,
        availability: 'complete',
        unknownTimeRecords: 0,
        unknownTimeTokens: 0,
      },
      byModel,
      dailyTrends: daily,
      todayHourly: hourly,
    },
    events: null,
    eventsQuery: '',
    eventsOffset: 0,
    pricingStatus: { autoSyncEnabled: false, lastSyncAt: 0, lastCheckAt: 0, lastSyncSuccess: false, lastCheckSuccess: false, lastSyncError: null, feedVersion: '2026-11-19-r2', sourceUrl: '', modelCount: 20 },
    busyAction: null,
    conversations: [
      { conversationId: 'conv-1', title: 'Current Task', status: 'running', lastActiveAt: 1700000000, childCount: 2 },
    ],
    usageAllConversationId: 'all',
  });
  assert.ok(allUsageHtml.includes('data-usage-conversation'));
  assert.ok(allUsageHtml.includes('全部对话'));

  const mcpCaps = ui.getUiCapabilities('mcp-app');
  assert.deepEqual(mcpCaps.visibleViews, ['overview', 'context', 'usage', 'storage', 'settings', 'about']);
  assert.equal(ui.resolveAllowedView('quota', mcpCaps), 'overview');
  assert.equal(ui.resolveAllowedView('unknown', mcpCaps), 'overview');

  const { app, doc, win } = createMockDom();
  const shell = new ui.AppShellController(app, doc, win);
  const baseSidebar = {
    activeView: 'usage',
    status: { mode: 'mcp-direct', message: '纯本地只读模式已就绪', locale: 'zh-Hans', pid: 1001, rssMB: 50, windows: 0 },
    serviceError: null,
    busyAction: null,
    capabilities: mcpCaps,
    brandTitle: 'agy-usage-tool',
  };
  shell.ensureMounted(baseSidebar);
  assert.equal(app.innerHTMLWriteCount, 1);
  assert.equal(app.innerHTML.includes('gb-brand-sub'), false);
  const sidebarFooter = app.querySelector('#gb-sidebar-footer');
  assert.equal(sidebarFooter?.hidden, true);

  const mainEl = shell.getMainElement();
  const viewHostEl = shell.getViewHostElement();
  assert.ok(mainEl && viewHostEl);

  shell.patchMainView({ html: '<div class="gb-card"><input data-events-search /></div>', resetScroll: true });
  mainEl.scrollTop = 420;
  doc.documentElement.scrollTop = 180;
  const searchInput = viewHostEl.querySelector('[data-events-search]');
  doc.activeElement = searchInput;
  searchInput.setSelectionRange(2, 5, 'forward');

  shell.patchToasts([{ id: 1, text: 'Saved' }]);
  shell.patchSidebar({ ...baseSidebar, status: { ...baseSidebar.status, message: 'Updated' } });
  assert.equal(app.innerHTMLWriteCount, 1);
  assert.equal(shell.getMainElement(), mainEl);
  assert.equal(mainEl.scrollTop, 420);

  const fpA = ui.computeStatusFingerprint(baseSidebar.status, null);
  const fpB = ui.computeStatusFingerprint({ ...baseSidebar.status, rssMB: 99, windows: 0 }, null);
  assert.equal(fpA, fpB);
  assert.notEqual(fpA, ui.computeStatusFingerprint({ ...baseSidebar.status, mode: 'error' }, null));

  assert.equal(
    shell.patchMainView({ html: '<div class="gb-card"><input data-events-search /><span>row2</span></div>', resetScroll: false }),
    true
  );
  assert.equal(mainEl.scrollTop, 420);
  assert.equal(doc.documentElement.scrollTop, 180);
  const nextSearch = viewHostEl.querySelector('[data-events-search]');
  assert.equal(doc.activeElement, nextSearch);
  assert.deepEqual(nextSearch.focusCalls[0], { preventScroll: true });
  assert.equal(nextSearch.selectionStart, 2);
  assert.equal(nextSearch.selectionEnd, 5);

  shell.patchMainView({ html: '<div>Overview</div>', resetScroll: true });
  assert.equal(mainEl.scrollTop, 0);

  shell.patchSidebar({ ...baseSidebar, status: { ...baseSidebar.status, mode: 'error', message: 'Offline' } });
  assert.equal(sidebarFooter?.hidden, false);

  const mainTs = await readFile(join(repoRoot, 'ui', 'src', 'main.ts'), 'utf8');
  assert.equal(mainTs.includes('root.innerHTML'), false);
  assert.equal(mainTs.includes('AppShellController'), true);
  assert.equal(mainTs.includes('overviewContextSnapshot'), true);
  assert.equal(mainTs.includes('loadOverviewContextData'), true);
  assert.equal(mainTs.includes('pinnedConversationId'), true);
});
