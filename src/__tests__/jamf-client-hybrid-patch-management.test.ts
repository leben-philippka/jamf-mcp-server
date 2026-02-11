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

type PatchClient = InstanceType<typeof JamfApiClientHybrid> & {
  listPatchAvailableTitles: (sourceId?: string) => Promise<any>;
  listPatchPolicies: (limit?: number) => Promise<any>;
  getPatchPolicyLogs: (policyId: string, limit?: number) => Promise<any>;
  retryPatchPolicyLogs: (policyId: string, retryAll?: boolean, payload?: any) => Promise<any>;
  listPatchSoftwareTitleConfigurations: (limit?: number) => Promise<any>;
  getPatchSoftwareTitleConfiguration: (configId: string) => Promise<any>;
  getPatchSoftwareTitleConfigurationSummary: (configId: string) => Promise<any>;
  getPatchSoftwareTitleConfigurationVersionSummary: (configId: string) => Promise<any>;
  createPatchSoftwareTitleConfiguration: (config: any) => Promise<any>;
  updatePatchSoftwareTitleConfiguration: (configId: string, updates: any) => Promise<any>;
  deletePatchSoftwareTitleConfiguration: (configId: string) => Promise<any>;
  getPatchSoftwareTitleConfigurationReport: (configId: string) => Promise<any>;
  getManagedSoftwareUpdatesAvailable: () => Promise<any>;
  getManagedSoftwareUpdateStatuses: (limit?: number) => Promise<any>;
  listManagedSoftwareUpdatePlans: (limit?: number) => Promise<any>;
  getManagedSoftwareUpdatePlan: (planId: string) => Promise<any>;
  getManagedSoftwareUpdatePlansFeatureToggle: () => Promise<any>;
  getManagedSoftwareUpdatePlansFeatureToggleStatus: () => Promise<any>;
  createManagedSoftwareUpdatePlan: (plan: any) => Promise<any>;
  createManagedSoftwareUpdatePlanForGroup: (plan: any) => Promise<any>;
};

const createClient = (readOnlyMode: boolean = false): PatchClient => {
  mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  const client = new JamfApiClientHybrid({
    baseUrl: 'https://example.test',
    username: 'user',
    password: 'pass',
    readOnlyMode,
  }) as PatchClient;

  (client as any).bearerTokenAvailable = true;
  (client as any).bearerToken = {
    token: 'token',
    issuedAt: new Date(),
    expires: new Date(Date.now() + 60 * 60 * 1000),
    expiresIn: 3600,
  };

  return client;
};

describe('JamfApiClientHybrid patch management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.post.mockReset();
    mockAxiosInstance.put.mockReset();
    mockAxiosInstance.patch.mockReset();
    mockAxiosInstance.delete.mockReset();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
    process.env.JAMF_PATCH_VERIFY_ENABLED = 'true';
    process.env.JAMF_PATCH_VERIFY_ATTEMPTS = '1';
    process.env.JAMF_PATCH_VERIFY_REQUIRED_CONSISTENT_READS = '1';
    process.env.JAMF_PATCH_VERIFY_DELAY_MS = '0';
  });

  test('listPatchPolicies calls v2 patch policies endpoint', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { results: [{ id: '1' }] } });

    const result = await client.listPatchPolicies(42);

    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v2/patch-policies', {
      params: { 'page-size': 42 },
    });
    expect(result).toEqual({ results: [{ id: '1' }] });
  });

  test('listPatchAvailableTitles calls classic patch available titles endpoint', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({
      data: {
        patch_available_titles: {
          size: '1',
          available_titles: {
            available_title: [{ name_id: 'ABC', app_name: 'Google Chrome', current_version: '136.0' }],
          },
        },
      },
    });

    const result = await client.listPatchAvailableTitles('1');

    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/JSSResource/patchavailabletitles/sourceid/1', {
      headers: { Accept: 'application/json' },
    });
    expect(result).toEqual({
      patch_available_titles: {
        size: '1',
        available_titles: {
          available_title: [{ name_id: 'ABC', app_name: 'Google Chrome', current_version: '136.0' }],
        },
      },
    });
  });

  test('listPatchAvailableTitles falls back to XML when JSON appears truncated', async () => {
    const client = createClient();
    mockAxiosInstance.get
      .mockResolvedValueOnce({
        data: {
          patch_available_titles: {
            size: '1500',
            available_titles: {
              available_title: { name_id: 'ZZZ', app_name: 'Zulu OpenJDK 9', current_version: '9.0.7.1' },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: '<?xml version=\"1.0\" encoding=\"UTF-8\"?><patch_available_titles><size>1500</size><available_titles><available_title><name_id>50F</name_id><current_version>8.12.2</current_version><publisher>AgileBits</publisher><last_modified>2026-02-10T19:03:30Z</last_modified><app_name>1Password 8</app_name></available_title><available_title><name_id>6C9</name_id><current_version>136.0</current_version><publisher>Google</publisher><last_modified>2026-02-10T19:03:30Z</last_modified><app_name>Google Chrome</app_name></available_title></available_titles></patch_available_titles>',
      });

    const result = await client.listPatchAvailableTitles('1');

    expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(1, '/JSSResource/patchavailabletitles/sourceid/1', {
      headers: { Accept: 'application/json' },
    });
    expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, '/JSSResource/patchavailabletitles/sourceid/1', {
      headers: { Accept: 'application/xml' },
      responseType: 'text',
      transformResponse: expect.any(Function),
    });
    expect(result?.patch_available_titles?.available_titles?.available_title).toHaveLength(2);
    expect(result?.patch_available_titles?.available_titles?.available_title?.[1]?.app_name).toBe('Google Chrome');
  });

  test('retryPatchPolicyLogs uses retry-all endpoint when requested', async () => {
    const client = createClient();
    mockAxiosInstance.post.mockResolvedValue({ data: { retried: 5 } });

    const result = await client.retryPatchPolicyLogs('99', true);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v2/patch-policies/99/logs/retry-all');
    expect(result).toEqual({ retried: 5 });
  });

  test('createPatchSoftwareTitleConfiguration calls v2 endpoint', async () => {
    const client = createClient();
    const payload = { displayName: 'Google Chrome' };
    mockAxiosInstance.post.mockResolvedValue({ data: { id: '321', ...payload } });
    mockAxiosInstance.get.mockResolvedValue({ data: { id: '321', displayName: 'Google Chrome' } });

    const result = await client.createPatchSoftwareTitleConfiguration(payload);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v2/patch-software-title-configurations', payload);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v2/patch-software-title-configurations/321');
    expect(result).toMatchObject({ id: '321', displayName: 'Google Chrome' });
  });

  test('updatePatchSoftwareTitleConfiguration verifies persisted fields', async () => {
    const client = createClient();
    const updates = { displayName: 'Updated Chrome' };
    mockAxiosInstance.patch.mockResolvedValue({ data: { id: '321', displayName: 'Updated Chrome' } });
    mockAxiosInstance.get.mockResolvedValue({ data: { id: '321', displayName: 'Updated Chrome' } });

    const result = await client.updatePatchSoftwareTitleConfiguration('321', updates);

    expect(mockAxiosInstance.patch).toHaveBeenCalledWith(
      '/api/v2/patch-software-title-configurations/321',
      updates,
      {
        headers: {
          'Content-Type': 'application/merge-patch+json',
        },
      }
    );
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v2/patch-software-title-configurations/321');
    expect(result).toMatchObject({ id: '321', displayName: 'Updated Chrome' });
  });

  test('updatePatchSoftwareTitleConfiguration strict verification fails on mismatch', async () => {
    const client = createClient();
    const updates = { displayName: 'Updated Chrome' };
    mockAxiosInstance.patch.mockResolvedValue({ data: { id: '321', displayName: 'Updated Chrome' } });
    mockAxiosInstance.get.mockResolvedValue({ data: { id: '321', displayName: 'Old Chrome' } });

    await expect(client.updatePatchSoftwareTitleConfiguration('321', updates)).rejects.toThrow(
      'did not persist requested fields'
    );
  });

  test('deletePatchSoftwareTitleConfiguration verifies resource is deleted', async () => {
    const client = createClient();
    mockAxiosInstance.delete.mockResolvedValue({ data: { status: 'ok' } });
    mockAxiosInstance.get.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { message: 'not found' } },
    });

    const result = await client.deletePatchSoftwareTitleConfiguration('321');

    expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/api/v2/patch-software-title-configurations/321');
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v2/patch-software-title-configurations/321');
    expect(result).toEqual({ status: 'ok' });
  });

  test('createPatchSoftwareTitleConfiguration rejects in read-only mode', async () => {
    const client = createClient(true);

    await expect(client.createPatchSoftwareTitleConfiguration({ displayName: 'Chrome' })).rejects.toThrow(
      'Cannot create patch software title configurations in read-only mode'
    );
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  test('getPatchSoftwareTitleConfigurationSummary calls patch-summary endpoint', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { patched: 10, unpatched: 2 } });

    const result = await client.getPatchSoftwareTitleConfigurationSummary('77');

    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v2/patch-software-title-configurations/77/patch-summary');
    expect(result).toEqual({ patched: 10, unpatched: 2 });
  });

  test('getPatchSoftwareTitleConfigurationVersionSummary calls patch-summary/versions endpoint', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { versions: [{ version: '122.0', count: 5 }] } });

    const result = await client.getPatchSoftwareTitleConfigurationVersionSummary('77');

    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v2/patch-software-title-configurations/77/patch-summary/versions');
    expect(result).toEqual({ versions: [{ version: '122.0', count: 5 }] });
  });

  test('getManagedSoftwareUpdatesAvailable calls modern managed software updates endpoint', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { updates: [{ productVersion: '14.7.1' }] } });

    const result = await client.getManagedSoftwareUpdatesAvailable();

    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v1/managed-software-updates/available-updates');
    expect(result).toEqual({ updates: [{ productVersion: '14.7.1' }] });
  });

  test('createManagedSoftwareUpdatePlan calls plans endpoint', async () => {
    const client = createClient();
    const payload = { recipeId: 'macOS-14-latest' };
    mockAxiosInstance.post.mockResolvedValue({ data: { id: 'plan-1', ...payload } });

    const result = await client.createManagedSoftwareUpdatePlan(payload);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v1/managed-software-updates/plans', payload);
    expect(result).toMatchObject({ id: 'plan-1', recipeId: 'macOS-14-latest' });
  });

  test('getManagedSoftwareUpdatePlansFeatureToggle calls plans feature-toggle endpoint', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { enabled: true } });

    const result = await client.getManagedSoftwareUpdatePlansFeatureToggle();

    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v1/managed-software-updates/plans/feature-toggle');
    expect(result).toEqual({ enabled: true });
  });

  test('getManagedSoftwareUpdatePlansFeatureToggleStatus calls plans feature-toggle status endpoint', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { status: 'ENABLED' } });

    const result = await client.getManagedSoftwareUpdatePlansFeatureToggleStatus();

    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v1/managed-software-updates/plans/feature-toggle/status');
    expect(result).toEqual({ status: 'ENABLED' });
  });

  test('createManagedSoftwareUpdatePlan rejects in read-only mode', async () => {
    const client = createClient(true);

    await expect(client.createManagedSoftwareUpdatePlan({ recipeId: 'macOS-14-latest' })).rejects.toThrow(
      'Cannot create managed software update plans in read-only mode'
    );
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });
});
