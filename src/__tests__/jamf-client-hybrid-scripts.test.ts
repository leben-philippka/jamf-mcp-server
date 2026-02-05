import { jest as jestGlobals } from '@jest/globals';
import { jest } from '@jest/globals';
import axios from 'axios';

const mockAxiosInstance = {
  get: jestGlobals.fn() as jest.Mock<any>,
  post: jestGlobals.fn() as jest.Mock<any>,
  put: jestGlobals.fn() as jest.Mock<any>,
  delete: jestGlobals.fn() as jest.Mock<any>,
  interceptors: {
    request: { use: jestGlobals.fn() as jest.Mock<any> },
    response: { use: jestGlobals.fn() as jest.Mock<any> },
  },
};

const mockedAxios = axios as unknown as {
  create: jest.Mock;
  post: jest.Mock;
};

const mockLogger = {
  info: jestGlobals.fn(),
  warn: jestGlobals.fn(),
  error: jestGlobals.fn(),
  debug: jestGlobals.fn(),
};

jestGlobals.unstable_mockModule('../server/logger.js', () => ({
  createLogger: () => mockLogger,
}));

const { JamfApiClientHybrid } = await import('../jamf-client-hybrid.js');

const createClient = () => {
  const client = new JamfApiClientHybrid({
    baseUrl: 'https://jamf.example.test',
    username: 'api-user',
    password: 'api-pass',
  });

  const issuedAt = new Date();
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  (client as any).bearerToken = {
    token: 'bearer-token',
    expires,
    issuedAt,
    expiresIn: 3600,
  };
  (client as any).bearerTokenAvailable = true;

  return client;
};

describe('JamfApiClientHybrid scripts (Modern API preferred)', () => {
  beforeEach(() => {
    jestGlobals.restoreAllMocks();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    jestGlobals.spyOn(axios, 'create').mockReturnValue(mockAxiosInstance as any);
    jestGlobals.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.post.mockReset();
    mockAxiosInstance.put.mockReset();
    mockAxiosInstance.delete.mockReset();
    mockAxiosInstance.interceptors.request.use.mockReset();
    mockAxiosInstance.interceptors.response.use.mockReset();
    mockedAxios.post.mockReset();
  });

  test('listScripts prefers Modern API', async () => {
    const client = createClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { results: [{ id: '1', name: 'Script A' }] } });

    const scripts = await client.listScripts(10);

    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/scripts');
    expect(scripts).toHaveLength(1);
  });

  test('createScript prefers Modern API', async () => {
    const client = createClient();
    mockAxiosInstance.post.mockResolvedValue({ data: { id: '10' } });
    mockAxiosInstance.get.mockResolvedValue({ data: { id: '10', name: 'Script A' } });

    await client.createScript({ name: 'Script A', script_contents: 'echo ok' });

    expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v1/scripts');
    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/scripts/10');
  });

  test('createScript falls back to Classic API when Modern fails', async () => {
    const client = createClient();
    const scriptContents = 'echo secret';

    mockAxiosInstance.post
      .mockRejectedValueOnce(new Error('modern fail'))
      .mockResolvedValueOnce({
        headers: { location: 'https://jamf.example.test/JSSResource/scripts/id/101' },
        data: {},
      });
    mockAxiosInstance.get
      .mockRejectedValueOnce(new Error('modern fail'))
      .mockResolvedValueOnce({
        data: { script: { id: 101, name: 'Classic Script', script_contents: scriptContents } },
      });

    const created = await client.createScript({ name: 'Classic Script', script_contents: scriptContents });

    expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v1/scripts');
    expect(mockAxiosInstance.post.mock.calls[1][0]).toBe('/JSSResource/scripts/id/0');
    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/scripts/101');
    expect(mockAxiosInstance.get.mock.calls[1][0]).toBe('/JSSResource/scripts/id/101');
    expect(created).toEqual({
      id: 101,
      name: 'Classic Script',
      scriptContents: scriptContents,
    });

    const loggedOutput = mockLogger.info.mock.calls
      .flat()
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join(' ');
    expect(loggedOutput).not.toContain(scriptContents);
  });

  test('updateScript prefers Modern API', async () => {
    const client = createClient();
    mockAxiosInstance.put.mockResolvedValue({ data: { id: '10' } });
    mockAxiosInstance.get.mockResolvedValue({ data: { id: '10', name: 'Script A' } });

    await client.updateScript('10', { name: 'Script A' });

    expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v1/scripts/10');
    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/scripts/10');
  });

  test('updateScript falls back to Classic API when Modern fails', async () => {
    const client = createClient();
    mockAxiosInstance.put
      .mockRejectedValueOnce(new Error('modern fail'))
      .mockResolvedValueOnce({ data: {} });
    mockAxiosInstance.get
      .mockRejectedValueOnce(new Error('modern fail'))
      .mockResolvedValueOnce({ data: { script: { id: 33, name: 'Classic Update' } } });

    await client.updateScript('33', { name: 'Classic Update' });

    expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v1/scripts/33');
    expect(mockAxiosInstance.put.mock.calls[1][0]).toBe('/JSSResource/scripts/id/33');
    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/scripts/33');
    expect(mockAxiosInstance.get.mock.calls[1][0]).toBe('/JSSResource/scripts/id/33');
  });

  test('deleteScript prefers Modern API', async () => {
    const client = createClient();
    mockAxiosInstance.delete.mockResolvedValue({ data: {} });

    await client.deleteScript('10');

    expect(mockAxiosInstance.delete.mock.calls[0][0]).toBe('/api/v1/scripts/10');
  });

  test('deleteScript falls back to Classic API when Modern fails', async () => {
    const client = createClient();
    mockAxiosInstance.delete
      .mockRejectedValueOnce(new Error('modern fail'))
      .mockResolvedValueOnce({ data: {} });

    await client.deleteScript('77');

    expect(mockAxiosInstance.delete.mock.calls[0][0]).toBe('/api/v1/scripts/77');
    expect(mockAxiosInstance.delete.mock.calls[1][0]).toBe('/JSSResource/scripts/id/77');
  });

  test('getScriptDetails falls back to Classic API and normalizes fields', async () => {
    const client = createClient();
    mockAxiosInstance.get
      .mockRejectedValueOnce(new Error('modern fail'))
      .mockResolvedValueOnce({
        data: {
          script: {
            id: 7,
            name: 'Classic Script',
            category: 'Utilities',
            filename: 'classic.sh',
            info: 'info',
            notes: 'notes',
            priority: 'After',
            parameters: { parameter4: 'p4' },
            os_requirements: '10.15',
            script_contents: 'echo classic',
          },
        },
      });

    const script = await client.getScriptDetails('7');

    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/scripts/7');
    expect(mockAxiosInstance.get.mock.calls[1][0]).toBe('/JSSResource/scripts/id/7');
    expect(script).toEqual({
      id: 7,
      name: 'Classic Script',
      category: 'Utilities',
      filename: 'classic.sh',
      info: 'info',
      notes: 'notes',
      priority: 'After',
      parameters: { parameter4: 'p4' },
      osRequirements: '10.15',
      scriptContents: 'echo classic',
    });
  });

  test('listScripts falls back to Classic API and normalizes fields', async () => {
    const client = createClient();
    mockAxiosInstance.get
      .mockRejectedValueOnce(new Error('modern fail'))
      .mockResolvedValueOnce({ data: { scripts: [{ id: 3, name: 'Classic A' }] } });

    const scripts = await client.listScripts(10);

    expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/scripts');
    expect(mockAxiosInstance.get.mock.calls[1][0]).toBe('/JSSResource/scripts');
    expect(scripts).toEqual([{ id: 3, name: 'Classic A' }]);
  });

  test('createScript maps Modern payload fields and normalizes response', async () => {
    const client = createClient();
    mockAxiosInstance.post.mockResolvedValue({ data: { id: '42' } });
    mockAxiosInstance.get.mockResolvedValue({
      data: {
        id: '42',
        name: 'Script A',
        scriptContents: 'echo ok',
        scriptContentsEncoded: true,
        osRequirements: '13.0',
      },
    });

    const created = await client.createScript({
      name: 'Script A',
      script_contents: 'echo ok',
      script_contents_encoded: true,
      os_requirements: '13.0',
    });

    expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v1/scripts');
    expect(mockAxiosInstance.post.mock.calls[0][1]).toEqual({
      name: 'Script A',
      category: undefined,
      info: undefined,
      notes: undefined,
      priority: undefined,
      scriptContents: 'echo ok',
      scriptContentsEncoded: true,
      parameters: undefined,
      osRequirements: '13.0',
    });
    expect(created).toEqual({
      id: '42',
      name: 'Script A',
      scriptContents: 'echo ok',
      scriptContentsEncoded: true,
      osRequirements: '13.0',
    });
  });

  test('updateScript maps Modern payload fields and normalizes response', async () => {
    const client = createClient();
    mockAxiosInstance.put.mockResolvedValue({ data: { id: '55' } });
    mockAxiosInstance.get.mockResolvedValue({
      data: {
        id: '55',
        name: 'Updated Script',
        scriptContents: 'echo updated',
        scriptContentsEncoded: false,
        osRequirements: '12.5',
      },
    });

    const updated = await client.updateScript('55', {
      script_contents: 'echo updated',
      script_contents_encoded: false,
      os_requirements: '12.5',
    });

    expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v1/scripts/55');
    expect(mockAxiosInstance.put.mock.calls[0][1]).toEqual({
      name: undefined,
      category: undefined,
      info: undefined,
      notes: undefined,
      priority: undefined,
      scriptContents: 'echo updated',
      scriptContentsEncoded: false,
      parameters: undefined,
      osRequirements: '12.5',
    });
    expect(updated).toEqual({
      id: '55',
      name: 'Updated Script',
      scriptContents: 'echo updated',
      scriptContentsEncoded: false,
      osRequirements: '12.5',
    });
  });
});
