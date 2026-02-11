import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import { 
  normalizeError, 
  asyncHandler, 
  withTimeout,
  safeJsonParse,
  executeWithFallback,
  buildErrorContext
} from '../../utils/error-handler.js';
import { 
  JamfAPIError, 
  NetworkError, 
  AuthenticationError,
  RateLimitError 
} from '../../utils/errors.js';

describe('Error Handler Utilities', () => {
  describe('normalizeError', () => {
    test('should return JamfAPIError as-is', () => {
      const error = new JamfAPIError('Test error', 400);
      const result = normalizeError(error);
      expect(result).toBe(error);
    });

    test('should convert network errors', () => {
      const error = new Error('ECONNREFUSED: Connection refused');
      const result = normalizeError(error);
      expect(result).toBeInstanceOf(NetworkError);
      expect(result.message).toContain('Connection refused');
    });

    test('should convert auth errors', () => {
      const error = new Error('Unauthorized access');
      const result = normalizeError(error);
      expect(result).toBeInstanceOf(AuthenticationError);
    });

    test('should handle non-Error objects', () => {
      const result = normalizeError('String error');
      expect(result).toBeInstanceOf(JamfAPIError);
      expect(result.message).toBe('String error');
    });
  });

  describe('buildErrorContext', () => {
    test('adds actionable suggestions for patch policy log 404 responses', () => {
      const error: any = new Error('Request failed with status code 404');
      error.response = {
        status: 404,
        data: {
          errors: [{ description: 'Patch Policy Id 999999999 does not exist' }],
        },
      };
      error.config = { method: 'get', url: '/api/v2/patch-policies/999999999/logs' };

      const result = buildErrorContext(error, 'Execute tool: getPatchPolicyLogs', 'index-compat');

      expect(result.code).toBe('HTTP_404');
      expect(result.message).toContain('Patch Policy Id 999999999 does not exist');
      expect(result.suggestions?.[0]).toContain('listPatchPolicies');
    });

    test('adds toggle guidance for managed software update 503 responses', () => {
      const error: any = new Error('Request failed with status code 503');
      error.response = {
        status: 503,
        data: {
          errors: [{ description: 'This endpoint cannot be used if the Managed Software Update Plans toggle is off.' }],
        },
      };
      error.config = { method: 'get', url: '/api/v1/managed-software-updates/available-updates' };

      const result = buildErrorContext(error, 'Execute tool: getManagedSoftwareUpdatesAvailable', 'index-compat');

      expect(result.code).toBe('HTTP_503');
      expect(result.message).toContain('toggle is off');
      expect(result.suggestions?.[0]).toContain('Managed Software Update Plans is disabled');
    });
  });

  describe('asyncHandler', () => {
    test('should handle successful async operations', async () => {
      const handler = asyncHandler(async (req, res) => {
        res.json({ success: true });
      });

      const req = { method: 'GET', path: '/test', ip: '127.0.0.1' } as any;
      const res = { json: jest.fn() } as any;
      const next = jest.fn();

      await handler(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true });
      expect(next).not.toHaveBeenCalled();
    });

    test('should catch and forward errors', async () => {
      const error = new Error('Test error');
      const handler = asyncHandler(async () => {
        throw error;
      });

      const req = { method: 'GET', path: '/test', ip: '127.0.0.1' } as any;
      const res = {} as any;
      const next = jest.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalled();
      const forwardedError = next.mock.calls[0][0];
      expect(forwardedError).toBeInstanceOf(JamfAPIError);
    });
  });

  describe('withTimeout', () => {
    test('should resolve before timeout', async () => {
      const promise = new Promise(resolve => setTimeout(() => resolve('success'), 50));
      const result = await withTimeout(promise, 200, 'Test operation');
      expect(result).toBe('success');
    });

    test('should timeout on slow operations', async () => {
      const promise = new Promise(resolve => setTimeout(() => resolve('success'), 200));
      await expect(withTimeout(promise, 50, 'Test operation'))
        .rejects
        .toThrow('Test operation timed out after 50ms');
    });
  });

  describe('safeJsonParse', () => {
    test('should parse valid JSON', () => {
      const result = safeJsonParse('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    test('should return default on invalid JSON', () => {
      const result = safeJsonParse('invalid json', { default: true });
      expect(result).toEqual({ default: true });
    });

    test('should return null by default on error', () => {
      const result = safeJsonParse('invalid json');
      expect(result).toBeNull();
    });
  });

  describe('executeWithFallback', () => {
    test('should use primary when successful', async () => {
      const primary = jest.fn().mockResolvedValue('primary result');
      const fallback = jest.fn().mockResolvedValue('fallback result');

      const result = await executeWithFallback(primary, fallback, 'Test operation');

      expect(result).toBe('primary result');
      expect(primary).toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    });

    test('should use fallback when primary fails', async () => {
      const primary = jest.fn().mockRejectedValue(new Error('Primary failed'));
      const fallback = jest.fn().mockResolvedValue('fallback result');

      const result = await executeWithFallback(primary, fallback, 'Test operation');

      expect(result).toBe('fallback result');
      expect(primary).toHaveBeenCalled();
      expect(fallback).toHaveBeenCalled();
    });

    test('should throw original error when both fail', async () => {
      const primaryError = new Error('Primary failed');
      const primary = jest.fn().mockRejectedValue(primaryError);
      const fallback = jest.fn().mockRejectedValue(new Error('Fallback failed'));

      await expect(executeWithFallback(primary, fallback, 'Test operation'))
        .rejects
        .toThrow('Primary failed');
    });
  });
});
