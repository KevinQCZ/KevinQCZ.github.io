import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../public/js/writing-search.js', import.meta.url), 'utf8');

function createElement(attributes = {}) {
  const listeners = new Map();
  return {
    dataset: attributes,
    hidden: false,
    textContent: '',
    value: '',
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    }
  };
}

function createSearchHarness({ href, records, fetchError } = {}) {
  const form = createElement();
  const input = createElement();
  const status = createElement();
  const entries = [
    createElement({
      searchHref: '/2018/02/07/hello-world/',
      searchText: 'Hello World A short introduction'
    }),
    createElement({
      searchHref: '/another-article/',
      searchText: 'Other article'
    })
  ];
  const elements = new Map([
    ['[data-writing-search]', form],
    ['[data-search-input]', input],
    ['[data-search-status]', status]
  ]);
  const errors = [];
  let fetchCount = 0;
  const location = { href: href ?? 'https://kevinqcz.github.io/writing/search/' };
  const document = {
    querySelector: (selector) => elements.get(selector),
    querySelectorAll: (selector) => selector === '[data-search-entry]' ? entries : []
  };
  const window = {
    location,
    history: {
      replaceState(_state, _title, url) {
        location.href = url.href;
      }
    }
  };
  const fetch = async () => {
    fetchCount += 1;
    if (fetchError) throw fetchError;
    return {
      ok: true,
      json: async () => records ?? [
        { href: '/2018/02/07/hello-world/', body: 'Hexo deployment commands' },
        { href: '/another-article/', body: 'Supply chain planning' }
      ]
    };
  };

  runInNewContext(source, {
    document,
    window,
    fetch,
    console: { error: (...args) => errors.push(args) },
    URL
  });

  return { entries, errors, form, input, get fetchCount() { return fetchCount; }, location, status };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('full-text search loads its index lazily and keeps query state in the URL', async () => {
  const harness = createSearchHarness({ href: 'https://kevinqcz.github.io/writing/search/?q=Hexo' });
  await nextTurn();

  assert.equal(harness.fetchCount, 1);
  assert.deepEqual(harness.entries.map((entry) => entry.hidden), [false, true]);
  assert.equal(harness.status.textContent, '1 result for "Hexo".');
  assert.equal(new URL(harness.location.href).searchParams.get('q'), 'Hexo');
});

test('empty queries do not fetch the index and show all articles', async () => {
  const harness = createSearchHarness();
  await nextTurn();

  assert.equal(harness.fetchCount, 0);
  assert.deepEqual(harness.entries.map((entry) => entry.hidden), [false, false]);
  assert.equal(harness.status.textContent, 'Showing all 2 articles.');
});

test('a failed index request is surfaced and falls back to title and summary', async () => {
  const harness = createSearchHarness({
    href: 'https://kevinqcz.github.io/writing/search/?q=Hello',
    fetchError: new Error('offline')
  });
  await nextTurn();

  assert.equal(harness.entries[0].hidden, false);
  assert.equal(harness.entries[1].hidden, true);
  assert.match(harness.status.textContent, /Full-text search is unavailable/);
  assert.equal(harness.errors.length, 1);
});
