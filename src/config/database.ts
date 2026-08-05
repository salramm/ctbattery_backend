/**
 * Single shared PrismaClient. Import the default export everywhere so the whole
 * process reuses one connection pool.
 */
import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;

export const getPrismaClient = (): PrismaClient => {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
};

export default getPrismaClient();
