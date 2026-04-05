// ── Per-specPath serialization lock ───────────────────────────────────────────
//
// Prevents concurrent generation/gap-fill operations on the same spec file
// from producing stale-read → clobber sequences.
//
// Pattern: promise-chain queue per specPath key.
// The lock is ALWAYS released (finally block), even when fn() throws.
// The map entry is cleaned up when no more waiters are queued.

const locks = new Map<string, Promise<void>>();

/**
 * Run `fn` exclusively for `specPath`. If another call is already running for
 * the same specPath, this call waits until the previous one completes before
 * proceeding. Callers for different specPaths are never blocked by each other.
 *
 * The lock is always released — even if `fn` throws — so the queue never
 * gets permanently stuck.
 */
export async function withSpecPathLock(specPath: string, fn: () => Promise<void>): Promise<void> {
  const prev = locks.get(specPath) ?? Promise.resolve();

  let resolveNext!: () => void;
  const next = new Promise<void>(resolve => {
    resolveNext = resolve;
  });

  // Register ourselves as the current tail of the queue for this specPath.
  locks.set(specPath, prev.then(() => next));

  try {
    await prev;      // wait for any preceding operation to finish
    await fn();      // CRITICAL SECTION
  } finally {
    resolveNext();   // unblock any waiter behind us

    // Clean up the map when we're the last waiter (no new tail was appended
    // while we were running — i.e. the map still points to our `next`).
    // This is a best-effort trim; leaving a resolved promise in the map is
    // also safe — it just prevents GC of the entry until the next call.
    if (locks.get(specPath) === next) {
      locks.delete(specPath);
    }
  }
}
