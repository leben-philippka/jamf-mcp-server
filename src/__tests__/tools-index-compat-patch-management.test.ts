export {};

import { describe, expect, test, jest } from '@jest/globals';

const { registerTools } = await import('../tools/index-compat.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

describe('index-compat tools: patch management', () => {
  test('advertises and handles patch management tools with confirmation on writes', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const jamfClient = {
      listPatchAvailableTitles: jest.fn(async () => ({
        patch_available_titles: {
          size: '2',
          available_titles: {
            available_title: [
              { name_id: 'ABC', app_name: 'Google Chrome', publisher: 'Google', current_version: '136.0' },
              { name_id: 'DEF', app_name: 'Mozilla Firefox', publisher: 'Mozilla', current_version: '128.0' },
            ],
          },
        },
      })),
      listPatchPolicies: jest.fn(async () => ({ results: [{ id: '12', name: 'Chrome Patch Policy' }] })),
      getPatchSoftwareTitleConfigurationReport: jest.fn(async () => ({
        results: [
          { deviceName: 'MBP-01', status: 'Outdated', version: '120.0' },
          { deviceName: 'MBP-02', status: 'Patched', version: '122.0' },
        ],
      })),
      getManagedSoftwareUpdatesAvailable: jest.fn(async () => ({ updates: [{ productVersion: '14.7.1' }] })),
      getManagedSoftwareUpdatePlansFeatureToggle: jest.fn(async () => ({ enabled: true })),
      getManagedSoftwareUpdatePlansFeatureToggleStatus: jest.fn(async () => ({ state: 'ENABLED' })),
      createManagedSoftwareUpdatePlan: jest.fn(async () => ({ id: 'plan-1' })),
      createPatchSoftwareTitleConfiguration: jest.fn(async () => ({ id: '900', displayName: 'Google Chrome' })),
      retryPatchPolicyLogs: jest.fn(async () => ({ retried: 10 })),
    } as any;

    registerTools(server, jamfClient);

    const listHandler = handlers.get(ListToolsRequestSchema);
    expect(listHandler).toBeDefined();
    const { tools } = await listHandler();

    expect(tools.some((t: any) => t.name === 'listPatchAvailableTitles')).toBe(true);
    expect(tools.some((t: any) => t.name === 'listPatchPolicies')).toBe(true);
    expect(tools.some((t: any) => t.name === 'createPatchSoftwareTitleConfiguration')).toBe(true);
    expect(tools.some((t: any) => t.name === 'retryPatchPolicyLogs')).toBe(true);
    expect(tools.some((t: any) => t.name === 'getPatchSoftwareTitleConfigurationReportSummary')).toBe(true);
    expect(tools.some((t: any) => t.name === 'getManagedSoftwareUpdatesAvailable')).toBe(true);
    expect(tools.some((t: any) => t.name === 'getManagedSoftwareUpdatePlansFeatureToggle')).toBe(true);
    expect(tools.some((t: any) => t.name === 'getManagedSoftwareUpdatePlansFeatureToggleStatus')).toBe(true);
    expect(tools.some((t: any) => t.name === 'createManagedSoftwareUpdatePlan')).toBe(true);

    const callHandler = handlers.get(CallToolRequestSchema);
    expect(callHandler).toBeDefined();

    const availableTitles = await callHandler({
      params: {
        name: 'listPatchAvailableTitles',
        arguments: { sourceId: '1', query: 'chrome', limit: 10 },
      },
    });
    expect(jamfClient.listPatchAvailableTitles).toHaveBeenCalledWith('1');
    expect(JSON.parse(availableTitles.content?.[0]?.text)).toMatchObject({
      sourceId: '1',
      total: 1,
      titles: [{ name: 'Google Chrome', currentVersion: '136.0' }],
    });

    const listed = await callHandler({
      params: {
        name: 'listPatchPolicies',
        arguments: { limit: 25 },
      },
    });

    expect(jamfClient.listPatchPolicies).toHaveBeenCalledWith(25);
    expect(JSON.parse(listed.content?.[0]?.text)).toMatchObject({
      results: [{ id: '12' }],
    });

    const createNeedsConfirm = await callHandler({
      params: {
        name: 'createPatchSoftwareTitleConfiguration',
        arguments: { config: { displayName: 'Google Chrome' }, confirm: false },
      },
    });
    expect(createNeedsConfirm.content?.[0]?.text).toContain('requires confirmation');

    const created = await callHandler({
      params: {
        name: 'createPatchSoftwareTitleConfiguration',
        arguments: { config: { displayName: 'Google Chrome' }, confirm: true },
      },
    });
    expect(jamfClient.createPatchSoftwareTitleConfiguration).toHaveBeenCalledWith({ displayName: 'Google Chrome' });
    expect(JSON.parse(created.content?.[0]?.text)).toMatchObject({
      configuration: { id: '900' },
    });

    const retryNeedsConfirm = await callHandler({
      params: {
        name: 'retryPatchPolicyLogs',
        arguments: { policyId: '12', retryAll: true, confirm: false },
      },
    });
    expect(retryNeedsConfirm.content?.[0]?.text).toContain('requires confirmation');

    await callHandler({
      params: {
        name: 'retryPatchPolicyLogs',
        arguments: { policyId: '12', retryAll: true, confirm: true },
      },
    });
    expect(jamfClient.retryPatchPolicyLogs).toHaveBeenCalledWith('12', true, undefined);

    const reportSummary = await callHandler({
      params: {
        name: 'getPatchSoftwareTitleConfigurationReportSummary',
        arguments: { configId: '77', onlyOutdated: true },
      },
    });
    const parsedSummary = JSON.parse(reportSummary.content?.[0]?.text);
    expect(parsedSummary.totals.matchedRows).toBe(1);
    expect(parsedSummary.totals.outdated).toBe(1);

    const msuAvailable = await callHandler({
      params: {
        name: 'getManagedSoftwareUpdatesAvailable',
        arguments: {},
      },
    });
    expect(jamfClient.getManagedSoftwareUpdatesAvailable).toHaveBeenCalled();
    expect(JSON.parse(msuAvailable.content?.[0]?.text)).toMatchObject({
      updates: [{ productVersion: '14.7.1' }],
    });

    const msuFeatureToggle = await callHandler({
      params: {
        name: 'getManagedSoftwareUpdatePlansFeatureToggle',
        arguments: {},
      },
    });
    expect(jamfClient.getManagedSoftwareUpdatePlansFeatureToggle).toHaveBeenCalled();
    expect(JSON.parse(msuFeatureToggle.content?.[0]?.text)).toMatchObject({
      enabled: true,
    });

    const msuFeatureToggleStatus = await callHandler({
      params: {
        name: 'getManagedSoftwareUpdatePlansFeatureToggleStatus',
        arguments: {},
      },
    });
    expect(jamfClient.getManagedSoftwareUpdatePlansFeatureToggleStatus).toHaveBeenCalled();
    expect(JSON.parse(msuFeatureToggleStatus.content?.[0]?.text)).toMatchObject({
      state: 'ENABLED',
    });

    const msuCreateNeedsConfirm = await callHandler({
      params: {
        name: 'createManagedSoftwareUpdatePlan',
        arguments: { plan: { recipeId: 'macOS-14-latest' }, confirm: false },
      },
    });
    expect(msuCreateNeedsConfirm.content?.[0]?.text).toContain('requires confirmation');

    await callHandler({
      params: {
        name: 'createManagedSoftwareUpdatePlan',
        arguments: { plan: { recipeId: 'macOS-14-latest' }, confirm: true },
      },
    });
    expect(jamfClient.createManagedSoftwareUpdatePlan).toHaveBeenCalledWith({ recipeId: 'macOS-14-latest' });
  });
});
