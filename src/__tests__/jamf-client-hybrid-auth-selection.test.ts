import { describe, expect, test, jest, beforeEach } from '@jest/globals';

const jestGlobals = jest;

const mockAxiosInstance = {
  get: jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<any>>,
  post: jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<any>>,
  put: jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<any>>,
  delete: jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<any>>,
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
};

const mockAxiosCreate = jest.fn(() => mockAxiosInstance);
const mockAxiosPost = jest.fn();

jestGlobals.unstable_mockModule('axios', () => ({
  default: {
    create: mockAxiosCreate,
    post: mockAxiosPost,
  },
}));

const { JamfApiClientHybrid } = await import('../jamf-client-hybrid.js');

describe('JamfApiClientHybrid auth selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  });

  test('prefers OAuth2 token for Modern endpoints when both tokens exist', () => {
    const client = new JamfApiClientHybrid({
      baseUrl: 'https://example.test',
      clientId: 'id',
      clientSecret: 'secret',
      username: 'user',
      password: 'pass',
    });

    const requestInterceptor = (mockAxiosInstance.interceptors.request.use as jest.Mock).mock.calls[0][0] as any;

    (client as any).bearerTokenAvailable = true;
    (client as any).bearerToken = { token: 'basic-bearer', issuedAt: new Date(), expires: new Date(Date.now() + 60_000), expiresIn: 60 };
    (client as any).oauth2Available = true;
    (client as any).oauth2Token = { token: 'oauth2-token', issuedAt: new Date(), expires: new Date(Date.now() + 60_000), expiresIn: 60 };

    const cfg = requestInterceptor({ url: '/api/v2/computer-groups/smart-groups', headers: {} });
    expect(cfg.headers.Authorization).toBe('Bearer oauth2-token');
  });

  test('uses Basic-derived bearer for Modern endpoints when OAuth2 token unavailable', () => {
    const client = new JamfApiClientHybrid({
      baseUrl: 'https://example.test',
      clientId: 'id',
      clientSecret: 'secret',
      username: 'user',
      password: 'pass',
    });

    const requestInterceptor = (mockAxiosInstance.interceptors.request.use as jest.Mock).mock.calls[0][0] as any;

    (client as any).bearerTokenAvailable = true;
    (client as any).bearerToken = { token: 'basic-bearer', issuedAt: new Date(), expires: new Date(Date.now() + 60_000), expiresIn: 60 };
    (client as any).oauth2Available = false;
    (client as any).oauth2Token = null;

    const cfg = requestInterceptor({ url: '/api/v1/computers-inventory', headers: {} });
    expect(cfg.headers.Authorization).toBe('Bearer basic-bearer');
  });

  test('uses bearer token for Classic endpoints when available', () => {
    const client = new JamfApiClientHybrid({
      baseUrl: 'https://example.test',
      username: 'user',
      password: 'pass',
    });

    const requestInterceptor = (mockAxiosInstance.interceptors.request.use as jest.Mock).mock.calls[0][0] as any;

    (client as any).bearerTokenAvailable = true;
    (client as any).bearerToken = { token: 'basic-bearer', issuedAt: new Date(), expires: new Date(Date.now() + 60_000), expiresIn: 60 };

    const cfg = requestInterceptor({ url: '/JSSResource/computergroups/id/0', headers: {} });
    expect(cfg.headers.Authorization).toBe('Bearer basic-bearer');
  });

  test('ensureAuthenticated refreshes OAuth2 even when bearer token exists', async () => {
    const client = new JamfApiClientHybrid({
      baseUrl: 'https://example.test',
      clientId: 'id',
      clientSecret: 'secret',
      username: 'user',
      password: 'pass',
    });

    // Bearer token present and not expiring
    (client as any).bearerTokenAvailable = true;
    (client as any).bearerToken = {
      token: 'basic-bearer',
      issuedAt: new Date(),
      expires: new Date(Date.now() + 60 * 60 * 1000),
      expiresIn: 3600,
    };

    // OAuth2 token missing/expired
    (client as any).oauth2Available = false;
    (client as any).oauth2Token = null;

    // Mock OAuth token fetch
    (mockAxiosPost as any).mockResolvedValue({
      data: {
        access_token: 'oauth2-token',
        expires_in: 1200,
      },
    });

    await (client as any).ensureAuthenticated();

    expect(mockAxiosPost).toHaveBeenCalledWith(
      'https://example.test/api/oauth/token',
      expect.anything(),
      expect.anything()
    );
    expect((client as any).oauth2Available).toBe(true);
    expect((client as any).oauth2Token?.token).toBe('oauth2-token');
  });
});
