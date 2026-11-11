export const ARTICLES_PER_PAGE = 10;

export interface PaginatedItems<T> {
  items: T[];
  pageNumber: number;
  totalPages: number;
}

export function paginateItems<T>(
  items: readonly T[],
  pageNumber: number,
  pageSize: number
): PaginatedItems<T> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError('Page number must be a positive integer.');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('Page size must be a positive integer.');
  }

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  if (pageNumber > totalPages) {
    throw new RangeError(`Page number ${pageNumber} exceeds the total page count ${totalPages}.`);
  }

  const start = (pageNumber - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    pageNumber,
    totalPages
  };
}
