'use strict';

(() => {
  const STORAGE_KEY = 'holool.locale';
  const DEFAULT_LOCALE = 'en';
  const locales = window.APP_LOCALES || {};
  const supportedLocales = [DEFAULT_LOCALE, ...Object.keys(locales)];
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  const localizedAttributes = ['placeholder', 'title', 'aria-label', 'alt', 'data-placeholder'];
  let locale = supportedLocales.includes(localStorage.getItem(STORAGE_KEY)) ? localStorage.getItem(STORAGE_KEY) : DEFAULT_LOCALE;
  let observer;

  function dictionary() { return locales[locale] || {}; }
  function interpolate(message, values = {}) { return String(message).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? ''); }

  function compileTemplate(source) {
    const names = [];
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\w+)\\\}/g, (_, name) => {
      names.push(name);
      return '(.+?)';
    });
    return { names, expression: new RegExp(`^${escaped}$`, 'u') };
  }

  function translateMessage(message, values) {
    if (locale === DEFAULT_LOCALE) return interpolate(message, values);
    const catalog = dictionary();
    if (catalog[message]) return interpolate(catalog[message], values);
    for (const [source, translation] of Object.entries(catalog)) {
      if (!source.includes('{')) continue;
      const template = compileTemplate(source);
      const match = String(message).match(template.expression);
      if (!match) continue;
      const captures = Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]]));
      return interpolate(translation, { ...captures, ...values });
    }
    return interpolate(message, values);
  }

  function translatePreservingWhitespace(value) {
    const match = String(value).match(/^(\s*)(.*?)(\s*)$/s);
    if (!match || !match[2]) return value;
    return `${match[1]}${translateMessage(match[2])}${match[3]}`;
  }

  function localizeTextNode(node) {
    const current = node.data;
    if (locale === DEFAULT_LOCALE) {
      if (textSources.has(node)) node.data = textSources.get(node);
      return;
    }
    const translated = translatePreservingWhitespace(current);
    if (translated === current) return;
    const option = node.parentElement?.closest('option');
    if (option && !option.hasAttribute('value')) option.setAttribute('value', current.trim());
    textSources.set(node, current);
    node.data = translated;
  }

  function localizeElement(element) {
    if (!(element instanceof Element)) return;
    const sources = attributeSources.get(element) || {};
    localizedAttributes.forEach(attribute => {
      if (!element.hasAttribute(attribute)) return;
      if (locale === DEFAULT_LOCALE) {
        if (Object.hasOwn(sources, attribute)) element.setAttribute(attribute, sources[attribute]);
        return;
      }
      const current = element.getAttribute(attribute);
      const translated = translateMessage(current);
      if (translated === current) return;
      sources[attribute] = current;
      element.setAttribute(attribute, translated);
    });
    if (Object.keys(sources).length) attributeSources.set(element, sources);
  }

  function localizeTree(root = document.body) {
    if (root instanceof Text) { localizeTextNode(root); return; }
    if (!(root instanceof Element || root instanceof DocumentFragment)) return;
    if (root instanceof Element) localizeElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) node instanceof Text ? localizeTextNode(node) : localizeElement(node);
  }

  function setDocumentLanguage() {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }

  function startObserver() {
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: localizedAttributes });
  }

  function observe() {
    observer = observer || new MutationObserver(records => {
      observer.disconnect();
      records.forEach(record => {
        if (record.type === 'characterData') localizeTextNode(record.target);
        if (record.type === 'attributes') localizeElement(record.target);
        record.addedNodes.forEach(localizeTree);
      });
      startObserver();
    });
    startObserver();
  }

  function setLocale(nextLocale) {
    if (!supportedLocales.includes(nextLocale)) return;
    if (observer) observer.disconnect();
    if (locale !== DEFAULT_LOCALE) {
      const previous = locale;
      locale = DEFAULT_LOCALE;
      localizeTree();
      locale = previous;
    }
    locale = nextLocale;
    localStorage.setItem(STORAGE_KEY, locale);
    setDocumentLanguage();
    localizeTree();
    const selector = document.getElementById('languageSelect');
    if (selector) selector.value = locale;
    observe();
    document.dispatchEvent(new CustomEvent('localechange', { detail: { locale } }));
  }

  function initializeLanguageSettings() {
    const form = document.getElementById('languageSettingsForm');
    const select = document.getElementById('languageSelect');
    const message = document.getElementById('languageSettingsMessage');
    if (!form || !select || !message) return;
    select.value = locale;
    form.addEventListener('submit', event => {
      event.preventDefault();
      setLocale(select.value);
      message.textContent = 'Language preference saved on this device.';
      message.hidden = false;
    });
  }
  window.i18n = {
    get locale() { return locale; },
    t: translateMessage,
    setLocale,
    formatNumber(value, options) { return Number(value || 0).toLocaleString(locale === 'ar' ? 'ar-SD' : 'en-US', options); },
    formatDate(value, options) { return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SD' : 'en-GB', options).format(value); }
  };

  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  window.alert = message => nativeAlert(translateMessage(String(message ?? '')));
  window.confirm = message => nativeConfirm(translateMessage(String(message ?? '')));

  setDocumentLanguage();
  initializeLanguageSettings();
  localizeTree();
  observe();
})();
