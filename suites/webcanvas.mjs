import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdnUrl } from '../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = '@thorvg/webcanvas';

const caseId = (c) => [
  `${c.preset}-${c.renderer}`,
  c.cdn,
  c.format,
  c.iso,
  ...(c.preset === 'thread' ? [`t${c.threads ?? 'default'}`] : []),
].join('.');

function buildCases({ live = false } = {}) {
  const cases = [];
  const add = (c) => cases.push({ ...c, id: caseId(c) });

  for (const iso of ['none', 'require-corp']) {
    for (const renderer of ['sw', 'gl', 'wg']) {
      for (const [cdn, format] of [['unpkg', 'esm'], ['unpkg', 'umd'], ['jsdelivr', 'esm'], ...(live ? [['esmsh', 'esm']] : [])]) {
        add({ preset: 'default', renderer, cdn, format, iso, expect: 'play' });
      }
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
  for (const renderer of ['gl', 'wg']) {
    add({ preset: 'thread', renderer, cdn: 'unpkg', format: 'esm', iso: 'require-corp', threads: 4, expect: 'play' });
  }

  return cases;
}

const distDir = (c) => (c.preset === 'default' ? 'dist' : `dist/${c.preset}`);

const indent = (text, pad) => text.split('\n').map((line) => (line ? pad + line : line)).join('\n');

function page(c, { version, origin }) {
  const file = c.cdn === 'esmsh' ? (c.preset === 'default' ? '' : c.preset) : `${distDir(c)}/${c.format === 'umd' ? 'webcanvas.js' : 'webcanvas.esm.js'}`;
  const src = cdnUrl(c.cdn, PKG, version, file);
  const initOptions = c.threads !== undefined ? `{ renderer: '${c.renderer}', threads: ${c.threads} }` : `{ renderer: '${c.renderer}' }`;
  const canvasTag = '<canvas id="canvas"></canvas>';

  const body = `const TVG = await ThorVG.init(${initOptions});
const canvas = new TVG.Canvas('#canvas', { width: 300, height: 300 });

const animation = new TVG.LottieAnimation();
animation.load(await fetch('${origin}/assets/animation.json').then((r) => r.text()));
animation.picture.size(300, 300);
canvas.add(animation.picture);

animation.setLoop(true).play(() => canvas.update().render());`;

  const probe = `window.__probe = () => ({ state: animation.isPlaying() ? 'playing' : 'loading', frame: animation.frame(), totalFrame: animation.info()?.totalFrames });`;

  const wrap = (code) => (c.format === 'umd'
    ? `<script src="${src}"></script>\n<script>\n  (async () => {\n${indent(code, '    ')}\n  })();\n</script>`
    : `<script type="module">\n  import ThorVG from "${src}";\n\n${indent(code, '  ')}\n</script>`);

  return {
    html: canvasTag,
    code: `${c.cdn === 'self' ? `<!-- package served from this origin at /node_modules/${PKG}/ -->\n` : ''}${canvasTag}\n\n${wrap(body)}`,
    scripts: wrap(`${body}\n\n${probe}`),
  };
}

export default {
  pkgName: PKG,
  animation: path.resolve(here, '../assets/animation.json'),
  selector: '#canvas',
  buildCases,
  page,
  wasmUrl: (c, version) => `https://unpkg.com/${PKG}@${version}/${distDir(c)}/thorvg.wasm`,
  minWorkers: (c) => c.threads ?? 0,
};
