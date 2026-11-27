import type { IagentMediaInput } from '@/shared/contracts/iagentCreative';

import { publicIagentGroups } from '../iagentCatalog';
import {
  imageRequest,
  mediaStatusPath,
  readMediaPayload,
  selectIagentMediaModels,
  validateIagentMediaInput,
  videoCreatePath,
  videoRequest,
} from '../iagentMediaProtocol';

const catalog = {
  group_order: [8, 4, 9, 5],
  models: [
    { id: 'gpt-image-2.6-flare', group_id: 4, platform: 'openai', group_name: 'Image' },
    { id: 'gemini-3.1-flash-image-preview', group_id: 5, platform: 'gemini' },
    { id: 'wan3.0-video', group_id: 9, platform: 'bailian' },
    { id: 'sd-2.5-720', group_id: 8, platform: 'video-lt' },
    { id: 'minimax-h3', group_id: 8, platform: 'video-lt' },
    { id: 'gpt-6', group_id: 10, platform: 'openai' },
  ],
};

const models = selectIagentMediaModels(publicIagentGroups(catalog), catalog);
function input(id: string): IagentMediaInput {
  const model = models.find((item) => item.id === id)!;
  return {
    model,
    ratio: model.defaultRatio,
    resolution: model.defaultResolution,
    duration: model.defaultDuration,
    prompt: 'A paper boat',
    references: [],
  };
}

test('the public studio catalog keeps group order and distinguishes the actual media protocols', () => {
  expect(models.map(({ id, protocol }) => [id, protocol])).toEqual([
    ['sd-2.5-720', 'video-lt'],
    ['minimax-h3', 'video-lt'],
    ['gpt-image-2.6-flare', 'openai-image'],
    ['wan3.0-video', 'bailian'],
    ['gemini-3.1-flash-image-preview', 'gemini-image'],
  ]);
});

test('images use the online generation and editing paths and decode asynchronous responses', () => {
  const request = imageRequest({ ...input('gpt-image-2.6-flare'), ratio: '3:2' }, true);
  expect(request).toMatchObject({
    route: 'openai-edit',
    path: '/images/edits',
    fields: { size: '1536x1024', output_format: 'png', n: 1 },
  });
  expect(imageRequest(input('gemini-3.1-flash-image-preview'), false)).toMatchObject({
    route: 'gemini',
    path: '/v1beta/models/gemini-3.1-flash-image-preview:generateContent',
  });
  expect(mediaStatusPath('openai-image', 'imgtask_fixture')).toBe(
    '/site-api/image-tasks/imgtask_fixture',
  );
  expect(
    readMediaPayload('openai-image', {
      task_id: 'imgtask_fixture',
      status: 'completed',
      result: { data: [{ url: 'https://cdn.example.test/fixture.png' }] },
    }),
  ).toMatchObject({ done: true, outputs: ['https://cdn.example.test/fixture.png'] });
  expect(
    readMediaPayload('gemini-image', {
      status: 'completed',
      result: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/webp', data: 'AAAA' } }] } },
        ],
      },
    }).outputs,
  ).toEqual(['data:image/webp;base64,AAAA']);
});

test('Wan uses its native input and task identifiers, without polling the tracking request ID', () => {
  expect(
    videoRequest(input('wan3.0-video'), ['oss://bucket/first.png', 'oss://bucket/last.png']),
  ).toEqual({
    model: 'wan3.0-video',
    input: {
      prompt: 'A paper boat',
      media: [
        { type: 'first_frame', url: 'oss://bucket/first.png' },
        { type: 'last_frame', url: 'oss://bucket/last.png' },
      ],
    },
    parameters: {
      duration: 5,
      resolution: '1080P',
      ratio: 'adaptive',
      audio: true,
      prompt_extend: true,
      watermark: false,
    },
  });
  expect(videoCreatePath('bailian')).toBe('/v1/videos/generations');
  expect(readMediaPayload('bailian', { request_id: 'tracking-only' }).id).toBeUndefined();
  expect(
    readMediaPayload('bailian', {
      request_id: 'tracking-only',
      output: {
        task_id: 'real-task',
        task_status: 'SUCCEEDED',
        video_url: 'https://cdn.example.test/video.mp4',
      },
    }),
  ).toMatchObject({ id: 'real-task', done: true, outputs: ['https://cdn.example.test/video.mp4'] });
});

test('video-lt uses the native create and query envelope and requires a reference for MiniMax H3', () => {
  expect(videoCreatePath('video-lt')).toBe('/v1/video/create');
  expect(mediaStatusPath('video-lt', 'job-id')).toBe('/v1/video/query/job-id');
  expect(() => mediaStatusPath('video-lt', 'https://other.test')).toThrow('iAgent request');
  expect(() => validateIagentMediaInput(input('minimax-h3'))).toThrow('iAgent request');
  expect(videoRequest(input('sd-2.5-720'), ['https://cdn.example.test/reference.png'])).toEqual({
    model: 'sd-2.5-720',
    prompt: 'A paper boat',
    duration: 4,
    start_image_url: 'https://cdn.example.test/reference.png',
  });
  expect(
    readMediaPayload('video-lt', {
      success: true,
      data: {
        id: 'job-id',
        status: 'completed',
        result_url: 'https://cdn.example.test/video.mp4',
      },
    }),
  ).toMatchObject({ id: 'job-id', done: true, outputs: ['https://cdn.example.test/video.mp4'] });
});
