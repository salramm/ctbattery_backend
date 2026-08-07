/**
 * Waitlist lead capture. Upsert on email so a repeat sign-up updates rather than
 * duplicates.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';

export interface CreateLeadInput {
  email: string;
  firstName?: string;
  lastName?: string;
  cityOrZip?: string;
  phone?: string;
  tenure?: string;
  utility?: string;
  source?: string;
}

export async function createLead(input: CreateLeadInput) {
  const email = input.email.trim().toLowerCase();
  const data = {
    email,
    firstName: input.firstName,
    lastName: input.lastName,
    cityOrZip: input.cityOrZip,
    phone: input.phone,
    tenure: input.tenure,
    utility: input.utility,
    source: input.source ?? 'pre-approval-landing',
  };
  return prisma.lead.upsert({ where: { email }, create: data, update: data });
}

export async function listLeads(
  page: number,
  limit: number,
): Promise<{ rows: Prisma.LeadGetPayload<object>[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.lead.count(),
  ]);
  return { rows, total };
}
