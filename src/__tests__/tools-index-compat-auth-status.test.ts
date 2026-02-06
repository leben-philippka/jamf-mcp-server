import { describe, expect, test, jest } from '@jest/globals';

const { registerTools } = await import('../tools/index-compat.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

describe('index-compat tools: getAuthStatus', () => {
  test('registers getAuthStatus tool and handler', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const jamfClient = {
      getAuthStatus: () => ({
        hasOAuth2: true,
        hasBasicAuth: false,
        oauth2Available: true,
        bearerTokenAvailable: false,
        oauth2: null,
        bearer: null,
      }),
    } as any;

    registerTools(server, jamfClient);

    const listHandler = handlers.get(ListToolsRequestSchema);
    expect(listHandler).toBeDefined();
    const { tools } = await listHandler();
    expect(tools.some((t: any) => t.name === 'getAuthStatus')).toBe(true);

    const callHandler = handlers.get(CallToolRequestSchema);
    expect(callHandler).toBeDefined();

    const response = await callHandler({
      params: {
        name: 'getAuthStatus',
        arguments: {},
      },
    });

    expect(response).toHaveProperty('content');
    const text = response.content?.[0]?.text;
    expect(typeof text).toBe('string');
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({
      hasOAuth2: true,
      oauth2Available: true,
    });
  });
});
