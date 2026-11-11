import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/navigation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const { isCurrentNavigationLink } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('marks nested writing, archive, article, project, and about routes current', () => {
  for (const route of [
    '/writing/',
    '/writing/categories/software-engineering/',
    '/archives/2018/02/',
    '/2018/02/07/hello-world/',
    '/projects/example/'
  ]) {
    const section = route.startsWith('/projects/') ? '/projects/' : '/writing/';
    assert.equal(isCurrentNavigationLink(section, route), true, route);
  }

  assert.equal(isCurrentNavigationLink('/about/', '/about/'), true);
  assert.equal(isCurrentNavigationLink('/', '/'), true);
});

test('does not mark unrelated navigation sections current', () => {
  assert.equal(isCurrentNavigationLink('/writing/', '/projects/example/'), false);
  assert.equal(isCurrentNavigationLink('/projects/', '/writing/'), false);
  assert.equal(isCurrentNavigationLink('/', '/about/'), false);
});
