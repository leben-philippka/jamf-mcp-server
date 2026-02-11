import { describe, expect, test } from '@jest/globals';
import { parsePolicySelfServiceFromXml } from '../../utils/jamf-policy-xml.js';

describe('parsePolicySelfServiceFromXml', () => {
  test('extracts self_service_category and categories', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<policy>
  <self_service>
    <self_service_category>Apps löschen</self_service_category>
    <self_service_categories>
      <size>1</size>
      <category>
        <id>17</id>
        <name>Apps löschen</name>
        <display_in>true</display_in>
        <feature_in>false</feature_in>
      </category>
    </self_service_categories>
  </self_service>
</policy>`;

    const parsed = parsePolicySelfServiceFromXml(xml);
    expect(parsed.self_service_category).toBe('Apps löschen');
    expect(parsed.self_service_categories).toEqual([
      { id: 17, name: 'Apps löschen', display_in: true, feature_in: false },
    ]);
  });
});

