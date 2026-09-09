/**
 * Directory — "every object · two clicks" (mockup §8, 03 §Navigation).
 *
 * Six counts over the objects a unit's life hangs off. Scalars only, so there
 * is no pagination and no list here: each tile links into the surface that
 * already lists that object.
 *
 * Terminal systems are deliberately COUNTED. Per L5 the Directory is the one
 * lens that does not filter on `terminal_state IS NULL` — a withdrawn unit is
 * still a record you must be able to find, and the residents/equipment/documents
 * attached to it never stop existing. Every other lens hides them.
 */
import prisma from '../config/database';

export interface DirectorySummary {
  tiles: Array<{
    key: string;
    label: string;
    count: number;
    /** Second figure where the tile carries one, e.g. installers · crews. */
    secondary: number | null;
    note: string;
    href: string;
  }>;
  /** Systems are split out so the note can say how many are terminal. */
  systems: { total: number; terminal: number };
}

export async function getDirectorySummary(): Promise<DirectorySummary> {
  const [accounts, properties, residents, installers, crews, equipment, documents, systems, terminal] =
    await Promise.all([
      prisma.account.count(),
      prisma.property.count(),
      prisma.resident.count(),
      prisma.installer.count(),
      prisma.crew.count(),
      prisma.equipment.count(),
      prisma.document.count(),
      prisma.system.count(),
      prisma.system.count({ where: { terminalState: { not: null } } }),
    ]);

  return {
    systems: { total: systems, terminal },
    tiles: [
      {
        key: 'accounts',
        label: 'Accounts',
        count: accounts,
        secondary: null,
        note: 'Portfolio owners and their deal state',
        href: '/ops/pipeline?tab=deals',
      },
      {
        key: 'properties',
        label: 'Properties',
        count: properties,
        secondary: null,
        note: 'The working surface — geo computed once, units inherit',
        href: '/ops/pipeline',
      },
      {
        key: 'residents',
        label: 'Residents',
        count: residents,
        secondary: null,
        note: 'Occupancy history — a move-out opens a row, never overwrites',
        href: '/ops/pipeline',
      },
      {
        key: 'installers',
        label: 'Installers & crews',
        count: installers,
        secondary: crews,
        note: 'Licences, capacity, and the installer of record on every ticket',
        href: '/ops/service',
      },
      {
        key: 'equipment',
        label: 'Equipment',
        count: equipment,
        secondary: null,
        note: 'Serial lineage — stock and installed in one table',
        href: '/ops/service',
      },
      {
        key: 'documents',
        label: 'Documents',
        count: documents,
        secondary: null,
        note: 'Every letter, agreement and attestation, scoped to its record',
        href: '/ops/pipeline',
      },
    ],
  };
}
