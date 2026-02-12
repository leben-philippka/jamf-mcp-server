import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DocumentationGenerator } from '../documentation/generator.js';
import { DocumentationOptions } from '../documentation/types.js';
import { createLogger } from '../server/logger.js';
import { buildErrorContext, logErrorWithContext } from '../utils/error-handler.js';
import { isWriteLikeToolName } from './write-queue.js';
import { parsePolicySelfServiceFromXml } from '../utils/jamf-policy-xml.js';

const logger = createLogger('Tools');
// import { parseJamfDate } from '../jamf-client-classic.js';
// Helper function to parse Jamf dates
const parseJamfDate = (date: string | Date | undefined): Date => {
  if (!date) return new Date(0);
  if (date instanceof Date) return date;
  return new Date(date);
};

const SearchDevicesSchema = z.object({
  query: z.string().describe('Search query to find devices by name, serial number, IP address, username, etc.'),
  limit: z.number().optional().default(50).describe('Maximum number of results to return'),
});

const GetDeviceDetailsSchema = z.object({
  deviceId: z.string().describe('The Jamf device ID'),
});

const UpdateInventorySchema = z.object({
  deviceId: z.string().describe('The device ID to update inventory for'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for inventory update'),
});

const CheckDeviceComplianceSchema = z.object({
  days: z.number().optional().default(30).describe('Number of days to check for compliance'),
  includeDetails: z.boolean().optional().default(false).describe('Include detailed device list in response'),
});

const GetDevicesBatchSchema = z.object({
  deviceIds: z.array(z.string()).describe('Array of device IDs to fetch details for'),
  includeBasicOnly: z.boolean().optional().default(false).describe('Return only basic info to reduce response size'),
});

// Policy schemas
const ListPoliciesSchema = z.object({
  limit: z.number().optional().default(100).describe('Maximum number of policies to return'),
  category: z.string().optional().describe('Filter by policy category'),
});

const GetPolicyDetailsSchema = z.object({
  policyId: z.string().describe('The Jamf policy ID'),
  includeScriptContent: z.boolean().optional().default(false).describe('Include full script content for scripts in the policy'),
  includeXml: z.boolean().optional().default(false).describe('Include raw Classic policy XML in the response (can be large)'),
});

const SearchPoliciesSchema = z.object({
  query: z.string().describe('Search query for policy name or description'),
  limit: z.number().optional().default(50).describe('Maximum number of results'),
});

const GetPolicyXmlSchema = z.object({
  policyId: z.string().describe('The Jamf policy ID'),
  includeParsed: z.boolean().optional().default(true).describe('Include parsed Self Service category info from XML'),
});

const ExecutePolicySchema = z.object({
  policyId: z.string().describe('The Jamf policy ID to execute'),
  deviceIds: z.array(z.string()).describe('Array of device IDs to execute the policy on'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for policy execution'),
});

const DeployScriptSchema = z.object({
  scriptId: z.string().describe('The Jamf script ID to deploy'),
  deviceIds: z.array(z.string()).describe('Array of device IDs to deploy the script to'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for script deployment'),
});

const GetScriptDetailsSchema = z.object({
  scriptId: z.string().describe('The Jamf script ID'),
});

const ListConfigurationProfilesSchema = z.object({
  type: z.enum(['computer', 'mobiledevice']).optional().default('computer').describe('Type of configuration profiles to list'),
});

const GetConfigurationProfileDetailsSchema = z.object({
  profileId: z.string().describe('The configuration profile ID'),
  type: z.enum(['computer', 'mobiledevice']).optional().default('computer').describe('Type of configuration profile'),
});

const SearchConfigurationProfilesSchema = z.object({
  query: z.string().describe('Search query to find configuration profiles by name'),
  type: z.enum(['computer', 'mobiledevice']).optional().default('computer').describe('Type of configuration profiles to search'),
});

const DeployConfigurationProfileSchema = z.object({
  profileId: z.string().describe('The configuration profile ID to deploy'),
  deviceIds: z.array(z.string()).describe('Array of device IDs to deploy the profile to'),
  type: z.enum(['computer', 'mobiledevice']).optional().default('computer').describe('Type of configuration profile'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for profile deployment'),
});

const RemoveConfigurationProfileSchema = z.object({
  profileId: z.string().describe('The configuration profile ID to remove'),
  deviceIds: z.array(z.string()).describe('Array of device IDs to remove the profile from'),
  type: z.enum(['computer', 'mobiledevice']).optional().default('computer').describe('Type of configuration profile'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for profile removal'),
});

const ListComputerGroupsSchema = z.object({
  type: z.enum(['smart', 'static', 'all']).optional().default('all').describe('Type of computer groups to list'),
});

const GetComputerGroupDetailsSchema = z.object({
  groupId: z.string().describe('The computer group ID'),
});

const SearchComputerGroupsSchema = z.object({
  query: z.string().describe('Search query to find computer groups by name'),
});

const GetComputerGroupMembersSchema = z.object({
  groupId: z.string().describe('The computer group ID to get members for'),
});

const CreateStaticComputerGroupSchema = z.object({
  name: z.string().describe('Name for the new static computer group'),
  computerIds: z.array(z.string()).describe('Array of computer IDs to add to the group'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for group creation'),
});

const CreateSmartComputerGroupSchema = z.object({
  name: z.string().describe('Name for the new smart computer group'),
  criteria: z.array(z.object({
    name: z.string().describe('Criterion name (e.g., "Last Check-in")'),
    priority: z.number().describe('Criterion priority (0 = first)'),
    and_or: z.enum(['and', 'or']).describe('Logical operator for combining criteria'),
    search_type: z.string().describe('Search type (e.g., "more than x days ago")'),
    value: z.string().describe('Search value'),
  })).describe('Smart group criteria'),
  siteId: z.number().optional().describe('Optional site ID for the group'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for group creation'),
});

const UpdateStaticComputerGroupSchema = z.object({
  groupId: z.string().describe('The static computer group ID to update'),
  computerIds: z.array(z.string()).describe('Array of computer IDs to set as the group membership'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for group update'),
});

const UpdateSmartComputerGroupSchema = z.object({
  groupId: z.string().describe('The smart computer group ID to update'),
  updates: z.object({
    name: z.string().optional().describe('Updated group name'),
    criteria: z.array(z.object({
      name: z.string().describe('Criterion name (e.g., "Last Check-in")'),
      priority: z.number().describe('Criterion priority (0 = first)'),
      and_or: z.enum(['and', 'or']).describe('Logical operator for combining criteria'),
      search_type: z.string().describe('Search type (e.g., "more than x days ago")'),
      value: z.string().describe('Search value'),
    })).optional().describe('Updated smart group criteria'),
    siteId: z.number().optional().describe('Optional site ID for the group'),
  }).describe('Updates to apply'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for group update'),
});

const DeleteComputerGroupSchema = z.object({
  groupId: z.string().describe('The computer group ID to delete'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for group deletion'),
});

const CreateAdvancedComputerSearchSchema = z.object({
  searchData: z.object({
    name: z.string().describe('Name for the advanced computer search'),
    criteria: z.array(z.object({
      name: z.string().describe('Criterion name (e.g., "Last Check-in")'),
      priority: z.number().describe('Criterion priority (0 = first)'),
      and_or: z.enum(['and', 'or']).describe('Logical operator for combining criteria'),
      search_type: z.string().describe('Search type (e.g., "more than x days ago")'),
      value: z.string().describe('Search value'),
    })).optional().describe('Search criteria'),
    display_fields: z.array(z.string()).optional().describe('Fields to display in search results'),
  }).describe('Advanced computer search configuration'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for search creation'),
});

const ListAdvancedComputerSearchesSchema = z.object({
  limit: z.number().optional().default(100).describe('Maximum number of searches to return'),
});

const GetAdvancedComputerSearchDetailsSchema = z.object({
  searchId: z.string().describe('The ID of the advanced computer search'),
});

const DeleteAdvancedComputerSearchSchema = z.object({
  searchId: z.string().describe('The ID of the advanced computer search to delete'),
  confirm: z.boolean().describe('Must be true to confirm deletion'),
});

const SearchMobileDevicesSchema = z.object({
  query: z.string().describe('Search query to find mobile devices by name, serial number, UDID, etc.'),
  limit: z.number().optional().default(50).describe('Maximum number of results to return'),
});

const GetMobileDeviceDetailsSchema = z.object({
  deviceId: z.string().describe('The mobile device ID'),
});

const ListMobileDevicesSchema = z.object({
  limit: z.number().optional().default(50).describe('Maximum number of mobile devices to return'),
});

const UpdateMobileDeviceInventorySchema = z.object({
  deviceId: z.string().describe('The mobile device ID to update inventory for'),
});

const SendMDMCommandSchema = z.object({
  deviceId: z.string().describe('The mobile device ID to send command to'),
  command: z.string().describe('The MDM command to send (e.g., DeviceLock, EraseDevice, ClearPasscode)'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for destructive commands'),
});

const ListMobileDeviceGroupsSchema = z.object({
  type: z.enum(['smart', 'static', 'all']).optional().default('all').describe('Type of mobile device groups to list'),
});

const GetMobileDeviceGroupDetailsSchema = z.object({
  groupId: z.string().describe('The mobile device group ID'),
});

// Package management schemas
const ListPackagesSchema = z.object({
  limit: z.number().optional().default(100).describe('Maximum number of packages to return'),
});

const SearchPackagesSchema = z.object({
  query: z.string().describe('Search query for package name'),
  limit: z.number().optional().default(50).describe('Maximum number of results'),
});

const GetPackageDetailsSchema = z.object({
  packageId: z.string().describe('The Jamf package ID'),
});

const GetPackageDeploymentHistorySchema = z.object({
  packageId: z.string().describe('The Jamf package ID'),
  limit: z.number().optional().default(50).describe('Maximum number of deployment records to return'),
});

const GetPoliciesUsingPackageSchema = z.object({
  packageId: z.string().describe('The Jamf package ID'),
});

// Patch management schemas
const ListPatchAvailableTitlesSchema = z.object({
  sourceId: z.string().optional().default('1').describe('Patch source ID. Use `1` for Jamf patch catalog in most tenants.'),
  query: z.string().optional().describe('Optional case-insensitive substring filter on title name'),
  limit: z.number().optional().default(200).describe('Maximum number of patch available titles to return after filtering'),
});

const ListPatchPoliciesSchema = z.object({
  limit: z.number().optional().default(100).describe('Maximum number of patch policies to return'),
});

const GetPatchPolicyLogsSchema = z.object({
  policyId: z.string().describe('The patch policy ID'),
  limit: z.number().optional().default(100).describe('Maximum number of patch policy log records to return'),
});

const RetryPatchPolicyLogsSchema = z.object({
  policyId: z.string().describe('The patch policy ID'),
  retryAll: z.boolean().optional().default(false).describe('Retry all eligible failed logs for this policy'),
  payload: z.record(z.unknown()).optional().describe('Optional payload for targeted retry endpoint'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for patch log retry'),
});

const ListPatchSoftwareTitleConfigurationsSchema = z.object({
  limit: z.number().optional().default(100).describe('Maximum number of patch software title configurations to return'),
});

const GetPatchSoftwareTitleConfigurationSchema = z.object({
  configId: z.string().describe('The patch software title configuration ID'),
});

const GetPatchSoftwareTitleConfigurationReportSchema = z.object({
  configId: z.string().describe('The patch software title configuration ID'),
});

const GetPatchSoftwareTitleConfigurationSummarySchema = z.object({
  configId: z.string().describe('The patch software title configuration ID'),
});

const GetPatchSoftwareTitleConfigurationVersionSummarySchema = z.object({
  configId: z.string().describe('The patch software title configuration ID'),
});

const GetPatchSoftwareTitleConfigurationReportSummarySchema = z.object({
  configId: z.string().describe('The patch software title configuration ID'),
  deviceNameContains: z.string().optional().describe('Optional case-insensitive filter by device name'),
  onlyOutdated: z.boolean().optional().default(false).describe('Include only outdated devices in aggregation'),
  limit: z.number().optional().default(1000).describe('Maximum number of rows to include in aggregation'),
});

const CreatePatchSoftwareTitleConfigurationSchema = z.object({
  config: z.record(z.unknown()).describe('Patch software title configuration payload'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for patch software title configuration creation'),
});

const UpdatePatchSoftwareTitleConfigurationSchema = z.object({
  configId: z.string().describe('The patch software title configuration ID'),
  updates: z.record(z.unknown()).describe('Partial patch software title configuration payload'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for patch software title configuration update'),
});

const DeletePatchSoftwareTitleConfigurationSchema = z.object({
  configId: z.string().describe('The patch software title configuration ID'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for patch software title configuration deletion'),
});

// Managed software updates (macOS)
const GetManagedSoftwareUpdatesAvailableSchema = z.object({});
const GetManagedSoftwareUpdatePlansFeatureToggleSchema = z.object({});
const GetManagedSoftwareUpdatePlansFeatureToggleStatusSchema = z.object({});

const GetManagedSoftwareUpdateStatusesSchema = z.object({
  limit: z.number().optional().default(100).describe('Maximum number of managed software update statuses to return'),
});

const ListManagedSoftwareUpdatePlansSchema = z.object({
  limit: z.number().optional().default(100).describe('Maximum number of managed software update plans to return'),
});

const GetManagedSoftwareUpdatePlanSchema = z.object({
  planId: z.string().describe('The managed software update plan ID'),
});

const CreateManagedSoftwareUpdatePlanSchema = z.object({
  plan: z.record(z.unknown()).describe('Managed software update plan payload'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for managed software update plan creation'),
});

const CreateManagedSoftwareUpdatePlanForGroupSchema = z.object({
  plan: z.record(z.unknown()).describe('Managed software update plan-for-group payload'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for managed software update group plan creation'),
});

// Policy management schemas
const CreatePolicyDataSchema = z.object({
    general: z.object({
      name: z.string().describe('Policy name'),
      enabled: z.boolean().optional().describe('Whether the policy is enabled'),
      trigger: z.string().optional().describe('Policy trigger type'),
      trigger_checkin: z.boolean().optional().describe('Trigger on check-in'),
      trigger_enrollment_complete: z.boolean().optional().describe('Trigger on enrollment complete'),
      trigger_login: z.boolean().optional().describe('Trigger on login'),
      trigger_logout: z.boolean().optional().describe('Trigger on logout'),
      trigger_network_state_changed: z.boolean().optional().describe('Trigger on network state change'),
      trigger_startup: z.boolean().optional().describe('Trigger on startup'),
      trigger_other: z.string().optional().describe('Custom trigger name'),
      frequency: z.string().optional().describe('Execution frequency (Once per computer, Once per user, etc.)'),
      retry_event: z.string().optional().describe('Retry event type'),
      retry_attempts: z.number().optional().describe('Number of retry attempts'),
      notify_on_each_failed_retry: z.boolean().optional().describe('Notify on each failed retry'),
      location_user_only: z.boolean().optional().describe('Location information collected from user only'),
      target_drive: z.string().optional().describe('Target drive for installations'),
      offline: z.boolean().optional().describe('Make available offline'),
      category: z.string().optional().describe('Policy category'),
    }).describe('General policy settings'),
    scope: z.object({
      all_computers: z.boolean().optional().describe('Apply to all computers'),
      computers: z.array(z.object({ id: z.number() })).optional().describe('Specific computers'),
      computer_groups: z.array(z.object({ id: z.number() })).optional().describe('Computer groups'),
      buildings: z.array(z.object({ id: z.number() })).optional().describe('Buildings'),
      departments: z.array(z.object({ id: z.number() })).optional().describe('Departments'),
    }).optional().describe('Policy scope settings'),
    self_service: z.object({
      use_for_self_service: z.boolean().optional().describe('Make available in Self Service'),
      self_service_display_name: z.string().optional().describe('Display name in Self Service'),
      install_button_text: z.string().optional().describe('Install button text'),
      reinstall_button_text: z.string().optional().describe('Reinstall button text'),
      self_service_description: z.string().optional().describe('Description in Self Service'),
      force_users_to_view_description: z.boolean().optional().describe('Force users to view description'),
      feature_on_main_page: z.boolean().optional().describe('Feature on main page'),
      notification: z.boolean().optional().describe('Show Self Service notification'),
      notification_type: z.string().optional().describe('Self Service notification type'),
      notification_subject: z.string().optional().describe('Self Service notification subject'),
      notification_message: z.string().optional().describe('Self Service notification message'),
      self_service_category: z
        .union([
          z.string(),
          z
            .object({
              id: z.number().optional(),
              name: z.string().optional(),
            })
            .passthrough(),
        ])
        .optional()
        .describe(
          'Convenience alias for setting a single Self Service category. Prefer using an existing category id (number) when possible.'
        ),
      self_service_categories: z
        .union([
          z.array(z.object({ id: z.number().optional(), name: z.string().optional() }).passthrough()),
          z
            .object({
              category: z.union([
                z.object({ id: z.number().optional(), name: z.string().optional() }).passthrough(),
                z.array(z.object({ id: z.number().optional(), name: z.string().optional() }).passthrough()),
              ]),
            })
            .passthrough(),
        ])
        .optional()
        .describe(
          'Self Service categories for this policy. The server writes Classic policy XML <self_service_categories><size>... and includes display_in/feature_in defaults.'
        ),
    }).optional().describe('Self Service settings'),
    package_configuration: z.object({
      packages: z.array(z.object({
        id: z.number().describe('Package ID'),
        action: z.string().optional().describe('Install action'),
        fut: z.boolean().optional().describe('Fill user templates'),
        feu: z.boolean().optional().describe('Fill existing users'),
      })).optional().describe('Packages to deploy'),
    }).optional().describe('Package configuration'),
    scripts: z.array(z.object({
      id: z.number().describe('Script ID'),
      priority: z.string().optional().describe('Script priority (Before, After)'),
      parameter4: z.string().optional().describe('Script parameter 4'),
      parameter5: z.string().optional().describe('Script parameter 5'),
      parameter6: z.string().optional().describe('Script parameter 6'),
      parameter7: z.string().optional().describe('Script parameter 7'),
      parameter8: z.string().optional().describe('Script parameter 8'),
      parameter9: z.string().optional().describe('Script parameter 9'),
      parameter10: z.string().optional().describe('Script parameter 10'),
      parameter11: z.string().optional().describe('Script parameter 11'),
    })).optional().describe('Scripts to run'),
  }).describe('Policy configuration data');

const CreatePolicySchema = z.union([
  z.object({
    policyData: CreatePolicyDataSchema,
    confirm: z.boolean().optional().default(false).describe('Confirmation flag for policy creation'),
  }),
  z.object({
    policyXml: z.string().min(1).describe('Raw Classic policy XML payload. When provided, policyData is ignored.'),
    confirm: z.boolean().optional().default(false).describe('Confirmation flag for policy creation'),
  }),
]);

const UpdatePolicyDataSchema = z.object({
    general: z.object({
      name: z.string().optional().describe('Policy name'),
      enabled: z.boolean().optional().describe('Whether the policy is enabled'),
      trigger: z.string().optional().describe('Policy trigger type'),
      trigger_checkin: z.boolean().optional().describe('Trigger on check-in'),
      trigger_enrollment_complete: z.boolean().optional().describe('Trigger on enrollment complete'),
      trigger_login: z.boolean().optional().describe('Trigger on login'),
      trigger_logout: z.boolean().optional().describe('Trigger on logout'),
      trigger_network_state_changed: z.boolean().optional().describe('Trigger on network state change'),
      trigger_startup: z.boolean().optional().describe('Trigger on startup'),
      trigger_other: z.string().optional().describe('Custom trigger name'),
      frequency: z.string().optional().describe('Execution frequency'),
      retry_event: z.string().optional().describe('Retry event type'),
      retry_attempts: z.number().optional().describe('Number of retry attempts'),
      notify_on_each_failed_retry: z.boolean().optional().describe('Notify on each failed retry'),
      location_user_only: z.boolean().optional().describe('Location information collected from user only'),
      target_drive: z.string().optional().describe('Target drive for installations'),
      offline: z.boolean().optional().describe('Make available offline'),
      category: z.string().optional().describe('Policy category'),
    }).optional().describe('General policy settings to update'),
    scope: z.object({
      all_computers: z.boolean().optional().describe('Apply to all computers'),
      computers: z.array(z.object({ id: z.number() })).optional().describe('Specific computers'),
      computer_groups: z.array(z.object({ id: z.number() })).optional().describe('Computer groups'),
      buildings: z.array(z.object({ id: z.number() })).optional().describe('Buildings'),
      departments: z.array(z.object({ id: z.number() })).optional().describe('Departments'),
    }).optional().describe('Policy scope settings to update'),
    self_service: z.object({
      use_for_self_service: z.boolean().optional().describe('Make available in Self Service'),
      self_service_display_name: z.string().optional().describe('Display name in Self Service'),
      install_button_text: z.string().optional().describe('Install button text'),
      reinstall_button_text: z.string().optional().describe('Reinstall button text'),
      self_service_description: z.string().optional().describe('Description in Self Service'),
      force_users_to_view_description: z.boolean().optional().describe('Force users to view description'),
      feature_on_main_page: z.boolean().optional().describe('Feature on main page'),
      notification: z.boolean().optional().describe('Show Self Service notification'),
      notification_type: z.string().optional().describe('Self Service notification type'),
      notification_subject: z.string().optional().describe('Self Service notification subject'),
      notification_message: z.string().optional().describe('Self Service notification message'),
      self_service_category: z
        .union([
          z.string(),
          z
            .object({
              id: z.number().optional(),
              name: z.string().optional(),
            })
            .passthrough(),
        ])
        .optional()
        .describe(
          'Convenience alias for setting a single Self Service category. Prefer using an existing category id (number) when possible.'
        ),
      self_service_categories: z
        .union([
          z.array(z.object({ id: z.number().optional(), name: z.string().optional() }).passthrough()),
          z
            .object({
              category: z.union([
                z.object({ id: z.number().optional(), name: z.string().optional() }).passthrough(),
                z.array(z.object({ id: z.number().optional(), name: z.string().optional() }).passthrough()),
              ]),
            })
            .passthrough(),
        ])
        .optional()
        .describe(
          'Self Service categories for this policy. The server writes Classic policy XML <self_service_categories><size>... and includes display_in/feature_in defaults.'
        ),
    }).optional().describe('Self Service settings to update'),
    package_configuration: z.object({
      packages: z.array(z.object({
        id: z.number().describe('Package ID'),
        action: z.string().optional().describe('Install action'),
        fut: z.boolean().optional().describe('Fill user templates'),
        feu: z.boolean().optional().describe('Fill existing users'),
      })).optional().describe('Packages to deploy'),
    }).optional().describe('Package configuration to update'),
    scripts: z.array(z.object({
      id: z.number().describe('Script ID'),
      priority: z.string().optional().describe('Script priority (Before, After)'),
      parameter4: z.string().optional().describe('Script parameter 4'),
      parameter5: z.string().optional().describe('Script parameter 5'),
      parameter6: z.string().optional().describe('Script parameter 6'),
      parameter7: z.string().optional().describe('Script parameter 7'),
      parameter8: z.string().optional().describe('Script parameter 8'),
      parameter9: z.string().optional().describe('Script parameter 9'),
      parameter10: z.string().optional().describe('Script parameter 10'),
      parameter11: z.string().optional().describe('Script parameter 11'),
    })).optional().describe('Scripts to run'),
  }).describe('Policy configuration data to update');

const UpdatePolicySchema = z.union([
  z.object({
    policyId: z.string().describe('The policy ID to update'),
    policyData: UpdatePolicyDataSchema,
    confirm: z.boolean().optional().default(false).describe('Confirmation flag for policy update'),
  }),
  z.object({
    policyId: z.string().describe('The policy ID to update'),
    policyXml: z.string().min(1).describe('Raw Classic policy XML payload. When provided, policyData is ignored.'),
    confirm: z.boolean().optional().default(false).describe('Confirmation flag for policy update'),
  }),
]);

const CreatePolicyXmlSchema = z.object({
  policyXml: z.string().min(1).describe('Raw Classic policy XML payload'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for policy creation'),
});

const UpdatePolicyXmlSchema = z.object({
  policyId: z.string().describe('The policy ID to update'),
  policyXml: z.string().min(1).describe('Raw Classic policy XML payload'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for policy update'),
});

const ClonePolicySchema = z.object({
  sourcePolicyId: z.string().describe('The source policy ID to clone'),
  newName: z.string().describe('Name for the cloned policy'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for policy cloning'),
});

const SetPolicyEnabledSchema = z.object({
  policyId: z.string().describe('The policy ID'),
  enabled: z.boolean().describe('Whether to enable or disable the policy'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for enabling/disabling policy'),
});

const UpdatePolicyScopeSchema = z.object({
  policyId: z.string().describe('The policy ID to update scope for'),
  scopeUpdates: z.object({
    addComputers: z.array(z.string()).optional().describe('Computer IDs to add to scope'),
    removeComputers: z.array(z.string()).optional().describe('Computer IDs to remove from scope'),
    addComputerGroups: z.array(z.string()).optional().describe('Computer group IDs to add to scope'),
    removeComputerGroups: z.array(z.string()).optional().describe('Computer group IDs to remove from scope'),
    replaceComputers: z.array(z.string()).optional().describe('Replace all computers in scope with these IDs'),
    replaceComputerGroups: z.array(z.string()).optional().describe('Replace all computer groups in scope with these IDs'),
  }).describe('Scope update operations'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for scope update'),
});

// Script management schemas
const ListScriptsSchema = z.object({
  limit: z.number().optional().default(100).describe('Maximum number of scripts to return'),
});

const SearchScriptsSchema = z.object({
  query: z.string().describe('Search query for script name'),
  limit: z.number().optional().default(50).describe('Maximum number of results'),
});

const CreateScriptSchema = z.object({
  scriptData: z.object({
    name: z.string().describe('Script name'),
    script_contents: z.string().describe('Script contents'),
    category: z.string().optional().describe('Script category'),
    info: z.string().optional().describe('Script info/description'),
    notes: z.string().optional().describe('Script notes'),
    priority: z.string().optional().describe('Script priority'),
    parameters: z.object({
      parameter4: z.string().optional().describe('Parameter 4 label'),
      parameter5: z.string().optional().describe('Parameter 5 label'),
      parameter6: z.string().optional().describe('Parameter 6 label'),
      parameter7: z.string().optional().describe('Parameter 7 label'),
      parameter8: z.string().optional().describe('Parameter 8 label'),
      parameter9: z.string().optional().describe('Parameter 9 label'),
      parameter10: z.string().optional().describe('Parameter 10 label'),
      parameter11: z.string().optional().describe('Parameter 11 label'),
    }).optional().describe('Script parameter labels'),
    os_requirements: z.string().optional().describe('OS requirements'),
    script_contents_encoded: z.boolean().optional().describe('Whether script contents are encoded'),
  }).describe('Script configuration data'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for script creation'),
});

const UpdateScriptSchema = z.object({
  scriptId: z.string().describe('The script ID to update'),
  scriptData: z.object({
    name: z.string().optional().describe('Script name'),
    script_contents: z.string().optional().describe('Script contents'),
    category: z.string().optional().describe('Script category'),
    info: z.string().optional().describe('Script info/description'),
    notes: z.string().optional().describe('Script notes'),
    priority: z.string().optional().describe('Script priority'),
    parameters: z.object({
      parameter4: z.string().optional().describe('Parameter 4 label'),
      parameter5: z.string().optional().describe('Parameter 5 label'),
      parameter6: z.string().optional().describe('Parameter 6 label'),
      parameter7: z.string().optional().describe('Parameter 7 label'),
      parameter8: z.string().optional().describe('Parameter 8 label'),
      parameter9: z.string().optional().describe('Parameter 9 label'),
      parameter10: z.string().optional().describe('Parameter 10 label'),
      parameter11: z.string().optional().describe('Parameter 11 label'),
    }).optional().describe('Script parameter labels'),
    os_requirements: z.string().optional().describe('OS requirements'),
    script_contents_encoded: z.boolean().optional().describe('Whether script contents are encoded'),
  }).describe('Script configuration data to update'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for script update'),
});

const DeleteScriptSchema = z.object({
  scriptId: z.string().describe('The script ID to delete'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for script deletion'),
});

// Reporting and Analytics Schemas
const GetInventorySummarySchema = z.object({});

const GetPolicyComplianceReportSchema = z.object({
  policyId: z.string().describe('The Jamf policy ID to generate compliance report for'),
});

const GetPackageDeploymentStatsSchema = z.object({
  packageId: z.string().describe('The Jamf package ID to get deployment statistics for'),
});

const GetSoftwareVersionReportSchema = z.object({
  softwareName: z.string().describe('Name of the software to search for version information'),
});

const GetDeviceComplianceSummarySchema = z.object({});

const GetComputerPolicyLogsSchema = z
  .object({
    serialNumber: z.string().optional().describe('Computer serial number (preferred identifier)'),
    deviceId: z.string().optional().describe('Jamf computer ID (alternative identifier)'),
    limit: z.number().int().min(1).max(5000).optional().default(50).describe('Maximum number of log entries to return'),
    includeRaw: z.boolean().optional().default(false).describe('Include the raw Classic API response for debugging'),
  })
  .refine((v) => Boolean(v.serialNumber || v.deviceId), {
    message: 'Either serialNumber or deviceId is required',
    path: ['serialNumber'],
  });

// Category / Self Service Category schemas
const ListSelfServiceCategoriesSchema = z.object({
  query: z.string().optional().describe('Optional substring filter on category name'),
  limit: z.number().int().min(1).max(5000).optional().default(200).describe('Maximum number of categories to return'),
});

const EnsureSelfServiceCategoryExistsSchema = z.object({
  name: z.string().min(1).describe('Self Service category name to ensure exists'),
  priority: z.number().int().min(0).max(1000).optional().describe('Optional category priority'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag (required if category needs to be created)'),
});

const CreateCategorySchema = z.object({
  name: z.string().min(1).describe('Category name to create'),
  priority: z.number().int().min(0).max(1000).optional().describe('Optional category priority'),
  confirm: z.boolean().optional().default(false).describe('Confirmation flag for category creation'),
});

// Debug schemas
const GetAuthStatusSchema = z.object({});

// Documentation schemas
const DocumentJamfEnvironmentSchema = z.object({
  outputPath: z.string().optional().describe('Directory path where documentation files will be saved'),
  formats: z.array(z.enum(['markdown', 'json'])).optional().describe('Output formats to generate'),
  components: z.array(z.enum([
    'computers',
    'mobile-devices',
    'policies',
    'configuration-profiles',
    'scripts',
    'packages',
    'computer-groups',
    'mobile-device-groups',
  ])).optional().describe('Specific components to document'),
  detailLevel: z.enum(['summary', 'standard', 'full']).optional().describe('Level of detail to include'),
  includeScriptContent: z.boolean().optional().describe('Include full script content in documentation'),
  includeProfilePayloads: z.boolean().optional().describe('Include configuration profile payload details'),
});

export function registerTools(server: Server, jamfClient: any): void {
  const { listToolsHandler, callToolHandler } = createBaseToolHandlers(jamfClient);

  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, callToolHandler);
}

export function createBaseToolHandlers(jamfClient: any): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listToolsHandler: (request: any) => Promise<{ tools: Tool[] }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callToolHandler: (request: any) => Promise<any>;
} {
  const appendOnce = (base: string, note: string): string => {
    const b = String(base ?? '').trim();
    const n = String(note ?? '').trim();
    if (!n) return b;
    if (!b) return n;
    if (b.includes(n)) return b;
    return `${b} ${n}`;
  };

  const decorateToolDescription = (tool: Tool): Tool => {
    const name = String(tool.name ?? '');
    let description = String(tool.description ?? '');

    // Best-practice safety + behavior notes to prevent common LLM misuse.
    if (isWriteLikeToolName(name)) {
      description = appendOnce(
        description,
        'Writes require `confirm:true` and (in MCP mode) `JAMF_WRITE_ENABLED=true`. Writes are serialized to reduce Jamf 409 conflicts.'
      );
    }

    if (/xml$/i.test(name) || /Xml$/.test(name)) {
      description = appendOnce(
        description,
        'XML tools are a Classic API escape hatch. Prefer structured fields (e.g. policyData) when available; XML updates may replace sections if the payload is incomplete.'
      );
    }

    if (name === 'createPolicy' || name === 'updatePolicy') {
      description = appendOnce(
        description,
        'For Self Service categories, prefer passing an existing category `id` (use `listSelfServiceCategories`). The server writes Classic XML <self_service_categories> with required fields.'
      );
    }

    if (name === 'createCategory' || name === 'ensureSelfServiceCategoryExists') {
      description = appendOnce(
        description,
        '401/403 typically indicates missing Jamf permissions (API role). If your tenant rejects Bearer tokens for Classic writes, configure `JAMF_USERNAME`/`JAMF_PASSWORD` so the server can retry with Basic auth.'
      );
    }

    return { ...tool, description };
  };

  const listToolsHandler = async () => {
    const tools: Tool[] = [
      {
        name: 'searchDevices',
        description: 'Search for devices in Jamf Pro by name, serial number, IP address, username, or other criteria',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to find devices',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return',
              default: 50,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'getDeviceDetails',
        description: 'Get detailed information about a specific device including hardware, software, and user details',
        inputSchema: {
          type: 'object',
          properties: {
            deviceId: {
              type: 'string',
              description: 'The Jamf device ID',
            },
          },
          required: ['deviceId'],
        },
      },
      {
        name: 'updateInventory',
        description: 'Force an inventory update on a specific device',
        inputSchema: {
          type: 'object',
          properties: {
            deviceId: {
              type: 'string',
              description: 'The device ID to update inventory for',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for inventory update (required)',
              default: false,
            },
          },
          required: ['deviceId'],
        },
      },
      {
        name: 'checkDeviceCompliance',
        description: 'Check which devices have not reported within a specified number of days',
        inputSchema: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to check for compliance',
              default: 30,
            },
            includeDetails: {
              type: 'boolean',
              description: 'Include detailed device list in response',
              default: false,
            },
          },
        },
      },
      {
        name: 'getDevicesBatch',
        description: 'Get details for multiple devices in a single request',
        inputSchema: {
          type: 'object',
          properties: {
            deviceIds: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Array of device IDs to fetch details for',
            },
            includeBasicOnly: {
              type: 'boolean',
              description: 'Return only basic info to reduce response size',
              default: false,
            },
          },
          required: ['deviceIds'],
        },
      },
      {
        name: 'debugDeviceDates',
        description: 'Debug tool to see raw date fields from devices',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Number of devices to check',
              default: 3,
            },
          },
        },
      },
      {
        name: 'getAuthStatus',
        description: 'Get non-sensitive Jamf API auth status (debugging)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'listPolicies',
        description: 'List all policies in Jamf Pro',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of policies to return',
              default: 100,
            },
            category: {
              type: 'string',
              description: 'Filter by policy category',
            },
          },
        },
      },
      {
        name: 'getPolicyDetails',
        description:
          'Get detailed policy information. Note: Jamf Classic JSON often omits Self Service categories; this tool can parse them from Classic XML (set includeXml:true to include raw XML).',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The Jamf policy ID',
            },
            includeScriptContent: {
              type: 'boolean',
              description: 'Include full script content for scripts in the policy',
              default: false,
            },
            includeXml: {
              type: 'boolean',
              description: 'Include raw Classic policy XML in the response (can be large)',
              default: false,
            },
          },
          required: ['policyId'],
        },
      },
      {
        name: 'searchPolicies',
        description: 'Search for policies by name, description, or other criteria',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for policy name or description',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results',
              default: 50,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'getPolicyXml',
        description:
          'Get raw Classic policy XML for a policy. Useful for verifying fields Jamf may omit in JSON (e.g. Self Service categories).',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The Jamf policy ID',
            },
            includeParsed: {
              type: 'boolean',
              description: 'Include parsed Self Service category info from XML',
              default: true,
            },
          },
          required: ['policyId'],
        },
      },
      {
        name: 'executePolicy',
        description: 'Execute a Jamf policy on one or more devices (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The Jamf policy ID to execute',
            },
            deviceIds: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Array of device IDs to execute the policy on',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for policy execution',
              default: false,
            },
          },
          required: ['policyId', 'deviceIds'],
        },
      },
      {
        name: 'deployScript',
        description: 'Deploy and execute a Jamf script on one or more devices (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            scriptId: {
              type: 'string',
              description: 'The Jamf script ID to deploy',
            },
            deviceIds: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Array of device IDs to deploy the script to',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for script deployment',
              default: false,
            },
          },
          required: ['scriptId', 'deviceIds'],
        },
      },
      {
        name: 'getScriptDetails',
        description: 'Get detailed information about a specific script including its content, parameters, and metadata',
        inputSchema: {
          type: 'object',
          properties: {
            scriptId: {
              type: 'string',
              description: 'The Jamf script ID',
            },
          },
          required: ['scriptId'],
        },
      },
      {
        name: 'listConfigurationProfiles',
        description: 'List all configuration profiles in Jamf Pro (computer or mobile device)',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['computer', 'mobiledevice'],
              description: 'Type of configuration profiles to list',
              default: 'computer',
            },
          },
        },
      },
      {
        name: 'getConfigurationProfileDetails',
        description: 'Get detailed information about a specific configuration profile',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: {
              type: 'string',
              description: 'The configuration profile ID',
            },
            type: {
              type: 'string',
              enum: ['computer', 'mobiledevice'],
              description: 'Type of configuration profile',
              default: 'computer',
            },
          },
          required: ['profileId'],
        },
      },
      {
        name: 'searchConfigurationProfiles',
        description: 'Search for configuration profiles by name',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to find configuration profiles by name',
            },
            type: {
              type: 'string',
              enum: ['computer', 'mobiledevice'],
              description: 'Type of configuration profiles to search',
              default: 'computer',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'deployConfigurationProfile',
        description: 'Deploy a configuration profile to one or more devices (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: {
              type: 'string',
              description: 'The configuration profile ID to deploy',
            },
            deviceIds: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Array of device IDs to deploy the profile to',
            },
            type: {
              type: 'string',
              enum: ['computer', 'mobiledevice'],
              description: 'Type of configuration profile',
              default: 'computer',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for profile deployment',
              default: false,
            },
          },
          required: ['profileId', 'deviceIds'],
        },
      },
      {
        name: 'removeConfigurationProfile',
        description: 'Remove a configuration profile from one or more devices (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: {
              type: 'string',
              description: 'The configuration profile ID to remove',
            },
            deviceIds: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Array of device IDs to remove the profile from',
            },
            type: {
              type: 'string',
              enum: ['computer', 'mobiledevice'],
              description: 'Type of configuration profile',
              default: 'computer',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for profile removal',
              default: false,
            },
          },
          required: ['profileId', 'deviceIds'],
        },
      },
      {
        name: 'listComputerGroups',
        description: 'List computer groups in Jamf Pro (smart groups, static groups, or all)',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['smart', 'static', 'all'],
              description: 'Type of computer groups to list',
              default: 'all',
            },
          },
        },
      },
      {
        name: 'getComputerGroupDetails',
        description: 'Get detailed information about a specific computer group including membership and criteria',
        inputSchema: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              description: 'The computer group ID',
            },
          },
          required: ['groupId'],
        },
      },
      {
        name: 'searchComputerGroups',
        description: 'Search for computer groups by name',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to find computer groups by name',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'getComputerGroupMembers',
        description: 'Get all members of a specific computer group',
        inputSchema: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              description: 'The computer group ID to get members for',
            },
          },
          required: ['groupId'],
        },
      },
      {
        name: 'createStaticComputerGroup',
        description: 'Create a new static computer group with specified members (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name for the new static computer group',
            },
            computerIds: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Array of computer IDs to add to the group',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for group creation',
              default: false,
            },
          },
          required: ['name', 'computerIds'],
        },
      },
      {
        name: 'createSmartComputerGroup',
        description: 'Create a new smart computer group with criteria (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name for the new smart computer group',
            },
            criteria: {
              type: 'array',
              description: 'Array of criteria for the smart group',
              items: {
                type: 'object',
                properties: {
	                  name: { type: 'string', description: 'Criterion name' },
	                  priority: { type: 'number', description: 'Criterion priority' },
	                  and_or: {
	                    type: 'string',
	                    description: 'Logical operator (and/or)',
	                    enum: ['and', 'or'],
	                  },
	                  search_type: {
	                    type: 'string',
	                    description:
	                      'Search type/operator (varies by criterion, e.g. "is", "like", "more than x days ago"). Common aliases like "contains" will be normalized.',
	                  },
	                  value: { type: 'string', description: 'Search value' },
	                },
	                required: ['name', 'priority', 'and_or', 'search_type', 'value'],
	              },
	            },
            siteId: {
              type: 'number',
              description: 'Optional site ID for the group',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for group creation',
              default: false,
            },
          },
          required: ['name', 'criteria'],
        },
      },
      {
        name: 'updateStaticComputerGroup',
        description: 'Update the membership of a static computer group (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              description: 'The static computer group ID to update',
            },
            computerIds: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Array of computer IDs to set as the group membership',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for group update',
              default: false,
            },
          },
          required: ['groupId', 'computerIds'],
        },
      },
      {
        name: 'updateSmartComputerGroup',
        description: 'Update a smart computer group name and/or criteria (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              description: 'The smart computer group ID to update',
            },
            updates: {
              type: 'object',
              description: 'Updates to apply',
              properties: {
                name: { type: 'string', description: 'Updated group name' },
                criteria: {
                  type: 'array',
                  description: 'Updated criteria for the smart group',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'Criterion name' },
                      priority: { type: 'number', description: 'Criterion priority' },
	                      and_or: {
	                        type: 'string',
	                        description: 'Logical operator (and/or)',
	                        enum: ['and', 'or'],
	                      },
	                      search_type: {
	                        type: 'string',
	                        description:
	                          'Search type/operator (varies by criterion, e.g. "is", "like", "more than x days ago"). Common aliases like "contains" will be normalized.',
	                      },
	                      value: { type: 'string', description: 'Search value' },
	                    },
	                    required: ['name', 'priority', 'and_or', 'search_type', 'value'],
	                  },
	                },
                siteId: { type: 'number', description: 'Optional site ID' },
              },
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for group update',
              default: false,
            },
          },
          required: ['groupId', 'updates'],
        },
      },
      {
        name: 'deleteComputerGroup',
        description: 'Delete a computer group (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              description: 'The computer group ID to delete',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for group deletion',
              default: false,
            },
          },
          required: ['groupId'],
        },
      },
      {
        name: 'createAdvancedComputerSearch',
        description: 'Create an advanced computer search with custom criteria and display fields (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            searchData: {
              type: 'object',
              description: 'Advanced computer search configuration',
              properties: {
                name: {
                  type: 'string',
                  description: 'Name for the advanced computer search',
                },
                criteria: {
                  type: 'array',
                  description: 'Search criteria',
                  items: {
                    type: 'object',
                    properties: {
                      name: {
                        type: 'string',
                        description: 'Criterion name (e.g., "Last Check-in")',
                      },
                      priority: {
                        type: 'number',
                        description: 'Criterion priority (0 = first)',
                      },
                      and_or: {
                        type: 'string',
                        enum: ['and', 'or'],
                        description: 'Logical operator for combining criteria',
                      },
                      search_type: {
                        type: 'string',
                        description: 'Search type (e.g., "more than x days ago")',
                      },
                      value: {
                        type: 'string',
                        description: 'Search value',
                      },
                    },
                    required: ['name', 'priority', 'and_or', 'search_type', 'value'],
                  },
                },
                display_fields: {
                  type: 'array',
                  description: 'Fields to display in search results',
                  items: {
                    type: 'string',
                  },
                },
              },
              required: ['name'],
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for search creation',
              default: false,
            },
          },
          required: ['searchData'],
        },
      },
      {
        name: 'listAdvancedComputerSearches',
        description: 'List all advanced computer searches in Jamf Pro to see their names and IDs',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of searches to return',
              default: 100,
            },
          },
        },
      },
      {
        name: 'getAdvancedComputerSearchDetails',
        description: 'Get detailed information about a specific advanced computer search including its configured fields',
        inputSchema: {
          type: 'object',
          properties: {
            searchId: {
              type: 'string',
              description: 'The ID of the advanced computer search',
            },
          },
          required: ['searchId'],
        },
      },
      {
        name: 'deleteAdvancedComputerSearch',
        description: 'Delete an advanced computer search from Jamf Pro (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            searchId: {
              type: 'string',
              description: 'The ID of the advanced computer search to delete',
            },
            confirm: {
              type: 'boolean',
              description: 'Must be true to confirm deletion',
            },
          },
          required: ['searchId', 'confirm'],
        },
      },
      {
        name: 'searchMobileDevices',
        description: 'Search for mobile devices in Jamf Pro by name, serial number, UDID, or other criteria',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to find mobile devices',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return',
              default: 50,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'getMobileDeviceDetails',
        description: 'Get detailed information about a specific mobile device including hardware, OS, battery, and management status',
        inputSchema: {
          type: 'object',
          properties: {
            deviceId: {
              type: 'string',
              description: 'The mobile device ID',
            },
          },
          required: ['deviceId'],
        },
      },
      {
        name: 'listMobileDevices',
        description: 'List all mobile devices in Jamf Pro with basic information',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of mobile devices to return',
              default: 50,
            },
          },
        },
      },
      {
        name: 'updateMobileDeviceInventory',
        description: 'Force an inventory update on a specific mobile device',
        inputSchema: {
          type: 'object',
          properties: {
            deviceId: {
              type: 'string',
              description: 'The mobile device ID to update inventory for',
            },
          },
          required: ['deviceId'],
        },
      },
      {
        name: 'sendMDMCommand',
        description: 'Send an MDM command to a mobile device (e.g., lock, wipe, clear passcode) - requires confirmation for destructive actions',
        inputSchema: {
          type: 'object',
          properties: {
            deviceId: {
              type: 'string',
              description: 'The mobile device ID to send command to',
            },
            command: {
              type: 'string',
              description: 'The MDM command to send',
              enum: [
                'DeviceLock',
                'EraseDevice',
                'ClearPasscode',
                'RestartDevice',
                'ShutDownDevice',
                'EnableLostMode',
                'DisableLostMode',
                'PlayLostModeSound',
                'UpdateInventory',
                'ClearRestrictionsPassword',
                'SettingsEnableBluetooth',
                'SettingsDisableBluetooth',
                'SettingsEnableWiFi',
                'SettingsDisableWiFi',
                'SettingsEnableDataRoaming',
                'SettingsDisableDataRoaming',
                'SettingsEnableVoiceRoaming',
                'SettingsDisableVoiceRoaming',
                'SettingsEnablePersonalHotspot',
                'SettingsDisablePersonalHotspot',
              ],
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for destructive commands',
              default: false,
            },
          },
          required: ['deviceId', 'command'],
        },
      },
      {
        name: 'listMobileDeviceGroups',
        description: 'List mobile device groups in Jamf Pro (smart groups, static groups, or all)',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['smart', 'static', 'all'],
              description: 'Type of mobile device groups to list',
              default: 'all',
            },
          },
        },
      },
      {
        name: 'getMobileDeviceGroupDetails',
        description: 'Get detailed information about a specific mobile device group including membership and criteria',
        inputSchema: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              description: 'The mobile device group ID',
            },
          },
          required: ['groupId'],
        },
      },
      {
        name: 'listPackages',
        description: 'List all packages in Jamf Pro',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of packages to return',
              default: 100,
            },
          },
        },
      },
      {
        name: 'searchPackages',
        description: 'Search for packages by name',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for package name',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results',
              default: 50,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'getPackageDetails',
        description: 'Get detailed information about a specific package',
        inputSchema: {
          type: 'object',
          properties: {
            packageId: {
              type: 'string',
              description: 'The Jamf package ID',
            },
          },
          required: ['packageId'],
        },
      },
      {
        name: 'getPackageDeploymentHistory',
        description: 'Get deployment history for a specific package',
        inputSchema: {
          type: 'object',
          properties: {
            packageId: {
              type: 'string',
              description: 'The Jamf package ID',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of deployment records to return',
              default: 50,
            },
          },
          required: ['packageId'],
        },
      },
      {
        name: 'getPoliciesUsingPackage',
        description: 'Find all policies that use a specific package',
        inputSchema: {
          type: 'object',
          properties: {
            packageId: {
              type: 'string',
              description: 'The Jamf package ID',
            },
          },
          required: ['packageId'],
        },
      },
      {
        name: 'listPatchAvailableTitles',
        description:
          'List patch titles available from a patch source (Classic API). `id`/`nameId` in this output typically represent Jamf title `name_id` values. Use this before creating Patch Management configurations to discover what can be onboarded.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceId: {
              type: 'string',
              description: 'Patch source ID. Use `1` for Jamf patch catalog in most tenants.',
              default: '1',
            },
            query: {
              type: 'string',
              description: 'Optional case-insensitive substring filter on title name',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of patch available titles to return after filtering',
              default: 200,
            },
          },
        },
      },
      {
        name: 'listPatchPolicies',
        description:
          'List Patch Management policies from Jamf Pro (v2). Use this first to discover patch policy IDs before reading logs or triggering retries.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of patch policies to return',
              default: 100,
            },
          },
        },
      },
      {
        name: 'getPatchPolicyLogs',
        description:
          'Get execution logs for a specific Patch Management policy (v2). Use this to inspect device-level status, failures, and retry candidates.',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The patch policy ID',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of patch policy log records to return',
              default: 100,
            },
          },
          required: ['policyId'],
        },
      },
      {
        name: 'retryPatchPolicyLogs',
        description:
          'Retry failed/eligible Patch Management log entries for a patch policy (v2). Use `retryAll:true` for bulk retry, or provide `payload` for targeted retry (requires confirmation).',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The patch policy ID',
            },
            retryAll: {
              type: 'boolean',
              description: 'Retry all eligible failed logs for this policy',
              default: false,
            },
            payload: {
              type: 'object',
              description: 'Optional payload for targeted retry endpoint',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for patch log retry',
              default: false,
            },
          },
          required: ['policyId'],
        },
      },
      {
        name: 'listPatchSoftwareTitleConfigurations',
        description:
          'List Patch Software Title Configurations (v2). Use this to discover configuration IDs before requesting reports/summaries or performing updates.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of patch software title configurations to return',
              default: 100,
            },
          },
        },
      },
      {
        name: 'getPatchSoftwareTitleConfiguration',
        description:
          'Get details for one Patch Software Title Configuration (v2), including targeting and reporting context for that title.',
        inputSchema: {
          type: 'object',
          properties: {
            configId: {
              type: 'string',
              description: 'The patch software title configuration ID',
            },
          },
          required: ['configId'],
        },
      },
      {
        name: 'getPatchSoftwareTitleConfigurationReport',
        description:
          'Get the detailed patch report rows (device-level) for a Patch Software Title Configuration (v2).',
        inputSchema: {
          type: 'object',
          properties: {
            configId: {
              type: 'string',
              description: 'The patch software title configuration ID',
            },
          },
          required: ['configId'],
        },
      },
      {
        name: 'getPatchSoftwareTitleConfigurationSummary',
        description:
          'Get Jamf-provided aggregated patch summary for a Patch Software Title Configuration (v2).',
        inputSchema: {
          type: 'object',
          properties: {
            configId: {
              type: 'string',
              description: 'The patch software title configuration ID',
            },
          },
          required: ['configId'],
        },
      },
      {
        name: 'getPatchSoftwareTitleConfigurationVersionSummary',
        description:
          'Get version-based patch summary for a Patch Software Title Configuration (v2), useful for rollout planning and drift analysis.',
        inputSchema: {
          type: 'object',
          properties: {
            configId: {
              type: 'string',
              description: 'The patch software title configuration ID',
            },
          },
          required: ['configId'],
        },
      },
      {
        name: 'getPatchSoftwareTitleConfigurationReportSummary',
        description:
          'Build an MCP-side aggregated/filterable summary from patch report rows (device name filter + outdated-only mode + capped result set). Useful for LLM-friendly reporting.',
        inputSchema: {
          type: 'object',
          properties: {
            configId: {
              type: 'string',
              description: 'The patch software title configuration ID',
            },
            deviceNameContains: {
              type: 'string',
              description: 'Optional case-insensitive filter by device name',
            },
            onlyOutdated: {
              type: 'boolean',
              description: 'Include only outdated devices in aggregation',
              default: false,
            },
            limit: {
              type: 'number',
              description: 'Maximum number of rows to include in aggregation',
              default: 1000,
            },
          },
          required: ['configId'],
        },
      },
      {
        name: 'createPatchSoftwareTitleConfiguration',
        description:
          'Create a new Patch Software Title Configuration (v2) using raw configuration payload (requires confirmation). Uses strict post-write persistence verification by default. If `config.softwareTitleId` is passed as a Classic catalog `name_id` (from `listPatchAvailableTitles`), the server attempts Classic onboarding and then retries with the resolved numeric softwareTitleId.',
        inputSchema: {
          type: 'object',
          properties: {
            config: {
              type: 'object',
              description: 'Patch software title configuration payload',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for patch software title configuration creation',
              default: false,
            },
          },
          required: ['config'],
        },
      },
      {
        name: 'updatePatchSoftwareTitleConfiguration',
        description:
          'Update an existing Patch Software Title Configuration (v2) with partial fields in `updates` (requires confirmation). Uses strict post-write persistence verification by default.',
        inputSchema: {
          type: 'object',
          properties: {
            configId: {
              type: 'string',
              description: 'The patch software title configuration ID',
            },
            updates: {
              type: 'object',
              description: 'Partial patch software title configuration payload',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for patch software title configuration update',
              default: false,
            },
          },
          required: ['configId', 'updates'],
        },
      },
      {
        name: 'deletePatchSoftwareTitleConfiguration',
        description:
          'Delete a Patch Software Title Configuration (v2) by ID (requires confirmation). Uses strict post-delete verification by default.',
        inputSchema: {
          type: 'object',
          properties: {
            configId: {
              type: 'string',
              description: 'The patch software title configuration ID',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for patch software title configuration deletion',
              default: false,
            },
          },
          required: ['configId'],
        },
      },
      {
        name: 'getManagedSoftwareUpdatesAvailable',
        description:
          'Get currently available Managed Software Updates from Jamf (macOS workflow, v1). Use this to identify update products/versions before plan creation.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'getManagedSoftwareUpdatePlansFeatureToggle',
        description:
          'Get Managed Software Update plans feature-toggle details (v1). Useful to diagnose tenant-side plan-service availability issues.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'getManagedSoftwareUpdatePlansFeatureToggleStatus',
        description:
          'Get Managed Software Update plans feature-toggle status (v1), including enable/disable state diagnostics.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'getManagedSoftwareUpdateStatuses',
        description:
          'Get Managed Software Update statuses (v1), typically device-level progress/state for update operations.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of managed software update statuses to return',
              default: 100,
            },
          },
        },
      },
      {
        name: 'listManagedSoftwareUpdatePlans',
        description:
          'List Managed Software Update plans (v1). Use this to discover plan IDs and monitor rollout orchestration.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of managed software update plans to return',
              default: 100,
            },
          },
        },
      },
      {
        name: 'getManagedSoftwareUpdatePlan',
        description:
          'Get one Managed Software Update plan by ID (v1), including rollout details and plan metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            planId: {
              type: 'string',
              description: 'The managed software update plan ID',
            },
          },
          required: ['planId'],
        },
      },
      {
        name: 'createManagedSoftwareUpdatePlan',
        description:
          'Create a Managed Software Update plan (v1) from raw plan payload (requires confirmation).',
        inputSchema: {
          type: 'object',
          properties: {
            plan: {
              type: 'object',
              description: 'Managed software update plan payload',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for managed software update plan creation',
              default: false,
            },
          },
          required: ['plan'],
        },
      },
      {
        name: 'createManagedSoftwareUpdatePlanForGroup',
        description:
          'Create Managed Software Update plan(s) scoped to a group (v1) from raw payload (requires confirmation).',
        inputSchema: {
          type: 'object',
          properties: {
            plan: {
              type: 'object',
              description: 'Managed software update plan-for-group payload',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for managed software update group plan creation',
              default: false,
            },
          },
          required: ['plan'],
        },
      },
      {
        name: 'createPolicy',
        description:
          'Create a new policy. Prefer `policyData` for structured updates; `policyXml` is an advanced Classic-XML escape hatch (requires confirmation).',
        inputSchema: {
          type: 'object',
          properties: {
            policyXml: {
              type: 'string',
              description: 'Raw Classic policy XML payload. If set, policyData is ignored.',
            },
            policyData: {
              type: 'object',
              description: 'Policy configuration data',
              properties: {
                general: {
                  type: 'object',
                  description: 'General policy settings',
                  properties: {
                    name: { type: 'string', description: 'Policy name' },
                    enabled: { type: 'boolean', description: 'Whether the policy is enabled' },
                    trigger: { type: 'string', description: 'Policy trigger type' },
                    trigger_checkin: { type: 'boolean', description: 'Trigger on check-in' },
                    trigger_enrollment_complete: { type: 'boolean', description: 'Trigger on enrollment complete' },
                    trigger_login: { type: 'boolean', description: 'Trigger on login' },
                    trigger_logout: { type: 'boolean', description: 'Trigger on logout' },
	                    trigger_network_state_changed: { type: 'boolean', description: 'Trigger on network state change' },
	                    trigger_startup: { type: 'boolean', description: 'Trigger on startup' },
	                    trigger_other: { type: 'string', description: 'Custom trigger name' },
	                    frequency: {
	                      type: 'string',
	                      description:
	                        'Execution frequency (Classic values vary by tenant/version; commonly: Once per computer, Once per user per computer, Once per user, Once per day or Once every day, Once per week or Once every week, Once per month or Once every month, Ongoing).',
	                      enum: [
	                        'Once per computer',
	                        'Once per user per computer',
	                        'Once per user',
	                        'Once every day',
	                        'Once every week',
	                        'Once every month',
	                        'Ongoing',
	                      ],
	                    },
	                    category: { type: 'string', description: 'Policy category' },
	                  },
                  required: ['name'],
                },
                scope: {
                  type: 'object',
                  description: 'Policy scope settings',
                  properties: {
                    all_computers: { type: 'boolean', description: 'Apply to all computers' },
                    computers: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'number' } } },
                      description: 'Specific computers',
                    },
                    computer_groups: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'number' } } },
                      description: 'Computer groups',
                    },
                    buildings: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'number' } } },
                      description: 'Buildings',
                    },
                    departments: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'number' } } },
                      description: 'Departments',
                    },
                  },
                },
	                self_service: {
	                  type: 'object',
	                  description: 'Self Service settings',
	                  properties: {
	                    use_for_self_service: { type: 'boolean', description: 'Make available in Self Service' },
	                    self_service_display_name: { type: 'string', description: 'Display name in Self Service' },
	                    install_button_text: { type: 'string', description: 'Install button text' },
	                    reinstall_button_text: { type: 'string', description: 'Reinstall button text' },
	                    self_service_description: { type: 'string', description: 'Description in Self Service' },
	                    force_users_to_view_description: { type: 'boolean', description: 'Force users to view description' },
	                    feature_on_main_page: { type: 'boolean', description: 'Feature on main page' },
	                    notification: { type: 'boolean', description: 'Show Self Service notification' },
	                    notification_type: { type: 'string', description: 'Self Service notification type' },
	                    notification_subject: { type: 'string', description: 'Self Service notification subject' },
	                    notification_message: { type: 'string', description: 'Self Service notification message' },
	                    self_service_category: {
	                      description:
	                        'Self Service category (policy). Prefer using an existing category id or name.',
	                      anyOf: [
	                        { type: 'string' },
	                        {
	                          type: 'object',
	                          properties: {
	                            id: { type: 'number' },
	                            name: { type: 'string' },
	                          },
	                        },
	                      ],
	                    },
	                    self_service_categories: {
	                      description:
	                        'Self Service categories for this policy. The server writes Classic policy XML <self_service_categories><size>... and includes display_in/feature_in defaults.',
	                      anyOf: [
	                        {
	                          type: 'array',
	                          items: {
	                            type: 'object',
	                            properties: {
	                              id: { type: 'number' },
	                              name: { type: 'string' },
	                            },
	                          },
	                        },
	                        {
	                          type: 'object',
	                          properties: {
	                            category: {
	                              anyOf: [
	                                {
	                                  type: 'object',
	                                  properties: {
	                                    id: { type: 'number' },
	                                    name: { type: 'string' },
	                                  },
	                                },
	                                {
	                                  type: 'array',
	                                  items: {
	                                    type: 'object',
	                                    properties: {
	                                      id: { type: 'number' },
	                                      name: { type: 'string' },
	                                    },
	                                  },
	                                },
	                              ],
	                            },
	                          },
	                        },
	                      ],
	                    },
	                  },
	                },
                package_configuration: {
                  type: 'object',
                  description: 'Package configuration',
                  properties: {
                    packages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'number', description: 'Package ID' },
                          action: { type: 'string', description: 'Install action' },
                          fut: { type: 'boolean', description: 'Fill user templates' },
                          feu: { type: 'boolean', description: 'Fill existing users' },
                        },
                        required: ['id'],
                      },
                    },
                  },
                },
                scripts: {
                  type: 'array',
                  description: 'Scripts to run',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'number', description: 'Script ID' },
	                      priority: {
	                        type: 'string',
	                        description: 'Script priority (Before, After). Case-insensitive aliases will be normalized.',
	                        enum: ['Before', 'After'],
	                      },
                      parameter4: { type: 'string', description: 'Script parameter 4' },
                      parameter5: { type: 'string', description: 'Script parameter 5' },
                      parameter6: { type: 'string', description: 'Script parameter 6' },
                      parameter7: { type: 'string', description: 'Script parameter 7' },
                      parameter8: { type: 'string', description: 'Script parameter 8' },
                      parameter9: { type: 'string', description: 'Script parameter 9' },
                      parameter10: { type: 'string', description: 'Script parameter 10' },
                      parameter11: { type: 'string', description: 'Script parameter 11' },
                    },
                    required: ['id'],
                  },
                },
              },
              required: ['general'],
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for policy creation',
              default: false,
            },
          },
        },
      },
      {
        name: 'createPolicyXml',
        description:
          'Create a policy using raw Classic XML payload (advanced; requires exact Classic schema) (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            policyXml: {
              type: 'string',
              description: 'Raw Classic policy XML payload',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for policy creation',
              default: false,
            },
          },
          required: ['policyXml'],
        },
      },
      {
        name: 'updatePolicy',
        description:
          'Update an existing policy. Uses strict post-write persistence verification by default (JSON + Classic XML convergence checks) and returns an error if requested fields are not durably observed. Prefer `policyData` for structured updates; `policyXml` is an advanced Classic-XML escape hatch (requires confirmation).',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The policy ID to update',
            },
            policyXml: {
              type: 'string',
              description: 'Raw Classic policy XML payload. If set, policyData is ignored.',
            },
            policyData: {
              type: 'object',
              description: 'Policy configuration data to update',
              properties: {
                general: {
                  type: 'object',
                  description: 'General policy settings to update',
                  properties: {
                    name: { type: 'string', description: 'Policy name' },
                    enabled: { type: 'boolean', description: 'Whether the policy is enabled' },
                    trigger: { type: 'string', description: 'Policy trigger type' },
	                    frequency: {
	                      type: 'string',
	                      description:
	                        'Execution frequency (Classic values vary by tenant/version; commonly: Once per computer, Once per user per computer, Once per user, Once per day or Once every day, Once per week or Once every week, Once per month or Once every month, Ongoing).',
	                      enum: [
	                        'Once per computer',
	                        'Once per user per computer',
	                        'Once per user',
	                        'Once every day',
	                        'Once every week',
	                        'Once every month',
	                        'Ongoing',
	                      ],
	                    },
	                    category: { type: 'string', description: 'Policy category' },
	                  },
                },
                scope: {
                  type: 'object',
                  description: 'Policy scope settings to update',
                  properties: {
                    all_computers: { type: 'boolean', description: 'Apply to all computers' },
                    computers: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'number' } } },
                      description: 'Specific computers',
                    },
                    computer_groups: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'number' } } },
                      description: 'Computer groups',
                    },
                    buildings: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'number' } } },
                      description: 'Buildings',
                    },
                    departments: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'number' } } },
                      description: 'Departments',
                    },
                  },
                },
	                self_service: {
	                  type: 'object',
	                  description: 'Self Service settings to update',
	                  properties: {
	                    use_for_self_service: { type: 'boolean', description: 'Make available in Self Service' },
	                    self_service_display_name: { type: 'string', description: 'Display name in Self Service' },
	                    install_button_text: { type: 'string', description: 'Install button text' },
	                    reinstall_button_text: { type: 'string', description: 'Reinstall button text' },
	                    self_service_description: { type: 'string', description: 'Description in Self Service' },
	                    force_users_to_view_description: { type: 'boolean', description: 'Force users to view description' },
	                    feature_on_main_page: { type: 'boolean', description: 'Feature on main page' },
	                    notification: { type: 'boolean', description: 'Show Self Service notification' },
	                    notification_type: { type: 'string', description: 'Self Service notification type' },
	                    notification_subject: { type: 'string', description: 'Self Service notification subject' },
	                    notification_message: { type: 'string', description: 'Self Service notification message' },
	                    self_service_category: {
	                      description:
	                        'Self Service category (policy). Prefer using an existing category id or name.',
	                      anyOf: [
	                        { type: 'string' },
	                        {
	                          type: 'object',
	                          properties: {
	                            id: { type: 'number' },
	                            name: { type: 'string' },
	                          },
	                        },
	                      ],
	                    },
	                    self_service_categories: {
	                      description:
	                        'Self Service categories for this policy. The server writes Classic policy XML <self_service_categories><size>... and includes display_in/feature_in defaults.',
	                      anyOf: [
	                        {
	                          type: 'array',
	                          items: {
	                            type: 'object',
	                            properties: {
	                              id: { type: 'number' },
	                              name: { type: 'string' },
	                            },
	                          },
	                        },
	                        {
	                          type: 'object',
	                          properties: {
	                            category: {
	                              anyOf: [
	                                {
	                                  type: 'object',
	                                  properties: {
	                                    id: { type: 'number' },
	                                    name: { type: 'string' },
	                                  },
	                                },
	                                {
	                                  type: 'array',
	                                  items: {
	                                    type: 'object',
	                                    properties: {
	                                      id: { type: 'number' },
	                                      name: { type: 'string' },
	                                    },
	                                  },
	                                },
	                              ],
	                            },
	                          },
	                        },
	                      ],
	                    },
	                  },
	                },
                package_configuration: {
                  type: 'object',
                  description: 'Package configuration to update',
                  properties: {
                    packages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'number', description: 'Package ID' },
                          action: { type: 'string', description: 'Install action' },
                          fut: { type: 'boolean', description: 'Fill user templates' },
                          feu: { type: 'boolean', description: 'Fill existing users' },
                        },
                        required: ['id'],
                      },
                      description: 'Packages to deploy',
                    },
                  },
                },
                scripts: {
                  type: 'array',
                  description: 'Scripts to run',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'number', description: 'Script ID' },
	                      priority: {
	                        type: 'string',
	                        description: 'Script priority (Before, After). Case-insensitive aliases will be normalized.',
	                        enum: ['Before', 'After'],
	                      },
                      parameter4: { type: 'string', description: 'Script parameter 4' },
                      parameter5: { type: 'string', description: 'Script parameter 5' },
                      parameter6: { type: 'string', description: 'Script parameter 6' },
                      parameter7: { type: 'string', description: 'Script parameter 7' },
                      parameter8: { type: 'string', description: 'Script parameter 8' },
                      parameter9: { type: 'string', description: 'Script parameter 9' },
                      parameter10: { type: 'string', description: 'Script parameter 10' },
                      parameter11: { type: 'string', description: 'Script parameter 11' },
                    },
                    required: ['id'],
                  },
                },
              },
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for policy update',
              default: false,
            },
          },
          required: ['policyId'],
        },
      },
      {
        name: 'updatePolicyXml',
        description:
          'Update a policy using raw Classic XML payload (advanced; may replace sections if incomplete) (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The policy ID to update',
            },
            policyXml: {
              type: 'string',
              description: 'Raw Classic policy XML payload',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for policy update',
              default: false,
            },
          },
          required: ['policyId', 'policyXml'],
        },
      },
      {
        name: 'clonePolicy',
        description: 'Clone an existing policy with a new name (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            sourcePolicyId: {
              type: 'string',
              description: 'The source policy ID to clone',
            },
            newName: {
              type: 'string',
              description: 'Name for the cloned policy',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for policy cloning',
              default: false,
            },
          },
          required: ['sourcePolicyId', 'newName'],
        },
      },
      {
        name: 'setPolicyEnabled',
        description: 'Enable or disable a policy (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The policy ID',
            },
            enabled: {
              type: 'boolean',
              description: 'Whether to enable or disable the policy',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for enabling/disabling policy',
              default: false,
            },
          },
          required: ['policyId', 'enabled'],
        },
      },
      {
        name: 'updatePolicyScope',
        description: 'Update policy scope by adding/removing computers and groups (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The policy ID to update scope for',
            },
            scopeUpdates: {
              type: 'object',
              description: 'Scope update operations',
              properties: {
                addComputers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Computer IDs to add to scope',
                },
                removeComputers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Computer IDs to remove from scope',
                },
                addComputerGroups: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Computer group IDs to add to scope',
                },
                removeComputerGroups: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Computer group IDs to remove from scope',
                },
                replaceComputers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Replace all computers in scope with these IDs',
                },
                replaceComputerGroups: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Replace all computer groups in scope with these IDs',
                },
              },
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for scope update',
              default: false,
            },
          },
          required: ['policyId', 'scopeUpdates'],
        },
      },
      {
        name: 'listScripts',
        description: 'List all scripts in Jamf Pro',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of scripts to return',
              default: 100,
            },
          },
        },
      },
      {
        name: 'searchScripts',
        description: 'Search for scripts by name',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for script name',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results',
              default: 50,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'createScript',
        description: 'Create a new script with contents and parameters (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            scriptData: {
              type: 'object',
              description: 'Script configuration data',
              properties: {
                name: {
                  type: 'string',
                  description: 'Script name',
                },
                script_contents: {
                  type: 'string',
                  description: 'Script contents',
                },
                category: {
                  type: 'string',
                  description: 'Script category',
                },
                info: {
                  type: 'string',
                  description: 'Script info/description',
                },
                notes: {
                  type: 'string',
                  description: 'Script notes',
                },
	                priority: {
	                  type: 'string',
	                  description: 'Script priority (Before, After). Case-insensitive aliases will be normalized.',
	                  enum: ['Before', 'After'],
	                },
                parameters: {
                  type: 'object',
                  description: 'Script parameter labels',
                  properties: {
                    parameter4: { type: 'string', description: 'Parameter 4 label' },
                    parameter5: { type: 'string', description: 'Parameter 5 label' },
                    parameter6: { type: 'string', description: 'Parameter 6 label' },
                    parameter7: { type: 'string', description: 'Parameter 7 label' },
                    parameter8: { type: 'string', description: 'Parameter 8 label' },
                    parameter9: { type: 'string', description: 'Parameter 9 label' },
                    parameter10: { type: 'string', description: 'Parameter 10 label' },
                    parameter11: { type: 'string', description: 'Parameter 11 label' },
                  },
                },
                os_requirements: {
                  type: 'string',
                  description: 'OS requirements',
                },
                script_contents_encoded: {
                  type: 'boolean',
                  description: 'Whether script contents are encoded',
                },
              },
              required: ['name', 'script_contents'],
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for script creation',
              default: false,
            },
          },
          required: ['scriptData'],
        },
      },
      {
        name: 'updateScript',
        description: 'Update an existing script (requires confirmation). Uses strict post-write persistence verification by default.',
        inputSchema: {
          type: 'object',
          properties: {
            scriptId: {
              type: 'string',
              description: 'The script ID to update',
            },
            scriptData: {
              type: 'object',
              description: 'Script configuration data to update',
              properties: {
                name: {
                  type: 'string',
                  description: 'Script name',
                },
                script_contents: {
                  type: 'string',
                  description: 'Script contents',
                },
                category: {
                  type: 'string',
                  description: 'Script category',
                },
                info: {
                  type: 'string',
                  description: 'Script info/description',
                },
                notes: {
                  type: 'string',
                  description: 'Script notes',
                },
	                priority: {
	                  type: 'string',
	                  description: 'Script priority (Before, After). Case-insensitive aliases will be normalized.',
	                  enum: ['Before', 'After'],
	                },
                parameters: {
                  type: 'object',
                  description: 'Script parameter labels',
                  properties: {
                    parameter4: { type: 'string', description: 'Parameter 4 label' },
                    parameter5: { type: 'string', description: 'Parameter 5 label' },
                    parameter6: { type: 'string', description: 'Parameter 6 label' },
                    parameter7: { type: 'string', description: 'Parameter 7 label' },
                    parameter8: { type: 'string', description: 'Parameter 8 label' },
                    parameter9: { type: 'string', description: 'Parameter 9 label' },
                    parameter10: { type: 'string', description: 'Parameter 10 label' },
                    parameter11: { type: 'string', description: 'Parameter 11 label' },
                  },
                },
                os_requirements: {
                  type: 'string',
                  description: 'OS requirements',
                },
                script_contents_encoded: {
                  type: 'boolean',
                  description: 'Whether script contents are encoded',
                },
              },
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for script update',
              default: false,
            },
          },
          required: ['scriptId', 'scriptData'],
        },
      },
      {
        name: 'deleteScript',
        description: 'Delete a script (requires confirmation)',
        inputSchema: {
          type: 'object',
          properties: {
            scriptId: {
              type: 'string',
              description: 'The script ID to delete',
            },
            confirm: {
              type: 'boolean',
              description: 'Confirmation flag for script deletion',
              default: false,
            },
          },
          required: ['scriptId'],
        },
      },
      // Reporting and Analytics Tools
      {
        name: 'getInventorySummary',
        description: 'Get inventory summary report including total devices, OS version distribution, and model distribution',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'getPolicyComplianceReport',
        description: 'Get policy compliance report showing success/failure rates, computers in scope vs completed, and last execution times',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: {
              type: 'string',
              description: 'The Jamf policy ID to generate compliance report for',
            },
          },
          required: ['policyId'],
        },
      },
      {
        name: 'getComputerPolicyLogs',
        description: 'Get per-computer policy execution logs ("Policy Logs") from Jamf Classic API computer history',
        inputSchema: {
          type: 'object',
          properties: {
            serialNumber: {
              type: 'string',
              description: 'Computer serial number (preferred identifier)',
            },
            deviceId: {
              type: 'string',
              description: 'Jamf computer ID (alternative identifier)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of log entries to return',
              default: 50,
            },
            includeRaw: {
              type: 'boolean',
              description: 'Include the raw Classic API response for debugging',
              default: false,
            },
          },
        },
      },
      {
        name: 'listSelfServiceCategories',
        description:
          'List categories (Jamf Pro typically uses the global Categories list for Self Service policy categories). Prefer using category `id` when updating policies.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Optional substring filter on category name',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of categories to return',
              default: 200,
            },
          },
        },
      },
		      {
		        name: 'ensureSelfServiceCategoryExists',
		        description:
		          'Ensure a category exists (creates a Category if missing). Use this before setting policy Self Service categories. Requires confirmation when creation is needed.',
		        inputSchema: {
		          type: 'object',
		          properties: {
	            name: { type: 'string', description: 'Self Service category name to ensure exists' },
	            priority: { type: 'number', description: 'Optional category priority' },
	            confirm: {
	              type: 'boolean',
	              description: 'Confirmation flag (required if category needs to be created)',
	              default: false,
	            },
	          },
	          required: ['name'],
	        },
	      },
		      {
		        name: 'createCategory',
		        description:
		          'Create a Category in Jamf Pro (Modern-first with Classic fallback) (requires confirmation)',
		        inputSchema: {
		          type: 'object',
		          properties: {
	            name: { type: 'string', description: 'Category name to create' },
	            priority: { type: 'number', description: 'Optional category priority' },
	            confirm: {
	              type: 'boolean',
	              description: 'Confirmation flag for category creation',
	              default: false,
	            },
	          },
	          required: ['name'],
	        },
	      },
	      {
	        name: 'getPackageDeploymentStats',
	        description: 'Get package deployment statistics including policies using the package, deployment success rate, and target device count',
	        inputSchema: {
	          type: 'object',
	          properties: {
            packageId: {
              type: 'string',
              description: 'The Jamf package ID to get deployment statistics for',
            },
          },
          required: ['packageId'],
        },
      },
      {
        name: 'getSoftwareVersionReport',
        description: 'Get software version report showing version distribution across devices and out-of-date installations',
        inputSchema: {
          type: 'object',
          properties: {
            softwareName: {
              type: 'string',
              description: 'Name of the software to search for version information',
            },
          },
          required: ['softwareName'],
        },
      },
      {
        name: 'getDeviceComplianceSummary',
        description: 'Get device compliance summary showing devices checking in regularly, devices with failed policies, and devices missing critical software',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      // Documentation Tools
      {
        name: 'documentJamfEnvironment',
        description: 'Generate comprehensive documentation of the Jamf Pro environment including computers, mobile devices, policies, configuration profiles, scripts, packages, and groups. Outputs both markdown and JSON formats to the specified directory.',
        inputSchema: {
          type: 'object',
          properties: {
            outputPath: {
              type: 'string',
              description: 'Directory path where documentation files will be saved',
              default: './jamf-documentation',
            },
            formats: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['markdown', 'json'],
              },
              description: 'Output formats to generate (markdown, json, or both)',
              default: ['markdown', 'json'],
            },
            components: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'computers',
                  'mobile-devices',
                  'policies',
                  'configuration-profiles',
                  'scripts',
                  'packages',
                  'computer-groups',
                  'mobile-device-groups',
                ],
              },
              description: 'Specific components to document. If not provided, all components will be documented.',
            },
            detailLevel: {
              type: 'string',
              enum: ['summary', 'standard', 'full'],
              description: 'Level of detail to include in documentation',
              default: 'full',
            },
            includeScriptContent: {
              type: 'boolean',
              description: 'Include full script content in documentation',
              default: true,
            },
            includeProfilePayloads: {
              type: 'boolean',
              description: 'Include configuration profile payload details',
              default: true,
            },
          },
        },
      },
    ];

    return { tools: tools.map(decorateToolDescription) };
  };

  const callToolHandler = async (request: z.infer<typeof CallToolRequestSchema>) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'searchDevices': {
          const { query, limit } = SearchDevicesSchema.parse(args);
          const devices = await jamfClient.searchComputers(query, limit);
          
          // Handle both modern and classic API response formats
          const formattedDevices = devices.map((d: any) => ({
            id: d.id?.toString(),
            name: d.name,
            serialNumber: d.serialNumber || d.serial_number,
            lastContactTime: d.lastContactTime || d.last_contact_time || d.last_contact_time_utc,
            osVersion: d.osVersion || d.os_version,
            ipAddress: d.ipAddress || d.ip_address || d.reported_ip_address,
            username: d.username,
            email: d.email || d.email_address,
          }));

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              count: devices.length,
              devices: formattedDevices,
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getDeviceDetails': {
          const { deviceId } = GetDeviceDetailsSchema.parse(args);
          const device = await jamfClient.getComputerDetails(deviceId);
          
          // Handle both API formats
          const formatStorage = (storage: any) => {
            if (!storage) return undefined;
            
            // Modern API format
            if (storage.disks) {
              return {
                bootDriveAvailableMB: storage.bootDriveAvailableSpaceMegabytes,
                disks: storage.disks.map((disk: any) => ({
                  device: disk.device,
                  sizeMB: disk.sizeMegabytes,
                  partitions: disk.partitions?.map((p: any) => ({
                    name: p.name,
                    sizeMB: p.sizeMegabytes,
                    availableMB: p.availableMegabytes,
                    percentUsed: p.percentUsed,
                    fileVault2State: p.fileVault2State,
                  })),
                })),
              };
            }
            
            // Classic API format
            if (Array.isArray(storage)) {
              const disks = storage.map((item: any) => {
                if (item.disk) {
                  return {
                    device: item.disk.device,
                    sizeMB: item.disk.drive_capacity_mb,
                    model: item.disk.model,
                  };
                }
                if (item.partition) {
                  return {
                    partitionName: item.partition.name,
                    availableMB: item.partition.available_mb,
                    percentUsed: item.partition.percentage_full,
                    fileVault2State: item.partition.filevault2_status,
                  };
                }
                return item;
              });
              
              const bootPartition = storage.find((s: any) => 
                s.partition?.boot_drive_available_mb !== undefined
              );
              
              return {
                bootDriveAvailableMB: bootPartition?.partition?.boot_drive_available_mb,
                disks: disks,
              };
            }
            
            return storage;
          };

          const formatted = {
            id: device.id?.toString(),
            name: device.name || device.general?.name,
            general: {
              platform: device.general?.platform || device.platform,
              supervised: device.general?.supervised,
              managementUsername: device.general?.remote_management?.management_username ||
                                 device.general?.remoteManagement?.managementUsername,
              serialNumber: device.general?.serial_number || device.general?.serialNumber,
              lastContactTime: device.general?.last_contact_time || device.general?.lastContactTime,
            },
            hardware: {
              model: device.hardware?.model,
              osVersion: device.hardware?.os_version || device.hardware?.osVersion,
              processorType: device.hardware?.processor_type || device.hardware?.processorType,
              totalRamMB: device.hardware?.total_ram || device.hardware?.totalRamMegabytes,
              batteryPercent: device.hardware?.battery_capacity || device.hardware?.batteryCapacityPercent,
              appleSilicon: device.hardware?.apple_silicon || device.hardware?.appleSilicon,
            },
            userAndLocation: {
              username: device.location?.username || device.userAndLocation?.username,
              realname: device.location?.realname || device.location?.real_name || device.userAndLocation?.realname,
              email: device.location?.email_address || device.userAndLocation?.email,
              position: device.location?.position || device.userAndLocation?.position,
            },
            storage: formatStorage(device.hardware?.storage || device.storage),
          };

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(formatted, null, 2),
          };

          return { content: [content] };
        }

        case 'updateInventory': {
          const { deviceId, confirm } = UpdateInventorySchema.parse(args);

          if (!confirm) {
            throw new Error('Inventory update requires confirmation. Set confirm: true to proceed.');
          }

          await jamfClient.updateInventory(deviceId);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully triggered inventory update for device ${deviceId}`,
          };

          return { content: [content] };
        }

        case 'checkDeviceCompliance': {
          const { days, includeDetails } = CheckDeviceComplianceSchema.parse(args);
          
          // Get all computers (with date info already included)
          const allComputers = await jamfClient.getAllComputers();
          
          const now = new Date();
          const cutoffDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
          
          /** Device compliance info structure */
          interface ComplianceDeviceInfo {
            id: string | undefined;
            name: string | undefined;
            serialNumber: string | undefined;
            username: string | undefined;
            lastContact: string;
            lastContactReadable: string;
            daysSinceContact: number | null;
            status: string;
            severity?: string;
          }

          const results: {
            totalDevices: number;
            compliant: number;
            nonCompliant: number;
            notReporting: number;
            unknown: number;
            complianceRate: string;
            summary: {
              totalDevices: number;
              compliant: number;
              warning: number;
              critical: number;
              unknown: number;
              criticalDevices: ComplianceDeviceInfo[];
              warningDevices: ComplianceDeviceInfo[];
            };
            devices: ComplianceDeviceInfo[] | undefined;
          } = {
            totalDevices: allComputers.length,
            compliant: 0,
            nonCompliant: 0,
            notReporting: 0,
            unknown: 0,
            complianceRate: '0%',
            summary: {
              totalDevices: allComputers.length,
              compliant: 0,
              warning: 0,
              critical: 0,
              unknown: 0,
              criticalDevices: [],
              warningDevices: [],
            },
            devices: includeDetails ? [] : undefined,
          };
          
          // Process all computers without fetching individual details
          for (const computer of allComputers) {
            // Get date from the data we already have
            const dateValue = computer.general?.last_contact_time || 
                              computer.general?.last_contact_time_utc ||
                              computer.Last_Check_in;
            
            const lastContact = parseJamfDate(dateValue);
                
            const daysSinceContact = lastContact 
              ? Math.floor((now.getTime() - lastContact.getTime()) / (1000 * 60 * 60 * 24))
              : null;
            
            const deviceInfo = {
              id: computer.id?.toString(),
              name: computer.name || computer.general?.name || computer.Computer_Name,
              serialNumber: computer.general?.serial_number || computer.Serial_Number,
              username: computer.username || computer.Full_Name,
              lastContact: lastContact?.toISOString() || 'Unknown',
              lastContactReadable: dateValue || 'Unknown',
              daysSinceContact,
              status: 'unknown' as string,
            };
            
            if (!lastContact) {
              results.unknown++;
              results.summary.unknown++;
              deviceInfo.status = 'unknown';
            } else if (lastContact < cutoffDate) {
              results.nonCompliant++;
              results.notReporting++;
              deviceInfo.status = 'non-compliant';
              
              // Categorize by severity
              if (daysSinceContact && daysSinceContact > 90) {
                results.summary.critical++;
                if (includeDetails) {
                  results.summary.criticalDevices.push({
                    ...deviceInfo,
                    severity: 'critical',
                  });
                }
              } else {
                results.summary.warning++;
                if (includeDetails) {
                  results.summary.warningDevices.push({
                    ...deviceInfo,
                    severity: 'warning',
                  });
                }
              }
            } else {
              results.compliant++;
              results.summary.compliant++;
              deviceInfo.status = 'compliant';
            }
            
            if (includeDetails && results.devices) {
              results.devices.push(deviceInfo);
            }
          }
          
          // Calculate compliance rate
          const complianceRate = results.totalDevices > 0 
            ? ((results.compliant / results.totalDevices) * 100).toFixed(1)
            : '0.0';
          results.complianceRate = `${complianceRate}%`;
          
          // Sort devices by last contact time if details included
          if (includeDetails && results.devices) {
            results.devices.sort((a, b) => {
              const dateA = new Date(a.lastContact).getTime();
              const dateB = new Date(b.lastContact).getTime();
              return dateB - dateA;
            });
          }
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          };

          return { content: [content] };
        }

        case 'debugDeviceDates': {
          const { limit } = args as { limit?: number };
          const devices = await jamfClient.searchComputers('', limit || 3);
          
          const debugInfo = {
            deviceCount: devices.length,
            sampleDevices: devices.map((device: any) => {
              const dateFields: any = {};
              
              // Check all possible date field names
              const possibleDateFields = [
                'last_contact_time',
                'last_contact_time_epoch', 
                'last_contact_time_utc',
                'lastContactTime',
                'report_date',
                'report_date_epoch',
                'report_date_utc',
                'reportDate'
              ];
              
              possibleDateFields.forEach(field => {
                if (device[field] !== undefined) {
                  dateFields[field] = device[field];
                }
              });
              
              return {
                id: device.id,
                name: device.name,
                allKeys: Object.keys(device),
                dateFields: dateFields,
                rawDevice: device
              };
            })
          };
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(debugInfo, null, 2),
          };
          
          return { content: [content] };
        }

        case 'getAuthStatus': {
          GetAuthStatusSchema.parse(args);
          const status = jamfClient.getAuthStatus();

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(status, null, 2),
          };

          return { content: [content] };
        }

        case 'getDevicesBatch': {
          const { deviceIds, includeBasicOnly } = GetDevicesBatchSchema.parse(args);
          
          const devices = [];
          const errors = [];
          
          for (const deviceId of deviceIds) {
            try {
              const device = await jamfClient.getComputerDetails(deviceId);
              
              if (includeBasicOnly) {
                devices.push({
                  id: device.id?.toString(),
                  name: device.name || device.general?.name,
                  serialNumber: device.general?.serial_number || device.serialNumber,
                  lastContactTime: device.general?.last_contact_time || device.lastContactTime,
                  osVersion: device.hardware?.os_version || device.osVersion,
                  username: device.location?.username || device.username,
                });
              } else {
                devices.push(device);
              }
            } catch (error) {
              const errorContext = buildErrorContext(
                error,
                `Get device details: ${deviceId}`,
                'index-compat',
                { deviceId }
              );
              errors.push({
                deviceId,
                error: errorContext.message,
                code: errorContext.code,
              });
            }
          }
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              requested: deviceIds.length,
              successful: devices.length,
              failed: errors.length,
              devices,
              errors: errors.length > 0 ? errors : undefined,
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'listPolicies': {
          const { limit, category } = ListPoliciesSchema.parse(args);
          
          let policies = await jamfClient.listPolicies(limit);
          
          // Filter by category if provided
          if (category) {
            policies = policies.filter((p: any) => 
              p.category?.toLowerCase().includes(category.toLowerCase())
            );
          }
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              totalPolicies: policies.length,
              policies: policies.map((p: any) => ({
                id: p.id,
                name: p.name,
                category: p.category,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getPolicyDetails': {
          const { policyId, includeScriptContent, includeXml } = GetPolicyDetailsSchema.parse(args);
          
          const policyDetails = await jamfClient.getPolicyDetails(policyId);

          // Jamf Classic JSON is known to omit certain fields (notably Self Service categories).
          // Parse those from Classic XML so callers can reliably verify updates.
          let xmlText: string | null = null;
          try {
            xmlText = await (jamfClient as any).getPolicyXml(policyId);
          } catch (e) {
            xmlText = null;
          }
          const parsedFromXml = xmlText ? parsePolicySelfServiceFromXml(xmlText) : null;
          
          // If includeScriptContent is true, fetch full script details for each script
          if (includeScriptContent && policyDetails.scripts && policyDetails.scripts.length > 0) {
            for (let i = 0; i < policyDetails.scripts.length; i++) {
              const script = policyDetails.scripts[i];
              if (script.id) {
                try {
                  const scriptDetails = await jamfClient.getScriptDetails(script.id.toString());
                  policyDetails.scripts[i] = {
                    ...script,
                    scriptContent: scriptDetails.scriptContents || scriptDetails.script_contents,
                    fullDetails: scriptDetails,
                  };
                } catch (error) {
                  const errorContext = buildErrorContext(
                    error,
                    `Fetch script details: ${script.id}`,
                    'index-compat',
                    { scriptId: script.id }
                  );
                  logger.error('Failed to fetch script details', {
                    scriptId: script.id,
                    error: errorContext.message,
                    code: errorContext.code
                  });
                  policyDetails.scripts[i] = {
                    ...script,
                    scriptContentError: `Failed to fetch script content: ${errorContext.message}`,
                  };
                }
              }
            }
          }

          const result = {
            ...policyDetails,
            mcp: {
              ...(policyDetails.mcp && typeof policyDetails.mcp === 'object' ? policyDetails.mcp : {}),
              parsed_from_xml: parsedFromXml ?? undefined,
              policy_xml: includeXml ? xmlText ?? undefined : undefined,
              note:
                parsedFromXml
                  ? 'Self Service category fields are parsed from Classic policy XML for reliability.'
                  : 'Could not fetch/parse Classic policy XML; some fields may be missing from JSON.',
            },
          };
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          };

          return { content: [content] };
        }

        case 'getPolicyXml': {
          const { policyId, includeParsed } = GetPolicyXmlSchema.parse(args);
          const xml = await (jamfClient as any).getPolicyXml(policyId);
          const parsed = includeParsed ? parsePolicySelfServiceFromXml(xml) : undefined;
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({ policyId, parsed, xml }, null, 2),
          };
          return { content: [content] };
        }

        case 'searchPolicies': {
          const { query, limit } = SearchPoliciesSchema.parse(args);
          
          const policies = await jamfClient.searchPolicies(query, limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              query,
              totalResults: policies.length,
              policies,
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'executePolicy': {
          const { policyId, deviceIds, confirm } = ExecutePolicySchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Policy execution requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          await jamfClient.executePolicy(policyId, deviceIds);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully triggered policy ${policyId} on ${deviceIds.length} device(s)`,
          };

          return { content: [content] };
        }

        case 'deployScript': {
          const { scriptId, deviceIds, confirm } = DeployScriptSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Script deployment requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          try {
            await jamfClient.deployScript(scriptId, deviceIds);
            
            const content: TextContent = {
              type: 'text',
              text: `Successfully deployed script ${scriptId} to ${deviceIds.length} device(s)`,
            };

            return { content: [content] };
          } catch (error) {
            // Check if it's the not implemented error
            if (error instanceof Error && error.message.includes('not implemented for Classic API')) {
              const content: TextContent = {
                type: 'text',
                text: 'Script deployment is not available in the Classic API. Please use policies to deploy scripts instead.',
              };
              return { content: [content] };
            }
            // Log and re-throw with context
            logErrorWithContext(error, `Deploy script: ${scriptId}`, 'index-compat', { scriptId, deviceIds });
            throw error;
          }
        }

        case 'getScriptDetails': {
          const { scriptId } = GetScriptDetailsSchema.parse(args);
          const scriptDetails = await jamfClient.getScriptDetails(scriptId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(scriptDetails, null, 2),
          };

          return { content: [content] };
        }

        case 'listConfigurationProfiles': {
          const { type } = ListConfigurationProfilesSchema.parse(args);
          const profiles = await jamfClient.listConfigurationProfiles(type);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              type: type,
              count: profiles.length,
              profiles: profiles.map((p: any) => ({
                id: p.id,
                name: p.name || p.displayName,
                description: p.description,
                category: p.category?.name || p.category_name,
                level: p.level || p.distribution_method,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getConfigurationProfileDetails': {
          const { profileId, type } = GetConfigurationProfileDetailsSchema.parse(args);
          const profile = await jamfClient.getConfigurationProfileDetails(profileId, type);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(profile, null, 2),
          };

          return { content: [content] };
        }

        case 'searchConfigurationProfiles': {
          const { query, type } = SearchConfigurationProfilesSchema.parse(args);
          const profiles = await jamfClient.searchConfigurationProfiles(query, type);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              type: type,
              query: query,
              count: profiles.length,
              profiles: profiles.map((p: any) => ({
                id: p.id,
                name: p.name || p.displayName,
                description: p.description,
                category: p.category?.name || p.category_name,
                level: p.level || p.distribution_method,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'deployConfigurationProfile': {
          const { profileId, deviceIds, type, confirm } = DeployConfigurationProfileSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Configuration profile deployment requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          await jamfClient.deployConfigurationProfile(profileId, deviceIds, type);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully deployed ${type} configuration profile ${profileId} to ${deviceIds.length} device(s)`,
          };

          return { content: [content] };
        }

        case 'removeConfigurationProfile': {
          const { profileId, deviceIds, type, confirm } = RemoveConfigurationProfileSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Configuration profile removal requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          await jamfClient.removeConfigurationProfile(profileId, deviceIds, type);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully removed ${type} configuration profile ${profileId} from ${deviceIds.length} device(s)`,
          };

          return { content: [content] };
        }

        case 'listComputerGroups': {
          const { type } = ListComputerGroupsSchema.parse(args);
          const groups = await jamfClient.listComputerGroups(type);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              type: type,
              count: groups.length,
              groups: groups.map((g: any) => ({
                id: g.id,
                name: g.name,
                isSmart: g.is_smart ?? g.isSmart,
                memberCount: g.size || g.computers?.length || 0,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getComputerGroupDetails': {
          const { groupId } = GetComputerGroupDetailsSchema.parse(args);
          const group = await jamfClient.getComputerGroupDetails(groupId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              id: group.id,
              name: group.name,
              isSmart: group.is_smart ?? group.isSmart,
              memberCount: group.memberCount || group.computers?.length || 0,
              criteria: group.criteria,
              site: group.site,
              computers: group.computers?.map((c: any) => ({
                id: c.id,
                name: c.name,
                serialNumber: c.serial_number || c.serialNumber,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'searchComputerGroups': {
          const { query } = SearchComputerGroupsSchema.parse(args);
          const groups = await jamfClient.searchComputerGroups(query);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              query: query,
              count: groups.length,
              groups: groups.map((g: any) => ({
                id: g.id,
                name: g.name,
                isSmart: g.is_smart ?? g.isSmart,
                memberCount: g.size || g.computers?.length || 0,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getComputerGroupMembers': {
          const { groupId } = GetComputerGroupMembersSchema.parse(args);
          const members = await jamfClient.getComputerGroupMembers(groupId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              groupId: groupId,
              count: members.length,
              members: members.map((m: any) => ({
                id: m.id,
                name: m.name,
                serialNumber: m.serial_number || m.serialNumber,
                macAddress: m.mac_address || m.macAddress,
                username: m.username,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'createStaticComputerGroup': {
          const { name, computerIds, confirm } = CreateStaticComputerGroupSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Static computer group creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const group = await jamfClient.createStaticComputerGroup(name, computerIds);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: `Successfully created static computer group "${name}"`,
              group: {
                id: group.id,
                name: group.name,
                memberCount: computerIds.length,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'createSmartComputerGroup': {
          const { name, criteria, siteId, confirm } = CreateSmartComputerGroupSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Smart computer group creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const group = await jamfClient.createSmartComputerGroup(name, criteria, siteId);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: `Successfully created smart computer group "${name}"`,
              group: {
                id: group.id,
                name: group.name,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'updateStaticComputerGroup': {
          const { groupId, computerIds, confirm } = UpdateStaticComputerGroupSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Static computer group update requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const group = await jamfClient.updateStaticComputerGroup(groupId, computerIds);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: `Successfully updated static computer group ${groupId}`,
              group: {
                id: group.id,
                name: group.name,
                memberCount: computerIds.length,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'updateSmartComputerGroup': {
          const { groupId, updates, confirm } = UpdateSmartComputerGroupSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Smart computer group update requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const group = await jamfClient.updateSmartComputerGroup(groupId, updates);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: `Successfully updated smart computer group ${groupId}`,
              group: {
                id: group.id,
                name: group.name,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'deleteComputerGroup': {
          const { groupId, confirm } = DeleteComputerGroupSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Computer group deletion requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          await jamfClient.deleteComputerGroup(groupId);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully deleted computer group ${groupId}`,
          };

          return { content: [content] };
        }

        case 'createAdvancedComputerSearch': {
          const { searchData, confirm } = CreateAdvancedComputerSearchSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Advanced computer search creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const result = await jamfClient.createAdvancedComputerSearch(searchData);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: `Successfully created advanced computer search "${searchData.name}"`,
              search: {
                id: result.id,
                name: result.name,
                criteria: result.criteria,
                displayFields: result.display_fields,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'listAdvancedComputerSearches': {
          const { limit } = ListAdvancedComputerSearchesSchema.parse(args);
          const searches = await jamfClient.listAdvancedComputerSearches(limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              count: searches.length,
              searches: searches.map((s: any) => ({
                id: s.id,
                name: s.name,
                criteriaCount: s.criteria?.length || 0,
                displayFieldsCount: s.display_fields?.length || 0,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getAdvancedComputerSearchDetails': {
          const { searchId } = GetAdvancedComputerSearchDetailsSchema.parse(args);
          const searchDetails = await jamfClient.getAdvancedComputerSearchDetails(searchId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              id: searchDetails.id,
              name: searchDetails.name,
              criteria: searchDetails.criteria,
              displayFields: searchDetails.display_fields,
              site: searchDetails.site,
              sort: searchDetails.sort,
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'deleteAdvancedComputerSearch': {
          const { searchId, confirm } = DeleteAdvancedComputerSearchSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Advanced computer search deletion requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          await jamfClient.deleteAdvancedComputerSearch(searchId);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully deleted advanced computer search ${searchId}`,
          };

          return { content: [content] };
        }

        case 'searchMobileDevices': {
          const { query, limit } = SearchMobileDevicesSchema.parse(args);
          const devices = await jamfClient.searchMobileDevices(query, limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              count: devices.length,
              devices: devices.map((d: any) => ({
                id: d.id,
                name: d.name,
                serialNumber: d.serial_number || d.serialNumber,
                udid: d.udid,
                model: d.model || d.modelDisplay,
                osVersion: d.os_version || d.osVersion,
                batteryLevel: d.battery_level || d.batteryLevel,
                managed: d.managed,
                supervised: d.supervised,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getMobileDeviceDetails': {
          const { deviceId } = GetMobileDeviceDetailsSchema.parse(args);
          const device = await jamfClient.getMobileDeviceDetails(deviceId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              id: device.id,
              name: device.name || device.general?.name,
              udid: device.udid || device.general?.udid,
              serialNumber: device.serial_number || device.general?.serialNumber,
              model: device.model || device.hardware?.model,
              modelDisplay: device.model_display || device.hardware?.modelDisplay,
              osVersion: device.os_version || device.general?.osVersion,
              osType: device.os_type || device.general?.osType,
              batteryLevel: device.battery_level || device.general?.batteryLevel,
              deviceCapacity: device.device_capacity_mb || device.general?.deviceCapacityMb,
              availableCapacity: device.available_device_capacity_mb || device.general?.availableDeviceCapacityMb,
              managed: device.managed || device.general?.managed,
              supervised: device.supervised || device.general?.supervised,
              deviceOwnershipLevel: device.device_ownership_level || device.general?.deviceOwnershipLevel,
              lastInventoryUpdate: device.last_inventory_update || device.general?.lastInventoryUpdate,
              ipAddress: device.ip_address || device.general?.ipAddress,
              wifiMacAddress: device.wifi_mac_address || device.general?.wifiMacAddress,
              bluetoothMacAddress: device.bluetooth_mac_address || device.general?.bluetoothMacAddress,
              user: {
                username: device.location?.username || device.userAndLocation?.username,
                realName: device.location?.real_name || device.userAndLocation?.realName,
                email: device.location?.email_address || device.userAndLocation?.email,
                position: device.location?.position || device.userAndLocation?.position,
                phoneNumber: device.location?.phone_number || device.userAndLocation?.phoneNumber,
              },
              applications: device.applications?.length || 0,
              certificates: device.certificates?.length || 0,
              configurationProfiles: device.configuration_profiles?.length || 0,
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'listMobileDevices': {
          const { limit } = ListMobileDevicesSchema.parse(args);
          const devices = await jamfClient.listMobileDevices(limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              count: devices.length,
              devices: devices.map((d: any) => ({
                id: d.id,
                name: d.name,
                serialNumber: d.serial_number || d.serialNumber,
                udid: d.udid,
                model: d.model || d.modelDisplay,
                osVersion: d.os_version || d.osVersion,
                batteryLevel: d.battery_level || d.batteryLevel,
                managed: d.managed,
                supervised: d.supervised,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'updateMobileDeviceInventory': {
          const { deviceId } = UpdateMobileDeviceInventorySchema.parse(args);
          await jamfClient.updateMobileDeviceInventory(deviceId);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully triggered inventory update for mobile device ${deviceId}`,
          };

          return { content: [content] };
        }

        case 'sendMDMCommand': {
          const { deviceId, command, confirm } = SendMDMCommandSchema.parse(args);
          
          // Destructive commands require confirmation
          const destructiveCommands = ['EraseDevice', 'ClearPasscode', 'ClearRestrictionsPassword'];
          if (destructiveCommands.includes(command) && !confirm) {
            const content: TextContent = {
              type: 'text',
              text: `MDM command '${command}' is destructive and requires confirmation. Please set confirm: true to proceed.`,
            };
            return { content: [content] };
          }

          await jamfClient.sendMDMCommand(deviceId, command);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully sent MDM command '${command}' to mobile device ${deviceId}`,
          };

          return { content: [content] };
        }

        case 'listMobileDeviceGroups': {
          const { type } = ListMobileDeviceGroupsSchema.parse(args);
          const groups = await jamfClient.getMobileDeviceGroups(type);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              type: type,
              count: groups.length,
              groups: groups.map((g: any) => ({
                id: g.id,
                name: g.name,
                isSmart: g.is_smart ?? g.isSmart,
                memberCount: g.size || g.mobile_devices?.length || 0,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getMobileDeviceGroupDetails': {
          const { groupId } = GetMobileDeviceGroupDetailsSchema.parse(args);
          const group = await jamfClient.getMobileDeviceGroupDetails(groupId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              id: group.id,
              name: group.name,
              isSmart: group.is_smart ?? group.isSmart,
              memberCount: group.memberCount || group.mobile_devices?.length || 0,
              criteria: group.criteria,
              site: group.site,
              mobileDevices: group.mobile_devices?.map((d: any) => ({
                id: d.id,
                name: d.name,
                serialNumber: d.serial_number || d.serialNumber,
                udid: d.udid,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'listPackages': {
          const { limit } = ListPackagesSchema.parse(args);
          const packages = await jamfClient.listPackages(limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              count: packages.length,
              packages: packages.map((p: any) => ({
                id: p.id,
                name: p.name,
                category: p.category,
                filename: p.filename,
                size: p.size,
                priority: p.priority,
                fillUserTemplate: p.fill_user_template,
                fillExistingUsers: p.fill_existing_users,
                rebootRequired: p.reboot_required,
                osRequirements: p.os_requirements,
                requiredProcessor: p.required_processor,
                info: p.info,
                notes: p.notes,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'searchPackages': {
          const { query, limit } = SearchPackagesSchema.parse(args);
          const packages = await jamfClient.searchPackages(query, limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              query: query,
              count: packages.length,
              packages: packages.map((p: any) => ({
                id: p.id,
                name: p.name,
                category: p.category,
                filename: p.filename,
                size: p.size,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getPackageDetails': {
          const { packageId } = GetPackageDetailsSchema.parse(args);
          const packageDetails = await jamfClient.getPackageDetails(packageId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(packageDetails, null, 2),
          };

          return { content: [content] };
        }

        case 'getPackageDeploymentHistory': {
          const { packageId, limit } = GetPackageDeploymentHistorySchema.parse(args);
          const history = await jamfClient.getPackageDeploymentHistory(packageId, limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              packageId: packageId,
              deploymentCount: history.length,
              deployments: history.map((d: any) => ({
                date: d.date_completed_utc || d.date_completed,
                status: d.status,
                deviceName: d.computer_name || d.device_name,
                deviceId: d.computer_id || d.device_id,
                username: d.username,
                policyName: d.policy_name,
                policyId: d.policy_id,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'getPoliciesUsingPackage': {
          const { packageId } = GetPoliciesUsingPackageSchema.parse(args);
          const policies = await jamfClient.getPoliciesUsingPackage(packageId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              packageId: packageId,
              policyCount: policies.length,
              policies: policies.map((p: any) => ({
                id: p.id,
                name: p.name,
                category: p.category,
                enabled: p.enabled,
                frequency: p.frequency,
                targetDrive: p.target_drive,
                scope: {
                  allComputers: p.scope?.all_computers,
                  computerCount: p.scope?.computers?.length || 0,
                  groupCount: p.scope?.computer_groups?.length || 0,
                },
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'listPatchAvailableTitles': {
          const { sourceId, query, limit } = ListPatchAvailableTitlesSchema.parse(args);
          const raw = await jamfClient.listPatchAvailableTitles(sourceId);

          const toArray = (value: any): any[] =>
            Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];

          const candidates = [
            raw?.patch_available_titles?.available_titles?.available_title,
            raw?.patch_available_titles?.patch_available_title,
            raw?.available_titles?.available_title,
            raw?.patch_available_title,
            raw?.available_title,
            raw?.results,
            raw,
          ];

          const titleRows: any[] = (() => {
            for (const candidate of candidates) {
              const arr = toArray(candidate);
              if (arr.length > 0) return arr;
            }
            return [];
          })();

          const normalized = titleRows.map((row: any) => ({
            id: row?.id ?? row?.name_id ?? row?.softwareTitleId ?? row?.titleId ?? null,
            nameId: row?.name_id ?? row?.nameId ?? null,
            name: row?.app_name ?? row?.name ?? row?.displayName ?? row?.softwareTitle ?? row?.title ?? '',
            publisher: row?.publisher ?? row?.softwareTitlePublisher ?? '',
            currentVersion: row?.current_version ?? row?.currentVersion ?? row?.latestVersion ?? '',
            lastModified: row?.last_modified ?? row?.lastModified ?? '',
            raw: row,
          }));

          const q = (query ?? '').trim().toLowerCase();
          const filtered = q
            ? normalized.filter((t: any) =>
                String(t.name ?? '').toLowerCase().includes(q) ||
                String(t.publisher ?? '').toLowerCase().includes(q)
              )
            : normalized;

          const out = filtered.slice(0, limit).map((t: any) => ({
            id: t.id,
            nameId: t.nameId,
            name: t.name,
            publisher: t.publisher,
            currentVersion: t.currentVersion,
            lastModified: t.lastModified,
            raw: t.raw,
          }));

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              sourceId,
              query: query ?? '',
              sourceReportedSize: raw?.patch_available_titles?.size ?? null,
              total: filtered.length,
              returned: out.length,
              titles: out,
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'listPatchPolicies': {
          const { limit } = ListPatchPoliciesSchema.parse(args);
          const policies = await jamfClient.listPatchPolicies(limit);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(policies, null, 2),
          };

          return { content: [content] };
        }

        case 'getPatchPolicyLogs': {
          const { policyId, limit } = GetPatchPolicyLogsSchema.parse(args);
          const logs = await jamfClient.getPatchPolicyLogs(policyId, limit);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(logs, null, 2),
          };

          return { content: [content] };
        }

        case 'retryPatchPolicyLogs': {
          const { policyId, retryAll, payload, confirm } = RetryPatchPolicyLogsSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Patch policy log retry requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const result = await jamfClient.retryPatchPolicyLogs(policyId, retryAll, payload);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          };

          return { content: [content] };
        }

        case 'listPatchSoftwareTitleConfigurations': {
          const { limit } = ListPatchSoftwareTitleConfigurationsSchema.parse(args);
          const configurations = await jamfClient.listPatchSoftwareTitleConfigurations(limit);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(configurations, null, 2),
          };

          return { content: [content] };
        }

        case 'getPatchSoftwareTitleConfiguration': {
          const { configId } = GetPatchSoftwareTitleConfigurationSchema.parse(args);
          const configuration = await jamfClient.getPatchSoftwareTitleConfiguration(configId);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(configuration, null, 2),
          };

          return { content: [content] };
        }

        case 'getPatchSoftwareTitleConfigurationReport': {
          const { configId } = GetPatchSoftwareTitleConfigurationReportSchema.parse(args);
          const report = await jamfClient.getPatchSoftwareTitleConfigurationReport(configId);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(report, null, 2),
          };

          return { content: [content] };
        }

        case 'getPatchSoftwareTitleConfigurationSummary': {
          const { configId } = GetPatchSoftwareTitleConfigurationSummarySchema.parse(args);
          const summary = await jamfClient.getPatchSoftwareTitleConfigurationSummary(configId);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          };

          return { content: [content] };
        }

        case 'getPatchSoftwareTitleConfigurationVersionSummary': {
          const { configId } = GetPatchSoftwareTitleConfigurationVersionSummarySchema.parse(args);
          const summary = await jamfClient.getPatchSoftwareTitleConfigurationVersionSummary(configId);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          };

          return { content: [content] };
        }

        case 'getPatchSoftwareTitleConfigurationReportSummary': {
          const { configId, deviceNameContains, onlyOutdated, limit } =
            GetPatchSoftwareTitleConfigurationReportSummarySchema.parse(args);
          const report = await jamfClient.getPatchSoftwareTitleConfigurationReport(configId);

          const candidates =
            report?.results ??
            report?.items ??
            report?.computers ??
            report?.devices ??
            report?.patchReport ??
            report?.data ??
            [];

          const rows = Array.isArray(candidates) ? candidates : [];
          const nameFilter = (deviceNameContains ?? '').trim().toLowerCase();

          const normalizedRows = rows.map((row: any, index: number) => {
            const deviceName =
              row?.deviceName ??
              row?.computerName ??
              row?.name ??
              row?.computer_name ??
              row?.device_name ??
              row?.serialNumber ??
              `row-${index + 1}`;

            const rawStatus = String(
              row?.patchStatus ??
                row?.status ??
                row?.state ??
                row?.patch_state ??
                row?.patch_status ??
                ''
            ).trim();
            const status = rawStatus.toLowerCase();

            const patchedByStatus =
              status.includes('up-to-date') ||
              status.includes('patched') ||
              status.includes('latest') ||
              status === 'up_to_date';
            const outdatedByStatus =
              status.includes('outdated') ||
              status.includes('missing') ||
              status.includes('vulnerable') ||
              status.includes('needs');

            const patched = Boolean(row?.upToDate ?? row?.patched ?? patchedByStatus);
            const outdated = Boolean(row?.outdated ?? row?.needsPatch ?? (!patched && outdatedByStatus));

            return {
              deviceName: String(deviceName),
              status: rawStatus || (patched ? 'patched' : outdated ? 'outdated' : 'unknown'),
              patched,
              outdated,
              version:
                row?.installedVersion ??
                row?.version ??
                row?.currentVersion ??
                row?.softwareVersion ??
                row?.patchVersion ??
                'Unknown',
              raw: row,
            };
          });

          const filtered = normalizedRows
            .filter((r) => (nameFilter ? r.deviceName.toLowerCase().includes(nameFilter) : true))
            .filter((r) => (onlyOutdated ? r.outdated : true))
            .slice(0, limit);

          const byStatus = filtered.reduce((acc: Record<string, number>, r: any) => {
            const key = String(r.status || 'unknown');
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {});

          const byVersion = filtered.reduce((acc: Record<string, number>, r: any) => {
            const key = String(r.version || 'Unknown');
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {});

          const topVersions = Object.entries(byVersion)
            .map(([version, count]) => ({ version, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(
              {
                configId,
                filters: {
                  deviceNameContains: deviceNameContains ?? '',
                  onlyOutdated,
                  limit,
                },
                totals: {
                  sourceRows: rows.length,
                  matchedRows: filtered.length,
                  patched: filtered.filter((r) => r.patched).length,
                  outdated: filtered.filter((r) => r.outdated).length,
                  unknown: filtered.filter((r) => !r.patched && !r.outdated).length,
                },
                byStatus,
                topVersions,
                sample: filtered.slice(0, 20).map((r) => ({
                  deviceName: r.deviceName,
                  status: r.status,
                  patched: r.patched,
                  outdated: r.outdated,
                  version: r.version,
                })),
              },
              null,
              2
            ),
          };

          return { content: [content] };
        }

        case 'createPatchSoftwareTitleConfiguration': {
          const { config, confirm } = CreatePatchSoftwareTitleConfigurationSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Patch software title configuration creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const configuration = await jamfClient.createPatchSoftwareTitleConfiguration(config);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({ configuration }, null, 2),
          };

          return { content: [content] };
        }

        case 'updatePatchSoftwareTitleConfiguration': {
          const { configId, updates, confirm } = UpdatePatchSoftwareTitleConfigurationSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Patch software title configuration update requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const configuration = await jamfClient.updatePatchSoftwareTitleConfiguration(configId, updates);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({ configuration }, null, 2),
          };

          return { content: [content] };
        }

        case 'deletePatchSoftwareTitleConfiguration': {
          const { configId, confirm } = DeletePatchSoftwareTitleConfigurationSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Patch software title configuration deletion requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const result = await jamfClient.deletePatchSoftwareTitleConfiguration(configId);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({ deleted: true, configId, result }, null, 2),
          };

          return { content: [content] };
        }

        case 'getManagedSoftwareUpdatesAvailable': {
          GetManagedSoftwareUpdatesAvailableSchema.parse(args);
          const updates = await jamfClient.getManagedSoftwareUpdatesAvailable();

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(updates, null, 2),
          };

          return { content: [content] };
        }

        case 'getManagedSoftwareUpdatePlansFeatureToggle': {
          GetManagedSoftwareUpdatePlansFeatureToggleSchema.parse(args);
          const featureToggle = await jamfClient.getManagedSoftwareUpdatePlansFeatureToggle();

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(featureToggle, null, 2),
          };

          return { content: [content] };
        }

        case 'getManagedSoftwareUpdatePlansFeatureToggleStatus': {
          GetManagedSoftwareUpdatePlansFeatureToggleStatusSchema.parse(args);
          const featureToggleStatus = await jamfClient.getManagedSoftwareUpdatePlansFeatureToggleStatus();

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(featureToggleStatus, null, 2),
          };

          return { content: [content] };
        }

        case 'getManagedSoftwareUpdateStatuses': {
          const { limit } = GetManagedSoftwareUpdateStatusesSchema.parse(args);
          const statuses = await jamfClient.getManagedSoftwareUpdateStatuses(limit);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(statuses, null, 2),
          };

          return { content: [content] };
        }

        case 'listManagedSoftwareUpdatePlans': {
          const { limit } = ListManagedSoftwareUpdatePlansSchema.parse(args);
          const plans = await jamfClient.listManagedSoftwareUpdatePlans(limit);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(plans, null, 2),
          };

          return { content: [content] };
        }

        case 'getManagedSoftwareUpdatePlan': {
          const { planId } = GetManagedSoftwareUpdatePlanSchema.parse(args);
          const plan = await jamfClient.getManagedSoftwareUpdatePlan(planId);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(plan, null, 2),
          };

          return { content: [content] };
        }

        case 'createManagedSoftwareUpdatePlan': {
          const { plan, confirm } = CreateManagedSoftwareUpdatePlanSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Managed software update plan creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const created = await jamfClient.createManagedSoftwareUpdatePlan(plan);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({ plan: created }, null, 2),
          };

          return { content: [content] };
        }

        case 'createManagedSoftwareUpdatePlanForGroup': {
          const { plan, confirm } = CreateManagedSoftwareUpdatePlanForGroupSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Managed software update group plan creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const created = await jamfClient.createManagedSoftwareUpdatePlanForGroup(plan);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({ plan: created }, null, 2),
          };

          return { content: [content] };
        }

        case 'createPolicy': {
          const parsed = CreatePolicySchema.parse(args);
          const confirm = parsed.confirm;
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Policy creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const createdPolicy =
            'policyXml' in parsed
              ? await (jamfClient as any).createPolicyXml(parsed.policyXml)
              : await jamfClient.createPolicy((parsed as any).policyData);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: 'Policy created successfully',
              policy: {
                id: createdPolicy.id,
                name: createdPolicy.general?.name,
                enabled: createdPolicy.general?.enabled,
                trigger: createdPolicy.general?.trigger,
                frequency: createdPolicy.general?.frequency,
                category: createdPolicy.general?.category,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'createPolicyXml': {
          const { policyXml, confirm } = CreatePolicyXmlSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Policy creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const createdPolicy = await (jamfClient as any).createPolicyXml(policyXml);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(
              {
                message: 'Policy created successfully',
                policy: {
                  id: createdPolicy.id,
                  name: createdPolicy.general?.name,
                  enabled: createdPolicy.general?.enabled,
                  trigger: createdPolicy.general?.trigger,
                  frequency: createdPolicy.general?.frequency,
                  category: createdPolicy.general?.category,
                },
              },
              null,
              2
            ),
          };

          return { content: [content] };
        }

        case 'updatePolicy': {
          const parsed = UpdatePolicySchema.parse(args);
          const policyId = (parsed as any).policyId;
          const confirm = (parsed as any).confirm;
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Policy update requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          let updatedPolicy: any;
          try {
            updatedPolicy =
              'policyXml' in (parsed as any)
                ? await (jamfClient as any).updatePolicyXml(policyId, (parsed as any).policyXml)
                : await jamfClient.updatePolicy(policyId, (parsed as any).policyData);
          } catch (err: any) {
            const status = err?.response?.status;
            const responseData = err?.response?.data;
            if (status === 409) {
              const bodyText = typeof responseData === 'string' ? responseData : '';
              const isCategoryProblem = bodyText.toLowerCase().includes('problem with category');
              const content: TextContent = {
                type: 'text',
                text:
                  isCategoryProblem
                    ? `Jamf returned 409 Conflict while updating policy ${policyId}: "Problem with category". ` +
                      `This typically means the category you referenced does not exist or the payload shape is invalid for your Jamf Pro version. ` +
                      `Try using an existing Self Service category id (preferred) or create the category in the Jamf UI, then retry.`
                    : `Jamf returned 409 Conflict while updating policy ${policyId}. ` +
                      `This can mean the policy is locked for editing (open in the Jamf UI) OR there is a data conflict (Jamf sometimes reports those as 409). ` +
                      `Close any browser tabs editing that policy, wait ~30-120s, then retry. If it persists, inspect the response body in server logs (combined.log).`,
              };
              return { content: [content] };
            }
            throw err;
          }
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: 'Policy updated successfully',
              policy: {
                id: updatedPolicy.id,
                name: updatedPolicy.general?.name,
                enabled: updatedPolicy.general?.enabled,
                trigger: updatedPolicy.general?.trigger,
                frequency: updatedPolicy.general?.frequency,
                category: updatedPolicy.general?.category,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'updatePolicyXml': {
          const { policyId, policyXml, confirm } = UpdatePolicyXmlSchema.parse(args);

          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Policy update requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          let updatedPolicy: any;
          try {
            updatedPolicy = await (jamfClient as any).updatePolicyXml(policyId, policyXml);
          } catch (err: any) {
            const status = err?.response?.status;
            const responseData = err?.response?.data;
            if (status === 409) {
              const bodyText = typeof responseData === 'string' ? responseData : '';
              const isCategoryProblem = bodyText.toLowerCase().includes('problem with category');
              const content: TextContent = {
                type: 'text',
                text:
                  isCategoryProblem
                    ? `Jamf returned 409 Conflict while updating policy ${policyId}: "Problem with category". ` +
                      `This typically means the category you referenced does not exist or the payload shape is invalid for your Jamf Pro version. ` +
                      `Try using an existing Self Service category id (preferred) or create the category in the Jamf UI, then retry.`
                    : `Jamf returned 409 Conflict while updating policy ${policyId}. ` +
                      `This can mean the policy is locked for editing (open in the Jamf UI) OR there is a data conflict (Jamf sometimes reports those as 409). ` +
                      `Close any browser tabs editing that policy, wait ~30-120s, then retry. If it persists, inspect the response body in server logs (combined.log).`,
              };
              return { content: [content] };
            }
            throw err;
          }

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(
              {
                message: 'Policy updated successfully',
                policy: {
                  id: updatedPolicy.id,
                  name: updatedPolicy.general?.name,
                  enabled: updatedPolicy.general?.enabled,
                  trigger: updatedPolicy.general?.trigger,
                  frequency: updatedPolicy.general?.frequency,
                  category: updatedPolicy.general?.category,
                },
              },
              null,
              2
            ),
          };

          return { content: [content] };
        }

        case 'clonePolicy': {
          const { sourcePolicyId, newName, confirm } = ClonePolicySchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Policy cloning requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const clonedPolicy = await jamfClient.clonePolicy(sourcePolicyId, newName);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: 'Policy cloned successfully',
              originalPolicyId: sourcePolicyId,
              clonedPolicy: {
                id: clonedPolicy.id,
                name: clonedPolicy.general?.name || newName,
                enabled: clonedPolicy.general?.enabled,
                trigger: clonedPolicy.general?.trigger,
                frequency: clonedPolicy.general?.frequency,
                category: clonedPolicy.general?.category,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'setPolicyEnabled': {
          const { policyId, enabled, confirm } = SetPolicyEnabledSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: `${enabled ? 'Enabling' : 'Disabling'} policy requires confirmation. Please set confirm: true to proceed.`,
            };
            return { content: [content] };
          }

          const updatedPolicy = await jamfClient.setPolicyEnabled(policyId, enabled);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: `Policy ${enabled ? 'enabled' : 'disabled'} successfully`,
              policy: {
                id: updatedPolicy.id,
                name: updatedPolicy.general?.name,
                enabled: updatedPolicy.general?.enabled,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'updatePolicyScope': {
          const { policyId, scopeUpdates, confirm } = UpdatePolicyScopeSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Policy scope update requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const updatedPolicy = await jamfClient.updatePolicyScope(policyId, scopeUpdates);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: 'Policy scope updated successfully',
              policy: {
                id: updatedPolicy.id,
                name: updatedPolicy.general?.name,
                scope: {
                  all_computers: updatedPolicy.scope?.all_computers,
                  computerCount: updatedPolicy.scope?.computers?.length || 0,
                  computerGroupCount: updatedPolicy.scope?.computer_groups?.length || 0,
                  buildingCount: updatedPolicy.scope?.buildings?.length || 0,
                  departmentCount: updatedPolicy.scope?.departments?.length || 0,
                },
              },
              scopeUpdates: scopeUpdates,
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'listScripts': {
          const { limit } = ListScriptsSchema.parse(args);
          const scripts = await jamfClient.listScripts(limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              count: scripts.length,
              scripts: scripts.map((s: any) => ({
                id: s.id,
                name: s.name,
                category: s.category,
                filename: s.filename,
                priority: s.priority,
                info: s.info,
                notes: s.notes,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'searchScripts': {
          const { query, limit } = SearchScriptsSchema.parse(args);
          const scripts = await jamfClient.searchScripts(query, limit);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              query: query,
              count: scripts.length,
              scripts: scripts.map((s: any) => ({
                id: s.id,
                name: s.name,
                category: s.category,
                filename: s.filename,
                priority: s.priority,
                info: s.info,
              })),
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'createScript': {
          const { scriptData, confirm } = CreateScriptSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Script creation requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const createdScript = await jamfClient.createScript(scriptData);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: 'Script created successfully',
              script: {
                id: createdScript.id,
                name: createdScript.name,
                category: createdScript.category,
                filename: createdScript.filename,
                priority: createdScript.priority,
                info: createdScript.info,
                notes: createdScript.notes,
                parameters: createdScript.parameters,
                osRequirements: createdScript.osRequirements,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'updateScript': {
          const { scriptId, scriptData, confirm } = UpdateScriptSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Script update requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          const updatedScript = await jamfClient.updateScript(scriptId, scriptData);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify({
              message: 'Script updated successfully',
              script: {
                id: updatedScript.id,
                name: updatedScript.name,
                category: updatedScript.category,
                filename: updatedScript.filename,
                priority: updatedScript.priority,
                info: updatedScript.info,
                notes: updatedScript.notes,
                parameters: updatedScript.parameters,
                osRequirements: updatedScript.osRequirements,
              },
            }, null, 2),
          };

          return { content: [content] };
        }

        case 'deleteScript': {
          const { scriptId, confirm } = DeleteScriptSchema.parse(args);
          
          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: 'Script deletion requires confirmation. Please set confirm: true to proceed.',
            };
            return { content: [content] };
          }

          await jamfClient.deleteScript(scriptId);
          
          const content: TextContent = {
            type: 'text',
            text: `Successfully deleted script ${scriptId}`,
          };

          return { content: [content] };
        }

        // Reporting and Analytics Tools
        case 'getInventorySummary': {
          GetInventorySummarySchema.parse(args);
          const report = await jamfClient.getInventorySummary();
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(report, null, 2),
          };

          return { content: [content] };
        }

        case 'getPolicyComplianceReport': {
          const { policyId } = GetPolicyComplianceReportSchema.parse(args);
          const report = await jamfClient.getPolicyComplianceReport(policyId);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(report, null, 2),
          };

          return { content: [content] };
        }

        case 'getComputerPolicyLogs': {
          const { serialNumber, deviceId, limit, includeRaw } = GetComputerPolicyLogsSchema.parse(args);
          const raw = await jamfClient.getComputerPolicyLogs({ serialNumber, deviceId });

          // Jamf Classic API shapes vary by version/config; extract best-effort while keeping raw available.
          const candidate =
            raw?.computer_history?.policy_logs?.policy_log ??
            raw?.computer_history?.policy_logs ??
            raw?.policy_logs?.policy_log ??
            raw?.policy_logs ??
            null;

          const logs: any[] = Array.isArray(candidate) ? candidate : [];
          const limited = logs.slice(0, limit);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(
              {
                requested: {
                  serialNumber: serialNumber || undefined,
                  deviceId: deviceId || undefined,
                  limit,
                },
                total: logs.length,
                returned: limited.length,
                logs: limited,
                raw: includeRaw ? raw : undefined,
                note:
                  logs.length === 0
                    ? 'No policy log entries found in the parsed response shape. Try includeRaw:true to inspect the tenant-specific payload.'
                    : undefined,
              },
              null,
              2
            ),
          };

          return { content: [content] };
        }

        case 'listSelfServiceCategories': {
          const { query, limit } = ListSelfServiceCategoriesSchema.parse(args);
          const categories = await (jamfClient as any).listCategories();
          const q = (query ?? '').trim().toLowerCase();
          const filtered = q
            ? categories.filter((c: any) => String(c.name ?? '').toLowerCase().includes(q))
            : categories;
          const out = filtered.slice(0, limit);

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(
              {
                query: query ?? '',
                total: filtered.length,
                returned: out.length,
                categories: out,
              },
              null,
              2
            ),
          };

          return { content: [content] };
        }

	        case 'ensureSelfServiceCategoryExists': {
	          const { name, priority, confirm } = EnsureSelfServiceCategoryExistsSchema.parse(args);

	          const existing = await (jamfClient as any).getCategoryByName(name);
	          if (existing) {
            const content: TextContent = {
              type: 'text',
              text: JSON.stringify({ created: false, category: existing }, null, 2),
            };
	            return { content: [content] };
	          }

	          if (!confirm) {
            const content: TextContent = {
              type: 'text',
              text: `Category "${name}" does not exist yet. Creating it requires confirmation. Please re-run with confirm: true.`,
            };
	            return { content: [content] };
	          }

	          let ensured: any;
	          try {
	            ensured = await (jamfClient as any).ensureSelfServiceCategoryExists({ name, priority });
	          } catch (err: any) {
	            const status = err?.response?.status;
	            if (status === 401) {
	              const content: TextContent = {
	                type: 'text',
	                text:
	                  `Jamf returned 401 Unauthorized while creating category "${name}". ` +
	                  `The MCP server already auto-refreshes tokens; repeated "auth refresh" prompts won't fix this. ` +
	                  `This usually means the Jamf API credentials configured in the MCP server do not have permission to create Categories, ` +
	                  `or your tenant rejects Bearer tokens for Classic write endpoints (and JAMF_USERNAME/JAMF_PASSWORD are not configured). ` +
	                  `Next: run getAuthStatus to confirm hasBasicAuth/hasOAuth2, and ensure your API role allows creating Categories.`,
	              };
	              return { content: [content], isError: true };
	            }
	            throw err;
	          }
	          const content: TextContent = {
	            type: 'text',
	            text: JSON.stringify(ensured, null, 2),
	          };
	          return { content: [content] };
	        }

	        case 'createCategory': {
	          const { name, priority, confirm } = CreateCategorySchema.parse(args);

	          if (!confirm) {
	            const content: TextContent = {
	              type: 'text',
	              text: 'Category creation requires confirmation. Please set confirm: true to proceed.',
	            };
	            return { content: [content] };
	          }

	          let category: any;
	          try {
	            category = await (jamfClient as any).createCategory({ name, priority });
	          } catch (err: any) {
	            const status = err?.response?.status;
	            if (status === 401) {
	              const content: TextContent = {
	                type: 'text',
	                text:
	                  `Jamf returned 401 Unauthorized while creating category "${name}". ` +
	                  `The MCP server already auto-refreshes tokens; this is almost always a permissions/auth-mode issue, not a transient token expiry. ` +
	                  `Fix: ensure your OAuth client / Jamf user has rights to create Categories. If your tenant rejects Bearer on Classic writes, ` +
	                  `configure JAMF_USERNAME/JAMF_PASSWORD so the server can retry Classic writes with Basic auth.`,
	              };
	              return { content: [content], isError: true };
	            }
	            throw err;
	          }
	          const content: TextContent = {
	            type: 'text',
	            text: JSON.stringify({ category }, null, 2),
	          };
	          return { content: [content] };
	        }

	        case 'getPackageDeploymentStats': {
	          const { packageId } = GetPackageDeploymentStatsSchema.parse(args);
	          const stats = await jamfClient.getPackageDeploymentStats(packageId);
	          
	          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(stats, null, 2),
          };

          return { content: [content] };
        }

        case 'getSoftwareVersionReport': {
          const { softwareName } = GetSoftwareVersionReportSchema.parse(args);
          const report = await jamfClient.getSoftwareVersionReport(softwareName);
          
          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(report, null, 2),
          };

          return { content: [content] };
        }

        case 'getDeviceComplianceSummary': {
          GetDeviceComplianceSummarySchema.parse(args);
          const summary = await jamfClient.getDeviceComplianceSummary();

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          };

          return { content: [content] };
        }

        case 'documentJamfEnvironment': {
          const options = DocumentJamfEnvironmentSchema.parse(args);

          const documentationOptions: DocumentationOptions = {
            outputPath: options.outputPath || './jamf-documentation',
            formats: options.formats || ['markdown', 'json'],
            components: options.components || [
              'computers',
              'mobile-devices',
              'policies',
              'configuration-profiles',
              'scripts',
              'packages',
              'computer-groups',
              'mobile-device-groups',
            ],
            detailLevel: options.detailLevel || 'full',
            includeScriptContent: options.includeScriptContent !== false,
            includeProfilePayloads: options.includeProfilePayloads !== false,
          };

          const generator = new DocumentationGenerator(jamfClient);
          const documentation = await generator.generateDocumentation(documentationOptions);
          const progress = generator.getProgress();

          const content: TextContent = {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Documentation generated successfully for ${progress.completedComponents.length}/${progress.totalComponents} components`,
                overview: documentation.overview,
                progress: {
                  completedComponents: progress.completedComponents,
                  errors: progress.errors,
                  duration: progress.endTime && progress.startTime
                    ? progress.endTime.getTime() - progress.startTime.getTime()
                    : 0,
                },
                outputPath: documentationOptions.outputPath,
                formats: documentationOptions.formats,
              },
              null,
              2
            ),
          };

          return { content: [content] };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorContext = logErrorWithContext(
        error,
        `Execute tool: ${name}`,
        'index-compat',
        { toolName: name, args }
      );
      const content: TextContent = {
        type: 'text',
        text: `Error: ${errorContext.message}${errorContext.suggestions ? ` (${errorContext.suggestions[0]})` : ''}`,
      };
      return { content: [content], isError: true };
    }
  };

  return { listToolsHandler, callToolHandler };
}
