/**
 * Skills MCP Integration (Deprecated)
 *
 * This module used to "extend" the existing tools/list + tools/call handlers by attempting
 * to introspect SDK internals. That approach is brittle and can result in only skill tools
 * being advertised.
 *
 * Prefer `registerAllTools()` which registers a single unified dispatcher.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SkillsManager } from '../skills/manager.js';
import { JamfApiClientHybrid } from '../jamf-client-hybrid.js';
import { registerAllTools } from './register-all-tools.js';

export function registerSkillsAsMCPTools(
  server: Server,
  skillsManager: SkillsManager,
  jamfClient: JamfApiClientHybrid
): void {
  // Backwards-compatible wrapper: installing skills tools requires owning tools/list + tools/call.
  registerAllTools(server, skillsManager, jamfClient);
}

