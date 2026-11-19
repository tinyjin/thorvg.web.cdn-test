import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServers, preparePackage, hostRules, loadSuite, resolveSource, selectCases, describePackage, describeCdn } from './server.mjs';

const [suiteName, ...argv] = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const PLAY_TIMEOUT = Number(option('timeout', 30000));
const FAIL_TIMEOUT = 10000;

function launchArgs(cdnPort) {
  return [
    ...(cdnPort ? [hostRules(cdnPort), '--ignore-certificate-errors'] : []),
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--ignore-gpu-blocklist',
    '--use-gl=angle',
  ];
}

async function capture(page, selector) {
  const png = await page.locator(selector).screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) ink++;
      hash = (hash * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) | 0;
    }
    return { ink: ink / (data.length / 4), hash };
  }, png.toString('base64'));
}

const pageInfo = (page) => page.evaluate(() => ({
  ...window.__status(),
  isolated: globalThis.crossOriginIsolated,
  errors: window.__errors ?? [],
}));

async function runCase(browser, suite, c, origin, version, live) {
  const context = await browser.newContext({ ignoreHTTPSErrors: !live, viewport: { width: 480, height: 400 } });
  const page = await context.newPage();
  const ev = { errors: [], console: [], bad: [], requests: [], workers: [] };

  page.on('pageerror', (e) => ev.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && ev.console.push(m.text()));
  page.on('requestfailed', (r) => ev.bad.push(`${r.failure()?.errorText} ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && ev.bad.push(`${r.status()} ${r.url()}`));
  page.on('request', (r) => ev.requests.push(r.url()));
  page.on('worker', (w) => {
    ev.workers.push(w.url());
    w.on('console', (m) => m.type() === 'error' && ev.console.push(`[worker] ${m.text()}`));
  });

  const result = { case: c, status: 'PASS', problems: [], info: {} };
  const problem = (msg) => result.problems.push(msg);

  try {
    await page.goto(`${origin}/case/${c.id}`, { waitUntil: 'load' });

    if (c.renderer === 'wg') {
      const adapter = await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter()));
      if (!adapter) {
        result.status = 'SKIP';
        result.problems.push('no WebGPU adapter in this browser');
        return result;
      }
    }

    const settled = await page.waitForFunction(() => {
      const s = window.__status();
      return s.state === 'error' || (s.state === 'playing' && s.totalFrame > 0);
    }, null, { timeout: c.expect === 'play' ? PLAY_TIMEOUT : FAIL_TIMEOUT, polling: 100 }).then(() => true, () => false);

    const first = await pageInfo(page);
    result.info = { ...first, workers: ev.workers.length };

    if (c.expect === 'fail') {
      if (first.state === 'playing') problem('expected to fail without cross-origin isolation but it played');
      if (first.isolated) problem('page is unexpectedly cross-origin isolated');
      result.status = result.problems.length ? 'FAIL' : 'XFAIL';
      result.info.observed = [...new Set([...ev.errors, ...first.errors, ...ev.console])].slice(0, 3);
      if (!settled) result.info.observed.push(`stayed in '${first.state}' (no error state surfaced)`);
      return result;
    }

    if (!settled) problem(`did not start playing within ${PLAY_TIMEOUT}ms (state: ${first.state})`);
    if (first.state === 'error') problem('entered the error state');

    if (settled && first.state === 'playing') {
      const before = await capture(page, suite.selector);
      await page.waitForTimeout(700);
      const second = await pageInfo(page);
      const after = await capture(page, suite.selector);
      if (second.frame === first.frame) problem(`frame did not advance (${first.frame})`);
      const ink = Math.max(before.ink, after.ink);
      result.info.ink = Number(ink.toFixed(3));
      if (ink < 0.001) problem(`canvas looks empty (ink ratio ${ink.toFixed(4)})`);
      if (before.hash === after.hash) problem('canvas did not change between captures');
    }

    const expectedWasm = suite.wasmUrl(c, version);
    const wasmRequests = ev.requests.filter((u) => u.endsWith('.wasm'));
    if (!wasmRequests.includes(expectedWasm)) problem(`wasm not requested from ${expectedWasm}`);
    const strayWasm = wasmRequests.filter((u) => u !== expectedWasm);
    if (strayWasm.length) problem(`unexpected wasm requests: ${strayWasm.join(', ')}`);
    if (ev.requests.some((u) => /\/thorvg\.js(\?|$)/.test(u))) problem('requested thorvg.js (not published)');

    if (c.preset === 'thread') {
      if (!first.isolated) problem('page is not cross-origin isolated');
      const minWorkers = suite.minWorkers(c);
      if (ev.workers.length < minWorkers) problem(`spawned ${ev.workers.length} workers, expected >= ${minWorkers}`);
      const sameOrigin = c.cdn === 'self';
      const wrongKind = ev.workers.filter((u) => (sameOrigin ? !u.startsWith(origin) : !u.startsWith('blob:')));
      if (wrongKind.length) problem(`worker URL is not ${sameOrigin ? 'the same-origin bundle' : 'a blob'}: ${wrongKind[0]}`);
    }

    const errors = [...ev.errors, ...first.errors];
    if (errors.length) problem(`page errors: ${[...new Set(errors)].join(' | ')}`);
    const bad = ev.bad.filter((b) => !b.includes('favicon'));
    if (bad.length) problem(`failed requests: ${[...new Set(bad)].join(' | ')}`);
    if (ev.console.length) result.info.console = [...new Set(ev.console)].slice(0, 3);

    result.status = result.problems.length ? 'FAIL' : 'PASS';
    return result;
  } catch (e) {
    result.status = 'FAIL';
    problem(`harness error: ${e.message}`);
    return result;
  } finally {
    await context.close();
  }
}

function report(r) {
  const { case: c, status, problems, info } = r;
  const extra = [
    info.state && `state=${info.state}`,
    info.totalFrame && `frames=${Math.round(info.totalFrame)}`,
    info.ink !== undefined && `ink=${info.ink}`,
    c.preset === 'thread' && `isolated=${info.isolated} workers=${info.workers}`,
  ].filter(Boolean).join(' ');
  console.log(`${status.padEnd(5)} ${c.id.padEnd(46)} ${extra}`);
  for (const p of problems) console.log(`      - ${p}`);
  for (const o of info.observed ?? []) console.log(`      ~ ${o}`);
  for (const m of info.console ?? []) console.log(`      ! console: ${m}`);
}

async function pool(items, size, fn) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      const r = await fn(item);
      report(r);
      results.push(r);
    }
  }));
  return results;
}

async function main() {
  if (!suiteName) throw new Error('usage: node src/run.mjs <webcanvas|lottie-player> [--live [version] | --pack <dir> | --dist <dir>] [--filter s] [--headed] [--concurrency n]');
  const suite = await loadSuite(suiteName);
  const source = resolveSource(suite.pkgName, option);

  const live = source.kind === 'live';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvg-cdn-sim-'));
  const pkgDir = preparePackage(source, tmp, suite.pkgName);
  const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const cases = selectCases(suite, source, version, option('filter', ''));

  if (flag('list')) {
    for (const c of cases) console.log(c.id);
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }

  const servers = await startServers({ suite, pkgDir, version, cases, live });

  console.log(describePackage(source, suite, version));
  console.log(describeCdn(servers));
  console.log(`pages   : ${servers.origin}\n`);

  const browser = await chromium.launch({ headless: !flag('headed'), args: launchArgs(servers.cdnPort) });
  const results = await pool(cases, Number(option('concurrency', 4)), (c) => runCase(browser, suite, c, servers.origin, version, live));

  const cdnErrors = servers.log.filter((l) => l.host !== 'localhost' && l.status >= 400);
  if (cdnErrors.length) {
    console.log('\nCDN mock 4xx/5xx (includes worker requests):');
    for (const l of cdnErrors) console.log(`  ${l.status} https://${l.host}${l.path}`);
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count('PASS')} passed, ${count('XFAIL')} expected failures, ${count('SKIP')} skipped, ${count('FAIL')} failed (${results.length} total)`);

  await browser.close();
  servers.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = count('FAIL') || cdnErrors.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
