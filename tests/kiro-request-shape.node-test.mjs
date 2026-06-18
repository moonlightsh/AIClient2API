import assert from 'node:assert/strict';
import test from 'node:test';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';

function createInitializedService() {
    const service = new KiroApiService({});
    service.isInitialized = true;
    service.accessToken = 'test-access-token';
    service.profileArn = 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/test';
    service.baseUrl = 'https://runtime.eu-central-1.kiro.dev';
    service.amazonQUrl = 'https://runtime.eu-central-1.kiro.dev';
    service.axiosInstance = {
        async request(config) {
            return { data: '', config };
        }
    };
    return service;
}

test('Kiro generateAssistantResponse request uses gateway-compatible header order and values', async () => {
    const service = createInitializedService();
    let capturedConfig;
    service.axiosInstance.request = async (config) => {
        capturedConfig = config;
        return { data: '' };
    };

    await service.callApi('POST', 'claude-sonnet-4-5', {
        messages: [{ role: 'user', content: 'hello' }]
    });

    assert.deepEqual(Object.keys(capturedConfig.headers), [
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
    assert.equal(capturedConfig.headers.Host, 'runtime.eu-central-1.kiro.dev');
    assert.equal(capturedConfig.headers.Accept, '*/*');
    assert.equal(capturedConfig.headers['Accept-Encoding'], 'gzip, deflate');
    assert.equal(capturedConfig.headers['Content-Type'], 'application/x-amz-json-1.0');
    assert.equal(capturedConfig.headers['x-amz-target'], 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse');
    assert.match(capturedConfig.headers['User-Agent'], /^aws-sdk-js\/1\.0\.27 ua\/2\.1 os\/win32#10\.0\.19044 lang\/js md\/nodejs#22\.21\.1 api\/codewhispererstreaming#1\.0\.27 m\/E KiroIDE-0\.7\.45-/);
    assert.match(capturedConfig.headers['x-amz-user-agent'], /^aws-sdk-js\/1\.0\.27 KiroIDE-0\.7\.45-/);
});

test('Kiro generateAssistantResponse sends an ASCII-safe JSON body', async () => {
    const service = createInitializedService();
    let capturedConfig;
    service.axiosInstance.request = async (config) => {
        capturedConfig = config;
        return { data: '' };
    };

    await service.callApi('POST', 'claude-sonnet-4-5', {
        messages: [{ role: 'user', content: '目录结构 — ✓' }],
        system: '你一定不能说自己是 kiro'
    });

    assert.equal(typeof capturedConfig.data, 'string');
    assert.doesNotMatch(capturedConfig.data, /[^\x00-\x7f]/);
    assert.doesNotMatch(capturedConfig.data, /[\u0080-\u009f]/);
    assert.match(capturedConfig.data, /\\u76ee\\u5f55\\u7ed3\\u6784/);
    assert.match(capturedConfig.data, /\\u4f60\\u4e00\\u5b9a\\u4e0d\\u80fd\\u8bf4\\u81ea\\u5df1\\u662f kiro/);
    assert.equal(JSON.parse(capturedConfig.data).profileArn, service.profileArn);
});

test('Kiro current body content includes default thinking instructions before an empty placeholder', async () => {
    const service = createInitializedService();

    const payload = await service.buildCodewhispererRequest([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' }
    ], 'claude-sonnet-4-5');

    const currentContent = payload.conversationState.currentMessage.userInputMessage.content;
    assert.match(currentContent, /^<thinking_mode>enabled<\/thinking_mode>\n<max_thinking_length>4000<\/max_thinking_length>\n<thinking_instruction>[\s\S]+<\/thinking_instruction>\n\n\(empty placeholder\)$/);
});
