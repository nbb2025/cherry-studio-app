import { publicIagentGroups } from '../iagentCatalog';
import { buildIagentPriceGroups, type IagentPricingCatalog } from '../iagentModelPricing';

const catalog: IagentPricingCatalog = {
  group_order: [2, 1, 3, 4],
  group_pricing: [
    { id: 1, rate_multiplier: 0.5 },
    { id: 2, rate_multiplier: 1.5 },
    { id: 3, image_rate_independent: true, image_rate_multiplier: 0.8, image_price_1k: 0.06 },
    { id: 4, video_model_prices: { 'wan3.0-video': { '480p': 0.3, '1080p': 1.2 } } },
  ],
  models: [
    ...[1, 2].map((groupId) => ({
      id: 'gpt-test',
      group_id: groupId,
      platform: 'openai',
      default_pricing: { found: true, input_price: 0.000004 },
    })),
    { id: 'gpt-image-2.6-flare', group_id: 3, platform: 'openai' },
    { id: 'wan3.0-video', group_id: 4, platform: 'bailian' },
  ],
};

test('public prices retain group order, base rates and media billing units', () => {
  const groups = buildIagentPriceGroups(publicIagentGroups(catalog), catalog);
  expect(groups.map(({ id }) => id)).toEqual([2, 1, 3, 4]);
  expect(groups.slice(0, 2).map(({ models: [model] }) => model.prices[0].usd * model.rate)).toEqual(
    [6, 2],
  );
  expect(groups[2].models[0]).toMatchObject({
    rate: 0.8,
    prices: [{ field: 'generation', unit: 'image', usd: 0.06, detail: '1K' }],
  });
  expect(groups[3].models[0].prices).toEqual([
    { field: 'generation', unit: 'second', usd: 0.3, detail: '480p' },
    { field: 'generation', unit: 'second', usd: 1.2, detail: '1080p' },
  ]);
});

test('an account quote overrides the public estimate only for its own group', () => {
  const groups = buildIagentPriceGroups(
    publicIagentGroups(catalog).filter(({ id }) => id <= 2),
    catalog,
    [],
    {
      groups: [
        {
          id: 1,
          user_rate_multiplier: 0.25,
          models: [{ name: 'gpt-test', platform: 'openai', pricing: { input_price: 0.000002 } }],
        },
      ],
    },
  );
  expect(groups[0].models[0]).toMatchObject({ rate: 1.5, reference: true, prices: [{ usd: 4 }] });
  expect(groups[1].models[0]).toMatchObject({ rate: 0.25, reference: false, prices: [{ usd: 2 }] });
});
