import { z } from 'zod';

const upper = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : v);

const ownerOutreachMode = z.preprocess(upper, z.enum(['WE', 'SELF'])).optional();
const eligibilityKind = z
  .preprocess(upper, z.enum(['STANDARD', 'PRIORITY', 'INELIGIBLE']))
  .optional();

export const createApplicationSchema = z.object({
  body: z.object({
    // Contact
    firstName: z.string().min(1).max(120),
    lastName: z.string().min(1).max(120),
    email: z.string().email().max(255),
    phone: z.string().min(1).max(40),
    preferredLanguage: z.string().max(60).optional(),
    // Property
    formattedAddress: z.string().min(1).max(400),
    lat: z.number().optional(),
    lng: z.number().optional(),
    city: z.string().max(120).optional(),
    utility: z.string().max(160).optional(),
    dwellingType: z.string().max(80).optional(),
    isOwner: z.boolean(),
    utilityAccount: z.string().max(60).optional(),
    hasMedicalEquipment: z.boolean().optional(),
    // Eligibility snapshot
    eligibilityKind,
    resolvedUtility: z.string().max(160).optional(),
    resolvedCity: z.string().max(120).optional(),
    // Install (owner path)
    installLocation: z.string().max(80).optional(),
    panelAmps: z.string().max(80).optional(),
    panelAge: z.string().max(80).optional(),
    solarStatus: z.string().max(120).optional(),
    accessNotes: z.string().max(1000).optional(),
    // Renter path
    ownerName: z.string().max(200).optional(),
    ownerOrg: z.string().max(200).optional(),
    ownerEmail: z.string().max(255).optional(),
    ownerPhone: z.string().max(40).optional(),
    ownerOutreachMode,
    ownerNote: z.string().max(1000).optional(),
    renterPendingConsent: z.boolean().optional(),
    // Survey
    surveyDate: z.string().max(40).optional(),
    surveySlot: z.string().max(40).optional(),
    // Consent / ESA
    agreeReadEsa: z.boolean().optional(),
    agreeAuthEnroll: z.boolean().optional(),
    agreeESign: z.boolean().optional(),
    signedName: z.string().max(200).optional(),
    esaVersion: z.string().max(40).optional(),
    source: z.string().max(64).optional(),
  }),
});

export const updateApplicationStatusSchema = z.object({
  body: z.object({
    status: z.enum(['LEAD', 'SUBMITTED', 'RENTER_PENDING', 'SURVEY_SCHEDULED', 'SIGNED']),
  }),
});
