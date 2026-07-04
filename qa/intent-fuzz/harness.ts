/**
 * harness.ts — the intent-fuzz runner (Uplevel 3 / T1). Wraps fast-check's
 * model-based mode (`fc.commands` + `fc.modelRun`) with the factory's
 * failure-crystallization contract, so every app's fuzzer is three things at
 * once: a nightly bug-finder, a self-articulating defect reporter, and a
 * forever-green regression suite.
 *
 * WHY MODEL-BASED. A `fc.commands` model IS the grocery intent fuzzer,
 * formalized: each Command is one real user action with a `check(model)`
 * precondition and a `run(model, real)` that drives the REAL store (never a
 * re-implementation of it) and asserts INTENT oracles — "your check-off
 * survives", "re-add is a fresh need", "nothing resurrects by id". fast-check
 * adds the two things the hand-rolled loop lacked: exhaustive shrinking (a
 * failure minimizes itself to the shortest reproducing story) and an exact
 * replay path (seed + path re-runs that minimal case forever).
 *
 * WHAT THIS FILE OWNS. Reading FUZZ_RUNS/FUZZ_PROFILE, running `fc.check`
 * (which returns details instead of throwing), logging the seed, and — on
 * failure — handing the shrunk details to `harnessCore.crystallizeFailure`
 * (fixture + intake line + fuzz-log), then throwing so Jest goes red.
 *
 * tsc stays clean against a fresh Expo app: the only static import is
 * `fast-check` (an app devDep); all fs/path/node work lives in the CommonJS
 * `harnessCore.cjs`, pulled in via `require` (a call — tsc never resolves it).
 *
 * Synced into apps by `sync.mjs intent-fuzz` as `qa/intent-fuzz/harness.ts`.
 */

import fc from 'fast-check';

// Runtime-only bridge to the pure core (see file header — keeps this module
// tsc-clean and node-free while reusing one source for the fs/seed logic).
interface HarnessCore {
  resolveRuns(env: Record<string, string | undefined>): number;
  resolveProfile(env: Record<string, string | undefined>): string;
  logRun(a: {
    appRoot?: string; app: string; model: string; seed: number;
    runs?: number; profile?: string; outcome: 'pass' | 'fail';
  }): void;
  crystallizeFailure(a: {
    appRoot?: string; app: string; model: string; runDetails: unknown;
    message?: string;
  }): { regressionFile: string };
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./harnessCore.cjs') as HarnessCore;

/** A single app-defined app run: a fresh model + a fresh REAL store. */
export interface FuzzSetup<Model extends object, Real extends object> {
  model: Model;
  real: Real;
}

export interface IntentFuzzConfig<Model extends object, Real extends object> {
  /** App slug — labels the ledger record + artifacts (e.g. 'grocery-list'). */
  app: string;
  /** Model key — the archetype/trust-core name; names the fixture file (e.g. 'list'). */
  model: string;
  /**
   * The fast-check command arbitraries — one per user action. Each command's
   * `run(m, r)` drives the REAL store and asserts intent oracles; `check(m)`
   * gates preconditions. See the starter models in ./models/.
   */
  commands: fc.Arbitrary<fc.Command<Model, Real>>[];
  /**
   * Fresh state for one app run: a fresh model AND a fresh REAL store (use
   * `jest.isolateModules` here to get a clean store module per run/device).
   */
  setup: () => FuzzSetup<Model, Real>;
  /** Optional cap on commands per story (default 60 — grocery ran 25–60). */
  maxCommands?: number;
  /** Optional post-run quiescence assertion: everything converges + oracles hold
   *  after the story ends (e.g. force all devices online and re-check). */
  atQuiescence?: (s: FuzzSetup<Model, Real>) => void;
  /** Override the app root for artifacts (defaults to process.cwd()). */
  appRoot?: string;
  /** Pin the seed (defaults to a fresh random seed each run — logged so it replays). */
  seed?: number;
  /** Override the run count (defaults to resolveRuns(process.env)). */
  numRuns?: number;
}

/**
 * Run the intent fuzzer. Call this from a Jest test:
 *
 *   it('user intent survives randomized stories', () => {
 *     runIntentFuzz({ app: 'grocery-list', model: 'list', commands, setup });
 *   });
 *
 * Smoke by default (numRuns 50 — the blocking PR gate stays cheap); the nightly
 * engine sets FUZZ_PROFILE=nightly (2000) or FUZZ_RUNS=<n>. On a counterexample
 * it writes the minimized story to qa/regressions/, files a defect-intake line,
 * logs the seed, and throws — so the failure is red, checked-in, and replayable
 * in one motion.
 */
export function runIntentFuzz<Model extends object, Real extends object>(
  config: IntentFuzzConfig<Model, Real>
): void {
  const env = (typeof process !== 'undefined' && process.env) || {};
  const numRuns = config.numRuns ?? core.resolveRuns(env);
  const profile = core.resolveProfile(env);
  const maxCommands = config.maxCommands ?? 60;

  const property = fc.property(
    fc.commands(config.commands, { maxCommands }),
    (cmds) => {
      const s = config.setup();
      // fc.modelRun applies each command's check()→run() against the pair.
      fc.modelRun(() => ({ model: s.model, real: s.real }), cmds);
      if (config.atQuiescence) config.atQuiescence(s);
    }
  );

  // fc.check returns details rather than throwing — so we own the seed logging
  // and the crystallization instead of parsing a formatted error string.
  const runOpts: { numRuns: number; seed?: number } = { numRuns };
  if (config.seed != null) runOpts.seed = config.seed;
  const details = fc.check(property, runOpts);

  const seed = details.seed;
  if (!details.failed) {
    core.logRun({ appRoot: config.appRoot, app: config.app, model: config.model, seed, runs: numRuns, profile, outcome: 'pass' });
    return;
  }

  // A real counterexample — crystallize it (fixture + intake + log), then fail.
  const message = describeCounterexample(details);
  let regressionFile = '(not written)';
  try {
    ({ regressionFile } = core.crystallizeFailure({
      appRoot: config.appRoot, app: config.app, model: config.model, runDetails: details, message,
    }));
  } catch (e) {
    // Crystallization must never mask the real failure — note it and keep going.
    // eslint-disable-next-line no-console
    console.warn(`[intent-fuzz] could not crystallize failure: ${(e as Error)?.message}`);
  }

  throw new Error(
    `intent-fuzz(${config.model}) breached user intent.\n` +
      `  seed: ${seed}   (replay: FUZZ_SEED=${seed} or the checked-in regression)\n` +
      `  minimal story:\n    ${storyLines(details).join('\n    ')}\n` +
      `  oracle: ${message}\n` +
      `  saved: ${regressionFile}`
  );
}

function storyLines<T>(details: fc.RunDetails<T>): string[] {
  const ce: unknown = (details as { counterexample?: unknown }).counterexample;
  const first = Array.isArray(ce) ? ce[0] : ce;
  if (Array.isArray(first)) return first.map((c) => String(c));
  return [String(first)];
}

function describeCounterexample<T>(details: fc.RunDetails<T>): string {
  const err = (details as { errorInstance?: unknown; error?: unknown }).errorInstance
    ?? (details as { error?: unknown }).error;
  if (err instanceof Error) return err.message.split('\n')[0].slice(0, 400);
  if (typeof err === 'string') return err.split('\n')[0].slice(0, 400);
  return 'intent oracle breached';
}

/**
 * Assert two facts a person would state, not "the devices agree". Thin helpers
 * the models use so oracle failures read like the ledger's plain-language
 * `symptom` field. Convergence, when asserted, is asserted TOO — never alone.
 */
export function intent(claim: string, condition: boolean): void {
  if (!condition) throw new Error(claim);
}
