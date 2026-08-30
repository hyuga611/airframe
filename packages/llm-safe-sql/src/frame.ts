/**
 * The connection to the frame, [spar](https://github.com/hyuga611/airframe/tree/main/packages/spar).
 *
 * A dry run here is complete in itself: propose, execute, measure, always roll back. What was
 * measured goes back to the caller and then *disappears*. A proposal a human declined and a
 * change a human approved were both traceable afterwards only if the caller had kept its own
 * record.
 *
 * When `@hyuga/spar` is installed, that measurement goes to the ledger as one finding. When it
 * is not, nothing happens — `dependencies` stays empty (this is an optional peer) and anybody
 * using the library on its own sees exactly what they saw before.
 *
 *   dry run (plan)   phase `pre`   the force measured before the shot, and rolled back
 *   apply            phase `post`  the rows that actually changed
 */
type Frame = {
  finding: (f: Record<string, unknown>) => unknown;
  report: (f: unknown) => unknown;
} | null;

let frame: Frame | undefined; // undefined = not tried yet, null = not installed

export async function file(f: {
  phase: 'pre' | 'post';
  subject: string;
  observed: unknown;
  expected?: unknown;
  severity?: 'note' | 'warn' | 'stop';
  note?: string;
}): Promise<void> {
  try {
    if (frame === undefined) {
      try {
        // Through a variable so the type checker does not go looking for an optional
        // dependency that ships no types. Written as a literal, the build fails anywhere spar
        // is not installed.
        const optional = '@hyuga/spar';
        frame = (await import(optional)) as unknown as Frame;
      } catch {
        frame = null;
      }
    }
    if (!frame) return;
    frame.report(frame.finding({
      phase: f.phase,
      source: 'llm-safe-sql',
      severity: f.severity ?? 'note',
      subject: f.subject,
      observed: f.observed,
      expected: f.expected,
      note: f.note,
    }));
  } catch {
    // Not being able to write the record must not cost the measurement or the apply. The
    // result already exists.
  }
}
