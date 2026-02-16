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


describe('JamfApiClientHybrid updatePolicyXml strict verify for date_time_limitations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.put.mockReset();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
    process.env.JAMF_CONFLICT_RETRY_MAX = '1';
    process.env.JAMF_CONFLICT_RETRY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '2';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'true';
  });

  test('throws if date_time_limitations from policyXml do not persist', async () => {
    const client = createClient();

    mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

    // Existing full policy XML used as merge base for partial updatePolicyXml payload.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<policy><general><id>74</id><name>Auto Update - Notion</name>' +
        '<date_time_limitations><no_execute_start>08:00</no_execute_start></date_time_limitations>' +
        '</general></policy>',
    });

    // Immediate post-write read.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        policy: {
          id: 74,
          general: {
            date_time_limitations: {
              no_execute_start: '09:00',
            },
          },
        },
      },
    });

    // Verify attempt 1: JSON looks updated, XML still stale.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        policy: {
          id: 74,
          general: {
            date_time_limitations: {
              no_execute_start: '09:00',
            },
          },
        },
      },
    });
    mockAxiosInstance.get.mockResolvedValueOnce({
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<policy><general><date_time_limitations><no_execute_start>08:00</no_execute_start></date_time_limitations></general></policy>',
    });

    // Verify attempt 2: JSON still updated, XML still stale.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        policy: {
          id: 74,
          general: {
            date_time_limitations: {
              no_execute_start: '09:00',
            },
          },
        },
      },
    });
    mockAxiosInstance.get.mockResolvedValueOnce({
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<policy><general><date_time_limitations><no_execute_start>08:00</no_execute_start></date_time_limitations></general></policy>',
    });

    await expect(
      (client as any).updatePolicyXml(
        '74',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><general><date_time_limitations><no_execute_start>09:00</no_execute_start></date_time_limitations></general></policy>'
      )
    ).rejects.toThrow('did not persist requested fields');
  });

  test('merges partial date_time_limitations XML payload and normalizes AM/PM values', async () => {
    const client = createClient();

    mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

    // Existing full policy XML used as merge base for partial updatePolicyXml payload.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<policy><general><id>74</id><name>Auto Update - Google Chrome</name>' +
        '<date_time_limitations><no_execute_on/><no_execute_start/><no_execute_end/></date_time_limitations>' +
        '</general></policy>',
    });

    // Immediate post-write read.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        policy: {
          id: 74,
          general: {
            date_time_limitations: {
              no_execute_start: '17:00',
              no_execute_end: '09:00',
            },
          },
        },
      },
    });

    // Verify readback: JSON + XML both updated.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        policy: {
          id: 74,
          general: {
            date_time_limitations: {
              no_execute_start: '17:00',
              no_execute_end: '09:00',
            },
          },
        },
      },
    });
    mockAxiosInstance.get.mockResolvedValueOnce({
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<policy><general><date_time_limitations><no_execute_start>17:00</no_execute_start><no_execute_end>09:00</no_execute_end></date_time_limitations></general></policy>',
    });

    await (client as any).updatePolicyXml(
      '74',
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<policy><general><date_time_limitations><no_execute_start>5:00 PM</no_execute_start><no_execute_end>9:00 AM</no_execute_end></date_time_limitations></general></policy>'
    );

    expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1);
    const putPayload = String(mockAxiosInstance.put.mock.calls[0]?.[1] ?? '');
    expect(putPayload).toContain('<name>Auto Update - Google Chrome</name>');
    expect(putPayload).toContain('<no_execute_start>17:00</no_execute_start>');
    expect(putPayload).toContain('<no_execute_end>09:00</no_execute_end>');
  });

  test('treats self-closing no_execute_on as an explicit empty value for strict verify', async () => {
    const client = createClient();

    mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

    // Existing full policy XML used as merge base for partial updatePolicyXml payload.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<policy><general><id>74</id><name>Auto Update - Google Chrome</name>' +
        '<date_time_limitations><no_execute_on>Monday</no_execute_on></date_time_limitations>' +
        '</general></policy>',
    });

    // Immediate post-write read.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        policy: {
          id: 74,
          general: {
            date_time_limitations: {
              no_execute_on: {},
            },
          },
        },
      },
    });

    // Verify readback: JSON empty-object + XML self-closing should both be accepted as empty.
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        policy: {
          id: 74,
          general: {
            date_time_limitations: {
              no_execute_on: {},
            },
          },
        },
      },
    });
    mockAxiosInstance.get.mockResolvedValueOnce({
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<policy><general><date_time_limitations><no_execute_on/></date_time_limitations></general></policy>',
    });

    await expect(
      (client as any).updatePolicyXml(
        '74',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><general><date_time_limitations><no_execute_on/></date_time_limitations></general></policy>'
      )
    ).resolves.toBeDefined();
  });
});
