export {};

import { describe, expect, test, jest } from '@jest/globals';

const { registerTools } = await import('../tools/index-compat.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

describe('index-compat tools: smart computer groups', () => {
  test('advertises and handles createSmartComputerGroup and updateSmartComputerGroup', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const jamfClient = {
      createSmartComputerGroup: jest.fn(async () => ({ id: '9001', name: 'SG', is_smart: true })),
      updateSmartComputerGroup: jest.fn(async () => ({ id: '9001', name: 'SG2', is_smart: true })),
    } as any;

    registerTools(server, jamfClient);

    const listHandler = handlers.get(ListToolsRequestSchema);
    expect(listHandler).toBeDefined();
    const { tools } = await listHandler();
    expect(tools.some((t: any) => t.name === 'createSmartComputerGroup')).toBe(true);
    expect(tools.some((t: any) => t.name === 'updateSmartComputerGroup')).toBe(true);

    const callHandler = handlers.get(CallToolRequestSchema);
    expect(callHandler).toBeDefined();

    const criteria = [
      {
        name: 'Last Check-in',
        priority: 0,
        and_or: 'and',
        search_type: 'more than x days ago',
        value: '30',
      },
    ];

    // Confirm required
    const createNeedsConfirm = await callHandler({
      params: {
        name: 'createSmartComputerGroup',
        arguments: { name: 'SG', criteria, confirm: false },
      },
    });
    expect(createNeedsConfirm.content?.[0]?.text).toContain('requires confirmation');

    const created = await callHandler({
      params: {
        name: 'createSmartComputerGroup',
        arguments: { name: 'SG', criteria, confirm: true },
      },
    });
    expect(jamfClient.createSmartComputerGroup).toHaveBeenCalled();
    expect(JSON.parse(created.content?.[0]?.text)).toMatchObject({
      group: { id: '9001' },
    });

    const updateNeedsConfirm = await callHandler({
      params: {
        name: 'updateSmartComputerGroup',
        arguments: { groupId: '9001', updates: { name: 'SG2' }, confirm: false },
      },
    });
    expect(updateNeedsConfirm.content?.[0]?.text).toContain('requires confirmation');

    const updated = await callHandler({
      params: {
        name: 'updateSmartComputerGroup',
        arguments: { groupId: '9001', updates: { name: 'SG2' }, confirm: true },
      },
    });
    expect(jamfClient.updateSmartComputerGroup).toHaveBeenCalled();
    expect(JSON.parse(updated.content?.[0]?.text)).toMatchObject({
      group: { id: '9001' },
    });
  });
});
