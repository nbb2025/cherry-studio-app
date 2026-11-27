import { IAGENT_ORIGIN, IagentError } from '@/shared/contracts/iagent';
import type {
  IagentImageFormat,
  IagentMediaInput,
  IagentMediaModel,
  IagentMediaProtocol,
  IagentReferenceKind,
} from '@/shared/contracts/iagentCreative';
import {
  canonicalMediaModel,
  imageModelOptions,
  resolveIagentImageOptions,
} from '@/shared/utils/iagentImageOptions';
import {
  mediaReferenceRole,
  validateVideoReferences,
  wanReferenceLimits,
} from '@/shared/utils/iagentVideoOptions';

import {
  IAGENT_IMAGE_MODEL,
  type IagentCatalogResponse,
  type IagentGroups,
  type IagentModel,
} from './iagentCatalog';
const GROK_VIDEO = /grok[-_. ]?imag(?:ine|en)[-_. ]?video/i;
const STANDARD_RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1'];
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'];
const FRAME_ROLES = ['first_frame', 'last_frame'] as const;
const IMAGE_ROLES = [...FRAME_ROLES, 'reference_image'] as const;
const QUALITY = new Set(['auto', 'low', 'medium', 'high']);
const range = (min: number, max: number) =>
  Array.from({ length: max - min + 1 }, (_, i) => min + i);

function protocolFor(model: IagentModel, groupPlatform: string): IagentMediaProtocol | undefined {
  const group = groupPlatform?.trim().toLowerCase();
  const modelPlatform = model.platform?.trim().toLowerCase();
  const platform = group && group !== 'composite' ? group : modelPlatform;
  const name = `${model.id} ${model.name ?? ''}`;
  if (modelPlatform === 'bailian' || platform === 'bailian') return 'bailian';
  if (modelPlatform === 'video-lt' || platform === 'video-lt') return 'video-lt';
  if (/seedance/i.test(name)) return 'seedance';
  if (GROK_VIDEO.test(name)) return 'grok-video';
  if (!IAGENT_IMAGE_MODEL.test(name)) return undefined;
  if (
    ['gemini', 'google', 'antigravity'].includes(platform ?? '') ||
    (!platform && /gemini|nano[-_. ]?banana|imagen/i.test(name))
  )
    return 'gemini-image';
  if (['grok', 'xai'].includes(platform ?? '') || (!platform && /grok/i.test(name)))
    return 'grok-image';
  return 'openai-image';
}

type Capabilities = Omit<IagentMediaModel, 'id' | 'name' | 'groupId' | 'groupName' | 'protocol'>;

function capabilities(
  protocol: IagentMediaProtocol,
  id: string,
  name: string,
): Capabilities | undefined {
  if (protocol.endsWith('-image')) return imageModelOptions(protocol, id);
  if (protocol === 'bailian')
    return {
      kind: 'video',
      ratios: ['adaptive', ...STANDARD_RATIOS, '21:9'],
      resolutions: VIDEO_RESOLUTIONS,
      durations: [-1, ...range(1, 30)],
      defaultRatio: 'adaptive',
      defaultDuration: 5,
      defaultResolution: '1080p',
      referenceMode: 'frames',
      referenceLimits: wanReferenceLimits,
      referenceRoles: IMAGE_ROLES,
      supportsWatermark: true,
    };
  if (protocol === 'grok-video')
    return {
      kind: 'video',
      ratios: [...STANDARD_RATIOS, '3:2', '2:3', '2:1', '1:2'],
      resolutions: ['480p', '720p'],
      durations: [6, 10, 15],
      defaultRatio: '16:9',
      defaultDuration: 15,
      defaultResolution: '720p',
      referenceMode: /video[-_. ]?1\.5/i.test(name) ? 'image' : 'none',
      referenceLimits: { image: /video[-_. ]?1\.5/i.test(name) ? 7 : 0 },
      promptLimit: 4096,
    };
  if (protocol === 'seedance') {
    const version25 = /seedance[-_. ]?2[-_. ]?5/i.test(name);
    const second = /seedance[-_. ]?2/i.test(name);
    const version10 = /seedance[-_. ]?1[-_. ]?0/i.test(name);
    const allowsReferences = !/(?:^|[-_. /])t2v(?:$|[-_. /])/i.test(name);
    const multiple = second || /seedance.*lite.*i2v/i.test(name);
    return {
      kind: 'video',
      ratios: [...STANDARD_RATIOS, '21:9', ...(version10 ? [] : ['adaptive'])],
      resolutions: second && /fast|mini/i.test(name) ? ['480p', '720p'] : VIDEO_RESOLUTIONS,
      durations: range(version25 || version10 ? 2 : 4, version25 ? 30 : second ? 15 : 12),
      defaultRatio: '16:9',
      defaultDuration: 5,
      defaultResolution: '720p',
      referenceMode: allowsReferences ? 'frames' : 'none',
      referenceLimits: {
        image: allowsReferences ? (multiple ? (version25 ? 30 : second ? 9 : 4) : 2) : 0,
      },
      referenceRoles: multiple ? IMAGE_ROLES : FRAME_ROLES,
      framesUseAdaptiveRatio: version25,
      requiresReference: /(?:^|[-_. /])i2v(?:$|[-_. /])/i.test(name),
      promptLimit: 4096,
    };
  }
  const minimax = /\bminimax-h3\b/i.test(name);
  const videoLt = /\bsd-(2\.5(?:-flash)?|2-(?:fast|mini|vip))(?:-(480|720|1080))?\b/i.exec(name);
  if (!minimax && !videoLt) return undefined;
  const v25 = videoLt?.[1].startsWith('2.5') ?? false;
  const flash = videoLt?.[1] === '2.5-flash';
  const resolution = minimax ? '720p' : `${videoLt?.[2] ?? '480'}p`;
  return {
    kind: 'video',
    ratios: minimax ? ['16:9', '9:16'] : [...STANDARD_RATIOS, ...(v25 ? [] : ['21:9'])],
    resolutions: [resolution],
    durations: range(v25 ? 4 : 5, v25 ? 30 : 15),
    defaultRatio: '16:9',
    defaultDuration: v25 ? 4 : 5,
    defaultResolution: resolution,
    referenceMode: v25 ? 'frames' : 'image',
    referenceRoles: v25 ? IMAGE_ROLES : ['reference_image'],
    referenceLimits: {
      image: v25 ? (flash ? 10 : 30) : 9,
      video: minimax ? 0 : v25 ? (flash ? 5 : 10) : 3,
      audio: v25 ? (flash ? 5 : 10) : 3,
    },
    framesUseAdaptiveRatio: v25,
    requiresReference: minimax,
    supportsWatermark: minimax,
    promptLimit: minimax ? 7000 : 10_000,
  };
}

export function selectIagentMediaModels(
  groups: IagentGroups,
  catalog: IagentCatalogResponse,
): IagentMediaModel[] {
  const order = new Map(catalog.group_order?.map((id, index) => [id, index]));
  const byId = new Map(
    groups.filter((group) => group.status === 'active').map((group) => [group.id, group]),
  );
  const models = new Map<string, IagentMediaModel>();
  for (const model of catalog.models) {
    const group = byId.get(model.group_id);
    if (!group || typeof model.id !== 'string' || !model.id.trim()) continue;
    const protocol = protocolFor(model, group.platform);
    if (!protocol) continue;
    const modelCaps = capabilities(protocol, model.id, `${model.id} ${model.name ?? ''}`);
    if (!modelCaps) continue;
    models.set(`${group.id}:${model.id}`, {
      ...modelCaps,
      protocol,
      id: model.id,
      name: model.name || model.id,
      groupId: group.id,
      groupName: group.name,
    });
  }
  return [...models.values()].sort(
    (a, b) => (order.get(a.groupId) ?? Infinity) - (order.get(b.groupId) ?? Infinity),
  );
}

export function validateIagentMediaInput(input: IagentMediaInput): void {
  const { model, ratio, resolution, duration, references, count = 1, outputFormat = 'png' } = input;
  const referenceCounts = new Map<IagentReferenceKind, number>();
  for (const reference of references) {
    const kind = reference.kind ?? 'image';
    referenceCounts.set(kind, (referenceCounts.get(kind) ?? 0) + 1);
  }
  if (
    (!input.prompt.trim() && model.protocol !== 'bailian') ||
    (model.promptLimit !== undefined && Array.from(input.prompt).length > model.promptLimit) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !model.ratios.includes(ratio) ||
    (model.kind === 'video' &&
      (!resolution ||
        !model.resolutions.includes(resolution) ||
        duration === undefined ||
        !model.durations.includes(duration))) ||
    (model.kind === 'image' &&
      resolution !== undefined &&
      !model.resolutions.includes(resolution)) ||
    [...referenceCounts].some(([kind, total]) => total > (model.referenceLimits?.[kind] ?? 0)) ||
    (model.requiresReference && !referenceCounts.has('image'))
  )
    throw new IagentError('request');
  if (model.kind === 'video') {
    validateVideoReferences(input);
    return;
  }
  if (
    !model.outputFormats?.includes(outputFormat) ||
    (input.quality !== undefined && (!model.supportsQuality || !QUALITY.has(input.quality))) ||
    (input.complexity !== undefined &&
      (!model.supportsComplexity || !QUALITY.has(input.complexity))) ||
    (outputFormat === 'svg' && (count !== 1 || references.length)) ||
    (outputFormat === 'gif' &&
      ((resolution && resolution !== 'auto') ||
        !Number.isInteger(input.frameCount ?? 9) ||
        (input.frameCount ?? 9) < 2 ||
        (input.frameCount ?? 9) > 16 ||
        !Number.isInteger(input.frameDurationMs ?? 200) ||
        (input.frameDurationMs ?? 200) < 20 ||
        (input.frameDurationMs ?? 200) > 2000))
  )
    throw new IagentError('request');
  resolveIagentImageOptions(input);
}

export function imageRequest(input: IagentMediaInput, hasReferences: boolean) {
  const { model, prompt, outputFormat = 'png' } = input;
  const baseModel = canonicalMediaModel(model.id);
  const settings = resolveIagentImageOptions(input);
  if (model.protocol === 'gemini-image')
    return {
      route: 'gemini',
      path: `/v1beta/models/${encodeURIComponent(baseModel)}:generateContent`,
      baseModel,
      imageConfig: settings.gemini,
    };
  const route = model.protocol === 'grok-image' ? 'grok' : 'openai';
  return {
    route: `${route}-${hasReferences ? 'edit' : 'generation'}`,
    path: hasReferences ? '/images/edits' : '/images/generations',
    fields: {
      model: model.id,
      prompt,
      n: 1,
      ...(settings.size ? { size: settings.size } : {}),
      ...(model.supportsQuality
        ? {
            quality: input.quality ?? 'high',
            output_format: outputFormat,
            moderation: 'auto',
            ...(input.complexity && input.complexity !== 'auto'
              ? { complexity: input.complexity }
              : {}),
            ...(outputFormat === 'gif'
              ? {
                  frame_count: input.frameCount ?? 9,
                  frame_duration_ms: Math.round((input.frameDurationMs ?? 200) / 10) * 10,
                }
              : {}),
          }
        : {}),
    },
  };
}

export function videoCreatePath(protocol: IagentMediaProtocol): string {
  if (protocol === 'video-lt') return '/v1/video/create';
  if (protocol === 'seedance') return '/v1/contents/generations/tasks';
  return '/v1/videos/generations';
}

export function mediaStatusPath(protocol: IagentMediaProtocol, serverId: string): string {
  // Use our own paths. Never forward a billing credential to a response-supplied poll URL.
  if (!/^[\w.-]{1,255}$/.test(serverId) || serverId === '.' || serverId === '..')
    throw new IagentError('request');
  const id = encodeURIComponent(serverId);
  if (protocol.endsWith('-image')) return `/site-api/image-tasks/${id}`;
  if (protocol === 'video-lt') return `/v1/video/query/${id}`;
  if (protocol === 'seedance') return `/v1/contents/generations/tasks/${id}`;
  return `/v1/videos/${id}`;
}

export function videoRequest(input: IagentMediaInput, references: string[]) {
  const { model, prompt, ratio, duration, resolution } = input;
  const frames = references.map((url, index) => ({
    url,
    role: mediaReferenceRole(input.references[index], index),
    kind: input.references[index]?.kind ?? 'image',
  }));
  if (model.protocol === 'bailian')
    return {
      model: model.id,
      input: {
        ...(prompt ? { prompt } : {}),
        ...(frames.length
          ? {
              media: frames.map(({ role, url, kind }, index) => ({
                type:
                  kind === 'file' || kind === 'link'
                    ? kind
                    : kind === 'image'
                      ? input.references[index]
                        ? (input.references[index].role ?? 'reference_image')
                        : role
                      : `reference_${kind}`,
                url,
              })),
            }
          : {}),
      },
      parameters: {
        duration,
        resolution: resolution?.toUpperCase(),
        ratio,
        audio: input.audio ?? true,
        prompt_extend:
          frames.some(({ kind }) => kind === 'file' || kind === 'link') ||
          (input.promptExtend ?? true),
        watermark: input.watermark ?? false,
        ...(input.seed === undefined ? {} : { seed: input.seed }),
      },
    };
  if (model.protocol === 'seedance')
    return {
      model: model.id,
      duration,
      resolution,
      ratio:
        model.framesUseAdaptiveRatio && frames.some(({ role }) => role === 'first_frame')
          ? 'adaptive'
          : ratio,
      content: [
        { type: 'text', text: prompt },
        ...frames.map(({ url, role }) => ({
          type: 'image_url',
          image_url: { url },
          role,
        })),
      ],
    };
  if (model.protocol === 'video-lt') {
    const body = { model: model.id, prompt, duration };
    const first = frames.find(
      ({ role }, index) =>
        role === 'first_frame' &&
        (input.references[index]?.role ||
          (!input.references[index] && model.referenceMode === 'frames')),
    );
    const last = frames.find(({ role }) => role === 'last_frame');
    if (first)
      return {
        ...body,
        start_image_url: first.url,
        ...(last ? { end_image_url: last.url } : {}),
      };
    const [width, height] = ratio.split(':').map(Number);
    const lists = {
      images: frames.filter(({ kind }) => kind === 'image').map(({ url }) => url),
      videos: frames.filter(({ kind }) => kind === 'video').map(({ url }) => url),
      audios: frames.filter(({ kind }) => kind === 'audio').map(({ url }) => url),
    };
    return {
      ...body,
      orientation: width >= height ? 'landscape' : 'portrait',
      ...(model.supportsWatermark ? { watermark: input.watermark ?? false } : { ratio }),
      ...Object.fromEntries(Object.entries(lists).filter(([, urls]) => urls.length)),
    };
  }
  return {
    model: model.id,
    prompt,
    resolution,
    duration,
    aspect_ratio: ratio,
    ...(references.length > 1
      ? { reference_images: references.map((url) => ({ url })) }
      : references[0]
        ? { image: { url: references[0] } }
        : {}),
  };
}

export function publicMediaUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    // Untrusted model output is not a network destination unless it is an absolute HTTPS URL.
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readMediaPayload(
  protocol: IagentMediaProtocol,
  payload: unknown,
  format: IagentImageFormat = 'png',
) {
  const top = object(payload);
  const root =
    Number(top.code) === 0 && top.data && typeof top.data === 'object' && !Array.isArray(top.data)
      ? object(top.data)
      : top;
  const output = object(root.output);
  const data = object(root.data);
  const error = object(root.error);
  const video = object(root.video);
  const content = object(root.content);
  const code = string(root.code);
  const status = string(
    protocol === 'bailian' ? output.task_status : (root.status ?? data.status ?? video.status),
  )?.toLowerCase();
  const id = string(
    protocol === 'bailian'
      ? output.task_id
      : (root.task_id ?? root.id ?? data.id ?? root.request_id ?? data.request_id),
  );
  const failure =
    ['failed', 'error', 'cancelled', 'canceled', 'expired', 'deleted'].includes(status ?? '') ||
    (protocol === 'bailian' && (status === 'unknown' || Boolean(code && code !== '0')));
  const done = ['completed', 'complete', 'done', 'succeeded', 'success'].includes(status ?? '');
  const message = string(
    error.message ??
      output.message ??
      data.fail_reason ??
      root.fail_reason ??
      root.error ??
      root.message,
  );
  const outputs: string[] = [];

  if (protocol.endsWith('-image')) {
    let rawResult = root.result;
    if (typeof rawResult === 'string') {
      try {
        rawResult = JSON.parse(rawResult);
      } catch {
        rawResult = undefined;
      }
    }
    const result = object(rawResult ?? root);
    const wrapped = object(result.data);
    const generic = [...array(result.data), ...array(wrapped.data)];
    const firstUrl = string(root.image_url);
    if (firstUrl) outputs.push(firstUrl);
    for (const item of generic.map(object)) {
      const url = string(item.url);
      const encoded = string(item.b64_json);
      if (url) outputs.push(url);
      else if (encoded)
        outputs.push(`data:image/${format === 'svg' ? 'svg+xml' : format};base64,${encoded}`);
    }
    for (const candidate of array(result.candidates).map(object)) {
      for (const part of array(object(candidate.content).parts).map(object)) {
        const inline = object(part.inlineData ?? part.inline_data);
        const encoded = string(inline.data);
        const mime = string(inline.mimeType ?? inline.mime_type) ?? 'image/png';
        if (encoded) outputs.push(`data:${mime};base64,${encoded}`);
      }
    }
  } else {
    const result = object(root.result);
    const source = string(
      protocol === 'bailian'
        ? output.video_url
        : (root.video_url ??
            data.video_url ??
            data.result_url ??
            root.result_url ??
            video.url ??
            object(data.video).url ??
            content.video_url ??
            object(data.content).video_url ??
            result.video_url ??
            object(result.video).url ??
            output.url ??
            root.url),
    );
    if (source)
      outputs.push(source.startsWith('/v1/videos/') ? new URL(source, IAGENT_ORIGIN).href : source);
  }

  return {
    id,
    failure,
    done,
    running: !failure && !done && Boolean(status),
    message,
    outputs: [...new Set(outputs)],
  };
}
