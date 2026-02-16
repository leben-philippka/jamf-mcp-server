import { describe, expect, test, jest } from '@jest/globals';

const { registerAllTools } = await import('../tools/register-all-tools.js');
const { SkillsManager } = await import('../skills/manager.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

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

  test('createPolicy and updatePolicy advertise maintenance fields', async () => {
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

    const createMaintenance =
      createPolicy?.inputSchema?.properties?.policyData?.properties?.maintenance?.properties;
    const updateMaintenance =
      updatePolicy?.inputSchema?.properties?.policyData?.properties?.maintenance?.properties;

    expect(createMaintenance).toBeDefined();
    expect(updateMaintenance).toBeDefined();

    for (const field of [
      'recon',
      'reset_name',
      'install_all_cached_packages',
      'heal',
      'prebindings',
      'permissions',
      'byhost',
      'system_cache',
      'user_cache',
      'verify',
    ]) {
      expect(createMaintenance?.[field]).toBeDefined();
      expect(updateMaintenance?.[field]).toBeDefined();
    }
  });

  test('createPolicy and updatePolicy advertise general.date_time_limitations fields', async () => {
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

    const createDateTime =
      createPolicy?.inputSchema?.properties?.policyData?.properties?.general?.properties?.date_time_limitations
        ?.properties;
    const updateDateTime =
      updatePolicy?.inputSchema?.properties?.policyData?.properties?.general?.properties?.date_time_limitations
        ?.properties;

    expect(createDateTime).toBeDefined();
    expect(updateDateTime).toBeDefined();
    expect(createDateTime?.no_execute_start).toBeDefined();
    expect(createDateTime?.no_execute_end).toBeDefined();
    expect(createDateTime?.no_execute_on).toBeDefined();
    expect(createDateTime?.activation_date).toBeDefined();
    expect(createDateTime?.activation_date_epoch).toBeDefined();
    expect(createDateTime?.activation_date_utc).toBeDefined();
    expect(createDateTime?.expiration_date).toBeDefined();
    expect(createDateTime?.expiration_date_epoch).toBeDefined();
    expect(createDateTime?.expiration_date_utc).toBeDefined();
    expect(updateDateTime?.no_execute_start).toBeDefined();
    expect(updateDateTime?.no_execute_end).toBeDefined();
    expect(updateDateTime?.no_execute_on).toBeDefined();
    expect(updateDateTime?.activation_date).toBeDefined();
    expect(updateDateTime?.activation_date_epoch).toBeDefined();
    expect(updateDateTime?.activation_date_utc).toBeDefined();
    expect(updateDateTime?.expiration_date).toBeDefined();
    expect(updateDateTime?.expiration_date_epoch).toBeDefined();
    expect(updateDateTime?.expiration_date_utc).toBeDefined();
  });

  test('updatePolicy forwards general.date_time_limitations to jamf client', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const skillsManager = new SkillsManager();
    const jamfClient = {
      updatePolicy: jest.fn(async () => ({ id: 74 })),
    } as any;

    registerAllTools(server, skillsManager, jamfClient);

    const callHandler = handlers.get(CallToolRequestSchema);
    expect(callHandler).toBeDefined();

    await callHandler({
      params: {
        name: 'updatePolicy',
        arguments: {
          confirm: true,
          policyId: '74',
          policyData: {
            general: {
              date_time_limitations: {
                no_execute_start: '08:00',
                no_execute_end: '18:00',
                no_execute_on: 'Monday',
              },
            },
          },
        },
      },
    });

    expect(jamfClient.updatePolicy).toHaveBeenCalledTimes(1);
    expect(jamfClient.updatePolicy).toHaveBeenCalledWith(
      '74',
      expect.objectContaining({
        general: expect.objectContaining({
          date_time_limitations: {
            no_execute_start: '08:00',
            no_execute_end: '18:00',
            no_execute_on: 'Monday',
          },
        }),
      })
    );
  });

  test('updatePolicyXml returns explicit date_time_limitations 409 diagnostics', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const skillsManager = new SkillsManager();
    const jamfClient = {
      updatePolicyXml: jest.fn(async () => {
        throw new Error(
          'Classic policy XML update failed with 409 (Problem with date_time_limitations). policyId="134"'
        );
      }),
    } as any;

    registerAllTools(server, skillsManager, jamfClient);

    const callHandler = handlers.get(CallToolRequestSchema);
    expect(callHandler).toBeDefined();

    const response = await callHandler({
      params: {
        name: 'updatePolicyXml',
        arguments: {
          confirm: true,
          policyId: '134',
          policyXml:
            '<?xml version="1.0" encoding="UTF-8"?><policy><general><date_time_limitations><no_execute_start>5:00 PM</no_execute_start></date_time_limitations></general></policy>',
        },
      },
    });

    const text = String(response?.content?.[0]?.text ?? '');
    expect(text).toContain('Jamf rejected date_time_limitations while updating policy 134');
  });

  test('updatePolicy returns explicit date_time_limitations 409 diagnostics', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const skillsManager = new SkillsManager();
    const jamfClient = {
      updatePolicy: jest.fn(async () => {
        throw new Error(
          'Classic policy XML update failed with 409 (Problem with date_time_limitations). policyId="134"'
        );
      }),
    } as any;

    registerAllTools(server, skillsManager, jamfClient);

    const callHandler = handlers.get(CallToolRequestSchema);
    expect(callHandler).toBeDefined();

    const response = await callHandler({
      params: {
        name: 'updatePolicy',
        arguments: {
          confirm: true,
          policyId: '134',
          policyData: {
            general: {
              date_time_limitations: {
                no_execute_start: '5:00 PM',
                no_execute_end: '9:00 AM',
                no_execute_on: '',
              },
            },
          },
        },
      },
    });

    const text = String(response?.content?.[0]?.text ?? '');
    expect(text).toContain('Jamf rejected date_time_limitations while updating policy 134');
  });
});
