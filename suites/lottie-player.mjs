import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdnUrl } from '../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = '@thorvg/lottie-player';
const PRESETS = ['default', 'sw', 'gl', 'wg', 'sw-lite', 'gl-lite', 'wg-lite'];

const rendererOf = (preset) => (preset === 'default' ? 'sw' : preset.replace('-lite', ''));

const caseId = (c) => [
  c.preset === 'default' && c.renderer !== 'sw' ? `${c.preset}-${c.renderer}` : c.preset,
  c.cdn,
  c.format,
  c.iso,
  ...(c.preset === 'thread' ? [`t${c.threads ?? 'default'}`] : []),
].join('.');

function buildCases({ live = false } = {}) {
  const cases = [];
  const add = (c) => cases.push({ ...c, id: caseId(c) });

  for (const iso of ['none', 'require-corp']) {
    for (const preset of PRESETS) {
      for (const [cdn, format] of [['unpkg', 'esm'], ['unpkg', 'umd'], ['jsdelivr', 'esm'], ...(live ? [['esmsh', 'esm']] : [])]) {
        add({ preset, renderer: rendererOf(preset), cdn, format, iso, expect: 'play' });
      }
    }
    for (const renderer of ['gl', 'wg']) {
      add({ preset: 'default', renderer, cdn: 'unpkg', format: 'esm', iso, expect: 'play' });
      add({ preset: 'default', renderer, cdn: 'unpkg', format: 'umd', iso, expect: 'play' });
    }
  }

  for (const format of ['esm', 'umd']) {
    add({ preset: 'default', renderer: 'sw', cdn: 'unpkg-latest', format, iso: 'none', expect: 'play' });
  }

  for (const iso of ['none', 'require-corp', 'credentialless']) {
    for (const cdn of ['unpkg', 'unpkg-latest', 'jsdelivr', 'self', ...(live ? ['esmsh'] : [])]) {
      add({ preset: 'thread', renderer: 'sw', cdn, format: 'esm', iso, threads: 4, expect: iso === 'none' ? 'fail' : 'play' });
    }
  }
  for (const threads of [undefined, 1, 8]) {
    add({ preset: 'thread', renderer: 'sw', cdn: 'unpkg', format: 'esm', iso: 'require-corp', threads, expect: 'play' });
  }

  return cases;
}

const distDir = (c) => (c.preset === 'default' ? 'dist' : `dist/${c.preset}`);

function page(c, { version, origin }) {
  const file = c.cdn === 'esmsh' ? (c.preset === 'default' ? '' : c.preset) : `${distDir(c)}/${c.format === 'umd' ? 'lottie-player.js' : 'lottie-player.esm.js'}`;
  const src = cdnUrl(c.cdn, PKG, version, file);
  const renderConfig = c.preset === 'default' ? ` renderConfig='${JSON.stringify({ renderer: c.renderer })}'` : '';
  const player = `<lottie-player\n  src="${origin}/assets/animation.json"\n  autoplay\n  loop${renderConfig ? `\n ${renderConfig}` : ''}\n  style="width: 300px; height: 300px;">\n</lottie-player>`;
  const script = c.format === 'umd'
    ? `<script src="${src}"></script>`
    : c.preset === 'thread' && c.threads !== undefined
      ? `<script type="module">\n  import { setThreadCount } from "${src}";\n  setThreadCount(${c.threads});\n</script>`
      : `<script type="module">\n  import "${src}";\n</script>`;
  const probe = `<script>
  window.__probe = () => {
    const el = document.querySelector('lottie-player');
    return el && { state: el.currentState, frame: el.currentFrame, totalFrame: el.totalFrame };
  };
</script>`;

  return {
    html: player,
    code: `${c.cdn === 'self' ? `<!-- package served from this origin at /node_modules/${PKG}/ -->\n` : ''}${player}\n\n${script}`,
    scripts: `${probe}\n${script}`,
  };
}

export default {
  pkgName: PKG,
  animation: path.resolve(here, '../assets/animation.json'),
  selector: 'lottie-player',
  buildCases,
  page,
  wasmUrl: (c, version) => `https://unpkg.com/${PKG}@${version}/${distDir(c)}/thorvg.wasm`,
  minWorkers: (c) => (c.threads ? 2 * c.threads - 1 : 0),
};
