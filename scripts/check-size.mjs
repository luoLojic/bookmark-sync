/** 打包体积硬门禁（需求第 3 节：< 200KB；方案 7.5：CI 硬门禁）。 */
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';

const LIMIT = 200 * 1024;
const zip = path.resolve(import.meta.dirname, '..', 'release', 'bookmark-sync.zip');

if (!existsSync(zip)) {
  console.error('release/bookmark-sync.zip 不存在，先运行 npm run zip');
  process.exit(1);
}
const size = statSync(zip).size;
const kb = (size / 1024).toFixed(1);
if (size > LIMIT) {
  console.error(`✗ 打包体积 ${kb} KB 超过上限 ${LIMIT / 1024} KB`);
  process.exit(1);
}
console.log(`✓ 打包体积 ${kb} KB / 上限 ${LIMIT / 1024} KB`);
