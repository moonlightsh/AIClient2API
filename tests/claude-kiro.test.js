import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const mockRequest = jest.fn();
let KiroApiService;

jest.mock('axios', () => ({
    __esModule: true,
    default: {
        create: jest.fn(() => ({
            request: mockRequest
        }))
    }
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    __esModule: true,
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/services/service-manager.js', () => ({
    __esModule: true,
    getProviderPoolManager: jest.fn(() => null)
}));

describe('KiroApiService runtime endpoint', () => {
    let tempDir;
    let credsFilePath;

    beforeAll(async () => {
        ({ KiroApiService } = await import('../src/providers/claude/claude-kiro.js'));
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-provider-test-'));
        credsFilePath = path.join(tempDir, 'kiro-auth-token.json');
        await fs.writeFile(credsFilePath, JSON.stringify({
            accessToken: 'test-access-token',
            refreshToken: 'test-refresh-token',
            authMethod: 'builder-id',
            region: 'eu-central-1',
            idcRegion: 'eu-central-1',
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/test'
        }));
    });

    afterAll(async () => {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        mockRequest.mockReset();
    });

    function createService(config = {}) {
        return new KiroApiService({
            KIRO_OAUTH_CREDS_FILE_PATH: credsFilePath,
            ...config
        });
    }

    test('posts generateAssistantResponse to runtime region endpoint by default', async () => {
        mockRequest.mockResolvedValue({ data: '' });
        const service = createService();

        await service.callApi('POST', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        expect(mockRequest).toHaveBeenCalledTimes(1);
        const axiosConfig = mockRequest.mock.calls[0][0];
        expect(axiosConfig.url).toBe('https://runtime.eu-central-1.kiro.dev/generateAssistantResponse');
        expect(JSON.parse(axiosConfig.data).profileArn).toBe('arn:aws:codewhisperer:eu-central-1:123456789012:profile/test');
    });

    test('posts generateAssistantResponse with Kiro gateway-compatible headers', async () => {
        mockRequest.mockResolvedValue({ data: '' });
        const service = createService();

        await service.callApi('POST', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        const axiosConfig = mockRequest.mock.calls[0][0];
        expect(Object.keys(axiosConfig.headers)).toEqual([
            'Host',
            'Accept',
            'Accept-Encoding',
            'Authorization',
            'Content-Type',
            'x-amz-target',
            'User-Agent',
            'x-amz-user-agent',
            'x-amzn-codewhisperer-optout',
            'x-amzn-kiro-agent-mode',
            'amz-sdk-invocation-id',
            'amz-sdk-request',
            'Connection'
        ]);
        expect(axiosConfig.headers['Host']).toBe('runtime.eu-central-1.kiro.dev');
        expect(axiosConfig.headers['Accept']).toBe('*/*');
        expect(axiosConfig.headers['Accept-Encoding']).toBe('gzip, deflate');
        expect(axiosConfig.headers['Content-Type']).toBe('application/x-amz-json-1.0');
        expect(axiosConfig.headers['x-amz-target']).toBe('AmazonCodeWhispererStreamingService.GenerateAssistantResponse');
        expect(axiosConfig.headers['User-Agent']).toContain('aws-sdk-js/1.0.27 ua/2.1 os/win32#10.0.19044');
        expect(axiosConfig.headers['User-Agent']).toContain('md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27');
        expect(axiosConfig.headers['x-amz-user-agent']).toContain('aws-sdk-js/1.0.27 KiroIDE-0.7.45-');
    });

    test('uses custom host-style KIRO_BASE_URL with generateAssistantResponse path', async () => {
        mockRequest.mockResolvedValue({ data: '' });
        const service = createService({
            KIRO_BASE_URL: 'https://runtime.us-east-1.kiro.dev'
        });

        await service.callApi('POST', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        const axiosConfig = mockRequest.mock.calls[0][0];
        expect(axiosConfig.url).toBe('https://runtime.us-east-1.kiro.dev/generateAssistantResponse');
    });

    test('queries usage limits through runtime getUsageLimits endpoint', async () => {
        mockRequest.mockResolvedValue({ data: { resourceType: 'AGENTIC_REQUEST' } });
        const service = createService();

        await service.getUsageLimits();

        const axiosConfig = mockRequest.mock.calls[0][0];
        expect(axiosConfig.method).toBe('get');
        expect(axiosConfig.url).toContain('https://runtime.eu-central-1.kiro.dev/getUsageLimits?');
        expect(axiosConfig.url).toContain('profileArn=arn%3Aaws%3Acodewhisperer%3Aeu-central-1%3A123456789012%3Aprofile%2Ftest');
    });

    test('builds runtime payload without legacy agentTaskType or placeholder tools', async () => {
        const service = createService();
        service.profileArn = 'arn:aws:test';

        const payload = await service.buildCodewhispererRequest([
            { role: 'user', content: 'Hello' }
        ], 'claude-sonnet-4-5');

        expect(payload.conversationState).not.toHaveProperty('agentTaskType');
        const currentMessage = payload.conversationState.currentMessage.userInputMessage;
        expect(currentMessage.userInputMessageContext?.tools).toBeUndefined();
        expect(JSON.stringify(payload)).not.toContain('no_tool_available');
    });

    test('converts tool content to text when tools are not defined', async () => {
        const service = createService();

        const payload = await service.buildCodewhispererRequest([
            { role: 'user', content: 'Read the file' },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'call_123',
                        name: 'read_file',
                        input: { path: 'test.py' }
                    }
                ]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'call_123',
                        content: 'print("hello")'
                    }
                ]
            },
            { role: 'user', content: 'Summarize' }
        ], 'claude-sonnet-4-5', null);

        const serialized = JSON.stringify(payload);
        expect(serialized).toContain('[Tool: read_file (call_123)]');
        expect(serialized).toContain('[Tool Result (call_123)]');
        expect(serialized).not.toContain('"toolUses"');
        expect(serialized).not.toContain('"toolResults"');
        expect(serialized).not.toContain('no_tool_available');
    });

    test('converts OpenAI tool_calls and tool messages to text when tools are not defined', async () => {
        const service = createService();

        const payload = await service.buildCodewhispererRequest([
            { role: 'user', content: 'Read the file' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_openai',
                    type: 'function',
                    function: {
                        name: 'read_file',
                        arguments: '{"path":"index.js"}'
                    }
                }]
            },
            {
                role: 'tool',
                tool_call_id: 'call_openai',
                content: 'console.log("hello")'
            },
            { role: 'user', content: 'Summarize' }
        ], 'claude-sonnet-4-5', null);

        const serialized = JSON.stringify(payload);
        expect(serialized).toContain('[Tool: read_file (call_openai)]');
        expect(serialized).toContain('[Tool Result (call_openai)]');
        expect(serialized).not.toContain('"toolUses"');
        expect(serialized).not.toContain('"toolResults"');
    });

    test('keeps tool structure and fills empty tool descriptions when tools are defined', async () => {
        const service = createService();

        const payload = await service.buildCodewhispererRequest([
            { role: 'user', content: 'Use a tool' }
        ], 'claude-sonnet-4-5', [
            {
                name: 'inspect_file',
                description: '',
                input_schema: { type: 'object', properties: {} }
            }
        ]);

        const context = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext;
        expect(context.tools).toHaveLength(1);
        expect(context.tools[0].toolSpecification.name).toBe('inspect_file');
        expect(context.tools[0].toolSpecification.description).toBe('Tool: inspect_file');
    });

    test('converts standard OpenAI function tools to Kiro tool specifications', async () => {
        const service = createService();

        const payload = await service.buildCodewhispererRequest([
            { role: 'user', content: 'Use a tool' }
        ], 'claude-sonnet-4-5', [
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get weather for a location',
                    parameters: {
                        type: 'object',
                        properties: {
                            location: { type: 'string' }
                        },
                        required: ['location']
                    }
                }
            }
        ]);

        const toolSpec = payload.conversationState.currentMessage.userInputMessage
            .userInputMessageContext.tools[0].toolSpecification;
        expect(toolSpec.name).toBe('get_weather');
        expect(toolSpec.description).toBe('Get weather for a location');
        expect(toolSpec.inputSchema.json.required).toEqual(['location']);
    });

    test('prefixes runtime empty placeholder with default thinking instructions when assistant is the last message', async () => {
        const service = createService();

        const payload = await service.buildCodewhispererRequest([
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' }
        ], 'claude-sonnet-4-5');

        const currentContent = payload.conversationState.currentMessage.userInputMessage.content;
        expect(currentContent).toContain('<thinking_mode>enabled</thinking_mode>');
        expect(currentContent).toContain('<max_thinking_length>4000</max_thinking_length>');
        expect(currentContent).toContain('<thinking_instruction>');
        expect(currentContent).toContain('</thinking_instruction>');
        expect(currentContent.endsWith('\n\n(empty placeholder)')).toBe(true);
    });

    test('parses stream payloads after non-json AWS eventstream header braces', () => {
        const service = createService();
        const noisyAwsEventStream =
            '\x00{\x0b:event-type\x07\x00\x15reasoningContentEvent\n' +
            ':message-type\x07\x00\x05event{"text":"internal reasoning"}\x00' +
            '\x00:event-type\x07\x00\x16assistantResponseEvent\n' +
            ':message-type\x07\x00\x05event{"content":"Hello from Kiro","modelId":"claude-opus-4.8"}\x00' +
            '\x00:event-type\x07\x00\x0ctoolUseEvent\n' +
            ':message-type\x07\x00\x05event{"name":"Bash","toolUseId":"tool_1"}\x00' +
            '\x00:event-type\x07\x00\x0ctoolUseEvent\n' +
            ':message-type\x07\x00\x05event{"input":"{\\"command\\":\\"pwd\\"}","name":"Bash","toolUseId":"tool_1"}\x00' +
            '\x00:event-type\x07\x00\x0ctoolUseEvent\n' +
            ':message-type\x07\x00\x05event{"name":"Bash","stop":true,"toolUseId":"tool_1"}\x00';

        const parsed = service.parseAwsEventStreamBuffer(noisyAwsEventStream);

        expect(parsed.events).toEqual([
            { type: 'content', data: 'Hello from Kiro' },
            {
                type: 'toolUse',
                data: {
                    name: 'Bash',
                    toolUseId: 'tool_1',
                    input: '',
                    stop: false
                }
            },
            {
                type: 'toolUse',
                data: {
                    name: 'Bash',
                    toolUseId: 'tool_1',
                    input: '{"command":"pwd"}',
                    stop: false
                }
            },
            {
                type: 'toolUse',
                data: {
                    name: 'Bash',
                    toolUseId: 'tool_1',
                    input: '',
                    stop: true
                }
            }
        ]);
    });
});
