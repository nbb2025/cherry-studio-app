import type { IagentMediaInput, IagentMediaModel } from '@/shared/contracts/iagentCreative';

import { IagentAccountRuntime } from '../IagentAccountRuntime';
import { IagentClient } from '../IagentClient';
import { IagentCreativeRuntime } from '../IagentCreativeRuntime';

const mockRequest = jest.fn();
const mockStores = new Map<string, Map<string, string>>();

jest.mock('expo-crypto', () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/backend/services/download/downloadFile', () => ({ downloadFile: jest.fn() }));
jest.mock('@/backend/services/http', () => ({
  createHttpClient: () => ({ request: (options: unknown) => mockRequest(options) }),
}));
jest.mock('../iagentMediaFiles', () => ({
  openMediaReference: jest.fn(),
  storeImageOutput: (_owner: number, _id: string, _index: number, source: string) => source,
}));
jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const store = mockStores.get(id) ?? new Map<string, string>();
    mockStores.set(id, store);
    return {
      getAllKeys: () => [...store.keys()],
      getString: (key: string) => store.get(key),
      set: (key: string, value: string) => store.set(key, value),
    };
  },
}));

const model: IagentMediaModel = {
  id: 'gpt-image-2',
  name: 'Image test',
  protocol: 'openai-image',
  kind: 'image',
  groupId: 4,
  groupName: 'Image',
  ratios: ['auto'],
  resolutions: [],
  durations: [],
  defaultRatio: 'auto',
  referenceMode: 'image',
  outputFormats: ['png'],
};
const input: IagentMediaInput = { model, prompt: 'A paper boat', ratio: 'auto', references: [] };

function setup(owner: number | null = 1) {
  const account = new IagentAccountRuntime({
    client: new IagentClient(async () => ({
      status: 200,
      headers: {},
      data: { async_enabled: true },
    })),
    stored: owner ? { userId: owner, name: 'Test', accessToken: 'test-jwt' } : null,
    locale: () => 'en-US',
    save: () => {},
  });
  const models = {
    loadCatalog: jest.fn(),
    getMediaKey: jest.fn(async () => ({ id: 77, value: 'test-model-key' })),
  };
  return { models, creative: new IagentCreativeRuntime(account, models) };
}

beforeEach(() => {
  mockRequest.mockReset();
  mockStores.clear();
});

test('guest generation cannot reach the paid transport', async () => {
  const { creative, models } = setup(null);
  await expect(creative.submit(input)).rejects.toMatchObject({ code: 'session' });
  expect(models.getMediaKey).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

test('an accepted image task reopens with the original task ID and key on later searches', async () => {
  const { creative } = setup();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    mockRequest.mockResolvedValueOnce({
      status: 202,
      headers: {},
      data: { task_id: 'imgtask_fixture', status: 'processing', poll_url: 'https://other.test' },
    });
    const original = await creative.submit(input);
    expect(original).toMatchObject({ status: 'pending', serverId: 'imgtask_fixture' });
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/images/generations/async',
        body: { model: model.id, n: 1, prompt: input.prompt },
      }),
    );

    const restarted = setup();
    expect(restarted.creative.listTasks()).toEqual([original]);
    expect(setup(2).creative.listTasks()).toEqual([]);
    clock.mockReturnValue(106_000);
    mockRequest.mockResolvedValueOnce({
      status: 503,
      headers: { 'retry-after': '10' },
      data: {},
    });
    await expect(restarted.creative.check(original.id)).resolves.toMatchObject({
      status: 'pending',
      retryAt: 116_000,
    });
    await restarted.creative.check(original.id);
    expect(mockRequest).toHaveBeenCalledTimes(2);

    clock.mockReturnValue(117_000);
    mockRequest.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        id: 'imgtask_fixture',
        status: 'completed',
        result: { data: [{ url: 'https://cdn.example.test/fixture.png' }] },
      },
    });
    await expect(restarted.creative.check(original.id)).resolves.toMatchObject({
      status: 'completed',
      outputs: 1,
    });
    expect(restarted.models.getMediaKey).toHaveBeenCalledWith(4, 77);
    expect(mockRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/site-api/image-tasks/imgtask_fixture',
        headers: expect.objectContaining({ Authorization: 'Bearer test-model-key' }),
      }),
    );
    await expect(restarted.creative.output(original.id, 0)).resolves.toBe(
      'https://cdn.example.test/fixture.png',
    );
  } finally {
    clock.mockRestore();
  }
});

test('an ambiguous create response is recorded without resubmitting', async () => {
  const { creative } = setup();
  mockRequest.mockRejectedValueOnce(new Error('Connection interrupted'));
  const task = await creative.submit(input);
  expect(task.status).toBe('unknown');
  await expect(creative.check(task.id)).resolves.toEqual(task);
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
