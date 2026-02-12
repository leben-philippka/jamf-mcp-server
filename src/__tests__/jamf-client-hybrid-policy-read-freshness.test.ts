import { beforeEach, describe, expect, jest, test } from '@jest/globals';

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

jest.unstable_mockModule('axios', () => ({
  default: {
    create: mockAxiosCreate,
    post: mockAxiosPost,
  },
}));

const { JamfApiClientHybrid } = await import('../jamf-client-hybrid.js');

const createClient = (): InstanceType<typeof JamfApiClientHybrid> => {
  mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  const client = new JamfApiClientHybrid({
    baseUrl: 'https://example.test',
    username: 'user',
    password: 'pass',
  }) as any;

  client.bearerTokenAvailable = true;
  client.bearerToken = {
    token: 'token',
    issuedAt: new Date(),
    expires: new Date(Date.now() + 60 * 60 * 1000),
    expiresIn: 3600,
  };

  return client as any;
};

describe('JamfApiClientHybrid policy read freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  });

  test('getPolicyDetails uses cache-bypass headers and timestamp param', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { policy: { id: 134 } } });

    await client.getPolicyDetails('134');

    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    const args = mockAxiosInstance.get.mock.calls[0];
    expect(args[0]).toBe('/JSSResource/policies/id/134');
    expect(args[1]?.headers?.['Cache-Control']).toBe('no-cache');
    expect(args[1]?.headers?.Pragma).toBe('no-cache');
    expect(typeof args[1]?.params?._ts).toBe('number');
  });

  test('getPolicyXml uses cache-bypass headers and timestamp param', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValueOnce({ data: '<policy/>' });

    await client.getPolicyXml('134');

    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    const args = mockAxiosInstance.get.mock.calls[0];
    expect(args[0]).toBe('/JSSResource/policies/id/134');
    expect(args[1]?.headers?.Accept).toBe('application/xml');
    expect(args[1]?.headers?.['Cache-Control']).toBe('no-cache');
    expect(args[1]?.headers?.Pragma).toBe('no-cache');
    expect(typeof args[1]?.params?._ts).toBe('number');
    expect(args[1]?.responseType).toBe('text');
  });
});
