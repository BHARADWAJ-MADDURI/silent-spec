import { withSpecPathLock } from '../utils/specPathLock';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deferred promise — resolves when caller calls `resolve()`. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

// ── Sequential execution for the same specPath ────────────────────────────────

test('two calls for the same specPath execute sequentially, not concurrently', async () => {
  const order: number[] = [];
  const gate = deferred();

  const first = withSpecPathLock('/a/spec.test.ts', async () => {
    order.push(1);
    await gate.promise; // hold the lock open until we say so
    order.push(2);
  });

  // Give the microtask queue a tick so `first` starts running.
  await Promise.resolve();

  const second = withSpecPathLock('/a/spec.test.ts', async () => {
    order.push(3);
  });

  gate.resolve(); // release the first lock holder
  await Promise.all([first, second]);

  expect(order).toEqual([1, 2, 3]);
});

test('second waiter does not start before first completes', async () => {
  let firstDone = false;
  const gate = deferred();

  const first = withSpecPathLock('/b/spec.test.ts', async () => {
    await gate.promise;
    firstDone = true;
  });

  await Promise.resolve(); // let first start

  let secondStarted = false;
  const second = withSpecPathLock('/b/spec.test.ts', async () => {
    secondStarted = true;
    expect(firstDone).toBe(true); // first MUST be done by the time second runs
  });

  expect(secondStarted).toBe(false); // second has NOT started yet

  gate.resolve();
  await Promise.all([first, second]);

  expect(secondStarted).toBe(true);
});

// ── Independent specPaths never block each other ──────────────────────────────

test('calls for different specPaths run concurrently', async () => {
  const order: string[] = [];
  const gateA = deferred();
  const gateB = deferred();

  const a = withSpecPathLock('/x/a.test.ts', async () => {
    order.push('a-start');
    await gateA.promise;
    order.push('a-end');
  });

  const b = withSpecPathLock('/x/b.test.ts', async () => {
    order.push('b-start');
    await gateB.promise;
    order.push('b-end');
  });

  // Both should have started (microtask queue lets both enter their fn).
  await Promise.resolve();
  await Promise.resolve();

  expect(order).toContain('a-start');
  expect(order).toContain('b-start');

  gateA.resolve();
  gateB.resolve();
  await Promise.all([a, b]);

  expect(order).toContain('a-end');
  expect(order).toContain('b-end');
});

// ── Lock is always released even when fn throws ───────────────────────────────

test('lock is released when fn throws, allowing next waiter to proceed', async () => {
  const first = withSpecPathLock('/c/spec.test.ts', async () => {
    throw new Error('boom');
  });

  await expect(first).rejects.toThrow('boom');

  // If the lock was NOT released this promise would hang forever.
  let secondRan = false;
  await withSpecPathLock('/c/spec.test.ts', async () => {
    secondRan = true;
  });

  expect(secondRan).toBe(true);
});

// ── Map cleanup ───────────────────────────────────────────────────────────────

test('three sequential callers all execute in order', async () => {
  const log: number[] = [];
  await withSpecPathLock('/d/spec.test.ts', async () => { log.push(1); });
  await withSpecPathLock('/d/spec.test.ts', async () => { log.push(2); });
  await withSpecPathLock('/d/spec.test.ts', async () => { log.push(3); });
  expect(log).toEqual([1, 2, 3]);
});

test('three concurrent callers execute in arrival order', async () => {
  const log: number[] = [];
  const [g1, g2, g3] = [deferred(), deferred(), deferred()];

  const p1 = withSpecPathLock('/e/spec.test.ts', async () => { await g1.promise; log.push(1); });
  const p2 = withSpecPathLock('/e/spec.test.ts', async () => { await g2.promise; log.push(2); });
  const p3 = withSpecPathLock('/e/spec.test.ts', async () => { await g3.promise; log.push(3); });

  // Release in order 1→2→3
  g1.resolve(); await p1;
  g2.resolve(); await p2;
  g3.resolve(); await p3;

  expect(log).toEqual([1, 2, 3]);
});
