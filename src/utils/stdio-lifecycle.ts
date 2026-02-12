import { createLogger } from '../server/logger.js';

const logger = createLogger('stdio-lifecycle');

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PARENT_CHECK_INTERVAL_MS = 30 * 1000;

export interface StdioLifecycleConfig {
  enabled: boolean;
  idleTimeoutMs: number;
  parentCheckIntervalMs: number;
}

export interface StartStdioLifecycleGuardOptions {
  config?: StdioLifecycleConfig;
  stdin?: NodeJS.ReadableStream;
  getParentPid?: () => number;
  onShutdown: (reason: string) => Promise<void> | void;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === 'true';
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

export function getStdioLifecycleConfig(env: NodeJS.ProcessEnv = process.env): StdioLifecycleConfig {
  return {
    enabled: parseBoolean(env.MCP_STDIO_GUARD_ENABLED, true),
    idleTimeoutMs: parseNonNegativeInt(env.MCP_STDIO_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    parentCheckIntervalMs: parseNonNegativeInt(
      env.MCP_STDIO_PARENT_CHECK_INTERVAL_MS,
      DEFAULT_PARENT_CHECK_INTERVAL_MS
    ),
  };
}

export function startStdioLifecycleGuard(options: StartStdioLifecycleGuardOptions): () => void {
  const config = options.config ?? getStdioLifecycleConfig();
  if (!config.enabled) {
    return () => undefined;
  }

  const stdin = options.stdin ?? process.stdin;
  const getParentPid = options.getParentPid ?? (() => process.ppid);

  let stopped = false;
  let shutdownTriggered = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let parentTimer: NodeJS.Timeout | null = null;

  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const clearParentTimer = (): void => {
    if (parentTimer) {
      clearInterval(parentTimer);
      parentTimer = null;
    }
  };

  const triggerShutdown = (reason: string): void => {
    if (stopped || shutdownTriggered) {
      return;
    }

    shutdownTriggered = true;
    clearIdleTimer();
    clearParentTimer();
    detachListeners();

    Promise.resolve(options.onShutdown(reason)).catch((error) => {
      logger.error('stdio lifecycle shutdown handler failed', { reason, error });
    });
  };

  const resetIdleTimer = (): void => {
    if (config.idleTimeoutMs <= 0) {
      return;
    }

    clearIdleTimer();
    idleTimer = setTimeout(() => {
      triggerShutdown(`stdio idle timeout reached (${config.idleTimeoutMs}ms)`);
    }, config.idleTimeoutMs);
  };

  const onData = (): void => {
    resetIdleTimer();
  };

  const onEnd = (): void => {
    triggerShutdown('stdin stream ended');
  };

  const onClose = (): void => {
    triggerShutdown('stdin stream closed');
  };

  const detachListeners = (): void => {
    const stream = stdin as NodeJS.EventEmitter;
    if (typeof (stream as any).off === 'function') {
      (stream as any).off('data', onData);
      (stream as any).off('end', onEnd);
      (stream as any).off('close', onClose);
      return;
    }

    if (typeof stream.removeListener === 'function') {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
    }
  };

  const stream = stdin as NodeJS.EventEmitter;
  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onClose);

  resetIdleTimer();

  if (config.parentCheckIntervalMs > 0) {
    parentTimer = setInterval(() => {
      const parentPid = getParentPid();
      if (parentPid <= 1) {
        triggerShutdown(`parent process no longer available (ppid=${parentPid})`);
      }
    }, config.parentCheckIntervalMs);
  }

  return (): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearIdleTimer();
    clearParentTimer();
    detachListeners();
  };
}
