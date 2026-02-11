import { describe, expect, test, jest } from '@jest/globals';

const { registerAllTools } = await import('../tools/register-all-tools.js');
const { SkillsManager } = await import('../skills/manager.js');
const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

type JsonSchema = Record<string, any>;

function findArraySchemasMissingItems(schema: any, path: string, out: string[]): void {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type === 'array') {
    if (!('items' in schema) || schema.items === undefined) {
      out.push(path);
    } else {
      findArraySchemasMissingItems(schema.items, `${path}.items`, out);
    }
  }

  const combinators = ['anyOf', 'oneOf', 'allOf'] as const;
  for (const key of combinators) {
    if (Array.isArray(schema[key])) {
      schema[key].forEach((sub: any, i: number) =>
        findArraySchemasMissingItems(sub, `${path}.${key}[${i}]`, out)
      );
    }
  }

  if (schema.type === 'object' || schema.properties || schema.additionalProperties) {
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [prop, subSchema] of Object.entries(schema.properties)) {
        findArraySchemasMissingItems(subSchema, `${path}.properties.${prop}`, out);
      }
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      findArraySchemasMissingItems(schema.additionalProperties, `${path}.additionalProperties`, out);
    }
  }
}

describe('tool schemas', () => {
  test('no tool advertises an array schema without items', async () => {
    const handlers = new Map<any, any>();
    const server = {
      setRequestHandler: jest.fn((schema: any, handler: any) => {
        handlers.set(schema, handler);
      }),
    } as any;

    const skillsManager = new SkillsManager();
    const jamfClient = {} as any;
    registerAllTools(server, skillsManager, jamfClient);

    const listHandler = handlers.get(ListToolsRequestSchema);
    expect(listHandler).toBeDefined();

    const { tools } = await listHandler({} as any);
    expect(Array.isArray(tools)).toBe(true);

    const missing: string[] = [];
    for (const tool of tools as any[]) {
      const inputSchema = tool?.inputSchema as JsonSchema | undefined;
      if (!inputSchema) continue;
      findArraySchemasMissingItems(inputSchema, `${tool.name}.inputSchema`, missing);
    }

    expect(missing).toEqual([]);
  });
});

