// test/batch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, BatchPrintError } from '../src/batch.mjs';

// Build a task fixture whose methods record their own call count, argument
// history and per-task order. Overrides hook each phase for failure/abort.
function makeTask(overrides = {}) {
  const order = [];
  const calls = {
    printInit: 0,
    printPage: 0,
    waitForFinished: 0,
    printEnd: 0,
    lastPrintPageArgs: undefined,
  };
  const task = {
    async printInit() {
      calls.printInit++;
      order.push('printInit');
      if (overrides.printInit) await overrides.printInit({ calls, order });
    },
    async printPage(img, total) {
      calls.printPage++;
      calls.lastPrintPageArgs = { img, total };
      order.push('printPage');
      if (overrides.printPage) await overrides.printPage({ calls, order, img, total });
    },
    async waitForFinished() {
      calls.waitForFinished++;
      order.push('waitForFinished');
      if (overrides.waitForFinished) await overrides.waitForFinished({ calls, order });
    },
    async printEnd() {
      calls.printEnd++;
      order.push('printEnd');
      if (overrides.printEnd) await overrides.printEnd({ calls, order });
    },
  };
  return { task, calls, order };
}

// Build a session fixture that hands out task fixtures from a queue and records
// session-level calls. createTask never "runs out": beyond the provided list it
// yields a fresh default task, which is only reached if a page is unexpectedly
// started.
function buildSession({ tasks = [], onConnect, onDisconnect, onCancelPoll, events } = {}) {
  const calls = { connect: 0, disconnect: 0, cancelPoll: 0, createTask: 0 };
  const order = [];
  const created = [];
  let idx = 0;
  const emit = (name) => {
    order.push(name);
    if (events) events.push(name);
  };
  const session = {
    async connect() {
      calls.connect++;
      emit('connect');
      if (onConnect) await onConnect({ calls, order });
    },
    async disconnect() {
      calls.disconnect++;
      emit('disconnect');
      if (onDisconnect) await onDisconnect({ calls, order });
    },
    cancelStatusPoll() {
      calls.cancelPoll++;
      emit('cancelStatusPoll');
      if (onCancelPoll) onCancelPoll({ calls, order });
    },
    createTask() {
      calls.createTask++;
      emit('createTask');
      const fixture = tasks[idx++];
      created.push(fixture);
      return fixture ? fixture.task : makeTask().task;
    },
  };
  return { session, calls, order, created };
}

test('methods2pages oneconnection exact1copy', async () => {
  const events = [];
  const enc = { 1: { tag: 'enc-1' }, 2: { tag: 'enc-2' } };
  const pages = [
    { page: 1, path: 'a' },
    { page: 2, path: 'b' },
  ];
  const t1 = makeTask();
  const t2 = makeTask();

  let createSessionCalls = 0;
  const { session, calls: sessionCalls, created } = buildSession({ tasks: [t1, t2], events });

  const result = await runBatch({
    pages,
    encodePage: async (page) => {
      events.push(`encode-${page.page}`);
      return enc[page.page];
    },
    createSession: () => {
      createSessionCalls++;
      events.push('createSession');
      return session;
    },
    onProgress: (info) => events.push(`onProgress-${info.page}-${info.completed}-${info.total}`),
  });

  assert.equal(result.interrupted, false);
  assert.deepEqual(result.completedPages, [1, 2]);

  // Exactly one session, one connection, one disconnect, one task per page.
  assert.equal(createSessionCalls, 1);
  assert.equal(sessionCalls.connect, 1);
  assert.equal(sessionCalls.disconnect, 1);
  assert.equal(sessionCalls.createTask, 2);
  assert.equal(created.length, 2);

  // Exact method order and exact one copy per page, with totalPages = 1 and the
  // opaque encoded image passed straight through.
  for (let i = 0; i < created.length; i++) {
    const { calls, order } = created[i];
    assert.equal(calls.printInit, 1);
    assert.equal(calls.printPage, 1);
    assert.equal(calls.waitForFinished, 1);
    assert.equal(calls.printEnd, 1);
    assert.deepEqual(order, ['printInit', 'printPage', 'waitForFinished', 'printEnd']);
    assert.deepEqual(calls.lastPrintPageArgs, { img: enc[i + 1], total: 1 });
  }

  // Encoding happens before any session/connect side effect.
  assert.deepEqual(
    events.slice(0, 4),
    ['encode-1', 'encode-2', 'createSession', 'connect'],
  );

  // onProgress reports a single confirmation per page with increasing count.
  assert.deepEqual(
    events.filter((e) => e.startsWith('onProgress-')),
    ['onProgress-1-1-2', 'onProgress-2-2-2'],
  );
});

test('encodeall-before-connect and encodingfailure nevercreate', async () => {
  const events = [];
  const enc = { 1: { tag: 'enc-1' }, 2: { tag: 'enc-2' } };
  const pages = [
    { page: 1, path: 'a' },
    { page: 2, path: 'b' },
  ];
  const t1 = makeTask();

  let createSessionCalls = 0;
  const { session, calls: sessionCalls } = buildSession({ tasks: [t1], events });

  const result = await runBatch({
    pages,
    encodePage: async (page) => {
      events.push(`encode-${page.page}`);
      return enc[page.page];
    },
    createSession: () => {
      createSessionCalls++;
      events.push('createSession');
      return session;
    },
  });

  assert.deepEqual(result.completedPages, [1, 2]);
  // All pages were encoded before the session was created/connected.
  assert.deepEqual(
    events.slice(0, 4),
    ['encode-1', 'encode-2', 'createSession', 'connect'],
  );
  assert.equal(createSessionCalls, 1);
  assert.equal(sessionCalls.connect, 1);

  // Now: an encoding failure must never create the session.
  let newSessionCalls = 0;
  const { session: s2 } = buildSession({ tasks: [makeTask()] });
  await assert.rejects(
    runBatch({
      pages: [{ page: 1, path: 'a' }, { page: 2, path: 'b' }],
      encodePage: async (page) => {
        if (page.page === 2) throw new Error('encode blew up');
        return { tag: `enc-${page.page}` };
      },
      createSession: () => {
        newSessionCalls++;
        return s2;
      },
    }),
    (err) => {
      assert.ok(err instanceof BatchPrintError);
      assert.equal(err.cause.message, 'encode blew up');
      assert.deepEqual(err.completedPages, []);
      assert.equal(err.uncertainPage, undefined);
      return true;
    },
  );
  assert.equal(newSessionCalls, 0);
});

test('printerfailure stops no next and cleanup+uncertain diagnostics', async () => {
  const pages = [{ page: 1, path: 'a' }, { page: 2, path: 'b' }];
  const t1 = makeTask({
    waitForFinished: async () => {
      throw new Error('physical print failed');
    },
  });
  const { session, calls: sCalls, order: sOrder, created } = buildSession({ tasks: [t1] });

  await assert.rejects(
    runBatch({
      pages,
      encodePage: async (page) => ({ tag: `enc-${page.page}` }),
      createSession: () => session,
    }),
    (err) => {
      assert.ok(err instanceof BatchPrintError);
      assert.equal(err.cause.message, 'physical print failed');
      assert.deepEqual(err.completedPages, []);
      // The page must be reported as uncertain (possibly-started) conservatively.
      assert.equal(err.uncertainPage, 1);
      return true;
    },
  );

  // Failed page stopped the batch: no next task, no next page.
  assert.equal(sCalls.createTask, 1);
  assert.equal(created.length, 1);

  // Before physical completion the failure is ambiguous, so cleanup only
  // cancels polling and disconnects: no best-effort printEnd is issued.
  assert.equal(created[0].calls.printEnd, 0);
  assert.deepEqual(created[0].order, ['printInit', 'printPage', 'waitForFinished']);
  assert.equal(sCalls.disconnect, 1);
  // Polling is cancelled before disconnect.
  const cancelIdx = sOrder.indexOf('cancelStatusPoll');
  const disIdx = sOrder.indexOf('disconnect');
  assert.ok(cancelIdx >= 0 && cancelIdx < disIdx);
});

test('timeout cleanup no hangs', async () => {
  const pages = [{ page: 1, path: 'a' }, { page: 2, path: 'b' }];
  // waitForFinished never settles, so the deadline must trip it.
  const t1 = makeTask({
    waitForFinished: async () => new Promise(() => {}),
  });
  const { session, calls: sCalls, created } = buildSession({ tasks: [t1] });

  const started = Date.now();
  await assert.rejects(
    runBatch({
      pages,
      encodePage: async (page) => ({ tag: `enc-${page.page}` }),
      createSession: () => session,
      timeoutMs: 30,
      cleanupTimeoutMs: 100,
    }),
    (err) => {
      assert.ok(err instanceof BatchPrintError);
      assert.equal(err.cause.code, 'ETIMEOUT');
      assert.equal(err.uncertainPage, 1);
      return true;
    },
  );

  // After a timed-out waitForFinished, cleanup cancels polling and disconnects
  // only - no printEnd protocol write, no next page started - within a bounded
  // window (no hang).
  assert.equal(created[0].calls.printEnd, 0);
  assert.equal(sCalls.createTask, 1);
  assert.equal(sCalls.disconnect, 1);
  assert.ok(Date.now() - started < 2000, `batch took too long: ${Date.now() - started}ms`);
});

test('invalid timeout range rejected with zero encode/no hardware', async () => {
  const badValues = [0, -5, NaN, Infinity, -Infinity, null, '60000', 'abc'];

  async function expectInvalid(config) {
    let encodeCalls = 0;
    let sessionCalls = 0;
    const { session } = buildSession();
    await assert.rejects(
      runBatch({
        pages: [{ page: 1, path: 'a' }, { page: 2, path: 'b' }],
        encodePage: async () => {
          encodeCalls++;
          return { tag: 'enc' };
        },
        createSession: () => {
          sessionCalls++;
          return session;
        },
        ...config,
      }),
      (e) => {
        assert.ok(e instanceof BatchPrintError);
        assert.deepEqual(e.completedPages, []);
        assert.equal(e.uncertainPage, undefined);
        return true;
      },
    );
    assert.equal(encodeCalls, 0);
    assert.equal(sessionCalls, 0);
  }

  for (const bad of badValues) {
    await expectInvalid({ timeoutMs: bad });
    await expectInvalid({ cleanupTimeoutMs: bad });
  }
});

test('timeout deferred printPage late settle: no printEnd/no next/onProgress and disconnect', async () => {
  const pages = [{ page: 1, path: 'a' }, { page: 2, path: 'b' }];
  let rejectLate;
  const late = new Promise((_, reject) => {
    rejectLate = reject;
  });
  const t1 = makeTask({ printPage: async () => late });
  const { session, calls: sCalls, created } = buildSession({ tasks: [t1] });

  let progressCalls = 0;
  await assert.rejects(
    runBatch({
      pages,
      encodePage: async (page) => ({ tag: `enc-${page.page}` }),
      createSession: () => session,
      onProgress: () => {
        progressCalls++;
      },
      timeoutMs: 30,
      cleanupTimeoutMs: 100,
    }),
    (e) => {
      assert.ok(e instanceof BatchPrintError);
      assert.equal(e.cause.code, 'ETIMEOUT');
      assert.equal(e.uncertainPage, 1);
      assert.deepEqual(e.completedPages, []);
      return true;
    },
  );

  // After a timed-out printPage there must be no further protocol write
  // (printEnd), no next page, and no confirmation/onProgress.
  assert.equal(created[0].calls.printEnd, 0);
  assert.equal(sCalls.createTask, 1);
  assert.equal(progressCalls, 0);
  assert.equal(sCalls.disconnect, 1);

  // The underlying (still in-flight) printPage settles late, after the batch has
  // already rejected. This late rejection must be handled (no unhandled error).
  rejectLate(new Error('late printPage rejection'));
  await new Promise((r) => setImmediate(r));
});

test('connect timeout: no createTask and disconnect', async () => {
  const pages = [{ page: 1, path: 'a' }];
  let resolveConnect;
  const hang = new Promise((r) => {
    resolveConnect = r;
  });
  const { session, calls: sCalls } = buildSession({ onConnect: async () => hang });

  await assert.rejects(
    runBatch({
      pages,
      encodePage: async (page) => ({ tag: `enc-${page.page}` }),
      createSession: () => session,
      timeoutMs: 30,
      cleanupTimeoutMs: 100,
    }),
    (e) => {
      assert.ok(e instanceof BatchPrintError);
      assert.equal(e.cause.code, 'ETIMEOUT');
      assert.deepEqual(e.completedPages, []);
      assert.equal(e.uncertainPage, undefined);
      return true;
    },
  );

  // A connect timeout means no task was ever created; cleanup cancels polling
  // and disconnects only.
  assert.equal(sCalls.createTask, 0);
  assert.equal(sCalls.disconnect, 1);

  // The late settle of the hanging connect must be handled.
  resolveConnect();
  await new Promise((r) => setImmediate(r));
});

test('abortbefore=nohardware', async () => {
  let createSessionCalls = 0;
  let encodeCalls = 0;
  const { session } = buildSession();

  const controller = new AbortController();
  controller.abort();

  const result = await runBatch({
    pages: [{ page: 1, path: 'a' }, { page: 2, path: 'b' }],
    encodePage: async () => {
      encodeCalls++;
      return { tag: 'enc' };
    },
    createSession: () => {
      createSessionCalls++;
      return session;
    },
    signal: controller.signal,
  });

  assert.equal(result.interrupted, true);
  assert.deepEqual(result.completedPages, []);
  // Zero hardware and zero encode work: abort honoured before any side effect.
  assert.equal(createSessionCalls, 0);
  assert.equal(encodeCalls, 0);
});

test('abortduringencode stops further encodes no hardware', async () => {
  const controller = new AbortController();
  const pages = [
    { page: 1, path: 'a' },
    { page: 2, path: 'b' },
    { page: 3, path: 'c' },
  ];
  let encodeCalls = 0;
  let createSessionCalls = 0;
  const { session } = buildSession();

  const result = await runBatch({
    pages,
    encodePage: async (page) => {
      encodeCalls++;
      // Abort while the first page is being encoded so that the remaining pages
      // are never encoded and no session/connect side effect is ever created.
      controller.abort();
      return { tag: `enc-${page.page}` };
    },
    createSession: () => {
      createSessionCalls++;
      return session;
    },
    signal: controller.signal,
  });

  assert.equal(result.interrupted, true);
  assert.deepEqual(result.completedPages, []);
  // Only the first encode ran; no hardware was touched.
  assert.equal(encodeCalls, 1);
  assert.equal(createSessionCalls, 0);
});

test('abortduringpage finishes current but none next', async () => {
  const controller = new AbortController();
  const pages = [{ page: 1, path: 'a' }, { page: 2, path: 'b' }];

  // Abort is signalled while page 1 is physically waiting.
  const t1 = makeTask({
    waitForFinished: async () => {
      controller.abort();
    },
  });
  const { session, calls: sCalls, created } = buildSession({ tasks: [t1] });

  const result = await runBatch({
    pages,
    encodePage: async (page) => ({ tag: `enc-${page.page}` }),
    createSession: () => session,
    signal: controller.signal,
  });

  assert.equal(result.interrupted, true);
  // The in-flight page completed (confirmed), but the next page was not started.
  assert.deepEqual(result.completedPages, [1]);
  assert.equal(sCalls.createTask, 1);
  assert.equal(created.length, 1);
  // The in-flight page fully finished: printEnd ran before we stopped.
  assert.deepEqual(created[0].order, ['printInit', 'printPage', 'waitForFinished', 'printEnd']);
  assert.equal(created[0].calls.printEnd, 1);
  assert.equal(sCalls.disconnect, 1);
});

test('completion onlyafterwait', async () => {
  let waitDone = false;
  const pages = [{ page: 1, path: 'a' }];
  const t1 = makeTask({
    waitForFinished: async () => {
      await new Promise((r) => setTimeout(r, 5));
      waitDone = true;
    },
  });
  const { session } = buildSession({ tasks: [t1] });

  let progressAtOnProgress = null;
  const result = await runBatch({
    pages,
    encodePage: async () => ({ tag: 'enc' }),
    createSession: () => session,
    onProgress: (info) => {
      // Confirmation must happen only after the physical waitForFinished.
      progressAtOnProgress = { completed: info.completed, waitDone };
    },
  });

  assert.deepEqual(result.completedPages, [1]);
  assert.deepEqual(progressAtOnProgress, { completed: 1, waitDone: true });
});

test('disconnectonconnectfailure', async () => {
  const connectError = new Error('connect failed');
  const { session, calls: sCalls } = buildSession({
    onConnect: async () => {
      throw connectError;
    },
  });

  await assert.rejects(
    runBatch({
      pages: [{ page: 1, path: 'a' }],
      encodePage: async () => ({ tag: 'enc' }),
      createSession: () => session,
    }),
    (err) => {
      assert.ok(err instanceof BatchPrintError);
      assert.equal(err.cause, connectError);
      assert.deepEqual(err.completedPages, []);
      assert.equal(err.uncertainPage, undefined);
      return true;
    },
  );

  // The created session is always disconnected, even though connect rejected.
  assert.equal(sCalls.disconnect, 1);
  assert.equal(sCalls.createTask, 0);
});

test('printEnd failure no retry no lostconfirmed count', async () => {
  const pages = [{ page: 1, path: 'a' }, { page: 2, path: 'b' }];
  const t1 = makeTask({
    printEnd: async () => {
      throw new Error('printEnd failed');
    },
  });
  // Page 2 never starts.
  const { session, calls: sCalls, created } = buildSession({ tasks: [t1] });

  await assert.rejects(
    runBatch({
      pages,
      encodePage: async (page) => ({ tag: `enc-${page.page}` }),
      createSession: () => session,
    }),
    (err) => {
      assert.ok(err instanceof BatchPrintError);
      assert.equal(err.cause.message, 'printEnd failed');
      // The page was physically confirmed before printEnd, so it must not be lost.
      assert.deepEqual(err.completedPages, [1]);
      assert.equal(err.uncertainPage, undefined);
      return true;
    },
  );

  // printEnd is not retried after failing - exactly one attempt.
  assert.equal(created[0].calls.printEnd, 1);
  assert.equal(sCalls.createTask, 1);
  assert.equal(sCalls.disconnect, 1);
});

test('cleanupdoesntmaskprimary', async () => {
  const primaryError = new Error('primary print failure');
  const cleanupError = new Error('disconnect failure');
  const pages = [{ page: 1, path: 'a' }, { page: 2, path: 'b' }];

  const t1 = makeTask({
    waitForFinished: async () => {
      throw primaryError;
    },
  });
  const { session, calls: sCalls } = buildSession({
    tasks: [t1],
    onDisconnect: async () => {
      throw cleanupError;
    },
  });

  await assert.rejects(
    runBatch({
      pages,
      encodePage: async (page) => ({ tag: `enc-${page.page}` }),
      createSession: () => session,
    }),
    (err) => {
      assert.ok(err instanceof BatchPrintError);
      // The primary error is preserved; the cleanup failure does not mask it.
      assert.equal(err.cause, primaryError);
      assert.equal(err.cause.message, 'primary print failure');
      assert.deepEqual(err.completedPages, []);
      assert.equal(err.uncertainPage, 1);
      return true;
    },
  );

  // Cleanup still ran and recorded the disconnect failure without masking.
  assert.equal(sCalls.disconnect, 1);
});
