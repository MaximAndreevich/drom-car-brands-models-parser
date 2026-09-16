/**
 * drom-brands-models v4
 *
 * Collects every brand and its models (with listing counts) from the filter
 * dropdowns on auto.drom.ru, and for cars also every generation of every
 * model (code, full name, production years). The result is downloaded as
 * JSON.
 *
 * Works on both sections:
 *   https://auto.drom.ru/        cars (brands, models, generations)
 *   https://auto.drom.ru/moto/   motorcycles (brands, models)
 * The section is detected from the URL; progress is stored separately for
 * each section.
 *
 * HOW TO RUN
 *   1. Open a listing page, e.g. https://auto.drom.ru/toyota/all/
 *      or https://auto.drom.ru/moto/
 *   2. Open DevTools -> Console.
 *   3. Paste this file and press Enter. No manual setup required.
 *
 * The script drives the dropdowns itself. If a dropdown refuses to open
 * programmatically, it highlights the field, shows a prompt in the panel
 * at the top right, plays a short beep and waits for you to click it.
 *
 * RUNTIME CONTROLS (type in the console while it runs)
 *   window.__dromStop = true   stop after the current model, then export
 *   window.__dromExport()      download whatever has been collected so far
 *   window.__dromResult        raw result object with progress metadata
 *
 * Progress is written to localStorage after every brand (and, when
 * generations are collected, after every model), so a reload, a captcha or
 * a closed tab costs you very little: run the script again and it resumes.
 * To start over:
 *   localStorage.removeItem('__drom_scrape_v4_auto')
 *   localStorage.removeItem('__drom_scrape_v4_moto')
 */

(async () => {
  'use strict';

  /* ================================================================== */
  /* Configuration                                                      */
  /* ================================================================== */

  const CONFIG = {
    /** Brands to process. Empty array means all of them. */
    onlyBrands: [],

    /**
     * With onlyBrands set, export only those brands. Otherwise the JSON
     * contains everything saved for this section, including brands left
     * over from earlier runs.
     */
    exportOnlySelected: true,

    /** Hard cap on the number of brands, mostly useful for testing. */
    maxBrands: Infinity,

    /**
     * Collect generations for every model (cars only, ignored on /moto/).
     * This selects each model in turn, so it multiplies the run time by
     * roughly the number of models. Turn off for a fast brands+models pass.
     */
    collectGenerations: true,

    /** Try to open dropdowns programmatically before asking for a click. */
    tryAutoOpen: true,

    /**
     * Find options by typing their name into the combobox input instead of
     * scrolling the virtualised list. Disabled automatically for a field if
     * it never works there.
     */
    useTypeahead: true,

    /** How long to wait for the filtered option after typing, in ms. */
    typeaheadTimeout: 1200,

    /** How long to wait for a row after jumping to its remembered scroll position. */
    jumpTimeout: 350,

    /** Skip brands already marked as done in saved progress. */
    resume: true,

    /**
     * Re-run brands that were saved with status "review".
     *
     * A review status means that the script collected something but saw a
     * suspicious signal: no model options, incomplete scrolling, a timeout,
     * or the same model set as the previous brand.
     */
    retryReview: true,

    /** Automatically download the JSON at the end of every run. */
    autoExport: true,

    /** Milliseconds of network silence that counts as "loading finished". */
    networkQuietMs: 500,

    /** Give up waiting for network silence after this long. */
    networkIdleTimeout: 6000,

    /**
     * Requests matching any of these are not counted as "loading". Analytics
     * and ad beacons that never finish would otherwise stall every wait
     * until networkIdleTimeout.
     */
    networkIgnore: [
      /mc\.yandex\./i,
      /yandex\.[a-z]+\/(metrika|ads|clck)/i,
      /google-analytics|googletagmanager|doubleclick|googlesyndication/i,
      /top-fwz\d*\.mail\.ru|top\.mail\.ru|counter\.yadro|tns-counter/i,
      /adfox|adriver|criteo|betweendigital|adsniper/i,
      /vk\.com\/rtrg|sentry/i
    ],

    /** How long a list must stay unchanged before it counts as ready. */
    listStableMs: 500,

    /** Same for the (short) generation list. */
    generationStableMs: 600,

    /** Extra grace period after a brand filter has been applied. */
    afterBrandSettle: 400,

    /** Extra grace period after a model filter has been applied. */
    afterModelSettle: 800,

    /** Settle time after a model dropdown opens, before scraping it. */
    pauseAfterModelOpen: 400,

    /** Pause after each scroll step of a virtualised list. */
    pauseAfterScroll: 160,

    /** Retries when the model list looks stale, unavailable or empty. */
    modelAttempts: 3,

    /** Retries when the generation list looks stale or empty. */
    generationAttempts: 2,

    /** How long to wait for the generation field to become enabled. */
    generationFieldTimeout: 4000,

    /** How long to wait for generation options after the dropdown opens. */
    generationOptionsTimeout: 6000,

    /** Retries when a click does not change the filter field. */
    selectAttempts: 3,

    /** How long to wait for a clicked option to show up in the field. */
    applyTimeout: 8000,

    /**
     * Label fragments that identify the fields. Brand and model hints only
     * help before a value is selected: afterwards the placeholder holds the
     * selected value, and the field is found from cache or by position.
     */
    brandControlHints: ['марк', 'brand', 'firm'],
    modelControlHints: ['модел', 'model'],
    generationControlHints: ['поколен', 'generation'],

    /** Maximum scroll operations in one virtualised dropdown. */
    maxVirtualScrollSteps: 700,

    /** How long to wait for a manual click before giving up, in ms. */
    manualTimeout: 300000,

    /** Beep when a manual click is required. */
    sound: true,

    /** Verbose console output. */
    debug: true
  };

  /* ================================================================== */
  /* Section                                                            */
  /* ================================================================== */

  const SECTION = /^\/moto(\/|$)/.test(window.location.pathname)
    ? 'moto'
    : 'auto';

  const SECTIONS = {
    auto: {
      title: 'cars',
      example: 'https://auto.drom.ru/toyota/all/',
      hasGenerations: true,
      /**
       * Known brand names used to verify that the scraped list really is the
       * brand list and not, say, the model list of the current brand.
       */
      brandMarkers: [
        'toyota', 'honda', 'nissan', 'bmw', 'mercedes-benz',
        'volkswagen', 'ford', 'mazda', 'kia', 'hyundai'
      ]
    },
    moto: {
      title: 'motorcycles',
      example: 'https://auto.drom.ru/moto/',
      hasGenerations: false,
      brandMarkers: [
        'honda', 'yamaha', 'suzuki', 'kawasaki', 'bmw', 'ktm',
        'harley-davidson', 'ducati', 'triumph', 'aprilia', 'stels', 'irbis'
      ]
    }
  };

  const SECTION_INFO = SECTIONS[SECTION];
  const WITH_GENERATIONS =
    SECTION_INFO.hasGenerations && CONFIG.collectGenerations;

  const STORAGE_KEY = `__drom_scrape_v4_${SECTION}`;
  const LEGACY_STORAGE_KEY = '__drom_scrape_v2';
  const STATE_SCHEMA_VERSION = 4;

  /** Row height fallback for virtualised lists, in pixels. */
  const DEFAULT_ROW_HEIGHT = 35;

  /* ================================================================== */
  /* Utilities                                                          */
  /* ================================================================== */

  const log = (...args) => {
    if (CONFIG.debug) {
      console.log('[drom]', ...args);
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalize = (value) =>
    String(value || '').replace(/\s+/g, ' ').trim();

  const normalizeKey = (value) => normalize(value).toLocaleLowerCase('ru');

  const toNumber = (digits) =>
    Number(String(digits).replace(/[\s\u00a0\u202f]/g, ''));

  /** True when any of the hint fragments occurs in the given text. */
  const includesAnyHint = (text, hints) => {
    const haystack = normalizeKey(text);

    return (hints || []).some((hint) => haystack.includes(normalizeKey(hint)));
  };

  const isVisible = (element) => {
    if (!element || !element.isConnected) {
      return false;
    }

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const isDisabled = (element) =>
    Boolean(
      element &&
        (element.disabled ||
          element.getAttribute('aria-disabled') === 'true' ||
          element.closest('[aria-disabled="true"], fieldset[disabled]'))
    );

  /** Polls `callback` until it returns something truthy, or times out. */
  const waitFor = async (callback, timeout = 8000, interval = 100) => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      try {
        const result = callback();

        if (result) {
          return result;
        }
      } catch (error) {
        log('waitFor callback failed:', error);
      }

      await sleep(interval);
    }

    return null;
  };

  const timestampForFilename = () =>
    new Date().toISOString().replace(/[:.]/g, '-');

  const unique = (items) => [...new Set(items.filter(Boolean))];

  /* ================================================================== */
  /* Network idle detection                                             */
  /* ================================================================== */

  /**
   * Option lists are fetched asynchronously after a filter changes.
   * Counting in-flight requests gives an additional "loading finished"
   * signal without depending on any loader markup. Analytics requests are
   * ignored (CONFIG.networkIgnore).
   *
   * The hook is reference-counted and restores original browser APIs once
   * the last running copy of the script exits.
   */
  const acquireNetworkTracker = () => {
    const globalKey = '__dromNetworkTrackerStateV4';

    if (!window[globalKey]) {
      const state = {
        pending: 0,
        users: 0,
        ignore: [],
        originalFetch: window.fetch,
        originalXhrOpen: XMLHttpRequest.prototype.open,
        originalXhrSend: XMLHttpRequest.prototype.send,
        patchedFetch: null,
        patchedXhrOpen: null,
        patchedXhrSend: null
      };

      const isIgnored = (url) =>
        Boolean(url) && state.ignore.some((pattern) => pattern.test(url));

      const trackStart = () => {
        state.pending += 1;
      };

      const trackEnd = () => {
        state.pending = Math.max(0, state.pending - 1);
      };

      state.patchedFetch = function patchedFetch(...args) {
        const input = args[0];
        const url =
          typeof input === 'string' ? input : input?.url || String(input);

        if (isIgnored(url)) {
          return state.originalFetch.apply(this, args);
        }

        trackStart();

        try {
          return state.originalFetch.apply(this, args).finally(trackEnd);
        } catch (error) {
          trackEnd();
          throw error;
        }
      };

      state.patchedXhrOpen = function patchedXhrOpen(method, url, ...rest) {
        this.__dromUrl = String(url);

        return state.originalXhrOpen.call(this, method, url, ...rest);
      };

      state.patchedXhrSend = function patchedXhrSend(...args) {
        if (isIgnored(this.__dromUrl)) {
          return state.originalXhrSend.apply(this, args);
        }

        trackStart();

        let ended = false;

        const endOnce = () => {
          if (ended) {
            return;
          }

          ended = true;
          trackEnd();
        };

        this.addEventListener('loadend', endOnce, { once: true });

        try {
          return state.originalXhrSend.apply(this, args);
        } catch (error) {
          endOnce();
          throw error;
        }
      };

      window.fetch = state.patchedFetch;
      XMLHttpRequest.prototype.open = state.patchedXhrOpen;
      XMLHttpRequest.prototype.send = state.patchedXhrSend;

      window[globalKey] = state;
    }

    const state = window[globalKey];

    state.users += 1;
    state.ignore = CONFIG.networkIgnore || [];

    return {
      get pending() {
        return state.pending;
      },

      release() {
        state.users = Math.max(0, state.users - 1);

        if (state.users > 0) {
          return;
        }

        if (window.fetch === state.patchedFetch) {
          window.fetch = state.originalFetch;
        }

        if (XMLHttpRequest.prototype.open === state.patchedXhrOpen) {
          XMLHttpRequest.prototype.open = state.originalXhrOpen;
        }

        if (XMLHttpRequest.prototype.send === state.patchedXhrSend) {
          XMLHttpRequest.prototype.send = state.originalXhrSend;
        }

        delete window[globalKey];
      }
    };
  };

  const networkTracker = acquireNetworkTracker();

  const waitForNetworkIdle = async (
    quietMs = CONFIG.networkQuietMs,
    timeout = CONFIG.networkIdleTimeout
  ) => {
    const startedAt = Date.now();
    let quietSince = null;

    while (Date.now() - startedAt < timeout) {
      if (networkTracker.pending === 0) {
        if (quietSince === null) {
          quietSince = Date.now();
        }

        if (Date.now() - quietSince >= quietMs) {
          return true;
        }
      } else {
        quietSince = null;
      }

      await sleep(100);
    }

    return false;
  };

  /* ================================================================== */
  /* On-page status panel                                               */
  /* ================================================================== */

  document.getElementById('__drom_hud')?.remove();

  const hud = document.createElement('div');

  hud.id = '__drom_hud';

  Object.assign(hud.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '2147483647',
    width: '300px',
    padding: '12px 14px',
    background: 'rgba(17,17,20,0.95)',
    color: '#f2f2f2',
    font: '13px/1.45 -apple-system, system-ui, Segoe UI, sans-serif',
    borderRadius: '10px',
    borderLeft: '4px solid #46a758',
    boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
    whiteSpace: 'pre-wrap',

    // Never intercept clicks: the user may need to click the field below.
    pointerEvents: 'none'
  });

  document.body.appendChild(hud);

  const setStatus = (text, needsClick = false) => {
    hud.textContent = `[${SECTION}] ${text}`;
    hud.style.borderLeftColor = needsClick ? '#ff7a1a' : '#46a758';
  };

  let highlighted = null;

  const clearHighlight = () => {
    if (highlighted && highlighted.isConnected) {
      highlighted.style.outline = highlighted.__dromOutline || '';
      highlighted.style.outlineOffset = '';
    }

    highlighted = null;
  };

  const highlight = (element) => {
    clearHighlight();

    if (!element) {
      return;
    }

    element.__dromOutline = element.style.outline;
    element.style.outline = '3px solid #ff7a1a';
    element.style.outlineOffset = '2px';
    element.scrollIntoView({ block: 'center', inline: 'nearest' });

    highlighted = element;
  };

  const beep = () => {
    if (!CONFIG.sound) {
      return;
    }

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const context = new AudioCtx();
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.frequency.value = 880;
      gain.gain.value = 0.04;
      oscillator.start();

      setTimeout(() => {
        oscillator.stop();
        context.close();
      }, 120);
    } catch (error) {
      // Audio is optional; never let it break the run.
    }
  };

  /* ================================================================== */
  /* Synthetic input                                                    */
  /* ================================================================== */

  /**
   * PointerEvent defaults to pointerId 0, isPrimary false and an empty
   * pointerType, which many component libraries ignore. These have to be
   * set explicitly for the dropdown to react.
   */
  const POINTER_DEFAULTS = {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    width: 1,
    height: 1
  };

  const realClick = (element) => {
    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const topmost = document.elementFromPoint(clientX, clientY);

    // Select triggers are often covered by a transparent overlay that
    // owns the listener, so dispatch on whatever is actually on top.
    const target =
      topmost &&
      (element.contains(topmost) ||
        topmost.contains(element) ||
        topmost === element)
        ? topmost
        : element;

    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      detail: 1
    };

    const down = {
      ...base,
      ...POINTER_DEFAULTS,
      buttons: 1,
      pressure: 0.5
    };

    const up = {
      ...base,
      ...POINTER_DEFAULTS,
      buttons: 0,
      pressure: 0
    };

    target.dispatchEvent(new PointerEvent('pointerover', down));
    target.dispatchEvent(new MouseEvent('mouseover', base));
    target.dispatchEvent(new MouseEvent('mousemove', base));
    target.dispatchEvent(new PointerEvent('pointerdown', down));
    target.dispatchEvent(new MouseEvent('mousedown', down));

    if (typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }

    target.dispatchEvent(new PointerEvent('pointerup', up));
    target.dispatchEvent(new MouseEvent('mouseup', up));
    target.dispatchEvent(new MouseEvent('click', up));

    return target;
  };

  const pressKey = (element, descriptor) => {
    const options = {
      ...descriptor,
      which: descriptor.keyCode,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    element.dispatchEvent(new KeyboardEvent('keydown', options));
    element.dispatchEvent(new KeyboardEvent('keyup', options));
  };

  /**
   * React ignores direct value assignment, so go through the native setter
   * and let the component see a real input event.
   */
  const setInputValue = (control, value) => {
    if (!control || !control.matches('input')) {
      return false;
    }

    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    ).set;

    control.focus({ preventScroll: true });
    setter.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));

    return true;
  };

  /* ================================================================== */
  /* Comboboxes                                                         */
  /* ================================================================== */

  /**
   * role="combobox" is often present on both the input and its wrapper div.
   * Prefer actual inputs, otherwise selecting the "next" field can return a
   * wrapper for the same control.
   */
  const getComboboxes = () => {
    const inputControls = [
      ...document.querySelectorAll('input[role="combobox"][aria-controls]')
    ].filter(isVisible);

    if (inputControls.length > 0) {
      return inputControls;
    }

    return [
      ...document.querySelectorAll('[role="combobox"][aria-controls]')
    ].filter(isVisible);
  };

  /**
   * All text that can identify a control: its own attributes plus any
   * associated label.
   */
  const getControlSearchText = (control) => {
    if (!control) {
      return '';
    }

    const labels = control.id
      ? [...document.querySelectorAll(`label[for="${CSS.escape(control.id)}"]`)]
          .map((label) => label.textContent)
      : [];

    const parentLabel = control.closest('label')?.textContent || '';

    return normalize(
      [
        control.getAttribute('placeholder'),
        control.getAttribute('aria-label'),
        control.getAttribute('name'),
        control.getAttribute('data-testid'),
        parentLabel,
        ...labels
      ].join(' ')
    );
  };

  /**
   * The listbox id lives in aria-controls and may change on re-render, so it
   * is always read at call time and never cached.
   */
  const getListboxFor = (control) => {
    if (!control || !control.isConnected) {
      return null;
    }

    const id = control.getAttribute('aria-controls');
    let listbox = id ? document.getElementById(id) : null;

    // The generation field is not an input and its dropdown may be rendered
    // only while open, so it is also located by its data-ftid.
    if (!listbox && control.__dromListboxSelector) {
      listbox = document.querySelector(control.__dromListboxSelector);
    }

    return listbox && isVisible(listbox) ? listbox : null;
  };

  const isOpen = (control) => {
    if (!control || !control.isConnected) {
      return false;
    }

    const listbox = getListboxFor(control);

    if (!listbox) {
      return false;
    }

    if (control.__dromListboxSelector) {
      return true;
    }

    return control.getAttribute('aria-expanded') === 'true';
  };

  const hasOptions = (listbox) =>
    Boolean(listbox && listbox.querySelector('[role="option"]'));

  /**
   * Located fields are cached: once a value is selected, the placeholder
   * shows that value and the field can no longer be recognised by its text.
   */
  const controlCache = { brand: null, model: null, generation: null };

  const isAlive = (element) => Boolean(element && isVisible(element));

  const findByHints = (comboboxes, hints, exclude = []) =>
    comboboxes
      .filter(
        (element) =>
          !exclude.includes(element) &&
          includesAnyHint(getControlSearchText(element), hints)
      )
      .pop() || null;

  const followingControl = (comboboxes, anchor) =>
    anchor
      ? comboboxes.find(
          (element) =>
            element !== anchor &&
            anchor.compareDocumentPosition(element) &
              Node.DOCUMENT_POSITION_FOLLOWING
        ) || null
      : null;

  const precedingControl = (comboboxes, anchor) =>
    anchor
      ? comboboxes
          .filter(
            (element) =>
              element !== anchor &&
              element.compareDocumentPosition(anchor) &
                Node.DOCUMENT_POSITION_FOLLOWING
          )
          .pop() || null
      : null;

  /** Model field recognised by placeholder only ("Модель"). */
  const findUnselectedModelControl = (comboboxes) =>
    comboboxes.find((element) =>
      /^модел/i.test(normalize(element.getAttribute('placeholder') || ''))
    ) || null;

  const GENERATION_DROPDOWN_SELECTOR =
    '[data-ftid="sales__filter_generation__dropdown"]';

  /**
   * Unlike brand and model, the generation field is not an <input> (its
   * dropdown shows photo cards, there is nothing to type), so it is not
   * returned by getComboboxes(). It is searched among all combobox-like
   * elements by data-ftid, placeholder or visible text ("Поколение").
   */
  const findGenerationControl = () => {
    if (isAlive(controlCache.generation)) {
      return controlCache.generation;
    }

    const candidates = [
      ...document.querySelectorAll(
        '[data-ftid*="generation"], [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"]'
      )
    ].filter(
      (element) =>
        isVisible(element) &&
        !element.matches('[role="listbox"], [role="option"]') &&
        !element.closest('[role="listbox"]') &&
        !/__(dropdown|reset)$/.test(element.getAttribute('data-ftid') || '')
    );

    const describe = (element) =>
      normalize(
        [
          element.getAttribute('data-ftid'),
          element.getAttribute('placeholder'),
          element.getAttribute('aria-label'),
          element.getAttribute('name'),
          element.textContent.slice(0, 60)
        ].join(' ')
      );

    const matches = candidates.filter((element) =>
      includesAnyHint(describe(element), CONFIG.generationControlHints)
    );

    // Innermost match: the trigger itself, not a wrapper around the row.
    const found =
      matches.find((element) => element.matches('[role="combobox"]')) ||
      matches.filter(
        (element) => !matches.some((other) => other !== element && element.contains(other))
      )[0] ||
      null;

    if (found) {
      found.__dromListboxSelector = GENERATION_DROPDOWN_SELECTOR;
      controlCache.generation = found;
    }

    return found;
  };

  /**
   * Prefer an explicitly labelled brand field. If its label disappears after
   * selecting a value, use the closest combobox preceding the model field.
   */
  const findBrandControl = () => {
    if (isAlive(controlCache.brand)) {
      return controlCache.brand;
    }

    const comboboxes = getComboboxes();
    const modelControl =
      (isAlive(controlCache.model) && controlCache.model) ||
      findUnselectedModelControl(comboboxes);

    const exclude = [modelControl, controlCache.generation].filter(Boolean);

    return (
      findByHints(comboboxes, CONFIG.brandControlHints, exclude) ||
      precedingControl(comboboxes, modelControl) ||
      comboboxes[0] ||
      null
    );
  };

  /**
   * "Модель" placeholder first; once a model is selected, the cached element
   * or the combobox that directly follows the brand field.
   */
  const findModelControl = () => {
    if (isAlive(controlCache.model)) {
      return controlCache.model;
    }

    const comboboxes = getComboboxes();
    const byPlaceholder = findUnselectedModelControl(comboboxes);

    if (byPlaceholder) {
      controlCache.model = byPlaceholder;

      return byPlaceholder;
    }

    return followingControl(comboboxes, findBrandControl());
  };

  const autoOpenStrategies = [
    {
      name: 'click',
      run: (control) => realClick(control)
    },
    {
      name: 'focus + ArrowDown',
      run: (control) => {
        control.focus({ preventScroll: true });
        pressKey(control, {
          key: 'ArrowDown',
          code: 'ArrowDown',
          keyCode: 40
        });
      }
    },
    {
      name: 'focus + Alt+ArrowDown',
      run: (control) => {
        control.focus({ preventScroll: true });
        pressKey(control, {
          key: 'ArrowDown',
          code: 'ArrowDown',
          keyCode: 40,
          altKey: true
        });
      }
    },
    {
      name: 'input event',
      run: (control) => setInputValue(control, control.value || '')
    }
  ];

  /** Index of the strategy that last worked, per field label. */
  const preferredStrategy = {};

  const waitForManualOpen = async (control, label, progressText) => {
    highlight(control);
    beep();

    setStatus(
      `${progressText}\n\n👉 Click the highlighted field:\n${label}`,
      true
    );

    const listbox = await waitFor(
      () => (isOpen(control) ? getListboxFor(control) : null),
      CONFIG.manualTimeout,
      150
    );

    clearHighlight();

    return listbox;
  };

  const isInViewport = (element) => {
    const rect = element.getBoundingClientRect();

    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  };

  /**
   * `manual: false` returns null instead of asking for a click, and
   * `onlyPreferred` skips the other strategies once one is known to work.
   * Both are used for dropdowns that may legitimately be empty.
   */
  const ensureOpen = async (
    control,
    label,
    progressText,
    { manual = true, onlyPreferred = false } = {}
  ) => {
    if (isOpen(control)) {
      return getListboxFor(control);
    }

    if (CONFIG.tryAutoOpen) {
      const preferred = preferredStrategy[label];
      const order = autoOpenStrategies
        .map((strategy, index) => index)
        .filter(
          (index) =>
            !onlyPreferred || preferred === undefined || index === preferred
        )
        .sort((left, right) =>
          left === preferred ? -1 : right === preferred ? 1 : left - right
        );

      for (const index of order) {
        const strategy = autoOpenStrategies[index];

        if (!isInViewport(control)) {
          control.scrollIntoView({ block: 'center', inline: 'nearest' });
          await sleep(80);
        }

        if (strategy.run(control) === false) {
          continue;
        }

        const listbox = await waitFor(
          () => (isOpen(control) ? getListboxFor(control) : null),
          1800,
          50
        );

        if (listbox) {
          if (preferredStrategy[label] !== index) {
            log(`${label}: opened via "${strategy.name}"`);
          }

          preferredStrategy[label] = index;

          return listbox;
        }
      }

      if (!manual) {
        return null;
      }

      log(`${label}: could not open programmatically, asking for a click`);
    }

    return manual ? waitForManualOpen(control, label, progressText) : null;
  };

  const ensureClosed = async (control) => {
    if (!isOpen(control)) {
      return;
    }

    pressKey(control, { key: 'Escape', code: 'Escape', keyCode: 27 });

    if (await waitFor(() => !isOpen(control), 1000, 50)) {
      return;
    }

    realClick(control);
    await waitFor(() => !isOpen(control), 1000, 50);
  };

  /* ================================================================== */
  /* Virtualised list scraping                                          */
  /* ================================================================== */

  const isScrollable = (element) => {
    const style = getComputedStyle(element);

    return (
      element.scrollHeight > element.clientHeight + 1 &&
      (style.overflowY === 'auto' || style.overflowY === 'scroll')
    );
  };

  const getScrollableElement = (root) => {
    const firstOption = root.querySelector('[role="option"]');

    if (firstOption) {
      let current = firstOption.parentElement;

      while (current && current !== root.parentElement) {
        if (isScrollable(current)) {
          return current;
        }

        current = current.parentElement;
      }
    }

    const candidates = [root, ...root.querySelectorAll('*')].filter(
      isScrollable
    );

    if (candidates.length > 0) {
      return candidates.sort(
        (left, right) => right.clientHeight - left.clientHeight
      )[0];
    }

    return root;
  };

  const scrollTo = (scroller, top) => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  };

  /** Measured rather than hard-coded, since row height is theme-dependent. */
  const detectRowHeight = (listbox) => {
    const options = [...listbox.querySelectorAll('[role="option"]')];

    if (options.length >= 2) {
      const delta = Math.abs(
        Math.round(
          options[1].getBoundingClientRect().top -
            options[0].getBoundingClientRect().top
        )
      );

      if (delta > 5) {
        return delta;
      }
    }

    if (options.length === 1) {
      const height = Math.round(options[0].getBoundingClientRect().height);

      if (height > 5) {
        return height;
      }
    }

    return DEFAULT_ROW_HEIGHT;
  };

  /**
   * Position is used only for ordering and efficient revealOption() scrolling.
   * It is deliberately not used as the identity of an option.
   */
  const getOptionIndex = (option, rowHeight) => {
    const ariaPosition = Number(option.getAttribute('aria-posinset'));

    if (Number.isInteger(ariaPosition) && ariaPosition > 0) {
      return ariaPosition - 1;
    }

    const dataIndex = Number(
      option.getAttribute('data-index') ||
        option.getAttribute('data-option-index')
    );

    if (Number.isInteger(dataIndex) && dataIndex >= 0) {
      return dataIndex;
    }

    const idMatch = (option.id || '').match(/-(\d+)$/);

    if (idMatch) {
      return Number(idMatch[1]);
    }

    let current = option;

    for (let level = 0; level < 4 && current; level += 1) {
      const transform = current.style?.transform || '';
      const match = transform.match(/translateY\(([\d.]+)px\)/);

      if (match) {
        return Math.round(Number(match[1]) / rowHeight);
      }

      current = current.parentElement;
    }

    return null;
  };

  const PLACEHOLDER_OPTIONS = [
    'марка',
    'модель',
    'поколение',
    'все марки',
    'все модели',
    'все поколения',
    'любая марка',
    'любая модель',
    'любое поколение',
    'выберите марку',
    'выберите модель',
    'выберите поколение'
  ];

  const isPlaceholderOption = (name) =>
    PLACEHOLDER_OPTIONS.includes(normalizeKey(name));

  const COUNT_TAIL_RE = /\s*\(([\d\s\u00a0\u202f]+)\)\s*$/;

  /** Splits "Corolla (1 234)" into a name and a listing count. */
  const parseOption = (option, rowHeight) => {
    const rawText = normalize(option.textContent);

    if (!rawText) {
      return null;
    }

    const countMatch = rawText.match(/^(.*?)\s+\(([\d\s\u00a0\u202f]+)\)$/);

    return {
      name: countMatch ? normalize(countMatch[1]) : rawText,
      count: countMatch ? toNumber(countMatch[2]) : null,
      index: getOptionIndex(option, rowHeight),
      rawText
    };
  };

  /* ------------------------------------------------------------------ */
  /* Generation option parsing                                          */
  /* ------------------------------------------------------------------ */

  /** Text nodes of an option, so "E210" and "2018 - н.в." in separate
   *  spans do not get glued into "E2102018 - н.в.". */
  const getTextParts = (element) => {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      const text = normalize(node.nodeValue);

      if (text) {
        parts.push(text);
      }
    }

    return parts;
  };

  const YEAR = '(?:19|20)\\d{2}';
  const YEARS_RANGE_RE = new RegExp(
    `(${YEAR})\\s*(?:г\\.?)?\\s*[-–—]\\s*(${YEAR}|н\\.?\\s*в\\.?|наст\\S*(?:\\s*вр\\S*)?)(?:\\s*г\\.?)?`,
    'i'
  );
  const YEAR_FROM_RE = new RegExp(
    `(?:^|\\s)(?:с|от|since)\\s*(${YEAR})(?:\\s*г\\.?)?(?=$|[\\s),])`,
    'i'
  );
  const YEAR_ONLY_RE = new RegExp(`^(${YEAR})(?:\\s*г\\.?)?$`, 'i');

  /** Generation codes: E210, XV70, J200/J210, B8, W213... */
  const isCodeLike = (text) =>
    /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9][A-Za-z0-9\-/.]{0,14}$/.test(text) ||
    /^[A-Z]{2,6}$/.test(text);

  /**
   * The exact markup of generation options is not known in advance, so this
   * is heuristic: the option is split into segments (text nodes, then commas
   * and bullets), and each segment is classified as a listing count,
   * production years, a code, or part of the full name. The untouched text
   * is always kept in `raw`.
   */
  /**
   * Known drom markup: a photo card whose aria-hidden caption has two lines,
   *   "2022 - н.в., 394"         years, then the generation code
   *   "1 поколение, рестайлинг"  full name
   * The listing count is not shown in cards.
   */
  const parseGenerationCard = (option) => {
    const caption = option.querySelector('[aria-hidden="true"]') || option;
    const lines = [...caption.querySelectorAll('div, span')]
      .filter((element) => !element.querySelector('div, span'))
      .map((element) => normalize(element.textContent))
      .filter(Boolean);

    const yearsIndex = lines.findIndex((line) =>
      new RegExp(`^(${YEAR})`).test(line)
    );

    if (lines.length < 2 || yearsIndex === -1) {
      return null;
    }

    const yearsLine = lines[yearsIndex];
    const range = yearsLine.match(YEARS_RANGE_RE);
    const single = range ? null : yearsLine.match(new RegExp(`^(${YEAR})`));
    const match = range || single;
    const code = normalize(
      yearsLine.slice(match.index + match[0].length).replace(/^[\s,;:·•\-–—]+/, '')
    );

    return {
      name: lines.filter((line, index) => index !== yearsIndex).join(', ') || null,
      code: code || null,
      yearFrom: Number(match[1]),
      yearTo: range && /^\d{4}$/.test(range[2]) ? Number(range[2]) : null,
      years: normalize(match[0]),
      count: null,
      label: option.getAttribute('aria-label') || null,
      photo: option.querySelector('img')?.getAttribute('src') || null,
      rawText: lines.join(' | ')
    };
  };

  const parseGeneration = (option, rowHeight) => {
    const card = parseGenerationCard(option);

    if (card) {
      return { ...card, index: getOptionIndex(option, rowHeight) };
    }

    const parts = getTextParts(option);
    const rawText = normalize(parts.join(' '));

    if (!rawText) {
      return null;
    }

    let count = null;
    let yearFrom = null;
    let yearTo = null;
    let years = null;
    let code = null;
    const nameParts = [];

    const segments = parts
      .flatMap((part) => part.split(/\s*[,·•|;]\s*/))
      .map(normalize)
      .filter(Boolean);

    for (let segment of segments) {
      const countMatch = segment.match(COUNT_TAIL_RE);

      if (countMatch && count === null) {
        count = toNumber(countMatch[1]);
        segment = segment.slice(0, countMatch.index);
      }

      if (years === null) {
        const range = segment.match(YEARS_RANGE_RE);
        const from = range ? null : segment.match(YEAR_FROM_RE);
        const only = range || from ? null : normalize(segment).match(YEAR_ONLY_RE);
        const match = range || from || only;

        if (match) {
          yearFrom = Number(match[1]);
          yearTo = range && /^\d{4}$/.test(range[2]) ? Number(range[2]) : null;
          years = normalize(match[0]);
          segment =
            segment.slice(0, match.index) +
            ' ' +
            segment.slice(match.index + match[0].length);
        }
      }

      segment = normalize(
        segment
          .replace(/\(\s*\)/g, ' ')
          .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '')
      );

      if (/^\(.*\)$/.test(segment)) {
        segment = normalize(segment.slice(1, -1));
      }

      if (!segment) {
        continue;
      }

      if (!code && isCodeLike(segment)) {
        code = segment;
        continue;
      }

      if (!code) {
        const words = segment.split(' ');

        if (words.length > 1 && isCodeLike(words[0])) {
          code = words.shift();
          segment = words.join(' ');
        } else if (words.length > 1 && isCodeLike(words[words.length - 1])) {
          code = words.pop();
          segment = words.join(' ');
        }
      }

      nameParts.push(segment);
    }

    return {
      name: nameParts.join(', ') || null,
      code,
      yearFrom,
      yearTo,
      years,
      count,
      label: option.getAttribute('aria-label') || null,
      photo: option.querySelector('img')?.getAttribute('src') || null,
      index: getOptionIndex(option, rowHeight),
      rawText
    };
  };

  const toGenerationRecord = (entry) => ({
    code: entry.code,
    name: entry.name,
    yearFrom: entry.yearFrom,
    yearTo: entry.yearTo,
    years: entry.years,
    count: entry.count,
    label: entry.label,
    photo: entry.photo,
    raw: entry.rawText
  });

  /** A list is ready once its visible contents stop changing for `quietMs`. */
  const waitForListStable = async (
    listbox,
    quietMs = CONFIG.listStableMs,
    timeout = 12000
  ) => {
    const signature = () => {
      const options = [...listbox.querySelectorAll('[role="option"]')];
      const scroller = getScrollableElement(listbox);

      return [
        options.length,
        scroller.scrollHeight,
        options.map((option) => normalize(option.textContent)).join('|')
      ].join('::');
    };

    const startedAt = Date.now();
    let previous = null;
    let stableSince = null;

    while (Date.now() - startedAt < timeout) {
      const current = signature();

      if (current === previous) {
        if (stableSince === null) {
          stableSince = Date.now();
        }

        if (Date.now() - stableSince >= quietMs) {
          return true;
        }
      } else {
        previous = current;
        stableSince = null;
      }

      await sleep(100);
    }

    return false;
  };

  /**
   * Only a window of rows may exist in the DOM at any time, so the list has
   * to be scrolled to the bottom while rows are harvested along the way.
   *
   * Identity is the normalized name by default. Drom renders a "popular"
   * block before the full alphabetical list, so the same brand or model
   * legitimately appears twice; a name-keyed map collapses those duplicates.
   *
   * Each entry also remembers the scrollTop at which it was first rendered,
   * so selecting it later is a single jump instead of a walk.
   */
  const collectAllOptions = async (
    listbox,
    {
      parse = parseOption,
      keyOf = (entry) => normalizeKey(entry.name),
      isPlaceholder = (entry) => isPlaceholderOption(entry.name)
    } = {}
  ) => {
    const scroller = getScrollableElement(listbox);
    const rowHeight = detectRowHeight(listbox);
    const collection = new Map();

    // Distinct DOM positions per key, used to tell a genuine duplicate
    // (the popular block) from the same row re-observed while scrolling.
    const positions = new Map();

    const collectVisibleOptions = () => {
      const scrollTop = scroller.scrollTop;

      listbox.querySelectorAll('[role="option"]').forEach((option) => {
        const parsed = parse(option, rowHeight);

        if (!parsed || isPlaceholder(parsed)) {
          return;
        }

        parsed.scrollTop = scrollTop;

        const key = keyOf(parsed);
        const position = option.id || `index:${parsed.index}`;

        if (!positions.has(key)) {
          positions.set(key, new Set());
        }

        positions.get(key).add(position);

        const previous = collection.get(key);

        if (!previous) {
          collection.set(key, parsed);

          return;
        }

        if (previous.count === null && parsed.count !== null) {
          previous.count = parsed.count;
        }

        if (
          previous.index === null ||
          (parsed.index !== null && parsed.index < previous.index)
        ) {
          previous.index = parsed.index;
        }
      });
    };

    collectVisibleOptions();

    const clientHeight = scroller.clientHeight || 350;
    const step = Math.max(70, Math.floor(clientHeight * 0.6));

    let reachedBottom = false;
    let scrollSteps = 0;

    while (scrollSteps < CONFIG.maxVirtualScrollSteps) {
      const maxScrollTop = Math.max(0, scroller.scrollHeight - clientHeight);
      const currentTop = scroller.scrollTop;

      if (currentTop >= maxScrollTop - 1) {
        reachedBottom = true;
        break;
      }

      const nextTop = Math.min(currentTop + step, maxScrollTop);

      if (nextTop <= currentTop) {
        break;
      }

      scrollTo(scroller, nextTop);

      await sleep(CONFIG.pauseAfterScroll);
      collectVisibleOptions();

      scrollSteps += 1;
    }

    if (scrollSteps > 0) {
      await sleep(CONFIG.pauseAfterScroll * 2);
      collectVisibleOptions();

      scrollTo(scroller, 0);
      await sleep(CONFIG.pauseAfterScroll);
    }

    const entries = [...collection.values()]
      .map((entry) => ({
        ...entry,
        popular: (positions.get(keyOf(entry))?.size || 1) > 1
      }))
      .sort((left, right) => {
        if (left.index !== null && right.index !== null) {
          return left.index - right.index;
        }

        if (left.index !== null) {
          return -1;
        }

        if (right.index !== null) {
          return 1;
        }

        return String(left.name || left.rawText).localeCompare(
          String(right.name || right.rawText),
          'ru'
        );
      });

    return {
      entries,
      reachedBottom,
      scrollSteps
    };
  };

  /** Options are matched by text only, never by position. */
  const findOptionByEntry = (listbox, entry) => {
    const rowHeight = detectRowHeight(listbox);
    const entryKey = normalizeKey(entry.name);

    return (
      [...listbox.querySelectorAll('[role="option"]')].find((option) => {
        const parsed = parseOption(option, rowHeight);

        return parsed && normalizeKey(parsed.name) === entryKey;
      }) || null
    );
  };

  /** Slow fallback: estimate by index, then walk the list and match text. */
  const revealOption = async (listbox, entry) => {
    const scroller = getScrollableElement(listbox);
    const rowHeight = detectRowHeight(listbox);
    const clientHeight = scroller.clientHeight || 350;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - clientHeight);

    if (entry.index !== null && entry.index !== undefined) {
      scrollTo(
        scroller,
        Math.max(
          0,
          Math.min(entry.index * rowHeight - clientHeight / 2, maxScrollTop)
        )
      );

      await sleep(CONFIG.pauseAfterScroll);

      const estimatedOption = findOptionByEntry(listbox, entry);

      if (estimatedOption) {
        return estimatedOption;
      }
    }

    const step = Math.max(70, Math.floor(clientHeight * 0.5));

    for (let top = 0; top <= maxScrollTop; top += step) {
      scrollTo(scroller, top);
      await sleep(CONFIG.pauseAfterScroll);

      const option = findOptionByEntry(listbox, entry);

      if (option) {
        return option;
      }
    }

    return null;
  };

  /** Typeahead success statistics per field label. */
  const typeaheadStats = {};

  /**
   * Fast path for finding a row in an open dropdown:
   *   1. already rendered;
   *   2. jump to the scrollTop remembered during collection;
   *   3. type the name into the input and let the component filter;
   *   4. fall back to revealOption().
   */
  const findOptionForEntry = async (control, label, entry) => {
    const current = () => {
      const listbox = getListboxFor(control);

      return listbox ? findOptionByEntry(listbox, entry) : null;
    };

    let option = current();

    if (option) {
      return option;
    }

    let listbox = getListboxFor(control);

    if (listbox && typeof entry.scrollTop === 'number') {
      scrollTo(getScrollableElement(listbox), entry.scrollTop);
      option = await waitFor(current, CONFIG.jumpTimeout, 40);

      if (option) {
        return option;
      }
    }

    const stats = (typeaheadStats[label] ||= { hits: 0, misses: 0 });
    const typeaheadUsable = !(stats.hits === 0 && stats.misses >= 3);

    if (CONFIG.useTypeahead && typeaheadUsable && control.matches('input')) {
      setInputValue(control, entry.name);
      option = await waitFor(current, CONFIG.typeaheadTimeout, 60);

      if (option) {
        stats.hits += 1;

        return option;
      }

      stats.misses += 1;

      if (stats.hits === 0 && stats.misses === 3) {
        log(`${label}: typeahead does not work here, disabled`);
      }

      setInputValue(control, '');
      await waitFor(() => hasOptions(getListboxFor(control)), 1500, 80);
    }

    listbox = getListboxFor(control);

    return listbox ? revealOption(listbox, entry) : null;
  };

  /**
   * Once a value is applied, the placeholder usually becomes "Volvo (1234)".
   * Compare exactly after removing the listing count.
   */
  const getSelectedName = (control) =>
    normalize(
      normalize(control?.getAttribute('placeholder')).replace(COUNT_TAIL_RE, '')
    );

  /**
   * Selecting is verified twice: the option text is checked before the
   * click, and the filter field is checked after it. Without the second
   * check a click that did not register leaves the previous value selected,
   * and everything collected next silently belongs to the wrong value.
   */
  const selectOption = async ({ label, getControl, entry, progress }) => {
    const expected = normalizeKey(entry.name);
    let selected = null;

    const isApplied = () => {
      const control = getControl();

      return Boolean(
        control && normalizeKey(getSelectedName(control)) === expected
      );
    };

    for (let attempt = 1; attempt <= CONFIG.selectAttempts; attempt += 1) {
      const control = await waitFor(() => {
        const candidate = getControl();

        return candidate && !isDisabled(candidate) ? candidate : null;
      }, 8000, 100);

      if (!control) {
        throw new Error(`${label} field not found or disabled.`);
      }

      if (isApplied()) {
        return { applied: true, changed: attempt > 1, attempts: attempt };
      }

      const listbox = await ensureOpen(control, label, progress);

      if (!listbox) {
        throw new Error(`${label} list did not open.`);
      }

      if (!(await waitFor(() => hasOptions(getListboxFor(control)), 5000, 80))) {
        throw new Error(`${label} list opened but has no options.`);
      }

      const option = await findOptionForEntry(control, label, entry);
      const optionName = option
        ? normalizeKey(parseOption(option, DEFAULT_ROW_HEIGHT)?.name)
        : null;

      if (!option || optionName !== expected) {
        log(
          `${label}: option "${entry.name}" not found on attempt ${attempt}` +
            (option ? ` (got "${optionName}")` : '')
        );

        await ensureClosed(control);
        continue;
      }

      realClick(option);

      const applied = await waitFor(isApplied, CONFIG.applyTimeout, 80);

      await ensureClosed(getControl() || control);

      if (applied) {
        return { applied: true, changed: true, attempts: attempt };
      }

      selected = getSelectedName(getControl());

      log(`${label}: not applied on attempt ${attempt}, field shows "${selected}"`);

      await waitForNetworkIdle();
      await sleep(CONFIG.afterBrandSettle);
    }

    return { applied: false, selected };
  };

  /* ================================================================== */
  /* Storage and export                                                 */
  /* ================================================================== */

  const createEmptyState = () => ({
    schemaVersion: STATE_SCHEMA_VERSION,
    section: SECTION,
    sourceOrigin: window.location.origin,
    sourceUrlInitial: window.location.href,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    brands: {}
  });

  /** v2 progress (cars only) keeps its brands and models. */
  const migrateV2State = (legacy) => {
    const state = createEmptyState();

    state.sourceUrlInitial = legacy.sourceUrlInitial || state.sourceUrlInitial;
    Object.assign(state.brands, legacy.brands);

    return state;
  };

  const loadSaved = () => {
    if (!CONFIG.resume) {
      return createEmptyState();
    }

    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');

      if (
        saved &&
        saved.schemaVersion === STATE_SCHEMA_VERSION &&
        saved.brands &&
        typeof saved.brands === 'object'
      ) {
        return saved;
      }
    } catch (error) {
      log('could not read saved progress:', error);
    }

    if (SECTION === 'auto') {
      try {
        const legacy = JSON.parse(
          localStorage.getItem(LEGACY_STORAGE_KEY) || 'null'
        );

        if (
          legacy &&
          legacy.schemaVersion === 2 &&
          legacy.brands &&
          !/\/moto(\/|$)/.test(new URL(legacy.sourceUrlInitial || location.href).pathname)
        ) {
          log('migrating progress from v2 storage');

          return migrateV2State(legacy);
        }
      } catch (error) {
        log('could not read v2 progress:', error);
      }
    }

    return createEmptyState();
  };

  const state = loadSaved();

  window.__dromResult = state;

  const save = () => {
    state.updatedAt = new Date().toISOString();
    window.__dromResult = state;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn(
        '[drom] Could not persist progress to localStorage. ' +
          'You can still export current data with window.__dromExport().',
        error
      );
    }
  };

  const download = (content, filename, mimeType) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const getBrandEntries = () =>
    Object.entries(state.brands).sort(([left], [right]) =>
      left.localeCompare(right, 'ru')
    );

  const buildExportPayload = () => {
    const selected = CONFIG.onlyBrands.map(normalizeKey).filter(Boolean);
    const brands = getBrandEntries()
      .filter(
        ([name]) =>
          !CONFIG.exportOnlySelected ||
          selected.length === 0 ||
          selected.includes(normalizeKey(name))
      )
      .map(([name, data]) => {
      const models = data.models || [];

      return {
        name,
        listings: data.brandListings ?? null,
        status: data.status,
        modelCount: models.length,
        collectedAt: data.collectedAt || null,
        reviewReasons: data.reviewReasons?.length
          ? data.reviewReasons
          : undefined,
        models: models.map((entry) => {
          const model = { name: entry.model, count: entry.count };

          if (SECTION_INFO.hasGenerations) {
            model.generations = entry.generations ?? null;

            if (entry.generationsStatus && entry.generationsStatus !== 'done') {
              model.generationsStatus = entry.generationsStatus;
            }

            if (entry.generationsReasons?.length) {
              model.generationsReasons = entry.generationsReasons;
            }
          }

          return model;
        })
      };
    });

    const stats = {
      brands: brands.length,
      done: brands.filter((brand) => brand.status === 'done').length,
      review: brands.filter((brand) => brand.status === 'review').length,
      partial: brands.filter((brand) => brand.status === 'partial').length,
      models: brands.reduce((sum, brand) => sum + brand.modelCount, 0)
    };

    if (SECTION_INFO.hasGenerations) {
      stats.generations = brands.reduce(
        (sum, brand) =>
          sum +
          brand.models.reduce(
            (inner, model) => inner + (model.generations?.length || 0),
            0
          ),
        0
      );
    }

    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      section: SECTION,
      source: state.sourceUrlInitial,
      collectedAt: state.updatedAt || new Date().toISOString(),
      stats,
      brands
    };
  };

  const exportAll = () => {
    download(
      JSON.stringify(buildExportPayload(), null, 2),
      `drom-${SECTION}-brands-models-${timestampForFilename()}.json`,
      'application/json;charset=utf-8'
    );
  };

  window.__dromExport = exportAll;
  window.__dromStop = false;

  /* ================================================================== */
  /* Collection steps                                                   */
  /* ================================================================== */

  /**
   * Opens the model dropdown of the currently applied brand and collects
   * it, retrying when the list looks stale or empty.
   */
  let previousModelSignature = null;

  const collectModels = async (progress, networkIdle) => {
    const reasons = [];
    let entries = [];
    let diagnostics = null;
    let accepted = false;
    let attemptsUsed = 0;

    for (
      let attempt = 1;
      attempt <= CONFIG.modelAttempts && !accepted;
      attempt += 1
    ) {
      attemptsUsed = attempt;

      let modelControl = null;

      try {
        modelControl = await waitFor(() => {
          const control = findModelControl();

          return control && !isDisabled(control) ? control : null;
        }, 12000, 150);

        if (!modelControl) {
          reasons.push('Model filter field was not found.');
          break;
        }

        setStatus(
          `${progress}\n\nOpening the model list` +
            (attempt > 1 ? ` (attempt ${attempt})...` : '...')
        );

        const modelListbox = await ensureOpen(modelControl, 'MODEL', progress);

        if (!modelListbox) {
          reasons.push('Model dropdown did not open.');
          continue;
        }

        if (!(await waitFor(() => hasOptions(modelListbox), 8000, 100))) {
          reasons.push(`Model list had no visible options on attempt ${attempt}.`);
          continue;
        }

        const modelListStable = await waitForListStable(modelListbox);

        if (!modelListStable) {
          reasons.push(`Model list did not become stable on attempt ${attempt}.`);
        }

        await sleep(CONFIG.pauseAfterModelOpen);

        setStatus(`${progress}\n\nCollecting models...`);

        const snapshot = await collectAllOptions(modelListbox);

        entries = snapshot.entries;
        diagnostics = {
          networkIdle,
          modelListStable,
          reachedBottom: snapshot.reachedBottom,
          scrollSteps: snapshot.scrollSteps,
          attempt
        };

        if (!snapshot.reachedBottom) {
          reasons.push(
            `Virtualised model list was not confirmed at the bottom ` +
              `after ${snapshot.scrollSteps} scroll steps.`
          );
        }

        if (entries.length === 0) {
          reasons.push(`No model options collected on attempt ${attempt}.`);

          await waitForNetworkIdle();
          await sleep(CONFIG.afterBrandSettle * 2);

          continue;
        }

        const signature = entries
          .map((entry) => normalizeKey(entry.rawText || entry.name))
          .sort()
          .join('|');

        // Same model set for neighbouring brands is unusual and can mean
        // the UI did not reload. Flagged for review, not rejected.
        if (previousModelSignature !== null && signature === previousModelSignature) {
          reasons.push(
            'The collected model set matches the previous brand. ' +
              'Verify this brand manually.'
          );
        }

        previousModelSignature = signature;
        accepted = true;
      } catch (error) {
        reasons.push(`Model collection attempt ${attempt} failed: ${error.message}`);
        console.warn(`[drom] model collection attempt ${attempt} failed`, error);

        await waitForNetworkIdle();
        await sleep(CONFIG.afterBrandSettle * 2);
      } finally {
        if (modelControl) {
          await ensureClosed(modelControl);
        }
      }
    }

    if (!accepted) {
      reasons.push(
        `Could not collect a non-empty model list after ` +
          `${CONFIG.modelAttempts} attempt(s).`
      );
    }

    return { entries, accepted, diagnostics, reasons, attemptsUsed };
  };

  /**
   * Selects a model and collects its generation dropdown.
   *
   * Returns { generations, generationsStatus, generationsReasons } where the
   * status is "done", "empty" (field disabled or no options: the model has
   * no generations) or "review".
   */
  let previousGenerationSignature = null;

  const collectGenerations = async (modelEntry, progress) => {
    const failures = [];

    for (
      let attempt = 1;
      attempt <= CONFIG.generationAttempts;
      attempt += 1
    ) {
      const isLastAttempt = attempt === CONFIG.generationAttempts;
      let generationControl = null;

      try {
        const selection = await selectOption({
          label: 'MODEL',
          getControl: findModelControl,
          entry: modelEntry,
          progress
        });

        if (!selection.applied) {
          failures.push(
            `Could not select the model; the field shows ` +
              `"${selection.selected || 'unknown'}".`
          );
          continue;
        }

        if (selection.changed) {
          await waitForNetworkIdle();
          await sleep(CONFIG.afterModelSettle * attempt);
        }

        generationControl = await waitFor(() => {
          const control = findGenerationControl();

          return control && !isDisabled(control) ? control : null;
        }, CONFIG.generationFieldTimeout, 100);

        if (!generationControl) {
          if (findGenerationControl()) {
            return {
              generations: [],
              generationsStatus: 'empty',
              generationsReasons: []
            };
          }

          failures.push('Generation field was not found.');
          continue;
        }

        // Once it is known how this dropdown opens, a refusal to open means
        // "nothing to show" rather than "ask the user to click".
        const knownHowToOpen = preferredStrategy.GENERATION !== undefined;

        const listbox = await ensureOpen(
          generationControl,
          'GENERATION',
          progress,
          { manual: !knownHowToOpen, onlyPreferred: knownHowToOpen }
        );

        if (!listbox) {
          if (knownHowToOpen && isLastAttempt) {
            return {
              generations: [],
              generationsStatus: 'empty',
              generationsReasons: []
            };
          }

          failures.push('Generation dropdown did not open.');
          continue;
        }

        const ready = await waitFor(
          () => hasOptions(listbox),
          CONFIG.generationOptionsTimeout,
          80
        );

        if (!ready) {
          if (isLastAttempt) {
            return {
              generations: [],
              generationsStatus: 'empty',
              generationsReasons: []
            };
          }

          continue;
        }

        await waitForListStable(listbox, CONFIG.generationStableMs, 6000);

        // Cards are not virtualised: every option is already in the DOM.
        const seen = new Set();
        const generations = [...listbox.querySelectorAll('[role="option"]')]
          .map((option) => parseGeneration(option, DEFAULT_ROW_HEIGHT))
          .filter((entry) => {
            if (!entry || isPlaceholderOption(entry.rawText)) {
              return false;
            }

            const key = `${normalizeKey(entry.rawText)}|${entry.photo || ''}`;

            if (seen.has(key)) {
              return false;
            }

            seen.add(key);

            return true;
          })
          .map(toGenerationRecord);

        if (generations.length === 0) {
          if (isLastAttempt) {
            return {
              generations: [],
              generationsStatus: 'empty',
              generationsReasons: []
            };
          }

          continue;
        }

        // Photo URLs contain the model slug, so two models with textually
        // identical generations (Abarth 595 / 695) still differ here.
        const signature = generations
          .map((generation) => `${normalizeKey(generation.raw)}|${generation.photo || ''}`)
          .sort()
          .join('|');

        const sameAsPrevious = signature === previousGenerationSignature;

        // Neighbouring models with identical generation lists almost always
        // means the list has not reloaded yet: wait and retry.
        if (sameAsPrevious && !isLastAttempt) {
          log(`generations of "${modelEntry.name}" look stale, retrying`);
          await waitForNetworkIdle();
          await sleep(CONFIG.afterModelSettle * 2);
          continue;
        }

        previousGenerationSignature = signature;

        const reasons = [];

        if (sameAsPrevious) {
          reasons.push('Generation set matches the previous model.');
        }

        return {
          generations,
          generationsStatus: reasons.length ? 'review' : 'done',
          generationsReasons: reasons
        };
      } catch (error) {
        failures.push(`Attempt ${attempt} failed: ${error.message}`);
        console.warn(`[drom] generations of "${modelEntry.name}" failed`, error);

        await waitForNetworkIdle();
      } finally {
        if (generationControl) {
          await ensureClosed(generationControl);
        }
      }
    }

    return {
      generations: null,
      generationsStatus: 'review',
      generationsReasons: unique(failures)
    };
  };

  /* ================================================================== */
  /* Main routine                                                       */
  /* ================================================================== */

  const suspiciousBrands = [];
  let fatalError = null;

  try {
    setStatus(`Locating filter fields (${SECTION_INFO.title})...`);

    const brandControl = findBrandControl();

    if (!brandControl) {
      throw new Error(
        `Filter fields not found. Open a listing page such as ${SECTION_INFO.example}`
      );
    }

    log('section:', SECTION, '| generations:', WITH_GENERATIONS);
    log('brand field:', brandControl);
    log('model field:', findModelControl());

    if (SECTION_INFO.hasGenerations) {
      log('generation field:', findGenerationControl());
    }

    log(
      'all filter fields:',
      getComboboxes().map(
        (element) => getControlSearchText(element) || '(no descriptive text)'
      )
    );

    setStatus('Opening the brand list...');

    const brandListbox = await ensureOpen(brandControl, 'BRAND', 'Setup');

    if (!brandListbox) {
      throw new Error('Could not open the brand list.');
    }

    await waitFor(() => hasOptions(brandListbox), 8000, 100);
    await waitForListStable(brandListbox);

    const allBrandsSnapshot = await collectAllOptions(brandListbox);
    const allBrands = allBrandsSnapshot.entries;

    console.log(
      `Brand options found: ${allBrands.length}; ` +
        `reached bottom: ${allBrandsSnapshot.reachedBottom}`
    );

    // Guard against picking up the wrong field and silently scraping the
    // model list of the current brand instead of the brand list.
    const names = new Set(allBrands.map((entry) => normalizeKey(entry.name)));
    const matchedMarkers = SECTION_INFO.brandMarkers.filter((marker) =>
      names.has(marker)
    );

    if (matchedMarkers.length < 3) {
      console.error('First 10 options:', allBrands.slice(0, 10));

      throw new Error(
        'This does not look like the brand list, so the wrong field was ' +
          'probably picked up. Check the options above against the element ' +
          'logged as "brand field".'
      );
    }

    controlCache.brand = brandControl;

    await ensureClosed(brandControl);

    const onlyBrands = CONFIG.onlyBrands.map(normalizeKey).filter(Boolean);

    const isModelFinished = (model) =>
      model &&
      (model.generationsStatus === 'done' || model.generationsStatus === 'empty');

    const shouldSkipBrand = (brandName) => {
      if (!CONFIG.resume) {
        return false;
      }

      const previous = state.brands[brandName];

      if (!previous) {
        return false;
      }

      // Brands collected without generations are revisited once
      // generations are switched on.
      if (
        WITH_GENERATIONS &&
        previous.status === 'done' &&
        (previous.models || []).some((model) => !isModelFinished(model))
      ) {
        return false;
      }

      if (previous.status === 'done') {
        return true;
      }

      return previous.status === 'review' && !CONFIG.retryReview;
    };

    const queue = allBrands
      .filter(
        (entry) =>
          onlyBrands.length === 0 ||
          onlyBrands.includes(normalizeKey(entry.name))
      )
      .filter((entry) => !shouldSkipBrand(entry.name))
      .slice(0, CONFIG.maxBrands);

    const alreadyDone = Object.values(state.brands).filter(
      (brand) => brand.status === 'done'
    ).length;

    if (alreadyDone > 0) {
      console.log(`Restored from a previous run: ${alreadyDone} done brands`);
    }

    const leftovers = Object.entries(state.brands)
      .filter(([, brand]) => brand.status !== 'done')
      .map(([name, brand]) => `${name} (${brand.status})`);

    if (leftovers.length > 0) {
      console.log('Unfinished brands in saved progress:', leftovers);
    }

    if (queue.length === 0) {
      setStatus('Nothing left to do, everything is already collected.');

      return;
    }

    console.log(`Queued: ${queue.length}`);

    for (let number = 0; number < queue.length; number += 1) {
      if (window.__dromStop) {
        console.warn('Stopped on request.');
        break;
      }

      const brandEntry = queue[number];
      const previousRun = state.brands[brandEntry.name];
      const startedAt = Date.now();

      const progress =
        `Brand ${number + 1} of ${queue.length}\n` +
        `${brandEntry.name}\n` +
        `Processed so far: ${Object.keys(state.brands).length}`;

      const reviewReasons = [];
      let models = [];
      let diagnostics = null;
      let accepted = false;
      let attemptsUsed = 0;
      let interrupted = false;

      const writeBrand = (status) => {
        state.brands[brandEntry.name] = {
          status,
          brandListings: brandEntry.count,
          models,
          collectedAt: new Date().toISOString(),
          attempts: (previousRun?.attempts || 0) + attemptsUsed,
          reviewReasons: unique(reviewReasons),
          diagnostics
        };

        save();
      };

      try {
        setStatus(`${progress}\n\nSelecting the brand...`);

        const selection = await selectOption({
          label: 'BRAND',
          getControl: findBrandControl,
          entry: brandEntry,
          progress
        });

        if (!selection.applied) {
          throw new Error(
            `Could not switch the filter to "${brandEntry.name}" after ` +
              `${CONFIG.selectAttempts} attempt(s). The field still ` +
              `shows "${selection.selected || 'unknown'}", so the brand was ` +
              `skipped rather than scraped with another brand's models.`
          );
        }

        // Selecting a brand reloads the model list. Opening it too early may
        // return the previous brand's models, so wait for several signals.
        setStatus(`${progress}\n\nWaiting for the model list to reload...`);

        let networkIdle = true;

        if (selection.changed) {
          networkIdle = await waitForNetworkIdle();

          if (!networkIdle) {
            reviewReasons.push(
              'Network activity did not become idle before model collection.'
            );
          }

          await sleep(CONFIG.afterBrandSettle);
        }

        const modelResult = await collectModels(progress, networkIdle);

        accepted = modelResult.accepted;
        diagnostics = modelResult.diagnostics;
        attemptsUsed = modelResult.attemptsUsed;
        reviewReasons.push(...modelResult.reasons);

        const previousModels = new Map(
          (previousRun?.models || []).map((model) => [
            normalizeKey(model.model),
            model
          ])
        );

        models = modelResult.entries.map((entry) => ({
          model: entry.name,
          count: entry.count
        }));

        if (WITH_GENERATIONS && accepted) {
          for (let index = 0; index < models.length; index += 1) {
            if (window.__dromStop) {
              interrupted = true;
              break;
            }

            const model = models[index];
            const previous = previousModels.get(normalizeKey(model.model));

            if (isModelFinished(previous)) {
              model.generations = previous.generations;
              model.generationsStatus = previous.generationsStatus;
              continue;
            }

            setStatus(
              `${progress}\n\nGenerations: model ${index + 1} of ` +
                `${models.length}\n${model.model}`
            );

            Object.assign(
              model,
              await collectGenerations(modelResult.entries[index], progress)
            );

            if (model.generationsStatus === 'review') {
              reviewReasons.push(
                `Generations of "${model.model}" need review.`
              );
            }

            writeBrand('partial');
          }
        }
      } catch (error) {
        reviewReasons.push(`Brand processing failed: ${error.message}`);
        console.warn(`[drom] ${brandEntry.name}: processing failed`, error);
      } finally {
        // If a retry collected nothing, keep previously collected data
        // instead of replacing it with an empty array.
        if (
          models.length === 0 &&
          Array.isArray(previousRun?.models) &&
          previousRun.models.length > 0
        ) {
          models = previousRun.models;
          reviewReasons.push(
            'Previous non-empty model data was preserved because the retry ' +
              'did not collect any models.'
          );
        }

        let status;

        if (interrupted) {
          status = 'partial';
        } else if (
          accepted &&
          unique(reviewReasons).length === 0 &&
          models.length > 0
        ) {
          status = 'done';
        } else {
          status = 'review';
        }

        writeBrand(status);

        if (status === 'review') {
          suspiciousBrands.push(brandEntry.name);
        }

        const generationCount = models.reduce(
          (sum, model) => sum + (model.generations?.length || 0),
          0
        );

        console.log(
          `[${number + 1}/${queue.length}] ${brandEntry.name}: ` +
            `${models.length} models` +
            (WITH_GENERATIONS ? `, ${generationCount} generations` : '') +
            `, status: ${status}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
            (reviewReasons.length > 0
              ? ` (${unique(reviewReasons).length} warning(s))`
              : '')
        );
      }
    }

    const brandValues = Object.values(state.brands);
    const countBy = (status) =>
      brandValues.filter((brand) => brand.status === status).length;

    setStatus(
      (window.__dromStop ? 'Stopped on request.\n' : 'Done.\n') +
        `Brands processed: ${brandValues.length}\n` +
        `Done: ${countBy('done')}\n` +
        `Need review: ${countBy('review')}\n` +
        `Partial: ${countBy('partial')}\n\n` +
        (CONFIG.autoExport
          ? 'JSON downloaded.'
          : 'Run window.__dromExport() to download JSON.')
    );
  } catch (error) {
    fatalError = error;

    console.error('[drom] Fatal error:', error);

    setStatus(
      `Stopped because of an error.\n\n${error.message}\n\n` +
        'Partial progress has been saved.'
    );
  } finally {
    clearHighlight();
    save();

    if (CONFIG.autoExport) {
      try {
        exportAll();
      } catch (error) {
        console.warn('[drom] Could not export automatically:', error);
      }
    }

    networkTracker.release();

    const uniqueSuspiciousBrands = unique(suspiciousBrands);

    if (uniqueSuspiciousBrands.length > 0) {
      console.warn('[drom] Brands requiring review:', uniqueSuspiciousBrands);
    }

    if (fatalError) {
      console.warn('[drom] You can export partial data with window.__dromExport().');
    }

    console.log(
      `[drom] Finished. Re-download: window.__dromExport(). ` +
        `Reset progress: localStorage.removeItem("${STORAGE_KEY}").`
    );

    setTimeout(() => hud.remove(), 15000);
  }
})();
