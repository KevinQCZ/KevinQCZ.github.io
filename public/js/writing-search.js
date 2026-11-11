const form = document.querySelector('[data-writing-search]');
const input = document.querySelector('[data-search-input]');
const status = document.querySelector('[data-search-status]');
const entries = [...document.querySelectorAll('[data-search-entry]')];

if (form && input && status) {
  const queryFromUrl = new URL(window.location.href).searchParams.get('q');
  if (queryFromUrl) input.value = queryFromUrl;

  const updateResults = () => {
    const query = input.value.trim().normalize('NFKC').toLocaleLowerCase();
    let resultCount = 0;

    for (const entry of entries) {
      const searchableText = (entry.dataset.searchText ?? '').normalize('NFKC').toLocaleLowerCase();
      const matches = !query || searchableText.includes(query);
      entry.hidden = !matches;
      if (matches) resultCount += 1;
    }

    status.textContent = query
      ? `${resultCount} ${resultCount === 1 ? 'result' : 'results'} for "${input.value.trim()}".`
      : `Showing all ${resultCount} ${resultCount === 1 ? 'article' : 'articles'}.`;

    const url = new URL(window.location.href);
    if (query) url.searchParams.set('q', input.value.trim());
    else url.searchParams.delete('q');
    window.history.replaceState(null, '', url);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    updateResults();
  });
  input.addEventListener('input', updateResults);
  updateResults();
}
