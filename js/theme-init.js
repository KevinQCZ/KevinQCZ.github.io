(function () {
  var theme = null;
  var storageKey = 'qk-theme';

  try {
    theme = window.localStorage.getItem(storageKey);
  } catch (error) {
    console.warn('Theme preference storage is unavailable; using system preference.', error);
  }

  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  document.documentElement.setAttribute('data-theme', theme);
})();
