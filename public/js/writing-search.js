const form = document.querySelector('[data-writing-search]');
const input = document.querySelector('[data-search-input]');
const status = document.querySelector('[data-search-status]');
const entries = [...document.querySelectorAll('[data-search-entry]')];

if (form && input && status) {
  const queryFromUrl = new URL(window.location.href).searchParams.get('q');
  if (queryFromUrl) input.value = queryFromUrl;

  let searchIndexPromise;
  let updateVersion = 0;

  const loadSearchIndex = () => {
    if (!searchIndexPromise) {
      searchIndexPromise = fetch('/writing/search/index.json')
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Search index request failed with status ${response.status}.`);
          }
          return response.json();
        })
        .then((records) => {
          if (!Array.isArray(records)) {
            throw new Error('Search index has an invalid format.');
          }
          return new Map(records.map((record) => [record.href, record.body]));
        })
        .catch((error) => {
          searchIndexPromise = undefined;
          throw error;
        });
    }

    return searchIndexPromise;
  };

  const updateResults = async () => {
    const version = ++updateVersion;
    const rawQuery = input.value.trim();
    const query = rawQuery.normalize('NFKC').toLocaleLowerCase();
    let bodyByHref = new Map();
    let fullTextAvailable = true;

    if (query) {
      status.textContent = 'Searching articles…';
      try {
        bodyByHref = await loadSearchIndex();
      } catch (error) {
        console.error('Full-text search index could not be loaded.', error);
        fullTextAvailable = false;
      }
    }

    if (version !== updateVersion) return;

    let resultCount = 0;
    for (const entry of entries) {
      const searchText = `${entry.dataset.searchText ?? ''} ${bodyByHref.get(entry.dataset.searchHref) ?? ''}`;
      const matches = !query ||
        searchText.normalize('NFKC').toLocaleLowerCase().includes(query);
      entry.hidden = !matches;
      if (matches) resultCount += 1;
    }

    if (!query) {
      status.textContent = `Showing all ${resultCount} ${resultCount === 1 ? 'article' : 'articles'}.`;
    } else if (fullTextAvailable) {
      status.textContent = `${resultCount} ${resultCount === 1 ? 'result' : 'results'} for "${rawQuery}".`;
    } else {
      status.textContent = `Full-text search is unavailable. Showing title and summary results for "${rawQuery}".`;
    }

    const url = new URL(window.location.href);
    if (rawQuery) url.searchParams.set('q', rawQuery);
    else url.searchParams.delete('q');
    window.history.replaceState(null, '', url);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void updateResults();
  });
  input.addEventListener('input', () => void updateResults());
  void updateResults();
}
