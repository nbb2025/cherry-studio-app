import { DatabaseSync } from 'node:sqlite';

import { fetch as expoFetch } from 'expo/fetch';

import { userModelTable, userProviderTable } from '@/backend/data/db/schemas';
import type { PreferenceService } from '@/backend/data/PreferenceService';
import { createTestDb } from '@/backend/data/services/__tests__/_testDb';
import {
  createCustomModel,
  providerRegistryService,
} from '@/backend/data/services/ProviderRegistryService';
import type { HttpRequest, HttpResponse } from '@/backend/services/http';

import { IagentAccountRuntime } from '../IagentAccountRuntime';
import { IagentClient } from '../IagentClient';
import { IagentModelRuntime } from '../IagentModelRuntime';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => {
    const state = new Map<string, string>();
    return {
      getString: state.get.bind(state),
      set: state.set.bind(state),
      remove: state.delete.bind(state),
    };
  },
}));

function json(data: unknown): HttpResponse<unknown> {
  return { data: { code: 0, data }, headers: {}, status: 200 };
}

function setup(control: (input: HttpRequest) => Promise<HttpResponse<unknown>>, signedIn = true) {
  const db = createTestDb(new DatabaseSync(':memory:'));
  const preference = { readCached: jest.fn(), set: jest.fn(async () => {}) };
  const account = new IagentAccountRuntime({
    client: new IagentClient(control),
    stored: signedIn ? { userId: 4, name: 'Test', accessToken: 'test-access' } : null,
    locale: () => 'zh-CN',
    save: () => {},
  });
  const models = new IagentModelRuntime(db.dbService, preference as unknown as PreferenceService);
  models.configure(account);
  return { db, account, models, preference };
}

afterEach(() => jest.clearAllMocks());

test('the authorized catalog keeps group identity, withdraws stale rows and selects an available default', async () => {
  const catalog = {
    models: [
      { group_id: 1, id: 'gpt-test' },
      { group_id: 2, id: 'gpt-test' },
      { group_id: 2, id: 'gpt-image-test' },
      { group_id: 3, id: 'codex-auto-review', name: 'Codex Auto Review' },
      { group_id: 3, id: 'claude-test' },
      { group_id: 9, id: 'private-example' },
    ],
    group_order: [3, 2, 1],
  };
  let groups = [
    { id: 1, name: 'OpenAI group', status: 'active', platform: 'openai' },
    { id: 2, name: 'Compatible group', status: 'active', platform: 'grok' },
    { id: 3, name: 'Anthropic group', status: 'active', platform: 'composite' },
  ];
  const request = jest
    .fn<Promise<HttpResponse<unknown>>, [HttpRequest]>()
    .mockImplementation(async ({ path, headers }) => {
      const publicCatalog = path === '/site-api/models';
      expect(headers?.Authorization).toBe(publicCatalog ? undefined : 'Bearer test-access');
      return json(publicCatalog ? catalog : groups);
    });
  const { db, models, preference } = setup(request);
  try {
    await expect(models.listModels()).resolves.toBe(3);
    const stored = await db.database.select().from(userModelTable);
    expect(stored).toHaveLength(3);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'iagent-group-1::gpt-test',
          endpointTypes: ['openai-responses'],
        }),
        expect.objectContaining({
          id: 'iagent-group-2::gpt-test',
          endpointTypes: ['openai-chat-completions'],
        }),
        expect.objectContaining({
          id: 'iagent-group-3::claude-test',
          endpointTypes: ['anthropic-messages'],
        }),
      ]),
    );
    expect(preference.set).toHaveBeenCalledWith(
      'agent.default_model_id',
      'iagent-group-3::claude-test',
    );
    groups = [groups[1]];
    await expect(models.listModels()).resolves.toBe(1);
    expect(
      (await db.database.select().from(userModelTable)).filter((model) => model.isEnabled),
    ).toMatchObject([{ id: 'iagent-group-2::gpt-test' }]);
    expect(await db.database.select().from(userProviderTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'iagent-group-2', apiKeys: [] }),
      ]),
    );
  } finally {
    db.sqlite.close();
  }
});

test('startup and inference can read a managed model before any Cherry registry download', () => {
  providerRegistryService.clearRemoteSnapshot();
  const provider = { id: 'iagent-group-1', defaultChatEndpoint: 'openai-responses' } as const;
  const model = createCustomModel(provider.id, 'gpt-test');
  expect(providerRegistryService.lookupModel(provider.id, model.modelId).presetModel).toBeNull();
  expect(providerRegistryService.resolveReasoningProfile(provider, model).format).toBe(
    'openai-responses',
  );
});

test('parallel requests share a group key and only the pinned route receives it', async () => {
  const control = jest
    .fn<Promise<HttpResponse<unknown>>, [HttpRequest]>()
    .mockImplementation(async ({ path, body, headers }) => {
      if (path.includes('?page=')) return json({ items: [], pages: 1 });
      if (path.endsWith('/groups/available')) return json([{ id: 2, status: 'active' }]);
      expect(body).toEqual({ name: '聊天', group_id: 2 });
      expect(headers?.['Idempotency-Key']).toBe('iagent-workspace-v1-4-2-chat');
      return json({ id: 11, name: '聊天', group_id: 2, key: 'test-model-key', status: 'active' });
    });
  jest.mocked(expoFetch).mockImplementation(
    async () =>
      new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }) as Awaited<ReturnType<typeof expoFetch>>,
  );
  const { db, models } = setup(control);
  try {
    const fetch = models.createModelFetch('iagent-group-2', 'anthropic-messages', 'claude-test');
    const options = {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-test' }),
      headers: { 'x-api-key': 'untrusted' },
    };
    await expect(fetch('https://example.test/v1/messages', options)).rejects.toMatchObject({
      code: 'request',
    });
    expect(control).not.toHaveBeenCalled();
    const response = await Promise.all([
      fetch('https://ai.iagent.dev/v1/messages?beta=true', options),
      fetch('https://ai.iagent.dev/v1/messages', options),
    ]);
    expect(control).toHaveBeenCalledTimes(3);
    expect(expoFetch).toHaveBeenCalledTimes(2);
    for (const [requestUrl, request] of jest.mocked(expoFetch).mock.calls) {
      expect(requestUrl).toBe('https://ai.iagent.dev/v1/messages');
      const headers = new Headers(request?.headers as HeadersInit);
      expect(headers.get('authorization')).toBe('Bearer test-model-key');
      expect(headers.get('x-api-key')).toBe('test-model-key');
    }
    await expect(response[0].text()).resolves.toBe('data: [DONE]\n\n');
  } finally {
    db.sqlite.close();
  }
});

test('an uncertain key creation is recovered from inventory without another POST', async () => {
  let visibleRemotely = false;
  const key = { id: 39, name: '创意工坊', group_id: 9, key: 'test-media-key', status: 'active' };
  const control = jest
    .fn<Promise<HttpResponse<unknown>>, [HttpRequest]>()
    .mockImplementation(async ({ path, headers }) => {
      if (path.includes('?page=')) return json({ items: visibleRemotely ? [key] : [], pages: 1 });
      if (path.endsWith('/groups/available')) return json([{ id: 9, status: 'active' }]);
      expect(headers?.['Idempotency-Key']).toBe('iagent-workspace-v1-4-9-media');
      throw new Error('connection lost');
    });
  const { db, models } = setup(control);
  try {
    await expect(models.getMediaKey(9)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(models.getMediaKey(9)).rejects.toMatchObject({ code: 'key' });
    visibleRemotely = true;
    await expect(models.getMediaKey(9)).resolves.toEqual({ id: 39, value: key.key });
    expect(control.mock.calls.filter(([{ method }]) => method === 'POST')).toHaveLength(1);
  } finally {
    db.sqlite.close();
  }
});

test('a guest catalog keeps user providers enabled and leaves the chosen custom default intact', async () => {
  const request = jest
    .fn<Promise<HttpResponse<unknown>>, [HttpRequest]>()
    .mockImplementation(async ({ headers }) => {
      expect(headers?.Authorization).toBeUndefined();
      return json({
        models: [{ group_id: 3, group_name: 'Global', id: 'claude-test', platform: 'anthropic' }],
      });
    });
  const { db, models, preference } = setup(request, false);
  try {
    await db.database.insert(userProviderTable).values({
      providerId: 'custom',
      name: 'My endpoint',
      isEnabled: true,
      orderKey: 'a0',
    });
    await db.database.insert(userModelTable).values({
      id: 'custom::mine',
      providerId: 'custom',
      modelId: 'mine',
      name: 'My model',
      capabilities: [],
      endpointTypes: ['openai-chat-completions'],
      supportsStreaming: true,
      isEnabled: true,
      isHidden: false,
      orderKey: 'a0',
    });
    (preference.readCached as jest.Mock).mockReturnValue('custom::mine');
    await expect(models.listModels()).resolves.toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(preference.set).not.toHaveBeenCalled();
    expect(await db.database.select().from(userProviderTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'custom', isEnabled: true }),
        expect.objectContaining({ providerId: 'iagent-group-3', isEnabled: true }),
      ]),
    );
    expect(await db.database.select().from(userModelTable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'custom::mine', isEnabled: true, isHidden: false }),
      ]),
    );
    expect(() =>
      models.createModelFetch('iagent-group-3', 'anthropic-messages', 'claude-test'),
    ).toThrow('iAgent session');
  } finally {
    db.sqlite.close();
  }
});
