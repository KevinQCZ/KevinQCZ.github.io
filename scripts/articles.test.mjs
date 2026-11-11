import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/articles.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const { hasPublishedBody, taxonomySlug, uniqueTaxonomies } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('taxonomy slugs preserve existing ASCII routes and support Unicode labels', () => {
  assert.equal(taxonomySlug('Software engineering'), 'software-engineering');
  assert.equal(taxonomySlug('人工智能'), '人工智能');
  assert.equal(taxonomySlug('Café'), 'cafe');
});

test('taxonomy collection rejects empty or colliding route slugs', () => {
  const article = (categories) => ({ data: { categories, tags: [] } });
  assert.throws(
    () => uniqueTaxonomies([article(['R&D']), article(['R-D'])], 'categories'),
    /Taxonomy slug collision/
  );
  assert.throws(
    () => uniqueTaxonomies([article(['   '])], 'categories'),
    /Taxonomy labels must not be empty/
  );
});

test('only articles with non-empty bodies are eligible for search and discovery', () => {
  assert.equal(hasPublishedBody({ body: 'Article content' }), true);
  assert.equal(hasPublishedBody({ body: ' \n\t ' }), false);
  assert.equal(hasPublishedBody({ body: undefined }), false);
});
