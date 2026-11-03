// Copies the single-file build into the folder people copy onto their computer.
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = join(root, 'dist', 'index.html');
if (!existsSync(src)) throw new Error('Run vite build first');
copyFileSync(src, join(root, 'Utility Soft', 'Utility Soft.html'));
console.log('Updated "Utility Soft/Utility Soft.html"');
