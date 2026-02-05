import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import type { JamfSearchCriteria } from '../types/jamf-api.js';

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

jest.unstable_mockModule('axios', () => ({
  default: {
    create: mockAxiosCreate,
    post: mockAxiosPost,
  },
}));

const { JamfApiClientHybrid } = await import('../jamf-client-hybrid.js');

type JamfApiClientHybridInstance = InstanceType<typeof JamfApiClientHybrid>;

type SmartGroupCriteriaInput = JamfSearchCriteria & {
  andOr?: 'and' | 'or';
  searchType?: string;
};

type SmartGroupCriteriaContainer = {
  criterion?: SmartGroupCriteriaInput[];
  criteria?: SmartGroupCriteriaInput[];
};

type SmartGroupClient = JamfApiClientHybridInstance & {
  createSmartComputerGroup: (
    name: string,
    criteria: SmartGroupCriteriaInput[],
    siteId?: number
  ) => Promise<any>;
  updateSmartComputerGroup: (
    groupId: string,
    updates: { name?: string; criteria?: SmartGroupCriteriaInput[]; siteId?: number }
  ) => Promise<any>;
};

const createClient = (): SmartGroupClient => {
  mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  const client = new JamfApiClientHybrid({
    baseUrl: 'https://example.test',
    username: 'user',
    password: 'pass',
  }) as SmartGroupClient;

  (client as any).bearerTokenAvailable = true;
  (client as any).bearerToken = {
    token: 'token',
    issuedAt: new Date(),
    expires: new Date(Date.now() + 60 * 60 * 1000),
    expiresIn: 3600,
  };

  return client;
};

describe('JamfApiClientHybrid smart group behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
  });

  test('createSmartComputerGroup prefers Modern API smart-groups endpoint', async () => {
    const client = createClient();
    const criteria: SmartGroupCriteriaInput[] = [
      {
        name: 'Last Check-in',
        priority: 0,
        and_or: 'and',
        search_type: 'more than x days ago',
        value: '30',
      },
    ];

    mockAxiosInstance.post.mockResolvedValue({ data: { id: '101' } });
    jestGlobals
      .spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '101', name: 'Smart Group', is_smart: true });

    await client.createSmartComputerGroup('Smart Group', criteria);

    expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v2/computer-groups/smart-groups');
  });

  test('createSmartComputerGroup falls back to Classic API when Modern fails', async () => {
    const client = createClient();
    const criteria: SmartGroupCriteriaInput[] = [
      {
        name: 'Last Check-in',
        priority: 0,
        and_or: 'and',
        search_type: 'more than x days ago',
        value: '30',
      },
    ];

    mockAxiosInstance.post
      .mockRejectedValueOnce(new Error('Modern create failed'))
      .mockResolvedValueOnce({ data: { id: '99' } });

    jestGlobals
      .spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '99', name: 'Fallback Group', is_smart: true });

    await client.createSmartComputerGroup('Fallback Group', criteria);

    expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v2/computer-groups/smart-groups');
    expect(mockAxiosInstance.post.mock.calls[1][0]).toBe('/JSSResource/computergroups/id/0');
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computer_group>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<name>Fallback Group</name>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<is_smart>true</is_smart>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<criteria>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][2]).toEqual(
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml',
        },
      })
    );
  });

  test('updateSmartComputerGroup updates via Modern API when Modern succeeds', async () => {
    const client = createClient();
    const criteria: SmartGroupCriteriaContainer = {
      criterion: [
        {
          name: 'Last Check-in',
          priority: 0,
          and_or: 'and',
          search_type: 'more than x days ago',
          value: '30',
        },
      ],
    };

    jestGlobals
      .spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '123', name: 'Smart Group', is_smart: true, criteria });

    mockAxiosInstance.put.mockResolvedValueOnce({ data: { id: '123' } });

    await client.updateSmartComputerGroup('123', { name: 'Updated Group' });

    expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v2/computer-groups/smart-groups/123');
    expect(mockAxiosInstance.put).toHaveBeenCalledTimes(1);
    expect(mockAxiosInstance.put.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        name: 'Updated Group',
        criteria: [
          expect.objectContaining({
            name: 'Last Check-in',
            priority: 0,
            andOr: 'and',
            searchType: 'more than x days ago',
            value: '30',
          }),
        ],
      })
    );
  });

  test('updateSmartComputerGroup falls back to Classic API when Modern fails', async () => {
    const client = createClient();
    const criteria: SmartGroupCriteriaInput[] = [
      {
        name: 'Last Check-in',
        priority: 0,
        and_or: 'and',
        search_type: 'more than x days ago',
        value: '30',
      },
    ];

    jestGlobals
      .spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '123', name: 'Smart Group', is_smart: true, criteria });

    mockAxiosInstance.put
      .mockRejectedValueOnce(new Error('Modern update failed'))
      .mockResolvedValueOnce({ data: { id: '123' } });

    await client.updateSmartComputerGroup('123', { name: 'Updated Group', criteria });

    expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v2/computer-groups/smart-groups/123');
    expect(mockAxiosInstance.put.mock.calls[1][0]).toBe('/JSSResource/computergroups/id/123');
    expect(mockAxiosInstance.put.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computer_group>')
    );
    expect(mockAxiosInstance.put.mock.calls[1][1]).toEqual(
      expect.stringContaining('<name>Updated Group</name>')
    );
    expect(mockAxiosInstance.put.mock.calls[1][1]).toEqual(
      expect.stringContaining('<is_smart>true</is_smart>')
    );
    expect(mockAxiosInstance.put.mock.calls[1][1]).toEqual(
      expect.stringContaining('<criteria>')
    );
    expect(mockAxiosInstance.put.mock.calls[1][2]).toEqual(
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml',
        },
      })
    );
  });

  test('createSmartComputerGroup maps normalized criteria to Modern payload', async () => {
    const client = createClient();
    const criteria: SmartGroupCriteriaInput[] = [
      {
        name: 'Serial Number',
        priority: 0,
        and_or: 'and',
        search_type: 'like',
        value: 'C02',
      },
    ];

    mockAxiosInstance.post.mockResolvedValue({ data: { id: '555' } });
    jestGlobals
      .spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '555', name: 'Mapped Group', is_smart: true });

    await client.createSmartComputerGroup('Mapped Group', criteria, 12);

    expect(mockAxiosInstance.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        name: 'Mapped Group',
        siteId: 12,
        criteria: [
          expect.objectContaining({
            name: 'Serial Number',
            priority: 0,
            andOr: 'and',
            searchType: 'like',
            value: 'C02',
          }),
        ],
      })
    );
  });

  test('createSmartComputerGroup rejects empty normalized criteria', async () => {
    const client = createClient();
    const criteria: SmartGroupCriteriaInput[] = [
      {
        name: '  ',
        priority: 0,
        and_or: 'and',
        search_type: 'more than x days ago',
        value: '30',
      },
    ];

    await expect(client.createSmartComputerGroup('Empty Criteria', criteria)).rejects.toThrow(
      'Smart group criteria cannot be empty'
    );
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  test('updateSmartComputerGroup rejects empty normalized criteria', async () => {
    const client = createClient();
    const criteria: SmartGroupCriteriaContainer = {
      criteria: [
        {
          name: 'Last Check-in',
          priority: 0,
          and_or: 'and',
          search_type: '',
          value: '30',
        },
      ],
    };

    jestGlobals
      .spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '123', name: 'Smart Group', is_smart: true, criteria });

    await expect(client.updateSmartComputerGroup('123', { name: 'Updated Group' })).rejects.toThrow(
      'Smart group criteria cannot be empty'
    );
    expect(mockAxiosInstance.put).not.toHaveBeenCalled();
  });

  test('createStaticComputerGroup prefers Modern API static-groups endpoint', async () => {
    const client = createClient();
    mockAxiosInstance.post.mockResolvedValue({ data: { id: '200' } });
    jestGlobals.spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '200', name: 'Static Group', is_smart: false });

    await client.createStaticComputerGroup('Static Group', ['10', '20']);

    expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v2/computer-groups/static-groups');
    expect(mockAxiosInstance.post.mock.calls[0][1]).toEqual({
      name: 'Static Group',
      computerIds: [10, 20],
    });
  });

  test('createStaticComputerGroup rejects invalid computer IDs after normalization', async () => {
    const client = createClient();

    await expect(
      client.createStaticComputerGroup('Static Group', [' ', 'abc', '0', '-2'])
    ).rejects.toThrow('Static group computer IDs cannot be empty');

    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  test('createStaticComputerGroup falls back to Classic API with XML payload', async () => {
    const client = createClient();

    mockAxiosInstance.post
      .mockRejectedValueOnce(new Error('Modern create failed'))
      .mockResolvedValueOnce({ data: { computer_group: { id: '201', name: 'Static Group' } } });

    await client.createStaticComputerGroup('Static Group', ['10', '20']);

    expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v2/computer-groups/static-groups');
    expect(mockAxiosInstance.post.mock.calls[1][0]).toBe('/JSSResource/computergroups/id/0');
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computer_group>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<name>Static Group</name>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<is_smart>false</is_smart>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computers>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computer><id>10</id></computer>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computer><id>20</id></computer>')
    );
    expect(mockAxiosInstance.post.mock.calls[1][2]).toEqual(
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml',
        },
      })
    );
  });

  test('updateStaticComputerGroup rejects invalid computer IDs after normalization', async () => {
    const client = createClient();
    jestGlobals.spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '200', name: 'Static Group', is_smart: false, computers: [] });

    await expect(
      client.updateStaticComputerGroup('200', [' ', 'abc'])
    ).rejects.toThrow('Static group computer IDs cannot be empty');

    expect(mockAxiosInstance.put).not.toHaveBeenCalled();
  });

  test('updateStaticComputerGroup prefers Modern API static-groups endpoint', async () => {
    const client = createClient();
    jestGlobals.spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '200', name: 'Static Group', is_smart: false, computers: [] });

    mockAxiosInstance.put.mockResolvedValue({ data: { id: '200' } });
    await client.updateStaticComputerGroup('200', ['10']);

    expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v2/computer-groups/static-groups/200');
    expect(mockAxiosInstance.put.mock.calls[0][1]).toEqual({
      name: 'Static Group',
      computerIds: [10],
    });
  });

  test('updateStaticComputerGroup falls back to Classic API with XML payload', async () => {
    const client = createClient();
    jestGlobals.spyOn(client, 'getComputerGroupDetails')
      .mockResolvedValue({ id: '200', name: 'Static & Group', is_smart: false, computers: [] });

    mockAxiosInstance.put
      .mockRejectedValueOnce(new Error('Modern update failed'))
      .mockResolvedValueOnce({ data: { success: true } });

    await client.updateStaticComputerGroup('200', ['10', '20']);

    expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v2/computer-groups/static-groups/200');
    expect(mockAxiosInstance.put.mock.calls[1][0]).toBe('/JSSResource/computergroups/id/200');
    expect(mockAxiosInstance.put.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computer_group>')
    );
    expect(mockAxiosInstance.put.mock.calls[1][1]).toEqual(
      expect.stringContaining('<name>Static &amp; Group</name>')
    );
    expect(mockAxiosInstance.put.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computer><id>10</id></computer>')
    );
    expect(mockAxiosInstance.put.mock.calls[1][1]).toEqual(
      expect.stringContaining('<computer><id>20</id></computer>')
    );
    expect(mockAxiosInstance.put.mock.calls[1][2]).toEqual(
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml',
        },
      })
    );
  });

  test('listPackages prefers Modern API', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { results: [{ id: '1', name: 'Pkg' }] } });

    const packages = await client.listPackages(10);

    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/packages');
    expect(packages).toHaveLength(1);
  });

  test('listPackages falls back to Classic API when Modern fails', async () => {
    const client = createClient();
    mockAxiosInstance.get
      .mockRejectedValueOnce(new Error('Modern list failed'))
      .mockResolvedValueOnce({ data: { packages: [{ id: '2', name: 'Classic Pkg' }] } });

    const packages = await client.listPackages(10);

    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/packages');
    expect(mockAxiosInstance.get.mock.calls[1][0]).toBe('/JSSResource/packages');
    expect(packages).toHaveLength(1);
  });

  test('listPackages normalizes Modern response', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({
      data: {
        results: [
          {
            id: '10',
            name: 'Modern Pkg',
            fileName: 'modern.pkg',
            category: 'Apps',
            size: 123,
            priority: 5,
            fillUserTemplate: true,
          },
        ],
      },
    });

    const packages = await client.listPackages(10);

    expect(packages).toEqual([
      {
        id: '10',
        name: 'Modern Pkg',
        filename: 'modern.pkg',
        category: 'Apps',
        size: 123,
        priority: 5,
        fill_user_template: true,
      },
    ]);
  });

  test('listPackages normalizes Classic response', async () => {
    const client = createClient();
    mockAxiosInstance.get
      .mockRejectedValueOnce(new Error('Modern list failed'))
      .mockResolvedValueOnce({
        data: {
          packages: [
            {
              id: 11,
              name: 'Classic Pkg',
              filename: 'classic.pkg',
              category: 'Legacy',
              size: 456,
              priority: 3,
              fill_user_template: false,
            },
          ],
        },
      });

    const packages = await client.listPackages(10);

    expect(packages).toEqual([
      {
        id: 11,
        name: 'Classic Pkg',
        filename: 'classic.pkg',
        category: 'Legacy',
        size: 456,
        priority: 3,
        fill_user_template: false,
      },
    ]);
  });

  test('getPackageDetails prefers Modern API', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { id: '1', name: 'Pkg' } });

    await client.getPackageDetails('1');

    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/packages/1');
  });

  test('getPackageDetails falls back to Classic API when Modern fails', async () => {
    const client = createClient();
    mockAxiosInstance.get
      .mockRejectedValueOnce(new Error('Modern details failed'))
      .mockResolvedValueOnce({ data: { package: { id: '2', name: 'Classic Pkg' } } });

    await client.getPackageDetails('2');

    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/packages/2');
    expect(mockAxiosInstance.get.mock.calls[1][0]).toBe('/JSSResource/packages/id/2');
  });

  test('getPackageDetails normalizes Modern response', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({
      data: {
        id: '20',
        name: 'Modern Pkg',
        fileName: 'modern.pkg',
        category: 'Apps',
        size: 321,
        priority: 2,
        fillUserTemplate: true,
      },
    });

    const pkg = await client.getPackageDetails('20');

    expect(pkg).toEqual({
      id: '20',
      name: 'Modern Pkg',
      filename: 'modern.pkg',
      category: 'Apps',
      size: 321,
      priority: 2,
      fill_user_template: true,
    });
  });

  test('getPackageDetails normalizes Classic response', async () => {
    const client = createClient();
    mockAxiosInstance.get
      .mockRejectedValueOnce(new Error('Modern details failed'))
      .mockResolvedValueOnce({
        data: {
          package: {
            id: 21,
            name: 'Classic Pkg',
            filename: 'classic.pkg',
            category: 'Legacy',
            size: 654,
            priority: 4,
            fill_user_template: false,
          },
        },
      });

    const pkg = await client.getPackageDetails('21');

    expect(pkg).toEqual({
      id: 21,
      name: 'Classic Pkg',
      filename: 'classic.pkg',
      category: 'Legacy',
      size: 654,
      priority: 4,
      fill_user_template: false,
    });
  });
});
