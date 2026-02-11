import { describe, expect, test, jest } from '@jest/globals';

const { registerAllTools } = await import('../tools/register-all-tools.js');
const { SkillsManager } = await import('../skills/manager.js');
const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

describe('policy tool schemas', () => {
  test('createPolicy and updatePolicy advertise self_service fields', async () => {
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
    const createPolicy = tools.find((t: any) => t.name === 'createPolicy');
    const updatePolicy = tools.find((t: any) => t.name === 'updatePolicy');

    expect(createPolicy?.inputSchema?.properties?.policyData?.properties?.self_service).toBeDefined();
    expect(updatePolicy?.inputSchema?.properties?.policyData?.properties?.self_service).toBeDefined();
    expect(
      createPolicy?.inputSchema?.properties?.policyData?.properties?.self_service?.properties?.self_service_categories
    ).toBeDefined();
    expect(
      updatePolicy?.inputSchema?.properties?.policyData?.properties?.self_service?.properties?.self_service_categories
    ).toBeDefined();
    expect(
      createPolicy?.inputSchema?.properties?.policyData?.properties?.self_service?.properties?.notification_subject
    ).toBeDefined();
    expect(
      updatePolicy?.inputSchema?.properties?.policyData?.properties?.self_service?.properties?.notification_subject
    ).toBeDefined();
    expect(createPolicy?.inputSchema?.properties?.policyXml).toBeDefined();
    expect(updatePolicy?.inputSchema?.properties?.policyXml).toBeDefined();
  });
});
