import { IagentError } from '@/shared/contracts/iagent';
import type {
  IagentImageFormat,
  IagentMediaInput,
  IagentMediaProtocol,
} from '@/shared/contracts/iagentCreative';

const standardRatios = ['1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9'];
const extendedRatios = ['4:1', '1:4', '8:1', '1:8'];
const pixels = { '1K': 1024 ** 2, '2K': 2048 ** 2, '4K': 3840 * 2160 } as const;
const geminiDimensions = {
  '1:1': [1024, 1024],
  '4:3': [1200, 896],
  '3:4': [896, 1200],
  '3:2': [1264, 848],
  '2:3': [848, 1264],
  '5:4': [1152, 928],
  '4:5': [928, 1152],
  '16:9': [1376, 768],
  '9:16': [768, 1376],
  '21:9': [1584, 672],
  '4:1': [2048, 512],
  '1:4': [512, 2048],
  '8:1': [3072, 384],
  '1:8': [384, 3072],
} satisfies Record<string, [number, number]>;
const legacyGemini = {
  '1:1': [1024, 1024],
  '4:3': [1184, 864],
  '3:4': [864, 1184],
  '3:2': [1248, 832],
  '2:3': [832, 1248],
  '5:4': [1152, 896],
  '4:5': [896, 1152],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '21:9': [1536, 672],
} as Record<string, [number, number]>;

export function canonicalMediaModel(value: string) {
  return (
    value
      .trim()
      .replace(/^models\//i, '')
      .split('/')
      .findLast(Boolean) ?? value
  );
}

function geminiFamily(name: string) {
  const key = canonicalMediaModel(name)
    .toLowerCase()
    .replace(/[-_. ]/g, '');
  if (/^(?:gemini31flashliteimage|nanobanana2lite)/.test(key)) return 'lite';
  if (/^(?:gemini31flashimage|nanobanana2)/.test(key)) return 'flash';
  if (/^(?:gemini3(?:1)?proimage|nanobananapro)/.test(key)) return 'pro';
  if (/^(?:gemini25flashimage|nanobanana)/.test(key)) return 'legacy';
}

export function imageModelOptions(protocol: IagentMediaProtocol, model: string) {
  const id = canonicalMediaModel(model);
  const gemini = protocol !== 'grok-image' && geminiFamily(id);
  const gpt2 = protocol === 'openai-image' && /^gpt-image-2(?:\.\d+)?(?:-|$)/i.test(id);
  const gpt26 = gpt2 && /^gpt-image-2\.6(?:-|$)/i.test(id);
  const gpt = protocol === 'openai-image' && /^gpt-image-/i.test(id);
  const grok = protocol === 'grok-image';
  const grokEdit = grok && /^grok[-_]imagine[-_]edit$/i.test(id);
  const supportsReferences = grok ? grokEdit : !/^dall-e-3$|^imagen-/i.test(id);
  const supports4K = gpt2 || gemini === 'flash' || gemini === 'pro';
  const outputFormats: readonly IagentImageFormat[] = gpt26
    ? ['png', 'jpeg', 'webp', 'gif', 'svg']
    : gpt
      ? ['png', 'jpeg', 'webp']
      : ['png'];
  const ratios = gpt2
    ? [...standardRatios, '9:21', '3:1', '1:3']
    : grok
      ? []
      : gemini === 'flash'
        ? [...standardRatios, ...extendedRatios]
        : gemini || protocol === 'gemini-image'
          ? standardRatios
          : /^dall-e-3$/i.test(id)
            ? ['1:1', '16:9', '9:16']
            : /^dall-e-2$/i.test(id)
              ? ['1:1']
              : ['1:1', '3:2', '2:3'];

  return {
    kind: 'image',
    ratios: ['auto', ...ratios],
    resolutions: supports4K
      ? ['auto', '1K', '2K', '4K']
      : gemini || protocol === 'gemini-image'
        ? ['auto', '1K']
        : [],
    durations: [],
    defaultRatio: 'auto',
    referenceMode: supportsReferences ? 'image' : 'none',
    referenceLimits: { image: supportsReferences ? (grok ? 1 : 6) : 0 },
    requiresReference: grokEdit,
    customSize: gpt2 ? 'exact' : gemini ? 'ratio' : undefined,
    supportsQuality: gpt,
    supportsComplexity: gpt26,
    outputFormats,
  } as const;
}

type ImageInput = Pick<
  IagentMediaInput,
  'model' | 'ratio' | 'resolution' | 'size' | 'outputFormat'
>;

function positiveDimensions(size: NonNullable<ImageInput['size']>) {
  return (
    Number.isSafeInteger(size.width) &&
    size.width > 0 &&
    Number.isSafeInteger(size.height) &&
    size.height > 0
  );
}

function getGeminiConfig(input: ImageInput) {
  const { model, size, ratio } = input;
  const legacy = geminiFamily(model.id) === 'legacy';
  const dimensions: Record<string, [number, number]> = legacy ? legacyGemini : geminiDimensions;
  const enabled = model.ratios.filter((candidate) => dimensions[candidate]);
  let aspectRatio = ratio === 'auto' ? '1:1' : ratio;
  let resolution = input.resolution === 'auto' || !input.resolution ? '1K' : input.resolution;
  if (size) {
    if (!positiveDimensions(size) || !enabled.length) throw new IagentError('request');
    const wanted = size.width / size.height;
    const maxRatio = Math.max(
      ...enabled.map((candidate) => {
        const [w, h] = dimensions[candidate];
        const [rw, rh] = candidate.split(':').map(Number);
        return Math.max(w / h, h / w, rw / rh, rh / rw);
      }),
    );
    if (Math.max(wanted, 1 / wanted) > maxRatio) throw new IagentError('request');
    const distance = (candidate: string) => {
      const [w, h] = dimensions[candidate];
      return Math.abs(Math.log(wanted / (w / h)));
    };
    aspectRatio = enabled.reduce((closest, candidate) =>
      distance(candidate) < distance(closest) ? candidate : closest,
    );
    const [w, h] = dimensions[aspectRatio];
    const scale = Math.max(size.width / w, size.height / h);
    if (scale > 4) throw new IagentError('request');
    resolution = scale <= 1 ? '1K' : scale <= 2 ? '2K' : '4K';
  }
  if (!model.resolutions.includes(resolution)) throw new IagentError('request');
  const [width, height] = dimensions[aspectRatio] ?? dimensions['1:1'];
  const multiplier = resolution === '4K' ? 4 : resolution === '2K' ? 2 : 1;
  return {
    aspectRatio,
    imageSize:
      !legacy && (size || (input.resolution && input.resolution !== 'auto'))
        ? resolution
        : undefined,
    pixels: `${width * multiplier}x${height * multiplier}`,
  };
}

export function resolveIagentImageOptions(input: ImageInput) {
  const { model, ratio, resolution, size, outputFormat } = input;
  if (size && (!model.customSize || !positiveDimensions(size))) throw new IagentError('request');
  if (model.protocol === 'grok-image') return {};
  if (model.protocol === 'gemini-image' || model.customSize === 'ratio') {
    const config = getGeminiConfig(input);
    return model.protocol === 'gemini-image'
      ? {
          gemini: {
            aspectRatio: config.aspectRatio,
            ...(config.imageSize ? { imageSize: config.imageSize } : {}),
          },
        }
      : { size: config.pixels };
  }
  if (outputFormat === 'gif') {
    if (!size) return {};
    if (size.width % 16 || size.height % 16) throw new IagentError('request');
    return { size: `${size.width}x${size.height}` };
  }
  if (!size && ratio === 'auto' && (!resolution || resolution === 'auto')) return {};
  const legacy = /^dall-e-3$/i.test(canonicalMediaModel(model.id));
  if (legacy) {
    const fixed = { '1:1': '1024x1024', '16:9': '1792x1024', '9:16': '1024x1792' };
    return { size: fixed[ratio as keyof typeof fixed] };
  }
  const [ratioWidth, ratioHeight] = (ratio === 'auto' ? '1:1' : ratio).split(':').map(Number);
  const longRatio = Math.max(ratioWidth, ratioHeight) / Math.min(ratioWidth, ratioHeight);
  const target = resolution ? pixels[resolution as keyof typeof pixels] : undefined;
  const longSide = Math.min(
    3840,
    target
      ? Math.floor(Math.sqrt(target * longRatio) / 16) * 16
      : Math.round((1024 * longRatio) / 16) * 16,
  );
  const shortSide = target ? Math.round(longSide / longRatio / 16) * 16 : 1024;
  const [width, height] = size
    ? [Math.ceil(size.width / 16) * 16, Math.ceil(size.height / 16) * 16]
    : ratioWidth >= ratioHeight
      ? [longSide, shortSide]
      : [shortSide, longSide];
  if (
    Math.max(width, height) > 3840 ||
    Math.max(width, height) / Math.min(width, height) > 3 ||
    width * height < 655_360 ||
    width * height > 8_294_400
  )
    throw new IagentError('request');
  return { size: `${width}x${height}` };
}
