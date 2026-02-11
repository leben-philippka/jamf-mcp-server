import { describe, expect, test, jest } from '@jest/globals';

const { registerAllTools } = await import('../tools/register-all-tools.js');
const { SkillsManager } = await import('../skills/manager.js');
const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

describe('registerAllTools', () => {
  test('advertises base tools and skill_* tools together', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const skillsManager = new SkillsManager();
    const jamfClient = {} as any;

    registerAllTools(server, skillsManager, jamfClient);

    const listHandler = handlers.get(ListToolsRequestSchema);
    expect(listHandler).toBeDefined();

    const { tools } = await listHandler({} as any);
    expect(Array.isArray(tools)).toBe(true);

    // One base tool + one skill tool is enough to prove the unified dispatcher.
    expect(tools.some((t: any) => t.name === 'searchDevices')).toBe(true);
    expect(tools.some((t: any) => t.name === 'skill_device_search')).toBe(true);
  });
});

