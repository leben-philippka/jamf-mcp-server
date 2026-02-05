# Modern-First Jamf API Preference Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure all Jamf MCP tools prefer Jamf Pro API (Modern) endpoints first, with Classic API as fallback only when Modern fails or is unavailable.

**Architecture:** Update `JamfApiClientHybrid` methods to use Modern API endpoints before Classic, add payload mappers for Modern schemas, and keep Classic as a fallback path. Add focused unit tests that assert Modern-first behavior for create/update/list flows, plus explicit fallback tests.

**Tech Stack:** TypeScript (ESM), Axios, Jest (ts-jest)

---

### Task 1: Smart Computer Groups use Modern API first

**Files:**
- Modify: `src/jamf-client-hybrid.ts`
- Test: `src/__tests__/jamf-client-hybrid-groups-packages.test.ts`

**Step 1: Write the failing tests**

Add tests that assert Modern endpoints are called before Classic.

```ts
test('createSmartComputerGroup prefers Modern API smart-groups endpoint', async () => {
  const client = createClient();
  const criteria = [{ name: 'Last Check-in', priority: 0, and_or: 'and', search_type: 'more than x days ago', value: '30' }];

  mockAxiosInstance.post.mockResolvedValue({ data: { id: '101' } });
  jestGlobals.spyOn(client, 'getComputerGroupDetails')
    .mockResolvedValue({ id: '101', name: 'Smart Group', is_smart: true });

  await client.createSmartComputerGroup('Smart Group', criteria);

  expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v2/computer-groups/smart-groups');
});

test('createSmartComputerGroup falls back to Classic API when Modern fails', async () => {
  const client = createClient();
  const criteria = [{ name: 'Last Check-in', priority: 0, and_or: 'and', search_type: 'more than x days ago', value: '30' }];

  mockAxiosInstance.post
    .mockRejectedValueOnce(new Error('Modern create failed'))
    .mockResolvedValueOnce({ data: { id: '99' } });

  jestGlobals.spyOn(client, 'getComputerGroupDetails')
    .mockResolvedValue({ id: '99', name: 'Fallback Group', is_smart: true });

  await client.createSmartComputerGroup('Fallback Group', criteria);

  expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v2/computer-groups/smart-groups');
  expect(mockAxiosInstance.post.mock.calls[1][0]).toBe('/JSSResource/computergroups/id/0');
});

test('updateSmartComputerGroup prefers Modern API smart-groups endpoint', async () => {
  const client = createClient();
  const criteria = [{ name: 'Last Check-in', priority: 0, and_or: 'and', search_type: 'more than x days ago', value: '30' }];

  jestGlobals.spyOn(client, 'getComputerGroupDetails')
    .mockResolvedValue({ id: '123', name: 'Smart Group', is_smart: true, criteria });

  mockAxiosInstance.put.mockResolvedValue({ data: { id: '123' } });

  await client.updateSmartComputerGroup('123', { name: 'Updated Group', criteria });

  expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v2/computer-groups/smart-groups/123');
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/__tests__/jamf-client-hybrid-groups-packages.test.ts`
Expected: FAIL, endpoints still Classic-only.

**Step 3: Implement Modern-first smart group calls**

Update `createSmartComputerGroup` and `updateSmartComputerGroup` to:

```ts
const modernPayload = this.buildModernSmartGroupPayload(name, criteria, siteId);
const response = await this.axiosInstance.post('/api/v2/computer-groups/smart-groups', modernPayload);
```

And for update:

```ts
const modernPayload = this.buildModernSmartGroupPayload(newName, newCriteria, updates.siteId);
await this.axiosInstance.put(`/api/v2/computer-groups/smart-groups/${groupId}`, modernPayload);
```

Keep Classic XML as fallback.

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/__tests__/jamf-client-hybrid-groups-packages.test.ts`
Expected: PASS.

---

### Task 2: Static Computer Groups use Modern API first

**Files:**
- Modify: `src/jamf-client-hybrid.ts`
- Test: `src/__tests__/jamf-client-hybrid-groups-packages.test.ts`

**Step 1: Write the failing tests**

```ts
test('createStaticComputerGroup prefers Modern API static-groups endpoint', async () => {
  const client = createClient();
  mockAxiosInstance.post.mockResolvedValue({ data: { id: '200' } });
  jestGlobals.spyOn(client, 'getComputerGroupDetails')
    .mockResolvedValue({ id: '200', name: 'Static Group', is_smart: false });

  await client.createStaticComputerGroup('Static Group', ['10', '20']);

  expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v2/computer-groups/static-groups');
  expect(mockAxiosInstance.post.mock.calls[0][1]).toEqual({
    name: 'Static Group',
    computerIds: [10, 20],
  });
});

test('updateStaticComputerGroup prefers Modern API static-groups endpoint', async () => {
  const client = createClient();
  jestGlobals.spyOn(client, 'getComputerGroupDetails')
    .mockResolvedValue({ id: '200', name: 'Static Group', is_smart: false, computers: [] });

  mockAxiosInstance.put.mockResolvedValue({ data: { id: '200' } });
  await client.updateStaticComputerGroup('200', ['10']);

  expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v2/computer-groups/static-groups/200');
  expect(mockAxiosInstance.put.mock.calls[0][1]).toEqual({
    computerIds: [10],
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/__tests__/jamf-client-hybrid-groups-packages.test.ts`
Expected: FAIL, still Classic-only.

**Step 3: Implement Modern-first static group calls**

Add helper:

```ts
private buildModernStaticGroupPayload(name: string, computerIds: string[]): { name: string; computerIds: number[] } {
  return {
    name,
    computerIds: computerIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id)),
  };
}
```

Use in `createStaticComputerGroup` and `updateStaticComputerGroup` with Modern endpoints:

```ts
await this.axiosInstance.post('/api/v2/computer-groups/static-groups', payload);
await this.axiosInstance.put(`/api/v2/computer-groups/static-groups/${groupId}`, { computerIds: payload.computerIds });
```

Keep Classic XML fallback for both.

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/__tests__/jamf-client-hybrid-groups-packages.test.ts`
Expected: PASS.

---

### Task 3: Scripts use Modern API first

**Files:**
- Modify: `src/jamf-client-hybrid.ts`
- Test: `src/__tests__/jamf-client-hybrid-scripts.test.ts`

**Step 1: Write failing tests**

Create `src/__tests__/jamf-client-hybrid-scripts.test.ts` with Modern-first assertions:

```ts
test('listScripts prefers Modern API', async () => {
  const client = createClient();
  mockAxiosInstance.get.mockResolvedValue({ data: { results: [{ id: '1', name: 'Script A' }] } });

  const scripts = await client.listScripts(10);

  expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/scripts');
  expect(scripts).toHaveLength(1);
});

test('createScript prefers Modern API', async () => {
  const client = createClient();
  mockAxiosInstance.post.mockResolvedValue({ data: { id: '10' } });

  await client.createScript({ name: 'Script A', script_contents: 'echo ok' });

  expect(mockAxiosInstance.post.mock.calls[0][0]).toBe('/api/v1/scripts');
});

test('updateScript prefers Modern API', async () => {
  const client = createClient();
  mockAxiosInstance.put.mockResolvedValue({ data: { id: '10' } });

  await client.updateScript('10', { name: 'Script A' });

  expect(mockAxiosInstance.put.mock.calls[0][0]).toBe('/api/v1/scripts/10');
});

test('deleteScript prefers Modern API', async () => {
  const client = createClient();
  mockAxiosInstance.delete.mockResolvedValue({ data: {} });

  await client.deleteScript('10');

  expect(mockAxiosInstance.delete.mock.calls[0][0]).toBe('/api/v1/scripts/10');
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/__tests__/jamf-client-hybrid-scripts.test.ts`
Expected: FAIL, Classic-only paths.

**Step 3: Implement Modern-first script calls**

Update methods to try Modern before Classic:

```ts
const modernPayload = {
  name: scriptData.name,
  category: scriptData.category,
  info: scriptData.info,
  notes: scriptData.notes,
  priority: scriptData.priority,
  scriptContents: scriptData.script_contents,
  scriptContentsEncoded: scriptData.script_contents_encoded,
  parameters: scriptData.parameters,
  osRequirements: scriptData.os_requirements,
};

await this.axiosInstance.post('/api/v1/scripts', modernPayload);
```

For update/delete, use `/api/v1/scripts/${scriptId}` with fallback to Classic XML.

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/__tests__/jamf-client-hybrid-scripts.test.ts`
Expected: PASS.

---

### Task 4: Packages use Modern API first

**Files:**
- Modify: `src/jamf-client-hybrid.ts`
- Test: `src/__tests__/jamf-client-hybrid-groups-packages.test.ts`

**Step 1: Write failing tests**

```ts
test('listPackages prefers Modern API', async () => {
  const client = createClient();
  mockAxiosInstance.get.mockResolvedValue({ data: { results: [{ id: '1', name: 'Pkg' }] } });

  const packages = await client.listPackages(10);

  expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/packages');
  expect(packages).toHaveLength(1);
});

test('getPackageDetails prefers Modern API', async () => {
  const client = createClient();
  mockAxiosInstance.get.mockResolvedValue({ data: { id: '1', name: 'Pkg' } });

  await client.getPackageDetails('1');

  expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/api/v1/packages/1');
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/__tests__/jamf-client-hybrid-groups-packages.test.ts`
Expected: FAIL, Classic-only paths.

**Step 3: Implement Modern-first packages**

Use Modern API endpoints first:

```ts
const response = await this.axiosInstance.get('/api/v1/packages', { params: { 'page-size': limit } });
return response.data?.results || response.data?.packages || [];
```

For details:

```ts
const response = await this.axiosInstance.get(`/api/v1/packages/${packageId}`);
return response.data;
```

Fallback to Classic on failure.

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/__tests__/jamf-client-hybrid-groups-packages.test.ts`
Expected: PASS.

---

### Task 5: Documentation update

**Files:**
- Modify: `docs/API_AUTHENTICATION.md`

**Step 1: Update docs**

Add a note that scripts, packages, and computer groups now attempt Modern API first (Jamf Pro API v1/v2), then Classic fallback for legacy/unsupported servers.

**Step 2: No tests required**

---

### Task 6: Final verification

**Step 1: Run focused tests**

Run:

```bash
npm test -- src/__tests__/jamf-client-hybrid-groups-packages.test.ts
npm test -- src/__tests__/jamf-client-hybrid-scripts.test.ts
```

Expected: PASS.

**Step 2: (Optional) Full test suite**

Run: `npm test`
Expected: PASS (if baseline issue is resolved).
