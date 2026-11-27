import type {
  IagentModelQuote,
  IagentPriceField,
  IagentPriceGroup,
  IagentPriceUnit,
} from '@/shared/contracts/iagent';

import { IAGENT_IMAGE_MODEL, type IagentGroup, type IagentModel } from './iagentCatalog';

const tokenFields = {
  input: 'input_price',
  output: 'output_price',
  cacheRead: 'cache_read_price',
  cacheWrite: 'cache_write_price',
  cacheWriteHour: 'cache_write_1h_price',
  imageInput: 'image_input_price',
  imageOutput: 'image_output_price',
} as const;

type TokenField = keyof typeof tokenFields;
type TokenPrices = Partial<Record<(typeof tokenFields)[TokenField], number | null>>;
type PriceInterval = TokenPrices & {
  min_tokens: number;
  max_tokens?: number | null;
  tier_label?: string;
  input_multiplier?: number;
  output_multiplier?: number;
  cache_write_multiplier?: number;
  cache_read_multiplier?: number;
  per_request_price?: number | null;
};
type Pricing = TokenPrices & {
  found?: boolean;
  billing_mode?: string;
  per_request_price?: number | null;
  intervals?: PriceInterval[];
};
type Rates = {
  id: number;
  rate_multiplier?: number;
  user_rate_multiplier?: number;
  long_context_pricing_enabled?: boolean;
  image_rate_independent?: boolean;
  image_rate_multiplier?: number;
  image_price_1k?: number | null;
  image_price_2k?: number | null;
  image_price_4k?: number | null;
  video_rate_independent?: boolean;
  video_rate_multiplier?: number;
  video_price_480p?: number | null;
  video_price_720p?: number | null;
  video_price_1080p?: number | null;
  video_model_prices?: Record<string, Partial<Record<string, number>>>;
};
type Model = IagentModel & { default_pricing?: Pricing; rate_multiplier?: number };
type PlazaModel = { name: string; platform: string; pricing: Pricing | null };
type ChannelModel = {
  name?: string;
  id?: string;
  model?: string;
  model_name?: string;
  group_id?: number;
  group_ids?: number[];
  pricing?: Pricing | null;
};
type PriceLine = IagentModelQuote['prices'][number];

export type IagentPricingCatalog = {
  models: Model[];
  group_order?: number[];
  group_pricing?: Rates[];
};
export type IagentPricingPlaza = { groups: (Rates & { models: PlazaModel[] })[] };
export type IagentPricingChannels = {
  platforms: {
    platform: string;
    groups: { id: number }[];
    supported_models: ChannelModel[];
  }[];
}[];

const tokenMultiplier: Partial<Record<TokenField, keyof PriceInterval>> = {
  input: 'input_multiplier',
  output: 'output_multiplier',
  cacheRead: 'cache_read_multiplier',
  cacheWrite: 'cache_write_multiplier',
};
const videoName =
  /grok[-_. ]?imag(?:ine|en)[-_. ]?video|seedance|wan3[._-]0-video|(?:^|[\s/_-])(?:sora|veo)(?:$|[\s/_.-])|video[-_ ]generation/i;

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nameKey(name = '') {
  const value = name.trim().toLowerCase().replace(/^\/+/, '');
  return value.includes('/models/')
    ? value.split('/models/').at(-1)!
    : value.replace(/^models\//, '');
}

function platformKey(platform = '') {
  const value = platform.trim().toLowerCase();
  return value === 'claude' ? 'anthropic' : value;
}

function indexChannels(channels: IagentPricingChannels) {
  const index = new Map<string, Pricing[]>();
  for (const channel of channels) {
    for (const section of channel.platforms ?? []) {
      for (const model of section.supported_models ?? []) {
        if (!model.pricing) continue;
        const groups = model.group_ids?.length
          ? model.group_ids
          : model.group_id == null
            ? section.groups.map(({ id }) => id)
            : [model.group_id];
        for (const group of groups) {
          for (const name of new Set(
            [model.id, model.name, model.model, model.model_name].map(nameKey),
          )) {
            if (!name) continue;
            const key = JSON.stringify([group, platformKey(section.platform), name]);
            const entries = index.get(key) ?? [];
            entries.push(model.pricing);
            index.set(key, entries);
          }
        }
      }
    }
  }
  return index;
}

function channelPrices(index: ReturnType<typeof indexChannels>, model: Model, platform: string) {
  const found = [model.id, model.name].flatMap(
    (name) =>
      index.get(JSON.stringify([model.group_id, platformKey(platform), nameKey(name)])) ?? [],
  );
  function score(pricing: Pricing) {
    const flat = Object.values(tokenFields);
    const complete =
      flat.filter((field) => amount(pricing[field]) !== undefined).length +
      (pricing.intervals?.length ?? 0) * 2;
    const custom = flat.filter((field) => {
      const value = amount(pricing[field]);
      const base = amount(model.default_pricing?.[field]);
      return (
        value !== undefined &&
        (base === undefined || Math.abs(value - base) > Math.max(1e-15, base * 1e-9))
      );
    }).length;
    const perRequest =
      amount(pricing.per_request_price) !== undefined ||
      pricing.intervals?.some((tier) => amount(tier.per_request_price) !== undefined);
    return (
      100 *
        (perRequest || (pricing.billing_mode && pricing.billing_mode !== 'token') ? 10 : custom) +
      complete
    );
  }
  return found.reduce<Pricing | undefined>(
    (best, entry) => (!best || score(entry) > score(best) ? entry : best),
    undefined,
  );
}

function priceLine(
  field: IagentPriceField,
  unit: IagentPriceUnit,
  value: unknown,
  detail?: string,
): PriceLine[] {
  const price = amount(value);
  if (price === undefined) return [];
  return [
    {
      field,
      unit,
      usd: price * (unit === 'tokens' || unit === 'imageTokens' ? 1_000_000 : 1),
      detail,
    },
  ];
}

function tierLabel(tier: PriceInterval) {
  const compact = (value: number) =>
    value >= 1_000_000
      ? `${value / 1_000_000}M`
      : value >= 1_000
        ? `${value / 1_000}K`
        : String(value);
  return (
    tier.tier_label?.trim() ||
    (tier.max_tokens == null
      ? `${compact(tier.min_tokens)}+`
      : `${compact(tier.min_tokens)}–${compact(tier.max_tokens)}`)
  );
}

function tokenLines(pricing: Pricing | null | undefined, tiersEnabled: boolean) {
  if (!pricing) return [];
  const fields = Object.entries(tokenFields) as [TokenField, (typeof tokenFields)[TokenField]][];
  const tiers = pricing.intervals?.length
    ? [...pricing.intervals].sort((a, b) => a.min_tokens - b.min_tokens)
    : [];
  return (tiers.length ? (tiersEnabled ? tiers : tiers.slice(0, 1)) : [undefined]).flatMap((tier) =>
    fields.flatMap(([field, key]) => {
      const multiplierKey = tokenMultiplier[field];
      const base = amount(pricing[key]);
      const factor = amount(multiplierKey && tier?.[multiplierKey]);
      return priceLine(
        field,
        field === 'imageInput' || field === 'imageOutput' ? 'imageTokens' : 'tokens',
        amount(tier?.[key]) ?? (base === undefined ? undefined : base * (factor || 1)),
        tier && tiersEnabled ? tierLabel(tier) : undefined,
      );
    }),
  );
}

function requestLines(pricing: Pricing | null | undefined, unit: IagentPriceUnit) {
  const tiers =
    pricing?.intervals?.flatMap((tier) =>
      priceLine('generation', unit, tier.per_request_price, tierLabel(tier)),
    ) ?? [];
  return tiers.length ? tiers : priceLine('generation', unit, pricing?.per_request_price);
}

function videoPriceKey(id: string) {
  const key = nameKey(id)
    .replace(/^(?:xai|x-ai|grok)\//, '')
    .replace('grok-imagen-video', 'grok-imagine-video');
  if (/^(?:grok-imagine-video-1\.5(?:-preview)?|grok-video-1\.5)$/.test(key))
    return 'grok-imagine-video-1.5';
  if (/^(?:grok-imagine-video(?:-preview)?|grok-video(?:-latest)?)$/.test(key))
    return 'grok-imagine-video';
  return key;
}

function quoteModel(
  model: Model,
  group: IagentGroup,
  rates: Rates,
  indexed: ReturnType<typeof indexChannels>,
  resolved?: PlazaModel,
): IagentModelQuote {
  const platform = resolved?.platform || model.platform || group.platform;
  const groupPlatform = platformKey(group.platform);
  const nativeVideo = ['bailian', 'video-lt'].includes(groupPlatform)
    ? groupPlatform
    : platformKey(platform);
  const name = `${model.id} ${model.name ?? ''}`;
  const pricing = resolved ? resolved.pricing : channelPrices(indexed, model, platform);
  const official = !resolved && model.default_pricing?.found ? model.default_pricing : undefined;
  const mode = pricing?.billing_mode?.toLowerCase();
  const video =
    ['bailian', 'video-lt'].includes(nativeVideo) ||
    (mode !== 'token' && (videoName.test(name) || mode === 'video'));
  const image = !video && mode !== 'token' && (IAGENT_IMAGE_MODEL.test(name) || mode === 'image');
  const standardRate = amount(rates.user_rate_multiplier) ?? amount(rates.rate_multiplier) ?? 1;
  let rate = standardRate;
  let prices: PriceLine[];

  if (video) {
    if (rates.video_rate_independent) rate = amount(rates.video_rate_multiplier) ?? rate;
    const modelPrices = rates.video_model_prices;
    if (nativeVideo === 'video-lt') {
      const perRequest = /minimax-h3/i.test(name);
      const resolution = perRequest
        ? '720p'
        : `${model.id.match(/-(480|720|1080)$/)?.[1] ?? '480'}p`;
      const alias = model.id === 'sd-2-vip' ? 'sd-2-vip-480' : 'sd-2-vip';
      const configured =
        modelPrices?.[model.id]?.[resolution] ??
        (/^sd-2-vip(?:-480)?$/.test(model.id) ? modelPrices?.[alias]?.[resolution] : undefined);
      prices = priceLine('generation', perRequest ? 'request' : 'second', configured, resolution);
    } else {
      const modelRate =
        modelPrices?.[nativeVideo === 'bailian' ? model.id : videoPriceKey(model.id)];
      prices = (['480p', '720p', '1080p'] as const).flatMap((resolution) =>
        priceLine(
          'generation',
          'second',
          modelRate?.[resolution] ?? rates[`video_price_${resolution}`],
          resolution,
        ),
      );
      if (!prices.length)
        prices = requestLines(
          pricing,
          nativeVideo === 'bailian' || mode === 'video' ? 'second' : 'video',
        );
    }
  } else if (image) {
    if (rates.image_rate_independent) rate = amount(rates.image_rate_multiplier) ?? rate;
    prices = resolved
      ? []
      : (['1k', '2k', '4k'] as const).flatMap((size) =>
          priceLine('generation', 'image', rates[`image_price_${size}`], size.toUpperCase()),
        );
    if (!prices.length) prices = requestLines(pricing, 'image');
    if (!prices.length) prices = tokenLines(official, false);
  } else if (mode === 'per_request') {
    prices = requestLines(pricing, 'request');
  } else {
    prices = tokenLines(pricing, rates.long_context_pricing_enabled !== false);
    if (!prices.length) prices = tokenLines(official, false);
  }
  return {
    id: model.id,
    name: model.name || model.id,
    platform,
    prices: [...new Map(prices.map((line) => [JSON.stringify(line), line])).values()],
    rate,
    reference: !resolved,
  };
}

export function buildIagentPriceGroups(
  groups: IagentGroup[],
  catalog: IagentPricingCatalog,
  channels: IagentPricingChannels = [],
  plaza?: IagentPricingPlaza,
  userRates: Record<string, number> = {},
): IagentPriceGroup[] {
  const ordered = new Map(catalog.group_order?.map((id, position) => [id, position]));
  const published = new Map(catalog.group_pricing?.map((group) => [group.id, group]));
  const effective = new Map(plaza?.groups?.map((group) => [group.id, group]));
  const indexed = indexChannels(channels);
  return groups
    .filter((group) => group.status === 'active')
    .map((group) => {
      const sources = catalog.models.filter((model) => model.group_id === group.id);
      const active = effective.get(group.id);
      const rates: Rates = {
        ...published.get(group.id),
        ...active,
        id: group.id,
        rate_multiplier:
          active?.rate_multiplier ??
          group.rate_multiplier ??
          published.get(group.id)?.rate_multiplier ??
          sources[0]?.rate_multiplier,
        user_rate_multiplier: amount(active?.user_rate_multiplier) ?? amount(userRates[group.id]),
      };
      const included = new Set<PlazaModel>();
      const models = sources.flatMap((source) => {
        const named =
          [source.id, source.name]
            .map(nameKey)
            .map((name) => active?.models?.filter((item) => nameKey(item.name) === name))
            .find((matches) => matches?.length) ?? [];
        const platform = platformKey(source.platform ?? group.platform);
        const exact = named.find((item) => platformKey(item.platform) === platform);
        const matches = exact ? [exact] : !platform || platform === 'composite' ? named : [];
        matches.forEach((match) => included.add(match));
        return matches.length
          ? matches.map((match) => quoteModel(source, group, rates, indexed, match))
          : [quoteModel(source, group, rates, indexed)];
      });
      for (const model of active?.models ?? []) {
        if (included.has(model)) continue;
        models.push(
          quoteModel({ id: model.name, group_id: group.id }, group, rates, indexed, model),
        );
      }
      const distinct = new Map<string, IagentModelQuote>();
      for (const model of models) {
        const key = JSON.stringify([nameKey(model.id), platformKey(model.platform)]);
        const previous = distinct.get(key);
        if (!previous || (previous.reference && !model.reference)) distinct.set(key, model);
      }
      const rate = amount(rates.user_rate_multiplier) ?? amount(rates.rate_multiplier) ?? 1;
      return { id: group.id, name: group.name, rate, models: [...distinct.values()] };
    })
    .filter((group) => group.models.length)
    .sort(
      (a, b) =>
        (ordered.get(a.id) ?? Infinity) - (ordered.get(b.id) ?? Infinity) ||
        b.name.localeCompare(a.name, undefined, { numeric: true }),
    );
}
