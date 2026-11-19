import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServers, preparePackage, hostRules, loadSuite, resolveSource, selectCases, describePackage, describeCdn } from './server.mjs';

const CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
};

const [suiteName, ...argv] = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

if (!suiteName) {
  console.error('usage: node src/serve.mjs <webcanvas|lottie-player> [--live [version] | --pack <dir> | --dist <dir>] [--port n] [--cdn-port n] [--no-launch] [--chrome path]');
  process.exit(1);
}

const suite = await loadSuite(suiteName);
const source = resolveSource(suite.pkgName, option);
const live = source.kind === 'live';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvg-cdn-serve-'));
const pkgDir = preparePackage(source, tmp, suite.pkgName);
const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const cases = selectCases(suite, source, version);
const servers = await startServers({
  suite,
  pkgDir,
  version,
  cases,
  pagePort: Number(option('port', 8080)),
  cdnPort: Number(option('cdn-port', 8443)),
  live,
});

const chromeArgs = [
  `--user-data-dir=${path.join(tmp, 'chrome-profile')}`,
  ...(servers.cdnPort ? [hostRules(servers.cdnPort), '--ignore-certificate-errors'] : []),
  '--enable-unsafe-webgpu',
  '--no-first-run',
  '--no-default-browser-check',
  servers.origin,
];

console.log(describePackage(source, suite, version));
console.log(describeCdn(servers));
console.log(`pages   : ${servers.origin} (${cases.length} cases)\n`);

const chromePath = option('chrome', (CHROME[process.platform] ?? []).find((p) => fs.existsSync(p)));
let chrome = null;

if (!flag('no-launch') && chromePath) {
  chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });
  chrome.on('exit', () => console.log('Chrome closed. The servers keep running until Ctrl+C.'));
  console.log(servers.cdnPort ? 'Opened a separate Chrome profile with the CDN mapping. Other Chrome windows are not affected.' : 'Opened a separate Chrome profile against the live CDNs.');
} else {
  console.log(servers.cdnPort ? 'Open a browser with the CDN mapping yourself:' : 'Open a browser yourself:');
  console.log(`  "${chromePath ?? '<chrome>'}" ${chromeArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
}
console.log('Press Ctrl+C to stop.');

process.on('SIGINT', () => {
  chrome?.kill();
  servers.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
});
