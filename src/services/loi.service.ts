/**
 * Letter of Intent capture. Stores the signed (non-binding) LOI data; the PDF is
 * generated on demand from this record (see loiPdf.service).
 */
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { qualifyForStorage } from './ess.service';

export interface CreateLoiInput {
  siteOwnerName: string;
  propertyAddress: string;
  email: string;
  phone?: string;
  batteryCount?: string; // one | two | three_plus
  rooftopSolar?: string; // yes | no | planned
  timeframe?: string; // asap | flexible
  reasons?: string[];
  reasonOther?: string;
  signedName: string;
  signatureIp?: string;
  source?: string;
}

async function generateLoiNumber(): Promise<string> {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 10; attempt++) {
    const n = Math.floor(10000 + Math.random() * 90000);
    const candidate = `LOI-${year}-${n}`;
    const exists = await prisma.loi.findUnique({ where: { loiNumber: candidate } });
    if (!exists) return candidate;
  }
  return `LOI-${year}-${Date.now().toString().slice(-6)}`;
}

export async function createLoi(input: CreateLoiInput) {
  const loiNumber = await generateLoiNumber();
  // Snapshot ESS/ITC qualification from the property address (best-effort).
  const q = await qualifyForStorage(input.propertyAddress);
  return prisma.loi.create({
    data: {
      loiNumber,
      siteOwnerName: input.siteOwnerName,
      propertyAddress: input.propertyAddress,
      email: input.email.trim().toLowerCase(),
      phone: input.phone,
      batteryCount: input.batteryCount,
      rooftopSolar: input.rooftopSolar,
      timeframe: input.timeframe,
      reasons: input.reasons ?? [],
      reasonOther: input.reasonOther,
      signedName: input.signedName,
      signatureIp: input.signatureIp,
      source: input.source ?? 'pre-approval-landing',
      essTier: q?.essTier ?? null,
      underserved: q?.underserved ?? null,
      energyCommunity: q?.energyCommunity ?? null,
      nmtcLowIncome: q?.nmtcLowIncome ?? null,
      itcConfirmedPct: q?.itcConfirmedPct ?? null,
      itcPotentialPct: q?.itcPotentialPct ?? null,
      lucrativeScore: q?.lucrativeScore ?? null,
    },
  });
}

export function getLoi(id: number) {
  return prisma.loi.findUnique({ where: { id } });
}

export async function listLois(
  page: number,
  limit: number,
  sort: 'value' | 'recent' = 'value',
): Promise<{ rows: Prisma.LoiGetPayload<object>[]; total: number }> {
  // Default prioritizes the most lucrative (highest score), then most recent.
  const orderBy: Prisma.LoiOrderByWithRelationInput[] =
    sort === 'value'
      ? [{ lucrativeScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
      : [{ createdAt: 'desc' }];
  const [rows, total] = await Promise.all([
    prisma.loi.findMany({ skip: (page - 1) * limit, take: limit, orderBy }),
    prisma.loi.count(),
  ]);
  return { rows, total };
}
