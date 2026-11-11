import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/pagination.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const { paginateItems } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('paginates partial and exact page boundaries', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(paginateItems(items, 1, 2), {
    items: ['a', 'b'],
    pageNumber: 1,
    totalPages: 3
  });
  assert.deepEqual(paginateItems(items, 3, 2), {
    items: ['e'],
    pageNumber: 3,
    totalPages: 3
  });
  assert.equal(paginateItems(['a', 'b', 'c', 'd'], 2, 2).totalPages, 2);
});

test('returns one empty page for an empty collection', () => {
  assert.deepEqual(paginateItems([], 1, 10), {
    items: [],
    pageNumber: 1,
    totalPages: 1
  });
});

test('rejects invalid page numbers, page sizes, and out-of-range pages', () => {
  assert.throws(() => paginateItems(['a'], 0, 1), RangeError);
  assert.throws(() => paginateItems(['a'], 1, 0), RangeError);
  assert.throws(() => paginateItems(['a'], 2, 1), RangeError);
});
