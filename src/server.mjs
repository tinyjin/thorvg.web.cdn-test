import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const CDN_HEADERS = {
  unpkg: {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-expose-headers': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=31536000',
  },
  jsdelivr: {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': '*',
    'timing-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable',
  },
};

export const ISO_HEADERS = {
  none: {},
  'require-corp': { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' },
  credentialless: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' },
};

export function cdnUrl(cdn, pkgName, version, file, origin = '') {
  switch (cdn) {
    case 'unpkg': return `https://unpkg.com/${pkgName}@${version}/${file}`;
    case 'unpkg-latest': return `https://unpkg.com/${pkgName}@latest/${file}`;
    case 'jsdelivr': return `https://cdn.jsdelivr.net/npm/${pkgName}@${version}/${file}`;
    case 'esmsh': return `https://esm.sh/${pkgName}@${version}${file ? `/${file}` : ''}`;
    case 'self': return `${origin}/node_modules/${pkgName}/${file}`;
  }
  throw new Error(`unknown cdn: ${cdn}`);
}

const mimeOf = (file, cdn) => {
  const ext = path.extname(file);
  if (cdn === 'jsdelivr' && ext === '.js') return 'application/javascript; charset=utf-8';
  return MIME[ext] ?? 'application/octet-stream';
};

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function readPackageFile(pkgDir, file) {
  const full = path.resolve(pkgDir, file);
  if (!full.startsWith(pkgDir + path.sep)) return null;
  try {
    return fs.statSync(full).isFile() ? fs.readFileSync(full) : null;
  } catch {
    return null;
  }
}

export function preparePackage(source, tmp, pkgName) {
  if (source.kind === 'dist') return source.dir;
  if (source.kind === 'live') {
    try {
      execFileSync('npm', ['pack', `${pkgName}@${source.version}`, '--pack-destination', tmp], { stdio: 'ignore' });
    } catch {
      throw new Error(`${pkgName}@${source.version} is not published on npm`);
    }
  } else {
    execFileSync('npm', ['pack', '--pack-destination', tmp], { cwd: source.dir, stdio: 'ignore' });
  }
  const tarball = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('pack produced no tarball');
  execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', tmp]);
  return path.join(tmp, 'package');
}

export function latestVersion(pkgName) {
  return execFileSync('npm', ['view', pkgName, 'version'], { encoding: 'utf8' }).trim();
}

export function resolveSource(pkgName, option) {
  const pack = option('pack', null);
  const dist = option('dist', null);
  if (pack) return { kind: 'pack', dir: path.resolve(pack) };
  if (dist) return { kind: 'dist', dir: path.resolve(dist) };
  const latest = latestVersion(pkgName);
  const requested = option('live', null);
  return { kind: 'live', version: requested ?? latest, latest };
}

export function hostRules(cdnPort) {
  return `--host-resolver-rules=MAP unpkg.com:443 127.0.0.1:${cdnPort}, MAP cdn.jsdelivr.net:443 127.0.0.1:${cdnPort}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`;
}

export function describePackage(source, suite, version) {
  const label = { live: 'published npm tarball', pack: `packed from ${source.dir}`, dist: `unpacked ${source.dir}` }[source.kind];
  return `package : ${label} ${suite.pkgName}@${version}`;
}

export function describeCdn(servers) {
  return servers.cdnPort
    ? `cdn     : https://unpkg.com, https://cdn.jsdelivr.net -> 127.0.0.1:${servers.cdnPort} (simulated)`
    : 'cdn     : https://unpkg.com, https://cdn.jsdelivr.net, https://esm.sh (live)';
}

export function selectCases(suite, source, version, filter = '') {
  const live = source.kind === 'live';
  return suite.buildCases({ live })
    .filter((c) => !(live && c.cdn === 'unpkg-latest' && version !== source.latest))
    .filter((c) => c.id.includes(filter));
}

function createCertificate(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=unpkg.com',
    '-addext', 'subjectAltName=DNS:unpkg.com,DNS:cdn.jsdelivr.net',
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function cdnHandler({ suite, pkgDir, version, log }) {
  return (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const cdn = host === 'unpkg.com' ? 'unpkg' : host === 'cdn.jsdelivr.net' ? 'jsdelivr' : null;
    const { pathname } = new URL(req.url, `https://${host}`);
    const send = (status, body, headers = {}) => {
      log.push({ host, path: pathname, status });
      res.writeHead(status, { ...(cdn ? CDN_HEADERS[cdn] : {}), ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (!cdn) return send(421, 'unknown host');
    if (req.method === 'OPTIONS') return send(204);

    const prefix = cdn === 'unpkg' ? `/${suite.pkgName}@` : `/npm/${suite.pkgName}@`;
    if (!pathname.startsWith(prefix)) return send(404, 'not found');

    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const spec = slash < 0 ? rest : rest.slice(0, slash);
    const file = slash < 0 ? '' : decodeURIComponent(rest.slice(slash + 1));
    const resolvable = spec === version || spec === 'latest' || version.startsWith(`${spec}.`);

    if (!resolvable) return send(404, `version ${spec} not found`);
    if (spec !== version && cdn === 'unpkg') {
      return send(302, '', { location: `${prefix}${version}/${file}` });
    }

    const body = readPackageFile(pkgDir, file);
    if (!body) return send(404, `file ${file} not found in package`);
    send(200, body, { 'content-type': mimeOf(file, cdn) });
  };
}

function casePage(suite, c, version, origin, prev, next) {
  const { html, code, scripts } = suite.page(c, { version, origin });
  const headers = Object.entries(ISO_HEADERS[c.iso]).map(([k, v]) => `${k.replace(/(^|-)\w/g, (m) => m.toUpperCase())}: ${v}`);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.id}</title>
<style>
  body { margin: 0; background: #fff; color: #222; font: 12px monospace; }
  nav { padding: 8px 16px; border-bottom: 1px solid #ddd; }
  nav a { margin-right: 12px; }
  .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; padding: 16px; }
  @media (max-width: 720px) { .layout { grid-template-columns: minmax(0, 1fr); } }
  lottie-player, canvas { display: block; }
  h4 { margin: 0 0 6px; font-size: 12px; color: #666; }
  pre { margin: 0 0 12px; white-space: pre-wrap; word-break: break-all; }
  .code { padding: 12px; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 4px; word-break: normal; overflow-wrap: anywhere; }
  #status { padding: 8px; border: 1px solid #ccc; }
  #status.ok { border-color: #2a2; background: #efe; }
  #status.bad { border-color: #c22; background: #fee; }
</style>
<script>
  window.__errors = [];
  addEventListener('error', (e) => __errors.push(String(e.message || e)));
  addEventListener('unhandledrejection', (e) => __errors.push(String((e.reason && e.reason.message) || e.reason)));
  window.__status = () => {
    const probe = window.__probe && window.__probe();
    const state = probe ? probe.state : (window.__errors.length ? 'error' : 'loading');
    return { state, frame: probe ? probe.frame : undefined, totalFrame: probe ? probe.totalFrame : undefined };
  };
</script>
</head>
<body>
<nav>${prev ? `<a href="/case/${prev}">&larr; prev</a>` : ''}<a href="/">index</a>${next ? `<a href="/case/${next}">next &rarr;</a>` : ''}<b>${c.id}</b></nav>
<div class="layout">
<div>
${html}
<h4>expect: ${c.expect === 'play' ? 'plays' : 'fails (no cross-origin isolation)'}</h4>
<pre id="status"></pre>
</div>
<div>
<h4>Page response headers</h4>
<pre class="code">${headers.length ? headers.join('\n') : '(none)'}</pre>
<h4>HTML</h4>
<pre class="code">${escapeHtml(code)}</pre>
</div>
</div>
<script>
  setInterval(() => {
    const s = window.__status();
    const wasm = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.endsWith('.wasm'));
    const playing = s.state === 'playing' && s.totalFrame > 0;
    const status = document.getElementById('status');
    status.className = ${c.expect === 'play'} ? (playing ? 'ok' : s.state === 'error' ? 'bad' : '') : (playing ? 'bad' : 'ok');
    status.textContent = [
      'state    : ' + s.state,
      'frame    : ' + (s.totalFrame ? s.frame.toFixed(1) + ' / ' + s.totalFrame : '-'),
      'isolated : ' + globalThis.crossOriginIsolated,
      'wasm     : ' + (wasm.join(', ') || '-'),
      'errors   : ' + (window.__errors.join(' | ') || '-'),
    ].join('\\n');
  }, 250);
</script>
${scripts}
</body>
</html>`;
}

function indexPage(suite, cases) {
  const rows = cases.map((c) => `<li><a href="/case/${c.id}">${c.id}</a>${c.expect === 'fail' ? ' (expected to fail)' : ''}</li>`).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${suite.pkgName} CDN cases</title>
<style>body { font: 13px monospace; padding: 16px; } li { margin: 2px 0; }</style></head>
<body><h3>${suite.pkgName} CDN simulation</h3><ul>${rows}</ul></body></html>`;
}

function pageHandler({ suite, pkgDir, version, cases, log }) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const ids = cases.map((c) => c.id);
  const caseOf = (req, pathname) => {
    if (pathname.startsWith('/case/')) return byId.get(pathname.slice(6));
    try {
      const ref = new URL(req.headers.referer ?? '');
      return ref.pathname.startsWith('/case/') ? byId.get(ref.pathname.slice(6)) : undefined;
    } catch {
      return undefined;
    }
  };

  return (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const c = caseOf(req, pathname);
    const send = (status, body, type) => {
      log.push({ host: 'localhost', path: pathname, status });
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...ISO_HEADERS[c?.iso ?? 'none'] });
      res.end(body);
    };

    if (pathname === '/') return send(200, indexPage(suite, cases), MIME['.html']);
    if (pathname === '/favicon.ico') return send(204, '', 'image/x-icon');
    if (pathname === '/assets/animation.json') return send(200, fs.readFileSync(suite.animation), MIME['.json']);
    if (pathname.startsWith('/case/')) {
      if (!c) return send(404, 'unknown case', 'text/plain');
      const i = ids.indexOf(c.id);
      return send(200, casePage(suite, c, version, `http://${req.headers.host}`, ids[i - 1], ids[i + 1]), MIME['.html']);
    }

    const selfPrefix = `/node_modules/${suite.pkgName}/`;
    if (pathname.startsWith(selfPrefix)) {
      const file = decodeURIComponent(pathname.slice(selfPrefix.length));
      const body = readPackageFile(pkgDir, file);
      return body ? send(200, body, mimeOf(file)) : send(404, 'not found', 'text/plain');
    }

    send(404, 'not found', 'text/plain');
  };
}

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server.address().port));
});

export async function startServers({ suite, pkgDir, version, cases, pagePort = 0, cdnPort = 0, live = false }) {
  const log = [];
  const page = http.createServer(pageHandler({ suite, pkgDir, version, cases, log }));
  let cdn = null;
  let certDir = null;
  let actualCdnPort = null;

  if (!live) {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvg-cdn-cert-'));
    cdn = https.createServer(createCertificate(certDir), cdnHandler({ suite, pkgDir, version, log }));
    actualCdnPort = await listen(cdn, cdnPort);
  }
  const actualPagePort = await listen(page, pagePort);

  return {
    log,
    cdnPort: actualCdnPort,
    origin: `http://localhost:${actualPagePort}`,
    close: () => {
      cdn?.close();
      page.close();
      if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
    },
  };
}

export const SUITES = ['webcanvas', 'lottie-player'];

export async function loadSuite(name) {
  if (!SUITES.includes(name)) throw new Error(`unknown suite: ${name} (expected ${SUITES.join(' or ')})`);
  return (await import(new URL(`../suites/${name}.mjs`, import.meta.url))).default;
}
