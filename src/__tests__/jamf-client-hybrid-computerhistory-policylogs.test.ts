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

describe('JamfApiClientHybrid computer history policy logs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.post.mockReset();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  });

  test('getComputerPolicyLogs fetches PolicyLogs by serial number via Classic API', async () => {
    const client = createClient();

    mockAxiosInstance.get.mockResolvedValueOnce({ data: { ok: true } });

    const serial = 'C02TESTSERIAL';
    const res = await (client as any).getComputerPolicyLogs({ serialNumber: serial });

    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe(
      `/JSSResource/computerhistory/serialnumber/${encodeURIComponent(serial)}/subset/PolicyLogs`
    );
    expect(res).toEqual({ ok: true });
  });

  test('getComputerPolicyLogs fetches PolicyLogs by id via Classic API', async () => {
    const client = createClient();

    mockAxiosInstance.get.mockResolvedValueOnce({ data: { ok: true } });

    const id = '123';
    await (client as any).getComputerPolicyLogs({ deviceId: id });

    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe(
      `/JSSResource/computerhistory/id/${encodeURIComponent(id)}/subset/PolicyLogs`
    );
  });
});

