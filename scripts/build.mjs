import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const entryPoints = {
  background: path.join(root, 'src/background.ts'),
  popup: path.join(root, 'src/ui/popup/popup.ts'),
  options: path.join(root, 'src/ui/options/options.ts'),
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints,
  outdir: out,
  bundle: true,
  format: 'esm',
  target: ['chrome116'],
  platform: 'browser',
  splitting: false,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  define: { __DEV__: String(dev) },
};

async function copyStatic() {
  await mkdir(out, { recursive: true });

  // manifest
  const manifest = JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // html / css
  for (const [from, to] of [
    ['src/ui/popup/popup.html', 'popup.html'],
    ['src/ui/popup/popup.css', 'popup.css'],
    ['src/ui/options/options.html', 'options.html'],
    ['src/ui/options/options.css', 'options.css'],
  ]) {
    const src = path.join(root, from);
    if (existsSync(src)) await cp(src, path.join(out, to));
  }

  // 语言包与图标
  await cp(path.join(root, '_locales'), path.join(out, '_locales'), { recursive: true });
  const icons = path.join(root, 'icons');
  if (existsSync(icons)) await cp(icons, path.join(out, 'icons'), { recursive: true });
}

await rm(out, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await build(options);
  console.log('built → dist/');
}
