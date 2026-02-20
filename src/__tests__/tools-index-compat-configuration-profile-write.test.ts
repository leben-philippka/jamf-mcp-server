import { describe, expect, test, jest } from '@jest/globals';

const { registerAllTools } = await import('../tools/register-all-tools.js');
const { SkillsManager } = await import('../skills/manager.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

describe('configuration profile write tools', () => {
  test('advertises create/update configuration profile tools with conditional payload requirement', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    registerAllTools(server, new SkillsManager(), {} as any);

    const listHandler = handlers.get(ListToolsRequestSchema);
    expect(listHandler).toBeDefined();

    const { tools } = await listHandler({} as any);
    const createTool = tools.find((tool: any) => tool.name === 'createConfigurationProfile');
    const updateTool = tools.find((tool: any) => tool.name === 'updateConfigurationProfile');

    expect(createTool).toBeDefined();
    expect(updateTool).toBeDefined();
    expect(createTool?.inputSchema?.properties?.profileData?.required).toContain('name');
    expect(updateTool?.inputSchema?.properties?.profileData?.required).toContain('name');
    expect(createTool?.inputSchema?.properties?.profileData?.required).not.toContain('payloads');
    expect(updateTool?.inputSchema?.properties?.profileData?.required).not.toContain('payloads');
    expect(createTool?.inputSchema?.properties?.type?.enum).toContain('mobile_device');
    expect(updateTool?.inputSchema?.properties?.type?.enum).toContain('mobile_device');
  });

  test('createConfigurationProfile requires confirm and forwards payload to jamf client', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const jamfClient = {
      createConfigurationProfile: jest.fn(async () => ({ id: '9001', name: 'Baseline Profile' })),
    } as any;
    registerAllTools(server, new SkillsManager(), jamfClient);

    const callHandler = handlers.get(CallToolRequestSchema);
    expect(callHandler).toBeDefined();

    const noConfirmResponse = await callHandler({
      params: {
        name: 'createConfigurationProfile',
        arguments: {
          type: 'computer',
          profileData: {
            name: 'Baseline Profile',
            payloads: '<plist/>',
          },
        },
      },
    });
    expect(String(noConfirmResponse?.content?.[0]?.text ?? '')).toContain('requires confirmation');
    expect(jamfClient.createConfigurationProfile).not.toHaveBeenCalled();

    await callHandler({
      params: {
        name: 'createConfigurationProfile',
        arguments: {
          confirm: true,
          type: 'mobile_device',
          profileData: {
            name: 'Mobile Profile',
            payloads: '<plist/>',
          },
        },
      },
    });
    expect(jamfClient.createConfigurationProfile).toHaveBeenCalledWith(
      'mobile_device',
      expect.objectContaining({
        name: 'Mobile Profile',
        payloads: '<plist/>',
      })
    );

    await callHandler({
      params: {
        name: 'createConfigurationProfile',
        arguments: {
          confirm: true,
          type: 'computer',
          profileData: {
            name: 'Convenience Profile',
            preferenceDomain: 'com.example.app',
            settingsJson: { key: 'value' },
          },
        },
      },
    });
    expect(jamfClient.createConfigurationProfile).toHaveBeenCalledWith(
      'computer',
      expect.objectContaining({
        name: 'Convenience Profile',
        preferenceDomain: 'com.example.app',
        settingsJson: { key: 'value' },
      })
    );
  });

  test('updateConfigurationProfile requires confirm and forwards profile id/type/data', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const jamfClient = {
      updateConfigurationProfile: jest.fn(async () => ({ id: '42', name: 'Updated Profile' })),
    } as any;
    registerAllTools(server, new SkillsManager(), jamfClient);

    const callHandler = handlers.get(CallToolRequestSchema);
    expect(callHandler).toBeDefined();

    const noConfirmResponse = await callHandler({
      params: {
        name: 'updateConfigurationProfile',
        arguments: {
          profileId: '42',
          type: 'computer',
          profileData: {
            name: 'Updated Profile',
            payloads: '<plist/>',
          },
        },
      },
    });
    expect(String(noConfirmResponse?.content?.[0]?.text ?? '')).toContain('requires confirmation');
    expect(jamfClient.updateConfigurationProfile).not.toHaveBeenCalled();

    await callHandler({
      params: {
        name: 'updateConfigurationProfile',
        arguments: {
          confirm: true,
          profileId: '42',
          type: 'computer',
          profileData: {
            name: 'Updated Profile',
            payloads: '<plist/>',
          },
        },
      },
    });
    expect(jamfClient.updateConfigurationProfile).toHaveBeenCalledWith(
      '42',
      'computer',
      expect.objectContaining({
        name: 'Updated Profile',
        payloads: '<plist/>',
      })
    );
  });
});
