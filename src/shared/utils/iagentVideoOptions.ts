import { IagentError } from '@/shared/contracts/iagent';
import {
  IAGENT_WAN_MODES,
  type IagentMediaInput,
  type IagentMediaReference,
  type IagentReferenceKind,
  type IagentReferenceRole,
  type IagentWanMode,
} from '@/shared/contracts/iagentCreative';

export const wanReferenceLimits = { image: 10, video: 5, audio: 5, file: 1, link: 1 } as const;

export function mediaReferenceRole(
  reference: IagentMediaReference | undefined,
  index: number,
): IagentReferenceRole {
  return reference?.role ?? (index === 0 ? 'first_frame' : 'last_frame');
}

export function wanModeFromReferences(
  input: Pick<IagentMediaInput, 'wanMode' | 'references'>,
): IagentWanMode {
  return (
    input.wanMode ??
    (input.references.some((item) => item.role === 'last_frame')
      ? 'first-last-frame'
      : input.references.some((item) => item.role === 'first_frame')
        ? 'first-frame'
        : input.references.length
          ? 'reference'
          : 'text')
  );
}

export function wanDurationChoices(references: IagentMediaReference[]) {
  const videos = references.filter((reference) => reference.kind === 'video');
  const used = videos.reduce(
    (total, { duration }) => total + (duration && duration >= 1 ? duration : 1),
    0,
  );
  const minimum = videos.length ? 1 : 2;
  const maximum = Math.max(minimum, Math.floor(30 - used + 1e-9));
  return [-1, ...Array.from({ length: maximum - minimum + 1 }, (_, index) => index + minimum)];
}

export function validateVideoReferences(input: IagentMediaInput): void {
  const { model, references, prompt } = input;
  const roles = references.map((item, index) =>
    model.protocol === 'seedance' ? mediaReferenceRole(item, index) : item.role,
  );
  const hasFirst = roles.includes('first_frame');
  const hasLast = roles.includes('last_frame');
  if (
    roles.filter((role) => role === 'first_frame').length > 1 ||
    roles.filter((role) => role === 'last_frame').length > 1 ||
    (hasLast && !hasFirst) ||
    ((hasFirst || hasLast) &&
      references.some(
        (item, index) =>
          (item.kind && item.kind !== 'image') ||
          (roles[index] !== 'first_frame' && roles[index] !== 'last_frame'),
      )) ||
    roles.some((role) => role && !model.referenceRoles?.includes(role))
  )
    throw new IagentError('request');

  const ofKind = (kind: IagentReferenceKind) =>
    references.filter((item) => (item.kind ?? 'image') === kind);
  if (model.protocol === 'bailian') {
    const mode = wanModeFromReferences(input);
    const frame = mode === 'first-frame' || mode === 'first-last-frame';
    const editing = mode === 'edit' || mode === 'extend';
    const documents = ofKind('file').length + ofKind('link').length;
    if (
      !IAGENT_WAN_MODES.includes(mode) ||
      (mode === 'text' && (references.length || !prompt.trim())) ||
      (frame && (!hasFirst || hasLast !== (mode === 'first-last-frame'))) ||
      (!frame && hasFirst) ||
      (mode === 'reference' && !references.length) ||
      (editing && (!ofKind('video').length || documents || !prompt.trim())) ||
      documents > 1 ||
      references.length > 20 ||
      !wanDurationChoices(references).includes(input.duration ?? 0) ||
      (input.seed !== undefined &&
        (!Number.isSafeInteger(input.seed) || input.seed < -1 || input.seed > 2_147_483_647))
    )
      throw new IagentError('request');
    for (const kind of ['video', 'audio'] as const) {
      const clips = ofKind(kind);
      if (
        clips.some(
          ({ duration }) =>
            duration !== undefined && (!Number.isFinite(duration) || duration < 1 || duration > 15),
        ) ||
        clips.reduce((sum, item) => sum + (item.duration ?? 0), 0) > 15
      )
        throw new IagentError('request');
    }
  }

  if (model.protocol === 'video-lt' && !hasFirst) {
    const images = ofKind('image').length;
    const videos = ofKind('video').length;
    const audio = ofKind('audio').length;
    const name = `${model.id} ${model.name}`;
    const requireImage =
      model.requiresReference || (/sd-2-(?:fast|mini|vip)/i.test(name) && videos > 0);
    const tags = [...prompt.matchAll(/@(image|video|audio|图片|视频|音频)?([0-9]+)\b/gi)];
    const counts: Record<string, number> = {
      '': references.length,
      image: images,
      video: videos,
      audio,
      图片: images,
      视频: videos,
      音频: audio,
    };
    const requireTags = references.length && /sd-(?:2\.5|2-vip)/i.test(name);
    if (
      (requireImage && !images) ||
      (requireTags && !tags.length) ||
      tags.some(
        (tag) => Number(tag[2]) < 1 || Number(tag[2]) > (counts[tag[1]?.toLowerCase() || ''] ?? 0),
      )
    )
      throw new IagentError('request');
    const clips = [...ofKind('video'), ...ofKind('audio')];
    if (
      clips.some(
        ({ duration }) =>
          duration !== undefined && (!Number.isFinite(duration) || duration < 3 || duration > 10),
      ) ||
      clips.reduce((sum, item) => sum + (item.duration ?? 3), 0) > 15
    )
      throw new IagentError('request');
  }
}
