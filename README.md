# ThorVG Web CDN Compatibility

`thorvg.web.cdn-test` checks that `@thorvg/webcanvas` and `@thorvg/lottie-player` load and render from [npm](https://www.npmjs.com/), [UNPKG](https://unpkg.com/), [jsDelivr](https://www.jsdelivr.com/) and [esm.sh](https://esm.sh/). 

## Setup

```bash
npm install
npx playwright install chromium
```

## After a release

Test the published version against the real CDNs.

```bash
node src/run.mjs webcanvas
node src/run.mjs lottie-player
```

This uses the `latest` version on npm. To test a specific version:

```bash
node src/run.mjs webcanvas --live 1.2.0
```

`@latest` cases are skipped when the tested version is not `latest`.

## Before a release

Test a local build with UNPKG and jsDelivr simulated on `127.0.0.1`. esm.sh cases run only against the real CDN, so they are not included here.

```bash
node src/run.mjs webcanvas --pack ../thorvg.web/packages/webcanvas
node src/run.mjs webcanvas --dist ../thorvg.web/packages/webcanvas
```

- `--pack <dir>` runs `npm pack` in the package directory and serves only the published files.
- `--dist <dir>` serves the directory as is.

## Options

| Option | Description |
|---|---|
| `--filter <text>` | Run only cases whose id contains the text |
| `--list` | Print case ids without running them |
| `--headed` | Show the browser |
| `--concurrency <n>` | Number of pages run in parallel (default 4) |
| `--timeout <ms>` | Time to wait for playback (default 30000) |

## Manual check

Serve the same cases and open them in a separate Chrome profile.

```bash
node src/serve.mjs webcanvas
node src/serve.mjs webcanvas --pack ../thorvg.web/packages/webcanvas
```

## Results

- `PASS`: the case behaved as expected.
- `XFAIL`: the thread build failed without cross-origin isolation, as expected.
- `SKIP`: no WebGPU adapter was available.
- `FAIL`: something went wrong. The exit code is 1.

### Expected summary

- `XFAIL` is not a failure. (Expected failure)
- `FAIL` must be 0. (healthy)

| Command | Total | PASS | XFAIL |
|---|---|---|---|
| `run.mjs webcanvas` | 46 | 41 | 5 |
| `run.mjs lottie-player` | 84 | 79 | 5 |
