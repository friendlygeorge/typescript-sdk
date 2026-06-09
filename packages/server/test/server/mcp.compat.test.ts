import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, isStandardSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '../../src/index.js';
import type { InferRawShape } from '../../src/server/mcp.js';
import { completable } from '../../src/server/completable.js';

describe('registerTool/registerPrompt accept raw Zod shape (auto-wrapped)', () => {
    it('registerTool accepts a raw shape for inputSchema and auto-wraps it', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('a', { inputSchema: { x: z.number() } }, async ({ x }) => ({
            content: [{ type: 'text' as const, text: String(x) }]
        }));
        server.registerTool('b', { inputSchema: { y: z.number() } }, async ({ y }) => ({
            content: [{ type: 'text' as const, text: String(y) }]
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
        expect(Object.keys(tools)).toEqual(['a', 'b']);
        // raw shape was wrapped into a Standard Schema (z.object)
        expect(isStandardSchema(tools['a']?.inputSchema)).toBe(true);
    });

    it('registerTool accepts a raw shape for outputSchema and auto-wraps it', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('out', { inputSchema: { n: z.number() }, outputSchema: { result: z.string() } }, async ({ n }) => ({
            content: [{ type: 'text' as const, text: String(n) }],
            structuredContent: { result: String(n) }
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { outputSchema?: unknown }> })._registeredTools;
        expect(isStandardSchema(tools['out']?.outputSchema)).toBe(true);
    });

    it('registerTool with z.object() inputSchema also works (passthrough, no auto-wrap)', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('c', { inputSchema: z.object({ x: z.number() }) }, async ({ x }) => ({
            content: [{ type: 'text' as const, text: String(x) }]
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
        expect(isStandardSchema(tools['c']?.inputSchema)).toBe(true);
    });

    it('registerPrompt accepts a raw shape for argsSchema', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerPrompt('p', { argsSchema: { topic: z.string() } }, async ({ topic }) => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: topic } }]
        }));

        const prompts = (server as unknown as { _registeredPrompts: Record<string, { argsSchema?: unknown }> })._registeredPrompts;
        expect(Object.keys(prompts)).toContain('p');
        expect(isStandardSchema(prompts['p']?.argsSchema)).toBe(true);
    });

    it('registerPrompt raw shape accepts completable() fields (v1 pattern)', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerPrompt(
            'p',
            {
                argsSchema: {
                    language: completable(z.string(), v => ['typescript', 'python'].filter(l => l.startsWith(v)))
                }
            },
            async ({ language }) => ({
                messages: [{ role: 'user' as const, content: { type: 'text' as const, text: language } }]
            })
        );

        const prompts = (server as unknown as { _registeredPrompts: Record<string, { argsSchema?: unknown }> })._registeredPrompts;
        expect(isStandardSchema(prompts['p']?.argsSchema)).toBe(true);
    });

    it('callback receives validated, typed args end-to-end via tools/call', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        let received: { x: number } | undefined;
        server.registerTool('echo', { inputSchema: { x: z.number() } }, async args => {
            received = args;
            return { content: [{ type: 'text' as const, text: String(args.x) }] };
        });

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
        await client.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'echo', arguments: { x: 7 } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        expect(received).toEqual({ x: 7 });
        const result = responses.find(r => 'id' in r && r.id === 2) as { result?: { content: Array<{ text: string }> } };
        expect(result.result?.content[0]?.text).toBe('7');

        await server.close();
    });
});

describe('InferRawShape', () => {
    it('preserves optionality from .optional() as ?: keys', () => {
        type S = InferRawShape<{ a: z.ZodString; b: z.ZodOptional<z.ZodString> }>;
        expectTypeOf<S>().toEqualTypeOf<{ a: string; b?: string | undefined }>();
    });
});

describe('onInputValidationError', () => {
    it('fires callback when input validation fails', async () => {
        const violations: Array<{ toolName: string; error: string }> = [];
        const server = new McpServer(
            { name: 't', version: '1.0.0' },
            {
                onInputValidationError: ({ toolName, error }) => {
                    violations.push({ toolName, error });
                }
            }
        );

        server.registerTool('greet', { inputSchema: { name: z.string() } }, async ({ name }) => ({
            content: [{ type: 'text' as const, text: `Hello ${name}` }]
        }));

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        // Initialize
        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

        // Call with invalid input (number instead of string)
        await client.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'greet', arguments: { name: 42 } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        // Callback should have been fired
        expect(violations).toHaveLength(1);
        const violation = violations[0]!;
        expect(violation.toolName).toBe('greet');
        expect(violation.error).toContain('Input validation error');

        // Error should still be returned to client
        const result = responses.find(r => 'id' in r && r.id === 2) as { result?: { isError: boolean } };
        expect(result.result?.isError).toBe(true);

        await server.close();
    });

    it('does not fire callback when input is valid', async () => {
        const violations: Array<{ toolName: string }> = [];
        const server = new McpServer(
            { name: 't', version: '1.0.0' },
            {
                onInputValidationError: ({ toolName }) => {
                    violations.push({ toolName });
                }
            }
        );

        server.registerTool('greet', { inputSchema: { name: z.string() } }, async ({ name }) => ({
            content: [{ type: 'text' as const, text: `Hello ${name}` }]
        }));

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

        // Call with valid input
        await client.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'greet', arguments: { name: 'world' } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        // Callback should NOT have been fired
        expect(violations).toHaveLength(0);

        await server.close();
    });

    it('does not fire callback for non-validation errors (e.g. handler throw)', async () => {
        const violations: Array<{ toolName: string }> = [];
        const server = new McpServer(
            { name: 't', version: '1.0.0' },
            {
                onInputValidationError: ({ toolName }) => {
                    violations.push({ toolName });
                }
            }
        );

        server.registerTool('crash', { inputSchema: { x: z.number() } }, async () => {
            throw new Error('handler exploded');
        });

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

        // Valid input, but handler throws
        await client.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'crash', arguments: { x: 1 } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        // Callback should NOT fire for handler errors
        expect(violations).toHaveLength(0);

        await server.close();
    });

    it('supports async callbacks', async () => {
        const violations: string[] = [];
        const server = new McpServer(
            { name: 't', version: '1.0.0' },
            {
                onInputValidationError: async ({ toolName }) => {
                    // Simulate async work (e.g. writing to a log file)
                    await new Promise(resolve => setTimeout(resolve, 10));
                    violations.push(toolName);
                }
            }
        );

        server.registerTool('greet', { inputSchema: { name: z.string() } }, async ({ name }) => ({
            content: [{ type: 'text' as const, text: `Hello ${name}` }]
        }));

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

        await client.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'greet', arguments: { name: 42 } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        // Async callback should have completed before response was sent
        expect(violations).toEqual(['greet']);

        await server.close();
    });
});
