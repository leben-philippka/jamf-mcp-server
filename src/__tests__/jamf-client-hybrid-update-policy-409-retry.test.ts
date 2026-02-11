import { describe, expect, test, jest, beforeEach } from '@jest/globals';

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

type JamfApiClientHybridInstance = InstanceType<typeof JamfApiClientHybrid>;

const createClient = (): JamfApiClientHybridInstance => {
  mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  const client = new JamfApiClientHybrid({
    baseUrl: 'https://example.test',
    username: 'user',
    password: 'pass',
  }) as JamfApiClientHybridInstance;

  (client as any).bearerTokenAvailable = true;
  (client as any).bearerToken = {
    token: 'token',
    issuedAt: new Date(),
    expires: new Date(Date.now() + 60 * 60 * 1000),
    expiresIn: 3600,
  };

  return client;
};

describe('JamfApiClientHybrid updatePolicyXml 409 retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.put.mockReset();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
    process.env.JAMF_CONFLICT_RETRY_MAX = '2';
    process.env.JAMF_CONFLICT_RETRY_DELAY_MS = '0';
  });

  test('retries once on 409 Conflict and then succeeds', async () => {
    const client = createClient();

    jest.spyOn(client as any, 'getPolicyDetails').mockResolvedValue({ id: '1' });

    mockAxiosInstance.put
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { message: 'Conflict' } } })
      .mockResolvedValueOnce({ data: {} });

    await (client as any).updatePolicyXml('1', '<policy/>');

    expect(mockAxiosInstance.put).toHaveBeenCalledTimes(2);
  });
});

