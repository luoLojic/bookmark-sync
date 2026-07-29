import { rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const target of ['dist', 'coverage', 'bookmark-sync.zip']) {
  await rm(path.join(root, target), { recursive: true, force: true });
}
console.log('cleaned');
