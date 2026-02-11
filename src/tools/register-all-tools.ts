/**
 * Unified tool registration (base tools + skills).
 *
 * Best practice: register a single tools/list + tools/call dispatcher that advertises and
 * routes both "base" Jamf tools and "skill_*" tools, without relying on SDK internals.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import { SkillsManager } from '../skills/manager.js';
import { SkillContext } from '../skills/types.js';
import { JamfApiClientHybrid } from '../jamf-client-hybrid.js';
import { createLogger } from '../server/logger.js';
import { createBaseToolHandlers } from './index-compat.js';
import { logErrorWithContext } from '../utils/error-handler.js';
import { createToolWriteQueue } from './write-queue.js';

const skillLogger = createLogger('Skills');

function parseToolTextContent(result: any): any {
  const first = result?.content?.[0];
  if (!first || first.type !== 'text') return { error: 'No text content in tool response' };
  const text = first.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function registerAllTools(
  server: Server,
  skillsManager: SkillsManager,
  jamfClient: JamfApiClientHybrid
): void {
  const base = createBaseToolHandlers(jamfClient as any);
  const writeQueue = createToolWriteQueue();

  // Provide skills a stable way to call base MCP tools, returning a consistent `{ data: ... }` shape.
  const skillContext: SkillContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callTool: async (toolName: string, params: any): Promise<any> => {
      const raw = await writeQueue.maybeRunWriteLocked(toolName, params, async () => {
        return await base.callToolHandler({
          method: 'tools/call',
          params: { name: toolName, arguments: params },
        });
      });

      return { data: parseToolTextContent(raw) };
    },
    client: jamfClient,
    env: {
      jamfUrl: process.env.JAMF_URL || '',
      jamfClientId: process.env.JAMF_CLIENT_ID || '',
    },
    logger: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      info: (message: string, meta?: any) => skillLogger.info(message, meta),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      warn: (message: string, meta?: any) => skillLogger.warn(message, meta),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: (message: string, meta?: any) => skillLogger.error(message, meta),
    },
  };

  skillsManager.context = skillContext;

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const baseResult = await base.listToolsHandler(request);
    const skillTools = skillsManager.getMCPTools();
    return { tools: [...(baseResult.tools || []), ...skillTools] as Tool[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    return await writeQueue.maybeRunWriteLocked(name, args, async () => {
      if (name.startsWith('skill_')) {
        const skillName = name.substring(6).replace(/_/g, '-');
        try {
          const result = await skillsManager.executeSkill(skillName, args || {});
          return {
            content: [{ type: 'text', text: result.message } as TextContent],
          };
        } catch (error: unknown) {
          const errorContext = logErrorWithContext(
            error,
            `Execute skill: ${skillName}`,
            'register-all-tools',
            { skillName, args }
          );
          return {
            content: [
              {
                type: 'text',
                text: `Skill execution failed: ${errorContext.message}${errorContext.suggestions ? ` (${errorContext.suggestions[0]})` : ''}`,
              } as TextContent,
            ],
            isError: true,
          };
        }
      }

      return await base.callToolHandler(request);
    });
  });
}
