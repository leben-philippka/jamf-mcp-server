/**
 * Skills Integration for MCP Tools (Deprecated)
 *
 * The HTTP/SSE server used to integrate skills by overriding MCP handlers and attempting to
 * access internal handler registries. Use the unified registration instead.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SkillsManager } from '../skills/manager.js';
import { JamfApiClientHybrid } from '../jamf-client-hybrid.js';
import { registerAllTools } from './register-all-tools.js';

export function integrateSkillsWithTools(
  server: Server,
  skillsManager: SkillsManager,
  jamfClient: JamfApiClientHybrid
): void {
  registerAllTools(server, skillsManager, jamfClient);
}

export function getSkillTools(skillsManager: SkillsManager) {
  return skillsManager.getMCPTools();
}

