export class BusyError extends Error {
  constructor() {
    super("server busy");
  }
}

/** Counting semaphore with a bounded wait queue; `acquire` throws BusyError when full. */
export function limiter(max: number, maxQueue = 10) {
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = () => {
    const next = waiters.shift();
    if (next) next(); // hand the slot straight to the next waiter
    else active--;
  };
  async function acquire(): Promise<() => void> {
    if (active >= max) {
      if (waiters.length >= maxQueue) throw new BusyError();
      await new Promise<void>((resolve) => waiters.push(resolve));
    } else active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    const done = await acquire();
    try {
      return await fn();
    } finally {
      done();
    }
  }
  return { acquire, run };
}
