import { IAGENT_ORIGIN, iagentProviderId } from '@/shared/contracts/iagent';
import { createUniqueModelId, ENDPOINT_TYPE, type EndpointType } from '@/shared/data/types/model';

export type IagentGroup = {
  id: number;
  name: string;
  platform: string;
  status: string;
  rate_multiplier?: number;
};
export type IagentModel = {
  id: string;
  name?: string;
  group_id: number;
  group_name?: string;
  platform?: string;
  owned_by?: string;
  context_length?: number | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
};
export type IagentCatalogResponse = { models: IagentModel[]; group_order?: number[] };

export const IAGENT_IMAGE_MODEL =
  /gpt[-_. ]?image|dall[-_. ]?e|imagegen|imagen|image[-_ ]generation|image[-_ ]preview|flash[-_ ]image|pro[-_ ]image|nano[-_. ]?banana|stable[-_ ]?diffusion|midjourney|flux(?:[-_. ]|$)|seedream|ideogram|qwen[-_ ]?image|grok[-_ ]?imagine/i;
const NON_CHAT_MODEL =
  /(?:^|[\s/])jev(?:[-/\s]|$)|typesafe|codex[-_. ]?auto[-_. ]?review|seedance|wan3[._-]0-video|video[-_ ]generation|(?:^|[\s/_-])(?:sora|veo)(?:[\s/_.-]|$)|embed|rerank|whisper|tts|transcri|moderation|(?:^|[-_/ ])speech(?:$|[-_/ ])/i;
const NON_CHAT_PLATFORM = /^(?:typesafe|bailian|wan|wan3|seedance|video[-_]?lt)$/i;

export const IAGENT_CHAT_ENDPOINTS = {
  [ENDPOINT_TYPE.OPENAI_RESPONSES]: { path: '/v1/responses', adapterFamily: 'openai' },
  [ENDPOINT_TYPE.ANTHROPIC_MESSAGES]: { path: '/v1/messages', adapterFamily: 'anthropic' },
  [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
    path: '/v1/chat/completions',
    adapterFamily: 'openai-compatible',
  },
} as const satisfies Partial<Record<EndpointType, { path: string; adapterFamily: string }>>;

export type IagentEndpoint = keyof typeof IAGENT_CHAT_ENDPOINTS;

export function isIagentEndpoint(endpoint: EndpointType | undefined): endpoint is IagentEndpoint {
  return endpoint !== undefined && Object.hasOwn(IAGENT_CHAT_ENDPOINTS, endpoint);
}

function chatEndpoint(groupPlatform: string, model: IagentModel): IagentEndpoint {
  const platform = groupPlatform.toLowerCase();
  if (platform === 'openai') return ENDPOINT_TYPE.OPENAI_RESPONSES;
  if (platform === 'anthropic') return ENDPOINT_TYPE.ANTHROPIC_MESSAGES;
  if (!platform || platform === 'composite') {
    const text = `${model.id} ${model.name ?? ''} ${model.owned_by ?? ''}`.toLowerCase();
    if (/\bclaude\b|anthropic/.test(text)) return ENDPOINT_TYPE.ANTHROPIC_MESSAGES;
    if (
      !/kimi|moonshot|\bglm\b|zhipu|bigmodel|deepseek|minimax|opencode|grok|xai|gemini|google|antigravity/.test(
        text,
      )
    )
      return ENDPOINT_TYPE.OPENAI_RESPONSES;
  }
  return ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS;
}

function tokenLimit(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function publicIagentGroups(catalog: IagentCatalogResponse): IagentGroup[] {
  const groups = new Map<number, IagentGroup>();
  for (const row of catalog.models) {
    if (!Number.isSafeInteger(row.group_id) || row.group_id <= 0) continue;
    const platform = row.platform ?? '';
    const group = groups.get(row.group_id);
    if (!group) {
      groups.set(row.group_id, {
        id: row.group_id,
        name: row.group_name || 'iAgent',
        platform,
        status: 'active',
      });
    } else if (group.platform !== platform) {
      group.platform = 'composite';
    }
  }
  return [...groups.values()];
}

export function selectIagentCatalog(groups: IagentGroup[], catalog: IagentCatalogResponse) {
  const order = new Map(catalog.group_order?.map((id, index) => [id, index]));
  return groups
    .filter(
      ({ id, status, platform }) =>
        Number.isSafeInteger(id) &&
        id > 0 &&
        status === 'active' &&
        !NON_CHAT_PLATFORM.test(platform),
    )
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
    .flatMap((group) => {
      const providerId = iagentProviderId(group.id);
      const rows = new Map<string, (typeof catalog.models)[number]>();
      for (const model of catalog.models) {
        if (
          typeof model.id === 'string' &&
          model.id.trim() &&
          model.group_id === group.id &&
          !NON_CHAT_PLATFORM.test(model.platform ?? '') &&
          !IAGENT_IMAGE_MODEL.test(`${model.id} ${model.name ?? ''}`) &&
          !NON_CHAT_MODEL.test(`${model.id} ${model.name ?? ''} ${model.owned_by ?? ''}`)
        )
          rows.set(model.id, model);
      }
      const endpoints: Partial<Record<IagentEndpoint, { baseUrl: string; adapterFamily: string }>> =
        {};
      const models = [...rows.values()].map((model) => {
        const endpoint = chatEndpoint(group.platform ?? '', model);
        endpoints[endpoint] = {
          baseUrl: `${IAGENT_ORIGIN}/v1`,
          adapterFamily: IAGENT_CHAT_ENDPOINTS[endpoint].adapterFamily,
        };
        return {
          id: createUniqueModelId(providerId, model.id),
          providerId,
          modelId: model.id,
          name: model.name || model.id,
          capabilities: [],
          endpointTypes: [endpoint],
          supportsStreaming: true,
          contextWindow: tokenLimit(model.context_length),
          maxInputTokens: tokenLimit(model.max_input_tokens),
          maxOutputTokens: tokenLimit(model.max_output_tokens),
          isEnabled: true,
          isHidden: false,
        };
      });
      const defaultChatEndpoint = models[0]?.endpointTypes[0];
      return defaultChatEndpoint
        ? [
            {
              providerId,
              name: group.name === 'iAgent' ? 'iAgent' : `iAgent · ${group.name}`,
              models,
              endpointConfigs: endpoints,
              defaultChatEndpoint,
            },
          ]
        : [];
    });
}

export type IagentCatalog = ReturnType<typeof selectIagentCatalog>;
export type IagentGroups = Parameters<typeof selectIagentCatalog>[0];
