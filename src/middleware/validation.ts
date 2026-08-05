/**
 * Zod validation middleware. Validates body/query/params in one pass and
 * flattens issues into a single VALIDATION_ERROR message.
 */
import { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { HTTP_STATUS } from '../constants/http-status';
import { errorResponse } from '../utils/response';

export const validate =
  (schema: ZodTypeAny) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      // Write coerced/transformed values back so handlers see normalized input
      // (e.g. enum casing). Only body is safely reassignable on Express.
      if (parsed && typeof parsed === 'object' && 'body' in parsed) {
        req.body = (parsed as { body: unknown }).body;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const detail = error.issues
          .map((i) => `${i.path.slice(1).join('.') || i.path.join('.')}: ${i.message}`)
          .join(', ');
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(errorResponse('VALIDATION_ERROR', detail));
      }
      return res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(errorResponse('INTERNAL_ERROR', 'Validation failure'));
    }
  };
