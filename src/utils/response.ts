/**
 * Standard API response envelope. Every endpoint returns either a
 * SuccessResponse or an ErrorResponse so clients can branch on `success`
 * and the stable `code` field.
 */

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
  pagination?: Pagination;
}

export interface ErrorResponse {
  success: false;
  code: string;
  message: string;
}

export const successResponse = <T>(
  data: T,
  pagination?: Pagination,
): SuccessResponse<T> => ({
  success: true,
  data,
  ...(pagination ? { pagination } : {}),
});

export const errorResponse = (code: string, message: string): ErrorResponse => ({
  success: false,
  code,
  message,
});

/** Build the pagination block; always returned on list endpoints, even when total is 0. */
export const buildPagination = (
  page: number,
  limit: number,
  total: number,
): Pagination => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});
