import { describe, expect, test } from '@jest/globals';

const { updateInventory } = await import('../tools/tool-implementations.js');

describe('updateInventory tool implementation', () => {
  test('requires confirm: true', async () => {
    const client = {
      readOnlyMode: false,
      updateInventory: async () => undefined,
    } as any;

    await expect(updateInventory(client, { deviceId: '39' })).rejects.toThrow(
      'Inventory update requires confirmation'
    );
  });
});
