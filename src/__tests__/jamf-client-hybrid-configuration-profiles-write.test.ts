import { describe, expect, test, jest, beforeEach } from '@jest/globals';

const mockAxiosInstance = {
  get: jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<any>>,
  post: jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<any>>,
  put: jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<any>>,
  patch: jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<any>>,
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

type ConfigProfileClient = InstanceType<typeof JamfApiClientHybrid> & {
  createConfigurationProfile: (type: 'computer' | 'mobiledevice' | 'mobile_device', profileData: any) => Promise<any>;
  updateConfigurationProfile: (
    profileId: string,
    type: 'computer' | 'mobiledevice' | 'mobile_device',
    profileData: any
  ) => Promise<any>;
};

const createClient = (readOnlyMode: boolean = false): ConfigProfileClient => {
  mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  const client = new JamfApiClientHybrid({
    baseUrl: 'https://example.test',
    username: 'user',
    password: 'pass',
    readOnlyMode,
  }) as ConfigProfileClient;

  (client as any).bearerTokenAvailable = true;
  (client as any).bearerToken = {
    token: 'token',
    issuedAt: new Date(),
    expires: new Date(Date.now() + 60 * 60 * 1000),
    expiresIn: 3600,
  };

  return client;
};

describe('JamfApiClientHybrid configuration profile create/update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.post.mockReset();
    mockAxiosInstance.put.mockReset();
    mockAxiosInstance.patch.mockReset();
    mockAxiosInstance.delete.mockReset();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
    process.env.JAMF_CONFIG_PROFILE_VERIFY_ENABLED = 'true';
    process.env.JAMF_CONFIG_PROFILE_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_CONFIG_PROFILE_VERIFY_DELAY_MS = '0';
    process.env.JAMF_CONFIG_PROFILE_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_CONFIG_PROFILE_VERIFY_MAX_DURATION_MS = '10000';
    process.env.JAMF_CONFLICT_RETRY_MAX = '1';
    process.env.JAMF_CONFLICT_RETRY_DELAY_MS = '0';
  });

  test('createConfigurationProfile creates and verifies persisted profile', async () => {
    const client = createClient();
    const payload =
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>A</key><string>B</string></dict></plist>';

    mockAxiosInstance.post.mockResolvedValueOnce({
      status: 201,
      data: { id: '501' },
      headers: {},
    });
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        id: '501',
        name: 'Baseline Profile',
        description: 'Test profile',
        payloads: payload,
      },
    });

    const result = await client.createConfigurationProfile('computer', {
      name: 'Baseline Profile',
      description: 'Test profile',
      payloads: payload,
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '/api/v2/computer-configuration-profiles',
      expect.objectContaining({
        name: 'Baseline Profile',
        payloads: payload,
      })
    );
    expect(result).toMatchObject({ id: '501', name: 'Baseline Profile' });
  });

  test('updateConfigurationProfile updates name and payload with strict verify', async () => {
    const client = createClient();
    const updatedPayload =
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>New</key><string>Value</string></dict></plist>';

    mockAxiosInstance.get
      .mockResolvedValueOnce({
        data: {
          id: '42',
          name: 'Old Name',
          description: 'Old description',
          payloads: '<plist><dict/></plist>',
          scope: { computerIds: [10] },
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: '42',
          name: 'New Name',
          description: 'New description',
          payloads: updatedPayload,
          scope: { computerIds: [10] },
        },
      });
    mockAxiosInstance.put.mockResolvedValueOnce({
      status: 200,
      data: { id: '42' },
    });

    const result = await client.updateConfigurationProfile('42', 'computer', {
      name: 'New Name',
      description: 'New description',
      payloads: updatedPayload,
      scope: { computerIds: [10] },
    });

    expect(mockAxiosInstance.put).toHaveBeenCalledWith(
      '/api/v2/computer-configuration-profiles/42',
      expect.objectContaining({
        name: 'New Name',
        description: 'New description',
        payloads: updatedPayload,
      })
    );
    expect(result).toMatchObject({ id: '42', name: 'New Name' });
  });

  test('createConfigurationProfile falls back to Classic API and still verifies persistence', async () => {
    const client = createClient();
    const payload =
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>k</key><string>v</string></dict></plist>';

    mockAxiosInstance.post
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: 'modern unavailable' } },
      })
      .mockResolvedValueOnce({
        status: 201,
        data: { os_x_configuration_profile: { id: '888' } },
        headers: {},
      });
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        id: '888',
        name: 'Classic Fallback',
        payloads: payload,
      },
    });

    const result = await client.createConfigurationProfile('computer', {
      name: 'Classic Fallback',
      payloads: payload,
    });

    expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
      1,
      '/api/v2/computer-configuration-profiles',
      expect.objectContaining({ name: 'Classic Fallback', payloads: payload })
    );
    expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
      2,
      '/JSSResource/osxconfigurationprofiles/id/0',
      expect.stringContaining('<os_x_configuration_profile>'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/xml',
          Accept: 'application/xml',
        }),
      })
    );
    const classicCreateXml = String((mockAxiosInstance.post.mock.calls[1] as any)?.[1] ?? '');
    expect(classicCreateXml).toContain('<name>Classic Fallback</name>');
    expect(classicCreateXml).toContain('&lt;plist');
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: '888', name: 'Classic Fallback' });
  });

  test('updateConfigurationProfile falls back to Classic API and still verifies persistence', async () => {
    const client = createClient();
    const payload =
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>k2</key><string>v2</string></dict></plist>';

    mockAxiosInstance.get
      .mockResolvedValueOnce({
        data: {
          id: '42',
          name: 'Before Fallback',
          payloads: '<plist><dict/></plist>',
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: '42',
          name: 'After Fallback',
          payloads: payload,
        },
      });
    mockAxiosInstance.put
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: 'modern unavailable' } },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { os_x_configuration_profile: { id: '42' } },
      });

    const result = await client.updateConfigurationProfile('42', 'computer', {
      name: 'After Fallback',
      payloads: payload,
    });

    expect(mockAxiosInstance.put).toHaveBeenNthCalledWith(
      1,
      '/api/v2/computer-configuration-profiles/42',
      expect.objectContaining({ name: 'After Fallback', payloads: payload })
    );
    expect(mockAxiosInstance.put).toHaveBeenNthCalledWith(
      2,
      '/JSSResource/osxconfigurationprofiles/id/42',
      expect.stringContaining('<os_x_configuration_profile>'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/xml',
          Accept: 'application/xml',
        }),
      })
    );
    const classicUpdateXml = String((mockAxiosInstance.put.mock.calls[1] as any)?.[1] ?? '');
    expect(classicUpdateXml).toContain('<name>After Fallback</name>');
    expect(classicUpdateXml).toContain('&lt;plist');
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ id: '42', name: 'After Fallback' });
  });

  test('serializes parallel updates to the same profile with per-profile write lock', async () => {
    const client = createClient();
    process.env.JAMF_CONFIG_PROFILE_VERIFY_ENABLED = 'false';

    mockAxiosInstance.get.mockResolvedValue({
      data: {
        id: '42',
        name: 'Current Name',
        payloads: '<plist><dict/></plist>',
      },
    });

    let inFlight = 0;
    let maxInFlight = 0;
    mockAxiosInstance.put.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { status: 200, data: { id: '42' } };
    });

    await Promise.all([
      client.updateConfigurationProfile('42', 'computer', {
        name: 'One',
        payloads: '<plist><dict><key>one</key><string>1</string></dict></plist>',
      }),
      client.updateConfigurationProfile('42', 'computer', {
        name: 'Two',
        payloads: '<plist><dict><key>two</key><string>2</string></dict></plist>',
      }),
    ]);

    expect(maxInFlight).toBe(1);
    expect(mockAxiosInstance.put).toHaveBeenCalledTimes(2);
  });

  test('createConfigurationProfile propagates 400 validation error for invalid payload', async () => {
    const client = createClient();
    const validationError = {
      isAxiosError: true,
      response: {
        status: 400,
        data: { error: 'Invalid payload' },
      },
    };
    mockAxiosInstance.post.mockRejectedValueOnce(validationError);

    await expect(
      client.createConfigurationProfile('computer', {
        name: 'Bad Profile',
        payloads: '<not-valid>',
      })
    ).rejects.toBe(validationError);
  });

  test('updateConfigurationProfile returns clear verify diagnostics when persistence does not converge', async () => {
    const client = createClient();
    process.env.JAMF_CONFIG_PROFILE_VERIFY_ATTEMPTS = '3';
    process.env.JAMF_CONFIG_PROFILE_VERIFY_DELAY_MS = '0';
    process.env.JAMF_CONFIG_PROFILE_VERIFY_REQUIRED_CONSISTENT_READS = '1';

    const requestedPayload =
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>x</key><string>y</string></dict></plist>';

    mockAxiosInstance.get
      .mockResolvedValueOnce({
        data: {
          id: '42',
          name: 'Initial',
          payloads: '<plist><dict/></plist>',
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: '42',
          name: 'Initial',
          payloads: '<plist><dict/></plist>',
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: '42',
          name: 'Initial',
          payloads: '<plist><dict/></plist>',
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: '42',
          name: 'Initial',
          payloads: '<plist><dict/></plist>',
        },
      });
    mockAxiosInstance.put.mockResolvedValueOnce({
      status: 200,
      data: { id: '42' },
    });

    await expect(
      client.updateConfigurationProfile('42', 'computer', {
        name: 'Expected Name',
        payloads: requestedPayload,
      })
    ).rejects.toThrow(
      /requestedFields|observedFields|payloadPersisted|fallbackFromModern|modernStatus|classicStatus|verifyAttempts/
    );
  });
});
