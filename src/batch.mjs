// src/batch.mjs
// Hardware-independent sequential B1 batch orchestration.
//
// Each PDF page is one independent B1 task (totalPages = 1). We retain a single
// serial session, encode every page up front, and await the physical
// waitForFinished() before printEnd() and before starting the next page. The
// library's waitForPageFinished() is a NO-OP, so we never use it; each task is
// deliberately created per page instead.

export class BatchPrintError extends Error {
  constructor(message, { completedPages = [], uncertainPage, cause } = {}) {
    super(message, { cause });
    this.name = 'BatchPrintError';
    this.completedPages = completedPages;
    this.uncertainPage = uncertainPage;
  }
}

// Wrap a promise in a deadline. The timer is cleared on settle. The losing
// promise is still tracked by Promise.race, so a late rejection after a timeout
// is never left unhandled. `ms` is guaranteed finite and positive by the
// caller-level validation, so there is no disabled branch.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ETIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Validate a deadline at entry, before any encode or session side effect. A
// value must be a finite positive number; 0, negatives, NaN, +/-Infinity, null
// and strings are rejected with a BatchPrintError carrying an empty confirmed
// list.
function assertDeadline(value, name) {
  const ok = typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!ok) {
    throw new BatchPrintError(`Invalid ${name}: ${JSON.stringify(value)}`, {
      completedPages: [],
      uncertainPage: undefined,
    });
  }
}

export async function runBatch({
  pages,
  encodePage,
  createSession,
  signal,
  onProgress = () => {},
  timeoutMs = 60000,
  cleanupTimeoutMs = 5000,
}) {
  // Validate deadlines before any encode/session side effect.
  assertDeadline(timeoutMs, 'timeoutMs');
  assertDeadline(cleanupTimeoutMs, 'cleanupTimeoutMs');

  const completedPages = [];
  let interrupted = false;

  // State consulted by cleanup.
  let session = null;
  let activeTask = null;
  let endAttempted = false;
  let activeConfirmed = false;
  let uncertainPage = undefined;
  let cleanupError = null;

  async function cleanup() {
    // Always cancel polling before any best-effort printEnd and before
    // disconnect, so the ordering requirement is satisfied in all paths.
    if (session) {
      try {
        session.cancelStatusPoll();
      } catch (err) {
        if (!cleanupError) cleanupError = err;
      }
    }

    // Issue a finalising printEnd ONLY when the active page is physically
    // confirmed (waitForFinished succeeded) and its end was never attempted
    // (e.g. onProgress failed after confirmation). On any ambiguous failure
    // before physical completion, or after a timed-out/late operation, we must
    // not write further protocol commands - cancel poll + disconnect only.
    if (activeTask != null && activeConfirmed && !endAttempted) {
      try {
        await withTimeout(activeTask.printEnd(), cleanupTimeoutMs, 'cleanup:printEnd');
      } catch (err) {
        if (!cleanupError) cleanupError = err;
      }
    }

    // Always disconnect (bounded), even if connect rejected or timed out; this
    // is the transport-abort boundary for any partially started operation.
    if (session) {
      try {
        await withTimeout(session.disconnect(), cleanupTimeoutMs, 'disconnect');
      } catch (err) {
        if (!cleanupError) cleanupError = err;
      }
    }
  }

  async function run() {
    // Honor abort before any side effect.
    if (signal && signal.aborted) {
      return { completedPages: [], interrupted: true };
    }

    try {
      // Encode ALL pages before creating/connecting the session. An encoding
      // failure means zero serial/hardware calls.
      const encoded = [];
      for (let i = 0; i < pages.length; i++) {
        // Honor an abort inside the encoding loop so an abort during encode does
        // not keep encoding the remaining pages; stop before any side effect.
        if (signal && signal.aborted) {
          interrupted = true;
          return { completedPages, interrupted: true };
        }
        encoded.push(await withTimeout(encodePage(pages[i]), timeoutMs, 'encodePage'));
      }

      // Honor abort before side effects (session creation / connect).
      if (signal && signal.aborted) {
        interrupted = true;
        return { completedPages, interrupted: true };
      }

      const s = createSession();
      session = s;

      await withTimeout(s.connect(), timeoutMs, 'connect');

      // If cancelled during connect, disconnect without starting any page.
      if (signal && signal.aborted) {
        interrupted = true;
        return { completedPages, interrupted: true };
      }

      for (let i = 0; i < pages.length; i++) {
        // Abort only stops new tasks; the current in-flight page is allowed to
        // complete up to its deadline.
        if (signal && signal.aborted) {
          interrupted = true;
          break;
        }

        const page = pages[i];
        const task = s.createTask();
        activeTask = task;
        endAttempted = false;
        activeConfirmed = false;
        // Conservative: this page may have started before printInit resolves,
        // so record it as the possibly-started unconfirmed page.
        uncertainPage = page.page;

        await withTimeout(task.printInit(), timeoutMs, 'printInit');
        await withTimeout(task.printPage(encoded[i], 1), timeoutMs, 'printPage');
        await withTimeout(task.waitForFinished(), timeoutMs, 'waitForFinished');

        // Physically confirmed only after waitForFinished succeeds. Never claim
        // success on packet-send alone.
        completedPages.push(page.page);
        activeConfirmed = true;
        uncertainPage = undefined;
        onProgress({ page: page.page, completed: completedPages.length, total: pages.length });

        endAttempted = true;
        await withTimeout(task.printEnd(), timeoutMs, 'printEnd');
        activeTask = null;
      }

      // If the signal became aborted while a page was in flight (including the
      // last page), the batch was cut short: report interrupted once that page's
      // completion and its printEnd have settled.
      if (signal && signal.aborted) interrupted = true;

      return { completedPages, interrupted };
    } catch (cause) {
      throw new BatchPrintError(
        cause && cause.message ? cause.message : 'Batch print failed',
        {
          completedPages: [...completedPages],
          uncertainPage,
          cause,
        },
      );
    }
  }

  let primaryError = null;
  let returnValue;
  try {
    returnValue = await run();
  } catch (err) {
    primaryError = err;
  } finally {
    // Cleanup must never mask a primary error; it only reports its own failure.
    await cleanup();
  }

  if (primaryError) throw primaryError;
  if (cleanupError) {
    throw new BatchPrintError(`Batch cleanup failed: ${cleanupError.message}`, {
      completedPages: [...completedPages],
      uncertainPage: undefined,
      cause: cleanupError,
    });
  }

  return returnValue;
}
