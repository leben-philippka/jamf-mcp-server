import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';

class JsonWebTokenError extends Error {}

const mockJwt = {
  default: {
    verify: jest.fn(),
    decode: jest.fn(),
    JsonWebTokenError
  }
};

const mockJwks = {
  default: jest.fn(() => ({
    getSigningKey: jest.fn()
  }))
};

jest.unstable_mockModule('jsonwebtoken', () => mockJwt);
jest.unstable_mockModule('jwks-rsa', () => mockJwks);

const { authMiddleware, cleanupAuthMiddleware } = await import('../../server/auth-middleware.js');
const jwt = (await import('jsonwebtoken')).default;
const jwksRsa = (await import('jwks-rsa')).default;

describe('Auth Middleware', () => {
  let mockReq: any;
  let mockRes: any;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      headers: {},
      ip: '127.0.0.1',
      method: 'GET',
      originalUrl: '/test',
      path: '/test'
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn()
    };

    mockNext = jest.fn();

    // Reset environment variables
    process.env.OAUTH_PROVIDER = 'dev';
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('authMiddleware', () => {
    test('should reject requests without Authorization header', async () => {
      await authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Missing authorization header'
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('should reject requests with invalid Bearer format', async () => {
      mockReq.headers = { authorization: 'BearerToken' };

      await authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Invalid authorization header format'
      });
    });

    test('should authenticate with dev token in development', async () => {
      process.env.OAUTH_PROVIDER = 'dev';
      mockReq.headers = { authorization: 'Bearer dev-token' };
      const mockVerify = jwt.verify as jest.Mock;
      mockVerify.mockReturnValue({
        sub: 'dev-user',
        permissions: ['read:all', 'write:all']
      });

      await authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).user).toEqual({
        sub: 'dev-user',
        permissions: ['read:all', 'write:all']
      });
    });

    test('should handle Okta token validation', async () => {
      process.env.OAUTH_PROVIDER = 'okta';
      process.env.OKTA_DOMAIN = 'https://test.okta.com';
      process.env.OKTA_CLIENT_ID = 'test-client-id';
      const mockVerify = jwt.verify as jest.Mock;
      const mockJwksClient = jwksRsa as unknown as jest.Mock;
      mockJwksClient.mockReturnValue({
        getSigningKey: (_kid: string, callback: (err: Error | null, key?: { publicKey: string }) => void) => {
          callback(null, { publicKey: 'test-public-key' });
        }
      });
      
      mockVerify.mockImplementation((_token: any, _getKey: any, _options: any, callback: any) => {
        callback(null, { sub: 'okta-user', permissions: ['read', 'write'] });
      });

      mockReq.headers = { authorization: 'Bearer valid-jwt' };

      await authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).user).toMatchObject({
        sub: 'okta-user',
        permissions: ['read', 'write']
      });
    });

    test('should handle JWT validation errors', async () => {
      process.env.OAUTH_PROVIDER = 'dev';
      const mockVerify = jwt.verify as jest.Mock;
      
      mockVerify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      mockReq.headers = { authorization: 'Bearer invalid-jwt' };

      await authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Invalid token'
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('should handle Auth0 token validation', async () => {
      process.env.OAUTH_PROVIDER = 'auth0';
      process.env.AUTH0_DOMAIN = 'test.auth0.com';
      process.env.AUTH0_AUDIENCE = 'https://api.test.com';

      const mockVerify = jwt.verify as jest.Mock;

      const mockJwksClient = jwksRsa as unknown as jest.Mock;
      const mockGetSigningKey = jest.fn((_kid: string, callback: any) => {
        callback(null, { publicKey: 'test-public-key' });
      });

      mockJwksClient.mockReturnValue({
        getSigningKey: mockGetSigningKey
      });

      mockVerify.mockImplementation((_token: any, _key: any, _options: any, callback: any) => {
        callback(null, {
          sub: 'auth0|user123', 
          permissions: ['read:devices', 'write:devices']
        });
      });

      mockReq.headers = { authorization: 'Bearer valid-auth0-token' };

      await authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).user).toMatchObject({
        sub: 'auth0|user123',
        permissions: ['read:devices', 'write:devices']
      });
    });

    test('should handle missing JWT_SECRET', async () => {
      process.env.OAUTH_PROVIDER = 'dev';
      delete process.env.JWT_SECRET;

      mockReq.headers = { authorization: 'Bearer some-token' };

      await authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'JWT_SECRET not configured for dev mode'
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('cleanupAuthMiddleware', () => {
    test('should clean up resources without errors', () => {
      expect(() => cleanupAuthMiddleware()).not.toThrow();
    });
  });
});
