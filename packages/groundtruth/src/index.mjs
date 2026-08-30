// groundtruth — 現地現物 ("go and see"). The completion gate: before an agent or an automation
// is allowed to report that something is done, it has to re-fetch the state of the world with a
// probe and show that the thing is really there.
//
// The worst hallucination is not a sentence. It is a fabricated fact about work having been
// carried out, and its cause is that acting and confirming have collapsed into one step: the
// tool returned without an error, so "done" gets written.
//
// The completion contract makes that impossible to express:
//   1. Anything with a side effect — create, update, delete, insert, upload — can only be
//      reported as done after a separate probe RE-FETCHES the real state
//   2. Empty, error and timeout are never filled in from imagination; they are reported as the
//      failures they are
//   3. Only a value the re-fetch confirmed to exist is written to the ledger
//
// The load-bearing decision: verify and gate accept a probe and nothing else. There is no API
// that takes the return value of the action as evidence, so "I believe I did it" has nowhere to
// be written down.
//
// No LLM and no API key at runtime. Zero dependencies. Framework-agnostic.

/**
 * Is there nothing here?
 *
 * In a completion check, 0 / NaN / '' / [] / {} / null / undefined all mean one thing: the
 * re-fetch found no evidence, so the change did not land. A count of 0 is "not one row went in",
 * and that must never read as success.
 */
export function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return v === 0 || Number.isNaN(v);
  if (typeof v === 'boolean') return v === false;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Map || v instanceof Set) return v.size === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function errText(e) {
  if (e instanceof Error) return e.message;
  try { return String(e); } catch { return '(unstringifiable error)'; }
}

/**
 * Read a value as a number, for the numeric expectations. NaN when it cannot be read.
 *
 * `Number('')` and `Number('   ')` are both 0, so a probe that returned nothing at all satisfied
 * `--count 0`, `--at-least 0` and every negative threshold. Passing "was not measured" off as
 * "measured zero" is the exact inversion of the reason this tool exists.
 *
 * The string '0' and the number 0 are real measurements and go through — deciding what they mean
 * is the comparison's job. Conversion of non-strings (arrays and the rest) is left as it was.
 */
function asNumber(s) {
  if (s == null) return NaN;
  if (typeof s === 'string' && s.trim() === '') return NaN;
  return Number(s);
}

function valueText(s) {
  if (typeof s === 'string') return JSON.stringify(s.length > 200 ? s.slice(0, 200) + '…' : s);
  if (typeof s === 'number' || typeof s === 'boolean' || s == null) return String(s);
  try {
    const j = JSON.stringify(s);
    return j.length > 200 ? j.slice(0, 200) + '…' : j;
  } catch { return Object.prototype.toString.call(s); }
}

function defaultDescribe(state) {
  return valueText(state);
}

/**
 * Label an expectation with the question it actually asked.
 *
 * Only pass or fail came back, so a verdict that passed `nonEmpty` — the weakest question there
 * is, satisfied by anything at all — was indistinguishable in the output from one that passed
 * `count(45)`. A check nobody thought about, standing in the record with the same face as one
 * written deliberately, is the precise shape this tool exists to destroy; it was what remained
 * of 0.4.0's "degrades quietly instead of refusing".
 *
 * It is emitted verbatim as verdict.expectation, so the CLI's --json and anything automated can
 * tell the two apart.
 */
function labelled(label, fn) {
  return Object.defineProperty(fn, 'groundtruthLabel', { value: label, enumerable: false });
}

/** Read back which question a contract asked. An unspecified one says that it is the default. */
export function expectationLabel(contract) {
  if (!contract || typeof contract.expect !== 'function') return 'nonEmpty (default)';
  return contract.expect.groundtruthLabel || 'custom';
}

/** Thrown when completion cannot be claimed. It carries the raw re-fetched evidence on verdict. */
export class GroundtruthIncomplete extends Error {
  constructor(verdict) {
    const d = verdict.detail ? `: ${verdict.detail}` : '';
    const x = verdict.expectation ? `\n  the expectation was: ${verdict.expectation}` : '';
    super(
      `groundtruth: "${verdict.action}" cannot be reported as done — ${verdict.reason}${d}\n` +
      `  the probe returned: ${verdict.evidence}${x}`
    );
    this.name = 'GroundtruthIncomplete';
    /** @type {Verdict} */
    this.verdict = verdict;
  }
}

/**
 * Mount groundtruth on the frame.
 *
 * When `@hyuga/spar` is installed, the verdict goes to the ledger as one finding. When it is
 * not, nothing happens — the dependency list stays empty and somebody using this on its own
 * sees no difference.
 *
 * The phase is `claim`, which the frame reads as refuse-shot: not the machine halting, this one
 * shot declining to fire. That is the same thing groundtruth was already doing.
 */
let frame; // undefined = not tried yet, null = not installed
async function file(v) {
  try {
    if (frame === undefined) {
      try { frame = await import('@hyuga/spar'); } catch { frame = null; }
    }
    if (!frame) return;
    frame.report(frame.finding({
      phase: 'claim',
      source: 'groundtruth',
      severity: v.ok ? 'note' : 'stop',
      subject: v.action,
      observed: v.evidence,
      expected: v.expectation,
      note: v.ok ? undefined : v.reason,
    }));
  } catch {
    // Not being able to write the record must not cost the check. The verdict already exists.
  }
}

export async function verify(contract) {
  const v = await assess(contract);
  await file(v);
  return v;
}

async function assess(contract) {
  const action = (contract && contract.action) ? String(contract.action) : 'operation';

  if (!contract || typeof contract.probe !== 'function') {
    // The backbone. What is demanded is a function that re-fetches real state, never the
    // return value of the action itself.
    throw new TypeError(
      'groundtruth: contract.probe is required — a function that RE-FETCHES real state. ' +
      'The return value of the action itself is not acceptable as evidence.'
    );
  }

  const expectation = expectationLabel(contract);

  let state;
  try {
    state = await contract.probe();
  } catch (error) {
    // The probe failed, so the real state was never established. That is not a pass.
    return { ok: false, action, expectation, reason: 'probe-error', error, evidence: `probe failed: ${errText(error)}` };
  }

  const describe = (contract.describeState) ? contract.describeState : defaultDescribe;
  let evidence;
  try { evidence = String(describe(state)); } catch { evidence = valueText(state); }

  const empty = isEmpty(state);

  // No expect given: the default question is "does anything actually exist" (non-empty).
  if (typeof contract.expect !== 'function') {
    if (empty && !contract.allowEmpty) {
      return { ok: false, action, expectation, reason: 'empty', state, evidence };
    }
    return { ok: true, action, expectation, state, evidence };
  }

  // An expect was given: it is the only criterion. An explicit question outranks emptiness.
  let res;
  try {
    res = await contract.expect(state);
  } catch (error) {
    return { ok: false, action, expectation, reason: 'probe-error', state, error, evidence: `expect failed: ${errText(error)}` };
  }

  const ok = res === true || (res && typeof res === 'object' && res.ok === true);
  if (ok) return { ok: true, action, expectation, state, evidence };

  const detail = (res && typeof res === 'object' && res.detail) ? String(res.detail) : undefined;
  const reason = empty ? 'empty' : 'mismatch';
  return { ok: false, action, expectation, reason, state, evidence, detail };
}

/**
 * verify, except that a claim it cannot support throws GroundtruthIncomplete.
 *
 * Put this at the end of anything with a side effect and the code physically cannot reach "done"
 * unless the re-fetched state passes. On success it returns that state.
 */
export async function gate(contract) {
  const v = await verify(contract);
  if (!v.ok) throw new GroundtruthIncomplete(v);
  return v.state;
}

/**
 * The questions worth asking most often. Each builds a function for `expect`.
 *
 * Return true or {ok:true} to pass, {ok:false, detail} to fail with a reason.
 */
export const expect = {
  /** Something exists (non-empty). The weakest question there is, and its label says so. */
  nonEmpty: () => labelled('nonEmpty', (s) => (!isEmpty(s) ? true : { ok: false, detail: `the probe returned nothing: ${valueText(s)}` })),
  /** Reads as a number equal to n — the count of rows that went in, say. */
  count: (n) => labelled(`count(${n})`, (s) => {
    const got = asNumber(s);
    if (Number.isNaN(got)) return { ok: false, detail: `expected a count of ${n}, but nothing countable came back: ${valueText(s)}` };
    return got === n ? true : { ok: false, detail: `expected a count of ${n}, the probe returned ${valueText(s)}` };
  }),
  /** Reads as a number of at least n. */
  atLeast: (n) => labelled(`atLeast(${n})`, (s) => {
    const got = asNumber(s);
    if (Number.isNaN(got)) return { ok: false, detail: `expected at least ${n}, but nothing countable came back: ${valueText(s)}` };
    return got >= n ? true : { ok: false, detail: `expected at least ${n}, the probe returned ${valueText(s)}` };
  }),
  /** Contains sub as a string — a word in the body a re-fetched URL served, say. */
  contains: (sub) => labelled(`contains(${JSON.stringify(String(sub))})`, (s) => (String(s).includes(sub) ? true : { ok: false, detail: `does not contain "${sub}": ${valueText(s)}` })),
  /** Equal to a value; strings are compared trimmed. */
  equals: (v) => labelled(`equals(${valueText(v)})`, (s) => {
    const eq = (typeof s === 'string') ? s.trim() === String(v).trim() : s === v;
    return eq ? true : { ok: false, detail: `expected ${valueText(v)}, the probe returned ${valueText(s)}` };
  }),
  /** Matches a regular expression. */
  matches: (re) => labelled(`matches(${String(re)})`, (s) => (re.test(String(s)) ? true : { ok: false, detail: `does not match ${re}: ${valueText(s)}` })),
};

export default { verify, gate, expect, isEmpty, expectationLabel, GroundtruthIncomplete };
