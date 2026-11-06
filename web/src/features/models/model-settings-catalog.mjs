export const MODEL_CATALOG_PAGE_SIZE = 100;

/** Search the whole catalog before taking a visible page. No result is discarded.
 * @template {{id:string,name:string,model?:string}} T
 * @param {T[]} models @param {string} query @param {number} [limit]
 */
export function modelCatalogPage(models, query, limit = MODEL_CATALOG_PAGE_SIZE) {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = normalized ? models.filter((item) => `${item.name} ${item.id} ${item.model || ''}`.toLocaleLowerCase().includes(normalized)) : models;
  const size = Math.max(MODEL_CATALOG_PAGE_SIZE, Number.isFinite(limit) ? Math.floor(limit) : MODEL_CATALOG_PAGE_SIZE);
  return { items: matches.slice(0, size), total: matches.length, remaining: Math.max(0, matches.length - size) };
}

/** @template {{id:string}} T
 * @param {T[]} discovered @param {Array<{model:string}>} catalog @param {string[]} selected
 */
export function discoverySelection(discovered, catalog, selected) {
  const addedIds = new Set(catalog.map((item) => item.model));
  const selectedIds = new Set(selected);
  const missing = discovered.filter((item) => !addedIds.has(item.id));
  const selectedMissing = missing.filter((item) => selectedIds.has(item.id));
  return { addedIds, selectedIds, missing, selectedMissing, allMissingSelected: missing.length > 0 && selectedMissing.length === missing.length };
}
