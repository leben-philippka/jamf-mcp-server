import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../server/logger.js';

const logger = createLogger('write-queue');

type QueueState = { writeDepth: number };
const als = new AsyncLocalStorage<QueueState>();

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

const defer = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

class Semaphore {
  private readonly max: number;
  private current: number = 0;
  private readonly waiters: Array<Deferred<void>> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      return () => this.release();
    }

    const d = defer<void>();
    this.waiters.push(d);
    await d.promise;
    this.current++;
    return () => this.release();
  }

  private release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.waiters.shift();
    if (next) next.resolve();
  }
}

const WRITE_PREFIXES = [
  'create',
  'update',
  'delete',
  'retry',
  'execute',
  'deploy',
  'remove',
  'set',
  'trigger',
  'run',
  'send',
  'clone',
];

export const isWriteLikeToolName = (name: string): boolean => {
  const n = String(name ?? '').trim();
  if (!n) return false;

  const base = n.startsWith('skill_') ? n.substring(6) : n;
  const lower = base.toLowerCase();

  // Skills like "batch_inventory_update" don't start with update/create but are writes when confirm=true.
  // We treat those via args.confirm in maybeRunWriteLocked().
  return WRITE_PREFIXES.some((p) => lower.startsWith(p));
};

export const createToolWriteQueue = (): {
  maybeRunWriteLocked: <T>(
    toolName: string,
    toolArgs: unknown,
    fn: () => Promise<T>
  ) => Promise<T>;
} => {
  const enabled = process.env.JAMF_WRITE_QUEUE_ENABLED !== 'false';
  const concurrency = Math.max(1, Number(process.env.JAMF_WRITE_CONCURRENCY ?? 1));
  const sem = new Semaphore(concurrency);

  const maybeRunWriteLocked = async <T>(
    toolName: string,
    toolArgs: unknown,
    fn: () => Promise<T>
  ): Promise<T> => {
    if (!enabled) return await fn();

    const store = als.getStore();
    if (store?.writeDepth) {
      // Re-entrant: a skill calling a base tool while already holding the write lock.
      return await fn();
    }

    const args: any = toolArgs as any;
    const confirmTrue = Boolean(args && typeof args === 'object' && args.confirm === true);
    const looksLikeWrite = isWriteLikeToolName(toolName) || confirmTrue;

    if (!looksLikeWrite) return await fn();

    const release = await sem.acquire();
    const startedAt = Date.now();
    logger.info('Acquired write lock', {
      toolName,
      concurrency,
    });

    try {
      return await als.run({ writeDepth: 1 }, async () => await fn());
    } finally {
      const elapsedMs = Date.now() - startedAt;
      release();
      logger.info('Released write lock', { toolName, elapsedMs });
    }
  };

  return { maybeRunWriteLocked };
};
