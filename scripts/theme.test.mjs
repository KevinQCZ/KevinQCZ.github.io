import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const themeInitSource = await readFile(new URL('../public/js/theme-init.js', import.meta.url), 'utf8');
const siteSource = await readFile(new URL('../public/js/site.js', import.meta.url), 'utf8');

function runThemeInit({ savedTheme = null, systemDark = false } = {}) {
  const attributes = new Map();
  const window = {
    localStorage: { getItem: () => savedTheme },
    matchMedia: () => ({ matches: systemDark })
  };
  const document = {
    documentElement: {
      setAttribute: (name, value) => attributes.set(name, value)
    }
  };
  runInNewContext(themeInitSource, { window, document, console });
  return attributes.get('data-theme');
}

function createEventTarget(initialAttributes = {}) {
  const attributes = new Map(Object.entries(initialAttributes));
  const listeners = new Map();
  return {
    attributes,
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    dispatch(type, event = {}) {
      for (const callback of listeners.get(type) ?? []) callback(event);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    }
  };
}

function createSiteHarness(savedTheme = null) {
  const root = createEventTarget();
  root.setAttribute('data-theme', 'light');
  const themeButton = createEventTarget({
    'data-label-on-light': 'Switch to dark theme',
    'data-label-on-dark': 'Switch to light theme'
  });
  const menuButton = createEventTarget({
    'data-label-open': 'Open navigation',
    'data-label-close': 'Close navigation'
  });
  let menuOpen = false;
  const nav = createEventTarget();
  nav.classList = {
    toggle(name) {
      menuOpen = !menuOpen;
      return menuOpen;
    },
    remove() {
      menuOpen = false;
    },
    contains() {
      return menuOpen;
    }
  };
  const documentListeners = new Map();
  const document = {
    documentElement: root,
    querySelector(selector) {
      return {
        '[data-theme-toggle]': themeButton,
        '[data-menu-toggle]': menuButton,
        '.site-nav': nav
      }[selector] ?? null;
    },
    addEventListener(type, callback) {
      documentListeners.set(type, callback);
    }
  };
  const values = new Map(savedTheme ? [['qk-theme', savedTheme]] : []);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  const mediaListeners = [];
  const media = {
    addEventListener(type, callback) {
      if (type === 'change') mediaListeners.push(callback);
    }
  };
  const window = {
    localStorage: storage,
    matchMedia: () => media
  };
  runInNewContext(siteSource, { window, document, console });
  return {
    documentListeners,
    mediaListeners,
    menuButton,
    nav,
    root,
    storage,
    themeButton
  };
}

test('theme initialization honors system preference unless an override is saved', () => {
  assert.equal(runThemeInit({ systemDark: true }), 'dark');
  assert.equal(runThemeInit({ savedTheme: 'light', systemDark: true }), 'light');
});

test('theme override persists and ignores later system changes', () => {
  const harness = createSiteHarness();
  harness.mediaListeners[0]({ matches: true });
  assert.equal(harness.root.getAttribute('data-theme'), 'dark');
  assert.equal(harness.themeButton.getAttribute('aria-pressed'), 'true');

  harness.themeButton.dispatch('click');
  assert.equal(harness.root.getAttribute('data-theme'), 'light');
  assert.equal(harness.storage.getItem('qk-theme'), 'light');
  harness.mediaListeners[0]({ matches: true });
  assert.equal(harness.root.getAttribute('data-theme'), 'light');
});

test('mobile navigation closes on Escape and restores focus', () => {
  const harness = createSiteHarness();
  let focused = false;
  harness.menuButton.focus = () => { focused = true; };

  harness.menuButton.dispatch('click');
  assert.equal(harness.nav.classList.contains('site-nav-on'), true);
  assert.equal(harness.menuButton.getAttribute('aria-expanded'), 'true');

  harness.documentListeners.get('keydown')({ key: 'Escape' });
  assert.equal(harness.nav.classList.contains('site-nav-on'), false);
  assert.equal(harness.menuButton.getAttribute('aria-expanded'), 'false');
  assert.equal(focused, true);
});
