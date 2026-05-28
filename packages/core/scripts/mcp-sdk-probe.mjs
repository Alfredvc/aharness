// SDK API verification probe for @modelcontextprotocol/sdk@^1.29.0.
//
// Kept in-tree as documentation; not part of @aharness/core's exports.
// Re-run by hand from a scratch directory (e.g. /tmp/mcp-probe) that has
// `@modelcontextprotocol/sdk` and `zod` installed if you want to re-verify
// the three claims pinned in
// docs/plans/2026-05-04-mcp-submit-route/sdk-probe-result.md:
//
//   1. The exact attribute path that exposes `_meta` to a tool handler.
//   2. Whether `McpServer.registerTool({inputSchema})` accepts a JSON Schema
//      object or requires a Zod `RawShape`.
//   3. Whether `McpServer` exposes `registerListResources` /
//      `registerListPrompts` shortcuts.
//
// Reproduce (Node ESM resolves bare imports relative to the script file, not
// cwd, so copy the script in next to its deps before running):
//
//   mkdir -p /tmp/mcp-probe && cd /tmp/mcp-probe
//   npm init -y >/dev/null
//   npm install @modelcontextprotocol/sdk@^1.29.0 zod
//   cp /path/to/aharness/packages/core/scripts/mcp-sdk-probe.mjs ./probe.mjs
//   node probe.mjs

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

// === Path A: lower-level Server + setRequestHandler ===
const lowServer = new Server(
  { name: 'aharness_fsm', version: '0.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);
lowServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'submit',
      description: 'probe',
      inputSchema: {
        type: 'object',
        required: ['state', 'exit', 'data'],
        properties: { state: { type: 'string' }, exit: { type: 'string' }, data: {} },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ],
}));
lowServer.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
lowServer.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
let lowSeenMeta;
lowServer.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  // Probe every plausible access path:
  lowSeenMeta = {
    'req.params._meta': req.params?._meta,
    'req._meta': req._meta,
    'extra._meta': extra?._meta,
    'extra.requestInfo._meta': extra?.requestInfo?._meta,
    'extra.mcpReq._meta': extra?.mcpReq?._meta,
  };
  return { content: [{ type: 'text', text: 'ok' }] };
});

// === Path B: McpServer.registerTool ===
const high = new McpServer({ name: 'aharness_fsm', version: '0.0.0' });
let highSeenMeta;
let highRegisterErrored = null;
try {
  high.registerTool(
    'submit',
    {
      description: 'probe',
      inputSchema: { state: z.string(), exit: z.string(), data: z.unknown() },
    },
    async (args, extra) => {
      highSeenMeta = {
        'extra._meta': extra?._meta,
        'extra.requestInfo._meta': extra?.requestInfo?._meta,
        'extra.mcpReq._meta': extra?.mcpReq?._meta,
      };
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  );
} catch (e) {
  highRegisterErrored = e.message;
}

// Try BAD shape: passing JSON Schema literal where ZodRawShape is expected
let badShapeErr = null;
try {
  high.registerTool(
    'bad',
    { description: 'x', inputSchema: { type: 'object', properties: {} } },
    async () => ({ content: [] }),
  );
} catch (e) {
  badShapeErr = e.message;
}

// Drive a call against Path A
{
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'p', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([lowServer.connect(a), client.connect(b)]);
  await client.callTool({
    name: 'submit',
    arguments: { state: 's', exit: 'e', data: {} },
    _meta: { threadId: 'T_LOW' },
  });
  console.log('Path A (Server + setRequestHandler):', JSON.stringify(lowSeenMeta, null, 2));
  await client.close();
}

if (!highRegisterErrored) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'p', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([high.connect(a), client.connect(b)]);
  await client.callTool({
    name: 'submit',
    arguments: { state: 's', exit: 'e', data: {} },
    _meta: { threadId: 'T_HIGH' },
  });
  console.log('Path B (McpServer.registerTool):', JSON.stringify(highSeenMeta, null, 2));
  await client.close();
} else {
  console.log('Path B FAILED to register:', highRegisterErrored);
}
console.log('JSON-Schema-as-shape check:', badShapeErr ?? 'accepted');

// Probe McpServer for shortcut methods
console.log('McpServer.registerListResources?', typeof high.registerListResources);
console.log('McpServer.registerListPrompts?', typeof high.registerListPrompts);
