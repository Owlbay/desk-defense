import type { Dict } from '../../index';

// Namespace agent · model catalog (per-model thinking levels and prices, data from modelinfo.dev) (en)
export default {
  'agent.think.clamped': '{model} has no "{from}" level; using "{to}"',
  'agent.mi.think.unknown': 'This model is not in the catalog; generic levels are sent.',
  'agent.mi.think.noReasoning': '{model} does not support thinking; only "No thinking" is available.',
  'agent.mi.think.levels': '{model} supports: {levels}.',
  'agent.mi.think.perModel': 'Remembered per model.',
  'agent.mi.priceKnown': 'Input {in} · output {out} / 1M tokens',
  'agent.mi.priceManual': 'Manual: input {in} · output {out} / 1M tokens',
  'agent.mi.cache': 'cache read {cr}',
  'agent.mi.perWave': '≈ {cost} / wave',
  'agent.mi.source': 'Data from modelinfo.dev ({date})',
  'agent.mi.priceUnknown': 'Price unknown — you can enter it under Advanced settings',
  'agent.mi.priceLocal': 'Local model, free',
  'agent.mi.hudUnknown': 'price unknown',
  'agent.mi.adv': 'Advanced settings',
  'agent.mi.advHint': 'Usually no need to change: tool mode is detected by "Test connection", context mode defaults to Balanced.',
  'agent.mi.price.title': 'Price',
  'agent.mi.price.label': 'Manual price (USD / 1M tokens)',
  'agent.mi.price.in': 'Input',
  'agent.mi.price.out': 'Output',
  'agent.mi.price.cr': 'Cache read',
  'agent.mi.price.cw': 'Cache write',
  'agent.mi.price.hint': 'Applies to the current model ({model}) only; leave blank to use the catalog price (shown in grey).',
} satisfies Dict;
