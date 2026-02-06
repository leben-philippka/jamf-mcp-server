import { describe, expect, test } from '@jest/globals';

const { JamfApiClientHybrid } = await import('../jamf-client-hybrid.js');

describe('Write guardrails', () => {
  test('MCP mode defaults to read-only unless JAMF_WRITE_ENABLED=true', () => {
    const oldMcpMode = process.env.MCP_MODE;
    const oldWriteEnabled = process.env.JAMF_WRITE_ENABLED;

    process.env.MCP_MODE = 'true';
    delete process.env.JAMF_WRITE_ENABLED;

    const client = new JamfApiClientHybrid({
      baseUrl: 'https://example.test',
      clientId: 'id',
      clientSecret: 'secret',
      readOnlyMode: false,
    });

    expect(client.readOnlyMode).toBe(true);

    process.env.MCP_MODE = oldMcpMode;
    process.env.JAMF_WRITE_ENABLED = oldWriteEnabled;
  });

  test('MCP mode allows writes when JAMF_WRITE_ENABLED=true', () => {
    const oldMcpMode = process.env.MCP_MODE;
    const oldWriteEnabled = process.env.JAMF_WRITE_ENABLED;

    process.env.MCP_MODE = 'true';
    process.env.JAMF_WRITE_ENABLED = 'true';

    const client = new JamfApiClientHybrid({
      baseUrl: 'https://example.test',
      clientId: 'id',
      clientSecret: 'secret',
      readOnlyMode: false,
    });

    expect(client.readOnlyMode).toBe(false);

    process.env.MCP_MODE = oldMcpMode;
    process.env.JAMF_WRITE_ENABLED = oldWriteEnabled;
  });
});
