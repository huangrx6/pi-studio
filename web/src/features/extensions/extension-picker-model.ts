import type { WorkbenchExtension } from '../../shell/useConversationExtensions';
import { QUOTA_EXTENSION_ID } from '../../types/provider-quota.ts';

/** Show the inline search input once scanning by eye starts to degrade. */
export const EXTENSION_PICKER_SEARCH_THRESHOLD = 6;

export type ExtensionPickerEntry = {
  group: WorkbenchExtension;
  primaryPanel: WorkbenchExtension['panels'][number];
  hasLiveSummary: boolean;
  extraPanels: WorkbenchExtension['panels'];
};

export function normalizePickerQuery(query: string): string {
  return query.normalize('NFKC').trim().toLocaleLowerCase();
}

export function describeExtensionPickerEntry(
  group: WorkbenchExtension,
  hasQuotaSource: boolean,
): ExtensionPickerEntry {
  const { panels, summary } = group;
  const primaryPanel = panels.find(item => item.contributionId === summary?.details) ?? panels[0];
  const quota = Boolean(summary && primaryPanel.extensionId === QUOTA_EXTENSION_ID && hasQuotaSource);
  const hasLiveSummary = quota || Boolean(summary?.content.length);
  const extraPanels = panels.length > 1 ? panels.filter(item => item.id !== primaryPanel.id) : [];
  return { group, primaryPanel, hasLiveSummary, extraPanels };
}

export function filterExtensionPickerEntries(
  groups: readonly WorkbenchExtension[],
  query: string,
  hasQuotaSource: boolean,
): ExtensionPickerEntry[] {
  const entries = groups.map(group => describeExtensionPickerEntry(group, hasQuotaSource));
  const needle = normalizePickerQuery(query);
  if (!needle) return entries;
  const terms = needle.split(/\s+/).filter(Boolean);
  return entries.filter(({ group, primaryPanel }) => {
    const haystack = normalizePickerQuery([
      primaryPanel.extensionName,
      primaryPanel.extensionId,
      primaryPanel.title,
      primaryPanel.description || '',
      ...group.panels.flatMap(panel => [panel.title, panel.description || '']),
    ].join(' '));
    return terms.every(term => haystack.includes(term));
  });
}
