/**
 * Diligence pack (03 §Money — "[Assemble diligence ZIP] per cohort").
 *
 * A buyer's counsel gets one archive per cohort, laid out by claim:
 *   manifest.json                       — machine-readable index
 *   README.txt                          — what this is, and what is missing
 *   claims/<system>/claim.json          — basis, stack, credit, dates
 *   claims/<system>/attestations/<serial>.pdf
 *   claims/<system>/pto.pdf, cof.pdf    — the two letters
 *
 * Evidence files are pulled from DO Spaces by `file_key`. A missing file is
 * recorded as a gap in the manifest and the README rather than failing the
 * export — an incomplete pack that says so is more useful than no pack, and
 * silently shipping a short pack would be worse than either.
 */
import prisma from '../config/database';
import { LifecycleError } from '../lib/lifecycle';
import { createZip, type ZipEntry } from '../lib/zip';
import { downloadBuffer, isStorageConfigured } from './storage.service';

export interface DiligenceGap {
  system_id: string;
  address: string | null;
  kind: string;
  detail: string;
}

/**
 * The two letters every claim carries. 01's evidence list says "PTO + COF
 * letters", but `doc_type` has no PTO value — PTO is tracked as the S08
 * `pto_received` checklist item, so the pack ships the two letters that DO
 * exist as typed documents (both of which drive the stage machine) and records
 * PTO separately as an evidence flag.
 */
const LETTER_TYPES = [
  { type: 'ROF_LETTER' as const, file: 'rof', label: 'Reservation of Funds' },
  { type: 'COF_LETTER' as const, file: 'cof', label: 'Certificate of Funds' },
];

export async function assembleDiligencePack(cohortId: string, opts: { by?: string | null } = {}) {
  const cohort = await prisma.itcCohort.findUnique({
    where: { id: cohortId },
    include: {
      claims: {
        include: {
          basisLines: true,
          system: {
            select: {
              id: true,
              addressLine: true,
              unitLabel: true,
              kwRated: true,
              tier: true,
              pisDate: true,
              cofDate: true,
              permitNo: true,
              property: { select: { name: true, town: true } },
              equipment: {
                where: { status: 'INSTALLED' },
                select: { serial: true, kind: true, sku: true, dom: true, attestationDocId: true },
              },
              documents: { select: { id: true, type: true, title: true, fileKey: true, signedAt: true } },
            },
          },
        },
      },
    },
  });
  if (!cohort) throw new LifecycleError(404, 'COHORT_NOT_FOUND', `No cohort ${cohortId}`);
  if (cohort.claims.length === 0) {
    throw new LifecycleError(409, 'COHORT_EMPTY', 'This cohort has no claims to assemble');
  }

  const entries: ZipEntry[] = [];
  const gaps: DiligenceGap[] = [];
  const storage = isStorageConfigured();

  const manifest = {
    cohort: {
      id: cohort.id,
      label: cohort.label,
      status: cohort.status,
      buyer: cohort.buyer,
      nominal_amt: cohort.nominalAmt == null ? null : Number(cohort.nominalAmt),
      price_cents: cohort.priceCents,
    },
    assembled_at: new Date().toISOString(),
    storage_configured: storage,
    claims: [] as Array<Record<string, unknown>>,
  };

  for (const claim of cohort.claims) {
    const sys = claim.system;
    // Folder key: readable, unique, filesystem-safe.
    const folder = `claims/${(sys.addressLine ?? sys.id).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60)}`;

    const claimDoc = {
      claim_id: claim.id,
      system_id: sys.id,
      address: sys.addressLine,
      property: sys.property?.name ?? null,
      town: sys.property?.town ?? null,
      kw_rated: sys.kwRated == null ? null : Number(sys.kwRated),
      tier: sys.tier,
      status: claim.status,
      basis_amt: claim.basisAmt == null ? null : Number(claim.basisAmt),
      stack: claim.stack,
      total_pct: claim.totalPct == null ? null : Number(claim.totalPct),
      credit_amt: claim.creditAmt == null ? null : Number(claim.creditAmt),
      pis_date: claim.pisDate,
      recapture_end: claim.recaptureEnd,
      permit_no: sys.permitNo,
      basis_lines: claim.basisLines.map((l) => ({ source: l.source, amount: Number(l.amount), doc_id: l.docId })),
      serials: sys.equipment.map((e) => ({ serial: e.serial, kind: e.kind, sku: e.sku, dom: e.dom })),
    };
    entries.push({ name: `${folder}/claim.json`, data: Buffer.from(JSON.stringify(claimDoc, null, 2)) });

    // --- per-serial attestations ------------------------------------------
    const attestations: Record<string, string | null> = {};
    for (const item of sys.equipment) {
      if (!item.attestationDocId) {
        attestations[item.serial] = null;
        gaps.push({ system_id: sys.id, address: sys.addressLine, kind: 'attestation', detail: `no attestation on file for serial ${item.serial}` });
        continue;
      }
      const doc = await prisma.document.findUnique({ where: { id: item.attestationDocId } });
      const name = `${folder}/attestations/${item.serial}.pdf`;
      const data = doc?.fileKey && storage ? await downloadBuffer(doc.fileKey) : null;
      if (data) {
        entries.push({ name, data });
        attestations[item.serial] = name;
      } else {
        // Record the reference even when the bytes are unavailable, so the pack
        // shows exactly which document is owed.
        attestations[item.serial] = null;
        entries.push({
          name: `${name}.MISSING.txt`,
          data: Buffer.from(
            `Attestation document ${item.attestationDocId} for serial ${item.serial} could not be retrieved` +
              `${doc?.fileKey ? ` (key ${doc.fileKey})` : ' (no file key recorded)'}.\n`,
          ),
        });
        gaps.push({
          system_id: sys.id,
          address: sys.addressLine,
          kind: 'attestation',
          detail: `attestation for ${item.serial} is referenced but its file could not be read`,
        });
      }
    }

    // --- the two letters ---------------------------------------------------
    const letters: Record<string, string | null> = {};
    for (const letter of LETTER_TYPES) {
      const doc = sys.documents.find((d) => d.type === letter.type);
      const name = `${folder}/${letter.file}.pdf`;
      const data = doc?.fileKey && storage ? await downloadBuffer(doc.fileKey) : null;
      if (data) {
        entries.push({ name, data });
        letters[letter.file] = name;
      } else if (doc) {
        entries.push({
          name: `${name}.MISSING.txt`,
          data: Buffer.from(`${letter.label} document ${doc.id} is on file but its bytes could not be retrieved.\n`),
        });
        letters[letter.file] = null;
        gaps.push({ system_id: sys.id, address: sys.addressLine, kind: letter.file, detail: `${letter.label} recorded but file unreadable` });
      } else {
        letters[letter.file] = null;
        gaps.push({ system_id: sys.id, address: sys.addressLine, kind: letter.file, detail: `${letter.label} missing` });
      }
    }

    // PTO has no document type; its proof is the S08 checklist item.
    const ptoItem = await prisma.checklistItem.findFirst({
      where: { systemId: sys.id, key: 'pto_received' },
      select: { state: true, doneAt: true },
    });
    const pto = { state: ptoItem?.state ?? 'MISSING', received_at: ptoItem?.doneAt ?? null };
    if (pto.state !== 'DONE') {
      gaps.push({ system_id: sys.id, address: sys.addressLine, kind: 'pto', detail: 'PTO not recorded as received' });
    }

    manifest.claims.push({ ...claimDoc, folder, attestations, letters, pto });
  }

  const readme = [
    `Diligence pack — ${cohort.label}`,
    `Assembled ${new Date().toISOString()}`,
    ``,
    `Claims: ${cohort.claims.length}`,
    `Nominal credit: ${cohort.nominalAmt == null ? '—' : Number(cohort.nominalAmt).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`,
    ``,
    gaps.length === 0
      ? 'No gaps: every claim carries its per-serial attestations and both letters.'
      : `${gaps.length} gap${gaps.length === 1 ? '' : 's'} — this pack is incomplete:`,
    ...gaps.map((g) => `  - ${g.address ?? g.system_id}: ${g.detail}`),
    ``,
    storage ? '' : 'NOTE: object storage is not configured in this environment, so no evidence files could be pulled.',
  ].join('\n');

  entries.unshift({ name: 'README.txt', data: Buffer.from(readme) });
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });

  const zip = createZip(entries);

  await prisma.activityLog.create({
    data: {
      entity: 'program',
      entityId: cohortId,
      action: 'diligence_pack',
      actor: opts.by ?? null,
      meta: { claims: cohort.claims.length, entries: entries.length, gaps: gaps.length, bytes: zip.length },
    },
  });

  return {
    zip,
    filename: `diligence-${cohort.label.replace(/[^a-zA-Z0-9._-]+/g, '_')}.zip`,
    entries: entries.map((e) => e.name),
    gaps,
    complete: gaps.length === 0,
  };
}
