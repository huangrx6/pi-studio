export const QUOTA_EXTENSION_ID = 'user:pi-quota-status';

export function quotaExtensionAvailable(extensions?: Array<{ id: string; available: boolean }>) {
  return extensions?.some(extension => extension.id === QUOTA_EXTENSION_ID && extension.available) === true;
}

export type QuotaField = {
  path: string;
  label: string;
  format: 'number' | 'percent' | 'fraction' | 'enum' | 'time';
  unit: string;
  translations: string;
  summary: boolean;
};

export type ProviderQuotaConfig = {
  enabled: boolean;
  endpoint: string;
  auth: 'none' | 'bearer' | 'authorization' | 'x-api-key' | 'api-key' | 'x-goog-api-key' | 'custom-header' | 'query';
  authName?: string;
  headers?: Array<{ name: string; value: string }>;
  fields: QuotaField[];
};

export type QuotaMetric = { label: string; value: string | null; summary: boolean; percent?: number; issue?: string };
export type ProviderQuotaSnapshot = {
  status: 'disabled' | 'ready' | 'unmapped' | 'error' | 'stale';
  metrics: QuotaMetric[];
  updatedAt?: number;
  message?: string;
};
export type QuotaFieldSuggestion = Pick<QuotaField, 'path' | 'format'>;

export function emptyQuotaField(summary = true): QuotaField {
  return { label: '', path: '', format: 'number', unit: '', translations: '', summary };
}
export function emptyProviderQuota(): ProviderQuotaConfig {
  return { enabled: false, endpoint: '', auth: 'none', fields: [emptyQuotaField()] };
}
