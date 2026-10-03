'use client';

import { useCallback, useMemo } from 'react';
import { CommandPalette, type CommandPaletteItem, type CommandPaletteLabels } from '@/components/ds/command-palette';
import { t } from '@/lib/i18n';
import { openCommands, type OpenCommandScope, type PartnerCommand } from '@/lib/partner-commands';

/**
 * Lost-features A16: the /partner command palette (Ctrl/Cmd K). The "Go to" items are built on the
 * server from the session role (buildPartnerCommands); this wrapper only adds "Open transfer <id>" /
 * "Open ticket <id>" for what the user types, within the role's scope (openCommandScope). Every
 * target page re-gates.
 */
export function PartnerPalette({ items, scope }: { items: PartnerCommand[]; scope: OpenCommandScope }) {
  const labels = useMemo<CommandPaletteLabels>(
    () => ({
      trigger: t('partner.palette.trigger'),
      label: t('partner.palette.label'),
      placeholder: t('partner.palette.placeholder'),
      empty: (query) => t('partner.palette.empty', { query }),
      results: (count) =>
        count === 0 ? t('partner.palette.noResults') : count === 1 ? t('partner.palette.oneResult') : t('partner.palette.results', { count }),
      hintOpen: t('partner.palette.hintOpen'),
      hintClose: t('partner.palette.hintClose'),
    }),
    [],
  );
  const extraFor = useCallback(
    (query: string): CommandPaletteItem[] =>
      openCommands(query, scope).map((c) => ({
        id: `open-${c.kind}`,
        href: c.href,
        group: t('partner.palette.groupOpen'),
        label: c.kind === 'transfer' ? t('partner.palette.openTransfer', { id: c.id }) : t('partner.palette.openTicket', { id: c.id }),
      })),
    [scope],
  );
  return <CommandPalette items={items} labels={labels} extraFor={extraFor} />;
}
