import type { QuotaField, QuotaPreviewInput } from '../../types/provider-quota';

const percentages = [32, 58, 76];

function exampleValue(field: QuotaField, index: number, today: Date): string | number {
  const percent = percentages[index % percentages.length];
  switch (field.format) {
    case 'number': return 120 * (index + 1);
    case 'percent': return percent;
    case 'fraction': return percent / 100;
    case 'enum': return field.translations.trim().split('=', 1)[0].trim();
    case 'time': return new Date(today.getFullYear(), today.getMonth(), today.getDate() + index + 1, 12).getTime();
  }
}

export function quotaExampleInput(fields: QuotaField[]): QuotaPreviewInput {
  const today = new Date();
  // Give each metric a sample value independently of the provider's response shape.
  return {
    fields: fields.map((field, index) => ({ ...field, path: `[${index}]` })),
    sample: JSON.stringify(fields.map((field, index) => exampleValue(field, index, today))),
  };
}
