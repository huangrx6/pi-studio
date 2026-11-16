export const MODEL_CATALOG_PAGE_SIZE = 100;

/** Search the whole catalog before taking a visible page. No result is discarded. */
export function modelCatalogPage<T extends { id: string; name: string; model?: string }>(models: T[], query: string, limit = MODEL_CATALOG_PAGE_SIZE) {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = normalized ? models.filter((item) => `${item.name} ${item.id} ${item.model || ''}`.toLocaleLowerCase().includes(normalized)) : models;
  const size = Math.max(MODEL_CATALOG_PAGE_SIZE, Number.isFinite(limit) ? Math.floor(limit) : MODEL_CATALOG_PAGE_SIZE);
  return { items: matches.slice(0, size), total: matches.length, remaining: Math.max(0, matches.length - size) };
}

export function discoverySelection<T extends { id: string }>(discovered: T[], catalog: { model: string }[], selected: string[]) {
  const addedIds = new Set(catalog.map((item) => item.model));
  const selectedIds = new Set(selected);
  const missing = discovered.filter((item) => !addedIds.has(item.id));
  const selectedMissing = missing.filter((item) => selectedIds.has(item.id));
  return { addedIds, selectedIds, missing, selectedMissing, allMissingSelected: missing.length > 0 && selectedMissing.length === missing.length };
}
