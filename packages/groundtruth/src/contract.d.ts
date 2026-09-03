// Type definitions for the contract-line reader: one JSONL line -> probe + expectation.
// This is the reader the Stop hook uses at the end of the turn and yubisashi uses before
// a write. Keep it the only one.

import type { ExpectResult, Verdict } from './index.js';

/** One line of a pending-contracts JSONL file, as written by the agent. */
export interface ContractSpec {
  action?: string;
  /** Shell command that re-fetches real state. Its stdout is the state. */
  probe: string;
  /** Omitted means nonempty. */
  expect?: { type: 'nonempty' } | { type: 'count' | 'at-least' | 'contains' | 'equals' | 'matches'; value: unknown };
}

/** A probe that runs `cmd` in a shell and resolves to its trimmed stdout. Rejects on a non-zero exit. */
export function shellProbe(cmd: string): () => Promise<string>;

/** The expectation function a spec names. Throws on an unknown `expect.type`. */
export function expectFromSpec(spec: ContractSpec['expect'] | null | undefined): (state: unknown) => ExpectResult;

/** Parse one line and verify it with the given `verify` (groundtruth's own). */
export function checkContract(
  line: string,
  verify: (contract: { action?: string; probe: () => Promise<string>; expect: (s: unknown) => ExpectResult }) => Promise<Verdict>,
): Promise<Verdict>;
