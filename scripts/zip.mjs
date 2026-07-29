/** 打包 dist/ 为可上架 zip。零运行时依赖，用系统 zip 或 PowerShell。 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'release');
const zip = path.join(outDir, 'bookmark-sync.zip');

if (!existsSync(dist)) {
  console.error('dist/ 不存在，先运行 npm run build');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
rmSync(zip, { force: true });

if (process.platform === 'win32') {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${dist}\\*' -DestinationPath '${zip}' -Force`],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('zip', ['-r', '-9', '-q', zip, '.'], { cwd: dist, stdio: 'inherit' });
}
console.log(`packed → ${path.relative(root, zip)}`);
