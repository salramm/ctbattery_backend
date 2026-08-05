/**
 * Consumer application persistence: create (with generated application number +
 * derived status), paginated list, detail, and status update.
 */
import type { ApplicationStatus, OwnerOutreachMode, EligibilityKind, Prisma } from '@prisma/client';
import prisma from '../config/database';

export interface CreateApplicationInput {
  // Contact
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  preferredLanguage?: string;
  // Property
  formattedAddress: string;
  lat?: number;
  lng?: number;
  city?: string;
  utility?: string;
  dwellingType?: string;
  isOwner: boolean;
  utilityAccount?: string;
  hasMedicalEquipment?: boolean;
  // Eligibility snapshot
  eligibilityKind?: EligibilityKind;
  resolvedUtility?: string;
  resolvedCity?: string;
  // Install (owner)
  installLocation?: string;
  panelAmps?: string;
  panelAge?: string;
  solarStatus?: string;
  accessNotes?: string;
  // Renter path
  ownerName?: string;
  ownerOrg?: string;
  ownerEmail?: string;
  ownerPhone?: string;
  ownerOutreachMode?: OwnerOutreachMode;
  ownerNote?: string;
  renterPendingConsent?: boolean;
  // Survey
  surveyDate?: string;
  surveySlot?: string;
  // Consent / ESA
  agreeReadEsa?: boolean;
  agreeAuthEnroll?: boolean;
  agreeESign?: boolean;
  signedName?: string;
  esaVersion?: string;
  source?: string;
}

/** Generate a unique CTB-YYYY-##### application number. */
async function generateApplicationNumber(): Promise<string> {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 10; attempt++) {
    const n = Math.floor(10000 + Math.random() * 90000);
    const candidate = `CTB-${year}-${n}`;
    const exists = await prisma.application.findUnique({ where: { applicationNumber: candidate } });
    if (!exists) return candidate;
  }
  // Extremely unlikely fallback
  return `CTB-${year}-${Date.now().toString().slice(-6)}`;
}

function deriveStatus(input: CreateApplicationInput): ApplicationStatus {
  if (!input.isOwner && input.renterPendingConsent) return 'RENTER_PENDING';
  if (input.agreeESign && input.signedName) return 'SIGNED';
  if (input.surveyDate && input.surveySlot) return 'SURVEY_SCHEDULED';
  return 'SUBMITTED';
}

export async function createApplication(input: CreateApplicationInput) {
  const applicationNumber = await generateApplicationNumber();
  const status = deriveStatus(input);

  return prisma.application.create({
    data: {
      applicationNumber,
      status,
      source: input.source ?? 'web',
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      preferredLanguage: input.preferredLanguage,
      formattedAddress: input.formattedAddress,
      lat: input.lat,
      lng: input.lng,
      city: input.city,
      utility: input.utility,
      dwellingType: input.dwellingType,
      isOwner: input.isOwner,
      utilityAccount: input.utilityAccount,
      hasMedicalEquipment: input.hasMedicalEquipment ?? false,
      eligibilityKind: input.eligibilityKind,
      resolvedUtility: input.resolvedUtility,
      resolvedCity: input.resolvedCity,
      installLocation: input.installLocation,
      panelAmps: input.panelAmps,
      panelAge: input.panelAge,
      solarStatus: input.solarStatus,
      accessNotes: input.accessNotes,
      ownerName: input.ownerName,
      ownerOrg: input.ownerOrg,
      ownerEmail: input.ownerEmail,
      ownerPhone: input.ownerPhone,
      ownerOutreachMode: input.ownerOutreachMode,
      ownerNote: input.ownerNote,
      renterPendingConsent: input.renterPendingConsent ?? false,
      surveyDate: input.surveyDate,
      surveySlot: input.surveySlot,
      agreeReadEsa: input.agreeReadEsa ?? false,
      agreeAuthEnroll: input.agreeAuthEnroll ?? false,
      agreeESign: input.agreeESign ?? false,
      signedName: input.signedName,
      signedAt: input.agreeESign && input.signedName ? new Date() : undefined,
      esaVersion: input.esaVersion,
    },
  });
}

export async function listApplications(
  page: number,
  limit: number,
  status?: ApplicationStatus,
): Promise<{ rows: Prisma.ApplicationGetPayload<object>[]; total: number }> {
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    prisma.application.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.application.count({ where }),
  ]);
  return { rows, total };
}

export function getApplication(id: number) {
  return prisma.application.findUnique({ where: { id } });
}

export function updateApplicationStatus(id: number, status: ApplicationStatus) {
  return prisma.application.update({ where: { id }, data: { status } });
}

export function setApplicationPanelPhoto(id: number, panelPhotoUrl: string) {
  return prisma.application.update({ where: { id }, data: { panelPhotoUrl } });
}
