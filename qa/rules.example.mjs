/**
 * Per-app QA rules.
 *
 * Rename this file to `rules.mjs` to activate. The canonical linter auto-loads
 * `qa/rules.mjs` from the app root and runs these rules after the canonical set.
 *
 * Each rule is a function that receives `{ appDir, surface }` and returns one of:
 *   - { id, severity: 'pass'|'warn'|'fail'|'skip', message, detail? }
 *   - an array of those
 *   - null/undefined (no result)
 *
 * `id` should be namespaced under your app, e.g. `myapp/no-todo-comments`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ruleExample = ({ appDir }) => {
  // Example: forbid TODO comments in shipped JS.
  const target = join(appDir, 'popup.js');
  if (!existsSync(target)) return { id: 'example/no-todos', severity: 'skip', message: 'popup.js not found' };
  const text = readFileSync(target, 'utf8');
  if (/\bTODO\b/.test(text)) {
    return { id: 'example/no-todos', severity: 'warn', message: 'TODO comments in shipped code' };
  }
  return { id: 'example/no-todos', severity: 'pass', message: 'No TODO comments in shipped code' };
};

export default [ruleExample];
