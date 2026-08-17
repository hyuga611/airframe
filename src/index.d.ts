// Type definitions for genchi — completion verification gate.

/** The reason a completion could not be confirmed. */
export type VerdictReason = 'empty' | 'mismatch' | 'probe-error';

/** Result of verifying a completion contract. Never fabricated: `evidence` always
 * reflects the actually re-fetched state (or the probe error). */
export type Verdict<T = unknown> =
  | { ok: true; action: string; expectation: string; state: T; evidence: string }
  | {
      ok: false;
      action: string;
      expectation: string;
      reason: VerdictReason;
      state?: T;
      error?: unknown;
      detail?: string;
      evidence: string;
    };

/** An expectation result: `true`/`{ok:true}` passes, `{ok:false, detail}` fails with a reason. */
export type ExpectResult = boolean | { ok: boolean; detail?: string };

/** A function that RE-FETCHES the real world state after the action. Must be a fresh
 * read — never the action's own return value. */
export type Probe<T> = () => T | Promise<T>;

export interface Contract<T = unknown> {
  /** Human label for the operation (used in messages). */
  action?: string;
  /** Re-fetches the actual world state. Required. */
  probe: Probe<T>;
  /** The sole pass/fail criterion. If omitted, the default is "state is non-empty". */
  expect?: (state: T) => ExpectResult | Promise<ExpectResult>;
  /** Render the state for the `evidence` string. Defaults to a JSON-ish preview. */
  describeState?: (state: T) => string;
  /** Allow an empty re-fetched state to count as complete (default: false). */
  allowEmpty?: boolean;
}

/** Treats 0, NaN, '', [], {}, Map/Set(size 0), false, null, undefined as "nothing there". */
export function isEmpty(v: unknown): boolean;

/** Names the question a contract asked: `count(45)`, `contains("200")`, `nonEmpty`,
 * `custom` for a hand-written predicate, or `nonEmpty (default)` when `expect` was
 * omitted. Present on every Verdict as `expectation`, so a pass under the weakest
 * expectation is distinguishable from a pass under a real one. */
export function expectationLabel(contract: { expect?: unknown } | null | undefined): string;

/** Thrown by `gate()` when the re-fetched state cannot confirm completion. */
export class GenchiIncomplete extends Error {
  readonly name: 'GenchiIncomplete';
  readonly verdict: Extract<Verdict, { ok: false }>;
  constructor(verdict: Extract<Verdict, { ok: false }>);
}

/** Runs the probe and returns a Verdict. Does not throw on a normal failure —
 * empty/error is reported as-is, never optimistically filled. */
export function verify<T>(contract: Contract<T>): Promise<Verdict<T>>;

/** Like `verify`, but throws `GenchiIncomplete` unless completion is confirmed.
 * Returns the re-fetched state on success. */
export function gate<T>(contract: Contract<T>): Promise<T>;

/** Ready-made expectations to pass as `contract.expect`. */
export const expect: {
  nonEmpty(): (s: unknown) => ExpectResult;
  count(n: number): (s: unknown) => ExpectResult;
  atLeast(n: number): (s: unknown) => ExpectResult;
  contains(sub: string): (s: unknown) => ExpectResult;
  equals(v: unknown): (s: unknown) => ExpectResult;
  matches(re: RegExp): (s: unknown) => ExpectResult;
};

declare const _default: {
  verify: typeof verify;
  gate: typeof gate;
  expect: typeof expect;
  isEmpty: typeof isEmpty;
  expectationLabel: typeof expectationLabel;
  GenchiIncomplete: typeof GenchiIncomplete;
};
export default _default;
