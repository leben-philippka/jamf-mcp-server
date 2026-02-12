import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';

import {
  getStdioLifecycleConfig,
  startStdioLifecycleGuard,
} from '../../utils/stdio-lifecycle.js';

describe('stdio lifecycle guard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  test('uses strict defaults when env vars are missing', () => {
    const config = getStdioLifecycleConfig({});

    expect(config.enabled).toBe(true);
    expect(config.idleTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.parentCheckIntervalMs).toBe(30 * 1000);
  });

  test('allows disabling the guard via env', () => {
    const config = getStdioLifecycleConfig({
      MCP_STDIO_GUARD_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    expect(config.enabled).toBe(false);
  });

  test('shuts down on idle timeout and resets on stdin activity', () => {
    const stdin = new EventEmitter() as NodeJS.ReadableStream;
    const onShutdown = jest.fn();

    startStdioLifecycleGuard({
      stdin,
      onShutdown,
      getParentPid: () => 1234,
      config: {
        enabled: true,
        idleTimeoutMs: 50,
        parentCheckIntervalMs: 0,
      },
    });

    jest.advanceTimersByTime(30);
    stdin.emit('data', Buffer.from('ping'));
    jest.advanceTimersByTime(30);
    expect(onShutdown).not.toHaveBeenCalled();

    jest.advanceTimersByTime(21);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledWith(expect.stringContaining('idle'));
  });

  test('shuts down when stdin closes or ends (once only)', () => {
    const stdin = new EventEmitter() as NodeJS.ReadableStream;
    const onShutdown = jest.fn();

    startStdioLifecycleGuard({
      stdin,
      onShutdown,
      getParentPid: () => 1234,
      config: {
        enabled: true,
        idleTimeoutMs: 0,
        parentCheckIntervalMs: 0,
      },
    });

    stdin.emit('close');
    stdin.emit('end');
    stdin.emit('close');

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledWith(expect.stringContaining('stdin'));
  });

  test('shuts down when parent process is gone', () => {
    const stdin = new EventEmitter() as NodeJS.ReadableStream;
    const onShutdown = jest.fn();
    let parentPid = 1234;

    startStdioLifecycleGuard({
      stdin,
      onShutdown,
      getParentPid: () => parentPid,
      config: {
        enabled: true,
        idleTimeoutMs: 0,
        parentCheckIntervalMs: 20,
      },
    });

    jest.advanceTimersByTime(20);
    expect(onShutdown).not.toHaveBeenCalled();

    parentPid = 1;
    jest.advanceTimersByTime(20);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledWith(expect.stringContaining('parent'));
  });
});
