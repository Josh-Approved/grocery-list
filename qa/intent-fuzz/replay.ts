/**
 * replay.ts — every crystallized failure runs as a normal Jest test FOREVER
 * (Uplevel 3 / T1, ratified condition 2). Point this at your app's models and
 * it registers one `it(...)` per checked-in fixture under `qa/regressions/`,
 * re-running that fixture's EXACT minimal case (fast-check `seed` + `path`,
 * `numRuns: 1`) against the current code. A fixed bug stays green; a regressed
 * bug turns red with the original plain-language story.
 *
 * Usage in an app test file (see the model starters in ./models/):
 *
 *   import { replayRegressions } from '../../qa/intent-fuzz/replay';
 *   import { buildListProperty } from '../../qa/intent-fuzz/models/list.model';
 *   replayRegressions({ models: { list: buildListProperty } });
 *
 * Each model exports a `buildProperty()` that returns the SAME
 * `fc.property(fc.commands(...))` the live fuzzer runs — so a fixture is
 * replayed against the real store, not a snapshot.
 *
 * tsc-clean against a fresh Expo app: static import is only `fast-check`; the
 * directory read routes through the CommonJS core (required, not resolved).
 * `describe`/`it` are ambient Jest globals (@types/jest).
 */

import fc from 'fast-check';

interface ReplayCore {
  listRegressions(appRoot?: string): Array<{
    _file: string; _error?: string; model?: string; seed?: number; path?: string; story?: string; message?: string;
  }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./harnessCore.cjs') as ReplayCore;

/** A model's property builder — returns the property the live fuzzer runs. */
export type PropertyBuilder = () => fc.IPropertyWithHooks<unknown>;

export interface ReplayConfig {
  /** model key -> the SAME property builder the live fuzzer uses. */
  models: Record<string, PropertyBuilder>;
  /** Override the app root (defaults to process.cwd()). */
  appRoot?: string;
}

/**
 * Register a replay test per checked-in regression fixture. Call at the top
 * level of a `*.test.ts`. If a fixture references a model not in `models`, it
 * registers a failing test that says so (a fixture must never silently skip).
 */
export function replayRegressions(config: ReplayConfig): void {
  const regs = core.listRegressions(config.appRoot);

  describe('intent-fuzz regressions (crystallized failures, replayed forever)', () => {
    if (regs.length === 0) {
      it('no regressions checked in yet', () => {
        expect(true).toBe(true);
      });
      return;
    }

    for (const reg of regs) {
      const label = reg.story ? `${reg._file} — ${firstLine(reg.story)}` : reg._file;

      if (reg._error) {
        it(`fixture ${reg._file} is unreadable`, () => {
          throw new Error(`corrupt regression fixture ${reg._file}: ${reg._error}`);
        });
        continue;
      }

      const build = reg.model ? config.models[reg.model] : undefined;
      if (!build) {
        it(`replays ${label}`, () => {
          throw new Error(
            `regression ${reg._file} references model "${reg.model}" not passed to replayRegressions — ` +
              `add its buildProperty to \`models\`.`
          );
        });
        continue;
      }

      it(`replays ${label}`, () => {
        // Re-run the EXACT minimized failing case. Throws if the bug regressed.
        fc.assert(build(), { seed: reg.seed as number, path: reg.path as string, numRuns: 1, endOnFailure: true });
      });
    }
  });
}

function firstLine(s: string): string {
  return String(s).split('\n')[0].slice(0, 80);
}
