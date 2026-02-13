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

const createClient = (): InstanceType<typeof JamfApiClientHybrid> => {
  mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  const client = new JamfApiClientHybrid({
    baseUrl: 'https://example.test',
    username: 'user',
    password: 'pass',
  }) as any;

  // Skip auth refresh logic in tests.
  client.bearerTokenAvailable = true;
  client.bearerToken = {
    token: 'token',
    issuedAt: new Date(),
    expires: new Date(Date.now() + 60 * 60 * 1000),
    expiresIn: 3600,
  };

  return client as any;
};

describe('JamfApiClientHybrid updatePolicy classic merge behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.post.mockReset();
    mockAxiosInstance.put.mockReset();
    mockAxiosInstance.delete.mockReset();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  });

  test('updatePolicy preserves existing general section when patch omits general', async () => {
    const client = createClient();
    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'false';

    try {
      // getPolicyXml (pre-update fetch)
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy>' +
          '<general><name>Remove - Microsoft Teams</name></general>' +
          '<self_service><use_for_self_service>true</use_for_self_service></self_service>' +
          '</policy>',
      });

      // updatePolicyXml PUT
      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

      // getPolicyDetails (post-update fetch)
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          policy: {
            id: 91,
            general: { name: 'Remove - Microsoft Teams' },
            self_service: { use_for_self_service: true },
          },
        },
      });

      // verifyPolicyUpdatePersisted fresh read
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          policy: {
            id: 91,
            general: { name: 'Remove - Microsoft Teams' },
            self_service: { use_for_self_service: true },
          },
        },
      });

      await client.updatePolicy('91', {
        self_service: {
          use_for_self_service: true,
          self_service_category: { id: 17, name: 'Apps löschen' },
        },
      });

      // Ensure the Classic PUT happened.
      expect(mockAxiosInstance.put).toHaveBeenCalled();

      const putArgs = mockAxiosInstance.put.mock.calls[0];
      expect(putArgs[0]).toBe('/JSSResource/policies/id/91');
      const xml = String(putArgs[1] ?? '');

      // Key behavior: existing general section remains intact even if patch omits it.
      expect(xml).toContain('<general>');
      expect(xml).toContain('<name>Remove - Microsoft Teams</name>');

      // And include the self service category fields.
      expect(xml).toContain('<self_service_category>Apps löschen</self_service_category>');
      expect(xml).toContain('<self_service_categories>');
      expect(xml).toContain('<id>17</id>');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });

  test('updatePolicy preserves unknown self_service fields while updating notification_subject', async () => {
    const client = createClient();
    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'false';

    try {
      // getPolicyXml (pre-update fetch)
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy>' +
          '<general><name>Auto Update - Notion</name></general>' +
          '<self_service>' +
          '<notification>false</notification>' +
          '<notification_type>Self Service</notification_type>' +
          '<notification_subject>AI - Notion</notification_subject>' +
          '<self_service_icon><uri>https://cdn.example/icon.png</uri></self_service_icon>' +
          '</self_service>' +
          '</policy>',
      });

      // updatePolicyXml PUT
      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

      // getPolicyDetails (post-update fetch)
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          policy: {
            id: 74,
            general: { name: 'Auto Update - Notion' },
            self_service: {
              notification_subject: 'Auto Update - Notion',
            },
          },
        },
      });

      // verifyPolicyUpdatePersisted fresh read
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          policy: {
            id: 74,
            general: { name: 'Auto Update - Notion' },
            self_service: {
              notification_subject: 'Auto Update - Notion',
            },
          },
        },
      });

      await client.updatePolicy('74', {
        self_service: {
          notification_subject: 'Auto Update - Notion',
        },
      });

      expect(mockAxiosInstance.put).toHaveBeenCalled();

      const putArgs = mockAxiosInstance.put.mock.calls[0];
      expect(putArgs[0]).toBe('/JSSResource/policies/id/74');
      const xml = String(putArgs[1] ?? '');

      // Ensure updated field is changed and unknown icon field is preserved.
      expect(xml).toContain('<notification_subject>Auto Update - Notion</notification_subject>');
      expect(xml).toContain('<self_service_icon><uri>https://cdn.example/icon.png</uri></self_service_icon>');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });

  test('updatePolicy retries verification reads until requested self_service field is persisted', async () => {
    const client = createClient();

    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '3';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'false';

    try {
      // getPolicyXml
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><self_service><notification_subject>OLD</notification_subject></self_service></policy>',
      });

      // updatePolicyXml -> immediate read still old
      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 74, self_service: { notification_subject: 'OLD' } } },
      });

      // verify attempt 1 -> still old
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 74, self_service: { notification_subject: 'OLD' } } },
      });

      // verify attempt 2 -> updated
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 74, self_service: { notification_subject: 'Auto Update - Notion' } } },
      });

      const result = await client.updatePolicy('74', {
        self_service: {
          notification_subject: 'Auto Update - Notion',
        },
      });

      expect(result?.self_service?.notification_subject).toBe('Auto Update - Notion');
      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(4);
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });

  test('updatePolicy throws when requested field is still unchanged after verification retries', async () => {
    const client = createClient();

    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '2';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'false';

    try {
      // getPolicyXml
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><self_service><notification_subject>OLD</notification_subject></self_service></policy>',
      });

      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

      // updatePolicyXml -> immediate read old
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 80, self_service: { notification_subject: 'OLD' } } },
      });
      // verify attempt 1 -> still old
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 80, self_service: { notification_subject: 'OLD' } } },
      });
      // verify attempt 2 -> still old
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 80, self_service: { notification_subject: 'OLD' } } },
      });

      await expect(
        client.updatePolicy('80', {
          self_service: {
            notification_subject: 'Auto Update - 1Password 8',
          },
        })
      ).rejects.toThrow('did not persist requested fields');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });

  test('updatePolicy does not trust immediate write readback and requires a fresh persisted read', async () => {
    const client = createClient();

    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'false';

    try {
      // getPolicyXml
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><self_service><notification_subject>OLD</notification_subject></self_service></policy>',
      });

      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

      // updatePolicyXml immediate read returns updated value
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 74, self_service: { notification_subject: 'Auto Update - Notion' } } },
      });

      // fresh verification read still old -> must fail
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 74, self_service: { notification_subject: 'OLD' } } },
      });

      await expect(
        client.updatePolicy('74', {
          self_service: {
            notification_subject: 'Auto Update - Notion',
          },
        })
      ).rejects.toThrow('did not persist requested fields');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });

  test('updatePolicy strict mode fails when JSON is updated but XML source still mismatches', async () => {
    const client = createClient();

    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'true';

    try {
      // getPolicyXml (pre-update fetch)
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><self_service><notification_subject>OLD</notification_subject></self_service></policy>',
      });

      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

      // updatePolicyXml immediate readback
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 74, self_service: { notification_subject: 'Auto Update - Notion' } } },
      });

      // strict verify JSON readback (looks updated)
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 74, self_service: { notification_subject: 'Auto Update - Notion' } } },
      });

      // strict verify XML readback (still old)
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><self_service><notification_subject>OLD</notification_subject></self_service></policy>',
      });

      await expect(
        client.updatePolicy('74', {
          self_service: {
            notification_subject: 'Auto Update - Notion',
          },
        })
      ).rejects.toThrow('did not persist requested fields');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });

  test('updatePolicy writes maintenance fields into Classic policy XML patch', async () => {
    const client = createClient();
    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'false';

    try {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy>' +
          '<general><name>Auto Update - Google Chrome</name></general>' +
          '<maintenance><recon>false</recon></maintenance>' +
          '</policy>',
      });

      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          policy: {
            id: 134,
            general: { name: 'Auto Update - Google Chrome' },
            maintenance: { recon: true, permissions: true },
          },
        },
      });

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          policy: {
            id: 134,
            general: { name: 'Auto Update - Google Chrome' },
            maintenance: { recon: true, permissions: true },
          },
        },
      });

      await client.updatePolicy('134', {
        maintenance: {
          recon: true,
          permissions: true,
        },
      });

      expect(mockAxiosInstance.put).toHaveBeenCalled();
      const putArgs = mockAxiosInstance.put.mock.calls[0];
      expect(putArgs[0]).toBe('/JSSResource/policies/id/134');
      const xml = String(putArgs[1] ?? '');
      expect(xml).toContain('<maintenance>');
      expect(xml).toContain('<recon>true</recon>');
      expect(xml).toContain('<permissions>true</permissions>');
      expect(xml).toContain('<name>Auto Update - Google Chrome</name>');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });

  test('updatePolicy strict mode verifies maintenance fields against XML source', async () => {
    const client = createClient();

    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'true';

    try {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><maintenance><recon>false</recon></maintenance></policy>',
      });

      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 133, maintenance: { recon: true } } },
      });

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { policy: { id: 133, maintenance: { recon: true } } },
      });

      // XML still stale although JSON looks updated.
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><maintenance><recon>false</recon></maintenance></policy>',
      });

      await expect(
        client.updatePolicy('133', {
          maintenance: {
            recon: true,
          },
        })
      ).rejects.toThrow('did not persist requested fields');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });
});

describe('JamfApiClientHybrid updatePolicy date_time_limitations behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.post.mockReset();
    mockAxiosInstance.put.mockReset();
    mockAxiosInstance.delete.mockReset();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  });

  test('updatePolicy writes general.date_time_limitations into Classic policy XML patch', async () => {
    const client = createClient();
    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'false';

    try {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy>' +
          '<general><name>Auto Update - Notion</name></general>' +
          '</policy>',
      });

      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          policy: {
            id: 74,
            general: {
              name: 'Auto Update - Notion',
              date_time_limitations: {
                no_execute_start: '09:00',
                no_execute_end: '17:00',
                no_execute_on: 'Monday',
              },
            },
          },
        },
      });

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          policy: {
            id: 74,
            general: {
              name: 'Auto Update - Notion',
              date_time_limitations: {
                no_execute_start: '09:00',
                no_execute_end: '17:00',
                no_execute_on: 'Monday',
              },
            },
          },
        },
      });

      await client.updatePolicy('74', {
        general: {
          date_time_limitations: {
            no_execute_start: '09:00',
            no_execute_end: '17:00',
            no_execute_on: 'Monday',
          },
        },
      });

      expect(mockAxiosInstance.put).toHaveBeenCalled();
      const putArgs = mockAxiosInstance.put.mock.calls[0];
      expect(putArgs[0]).toBe('/JSSResource/policies/id/74');
      const xml = String(putArgs[1] ?? '');
      expect(xml).toContain('<general>');
      expect(xml).toContain('<date_time_limitations>');
      expect(xml).toContain('<no_execute_start>09:00</no_execute_start>');
      expect(xml).toContain('<no_execute_end>17:00</no_execute_end>');
      expect(xml).toContain('<no_execute_on>Monday</no_execute_on>');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });

  test('updatePolicy strict mode verifies date_time_limitations fields against XML source', async () => {
    const client = createClient();

    const prevAttempts = process.env.JAMF_POLICY_VERIFY_ATTEMPTS;
    const prevDelay = process.env.JAMF_POLICY_VERIFY_DELAY_MS;
    const prevConsistentReads = process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS;
    const prevRequireXml = process.env.JAMF_POLICY_VERIFY_REQUIRE_XML;
    process.env.JAMF_POLICY_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_POLICY_VERIFY_DELAY_MS = '0';
    process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = 'true';

    try {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<policy><general><date_time_limitations><no_execute_start>08:00</no_execute_start></date_time_limitations></general></policy>',
      });

      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });

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
        client.updatePolicy('74', {
          general: {
            date_time_limitations: {
              no_execute_start: '09:00',
            },
          },
        })
      ).rejects.toThrow('did not persist requested fields');
    } finally {
      process.env.JAMF_POLICY_VERIFY_ATTEMPTS = prevAttempts;
      process.env.JAMF_POLICY_VERIFY_DELAY_MS = prevDelay;
      process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS = prevConsistentReads;
      process.env.JAMF_POLICY_VERIFY_REQUIRE_XML = prevRequireXml;
    }
  });
});
