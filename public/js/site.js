(function () {
  var root = document.documentElement;
  var button = document.querySelector('[data-theme-toggle]');
  var menuButton = document.querySelector('[data-menu-toggle]');
  var nav = document.querySelector('.site-nav');
  var storageKey = 'qk-theme';
  var media = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
  var hasOverride = false;

  try {
    var savedTheme = window.localStorage.getItem(storageKey);
    hasOverride = savedTheme === 'light' || savedTheme === 'dark';
  } catch (error) {
    console.warn('Theme preference storage is unavailable; changes last for this page only.', error);
  }

  function setTheme(theme) {
    root.setAttribute('data-theme', theme);

    if (button) {
      button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      var label = button.getAttribute(theme === 'dark' ? 'data-label-on-dark' : 'data-label-on-light');
      button.setAttribute('aria-label', label || 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
    }
  }

  if (button) {
    setTheme(root.getAttribute('data-theme') || 'light');

    button.addEventListener('click', function () {
      var nextTheme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      setTheme(nextTheme);
      hasOverride = true;

      try {
        window.localStorage.setItem(storageKey, nextTheme);
      } catch (error) {
        console.warn('Theme preference could not be saved.', error);
      }
    });
  }

  if (media) {
    var onSystemThemeChange = function (event) {
      if (!hasOverride) {
        setTheme(event.matches ? 'dark' : 'light');
      }
    };

    if (media.addEventListener) {
      media.addEventListener('change', onSystemThemeChange);
    } else if (media.addListener) {
      media.addListener(onSystemThemeChange);
    }
  }

  if (menuButton && nav) {
    var openLabel = menuButton.getAttribute('data-label-open') || 'Open navigation';
    var closeLabel = menuButton.getAttribute('data-label-close') || 'Close navigation';
    var closeMenu = function () {
      nav.classList.remove('site-nav-on');
      menuButton.setAttribute('aria-expanded', 'false');
      menuButton.setAttribute('aria-label', openLabel);
    };

    menuButton.addEventListener('click', function () {
      var isOpen = nav.classList.toggle('site-nav-on');
      menuButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      menuButton.setAttribute('aria-label', isOpen ? closeLabel : openLabel);
    });

    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        closeMenu();
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && nav.classList.contains('site-nav-on')) {
        closeMenu();
        menuButton.focus();
      }
    });
  }
})();
