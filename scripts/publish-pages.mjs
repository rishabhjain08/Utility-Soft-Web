// Publishes the built app (dist/index.html) to the gh-pages branch, which GitHub Pages
// serves at https://rishabhjain08.github.io/Utility-Soft-Web/ (Google sign-in needs a web address).
//   npm run build && node scripts/publish-pages.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = join(root, 'dist', 'index.html');
if (!existsSync(src)) throw new Error('Run npm run build first');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

const dir = mkdtempSync(join(tmpdir(), 'usw-pages-'));
try {
  git(root, 'worktree', 'add', '--detach', dir);
  git(dir, 'checkout', '--orphan', 'gh-pages-new');
  git(dir, 'rm', '-rf', '--quiet', '.');
  copyFileSync(src, join(dir, 'index.html'));
  writeFileSync(join(dir, '.nojekyll'), '');
  git(dir, 'add', 'index.html', '.nojekyll');
  git(dir, 'commit', '--quiet', '-m', `Publish ${git(root, 'rev-parse', '--short', 'HEAD')}`);
  git(dir, 'push', '--force', 'origin', 'gh-pages-new:gh-pages');
  console.log('Published to the gh-pages branch.');
} finally {
  git(root, 'worktree', 'remove', '--force', dir);
  try {
    git(root, 'branch', '-D', 'gh-pages-new');
  } catch {
    // Not made.
  }
  rmSync(dir, { recursive: true, force: true });
}
