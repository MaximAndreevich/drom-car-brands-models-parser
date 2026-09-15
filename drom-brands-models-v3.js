/**
 * drom-brands-models
 *
 * Collects every car brand and its models (with listing counts) from the
 * filter dropdowns on auto.drom.ru, then downloads the result as Markdown
 * and JSON.
 *
 * HOW TO RUN
 *   1. Open a listing page, e.g. https://auto.drom.ru/toyota/all/
 *   2. Open DevTools -> Console.
 *   3. Paste this file and press Enter. No manual setup required.
 *
 * The script drives the dropdowns itself. If a dropdown refuses to open
 * programmatically, it highlights the field, shows a prompt in the panel
 * at the top right, plays a short beep and waits for you to click it.
 *
 * RUNTIME CONTROLS (type in the console while it runs)
 *   window.__dromStop = true   stop after the current brand, then export
 *   window.__dromExport()      download whatever has been collected so far
 *   window.__dromResult        raw result object with progress metadata
 *
 * Progress is written to localStorage after every brand, so a reload, a
 * captcha or a closed tab costs you only the brand in flight: run the
 * script again and it resumes. To start over:
 *   localStorage.removeItem('__drom_scrape_v2')
 */

(async () => {
  'use strict';

  /* ================================================================== */
  /* Configuration                                                      */
  /* ================================================================== */

  const CONFIG = {
    /** Brands to process. Empty array means all of them. */
    onlyBrands: [],

    /** Hard cap on the number of brands, mostly useful for testing. */
    maxBrands: Infinity,

    /** Try to open dropdowns programmatically before asking for a click. */
    tryAutoOpen: true,

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

    /** Automatically download files at the end of every run. */
    autoExport: true,

    /** Milliseconds of network silence that counts as "loading finished". */
    networkQuietMs: 500,

    /** How long a list must stay unchanged before it counts as ready. */
    listStableMs: 500,

    /** Extra grace period after a brand filter has been applied. */
    afterBrandSettle: 700,

    /** Settle time after a model dropdown opens, before scraping it. */
    pauseAfterModelOpen: 400,

    /** Pause after each scroll step of a virtualised list. */
    pauseAfterScroll: 160,

    /** Retries when the model list looks stale, unavailable or empty. */
    modelAttempts: 3,

    /** Retries when a brand click does not change the filter field. */
    brandSelectAttempts: 3,

    /**
     * Label fragments that identify the brand field. They only help before
     * a brand is selected: afterwards the placeholder holds the brand name
     * itself, and the field is located relative to the model field instead.
     */
    brandControlHints: ['марк', 'brand', 'firm'],

    /** Maximum scroll operations in one virtualised dropdown. */
    maxVirtualScrollSteps: 700,

    /** How long to wait for a manual click before giving up, in ms. */
    manualTimeout: 300000,

    /** Beep when a manual click is required. */
    sound: true,

    /** Verbose console output. */
    debug: true,
  };

  const STORAGE_KEY = '__drom_scrape_v2';
  const LEGACY_STORAGE_KEY = '__drom_scrape_v1';
  const STATE_SCHEMA_VERSION = 2;

  /** Row height fallback for virtualised lists, in pixels. */
  const DEFAULT_ROW_HEIGHT = 35;

  /**
   * Known brand names used to verify that the scraped list really is the
   * brand list and not, say, the model list of the current brand.
   */
  const BRAND_MARKERS = [
    'toyota',
    'honda',
    'nissan',
    'bmw',
    'mercedes-benz',
    'volkswagen',
    'ford',
    'mazda',
    'kia',
    'hyundai'
  ];

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
   * The model list is fetched asynchronously after a brand is selected.
   * Counting in-flight requests gives an additional "loading finished"
   * signal without depending on any loader markup.
   *
   * The hook is reference-counted and restores original browser APIs once
   * the last running copy of the script exits.
   */
  const acquireNetworkTracker = () => {
    const globalKey = '__dromNetworkTrackerState';

    if (!window[globalKey]) {
      const state = {
        pending: 0,
        users: 0,
        originalFetch: window.fetch,
        originalXhrSend: XMLHttpRequest.prototype.send,
        patchedFetch: null,
        patchedXhrSend: null
      };

      const trackStart = () => {
        state.pending += 1;
      };

      const trackEnd = () => {
        state.pending = Math.max(0, state.pending - 1);
      };

      state.patchedFetch = function patchedFetch(...args) {
        trackStart();

        try {
          return state.originalFetch.apply(this, args).finally(trackEnd);
        } catch (error) {
          trackEnd();
          throw error;
        }
      };

      state.patchedXhrSend = function patchedXhrSend(...args) {
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
      XMLHttpRequest.prototype.send = state.patchedXhrSend;

      window[globalKey] = state;
    }

    const state = window[globalKey];

    state.users += 1;

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
    timeout = 15000
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
    hud.textContent = text;
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
   * associated label. Used to recognise the brand field by its label.
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
    const listbox = id ? document.getElementById(id) : null;

    return listbox && isVisible(listbox) ? listbox : null;
  };

  const isOpen = (control) =>
    Boolean(
      control &&
        control.isConnected &&
        control.getAttribute('aria-expanded') === 'true' &&
        getListboxFor(control)
    );

  const hasOptions = (listbox) =>
    Boolean(listbox && listbox.querySelector('[role="option"]'));

  /**
   * The model field is normally identifiable by its placeholder or label:
   * "Модель". The matching hints remain configurable at the top of script.
   */
const findModelControl = () =>
  getComboboxes().find((element) =>
    /^модел/i.test(
      normalize(element.getAttribute('placeholder') || '')
    )
  ) || null;

  /**
   * Prefer an explicitly labelled brand field. If its label disappears after
   * selecting a value, use the closest combobox preceding the model field.
   */
  const findBrandControl = () => {
    const comboboxes = getComboboxes();
    const modelControl = findModelControl();

    const labelledBrandControls = comboboxes.filter(
      (element) =>
        element !== modelControl &&
        includesAnyHint(getControlSearchText(element), CONFIG.brandControlHints)
    );

    if (labelledBrandControls.length > 0) {
      return labelledBrandControls[labelledBrandControls.length - 1];
    }

    if (modelControl) {
      const preceding = comboboxes.filter(
        (element) =>
          element !== modelControl &&
          element.compareDocumentPosition(modelControl) &
            Node.DOCUMENT_POSITION_FOLLOWING
      );

      if (preceding.length > 0) {
        return preceding[preceding.length - 1];
      }
    }

    return comboboxes[0] || null;
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
      // React ignores direct value assignment, so go through the native
      // setter and let the component see a real input event.
      name: 'input event',
      run: (control) => {
        if (!control.matches('input')) {
          return false;
        }

        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        ).set;

        control.focus({ preventScroll: true });
        setter.call(control, control.value || '');
        control.dispatchEvent(new Event('input', { bubbles: true }));

        return true;
      }
    }
  ];

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

  const ensureOpen = async (control, label, progressText) => {
    if (isOpen(control)) {
      return getListboxFor(control);
    }

    if (CONFIG.tryAutoOpen) {
      for (const strategy of autoOpenStrategies) {
        control.scrollIntoView({ block: 'center', inline: 'nearest' });
        await sleep(100);

        if (strategy.run(control) === false) {
          continue;
        }

        const listbox = await waitFor(
          () => (isOpen(control) ? getListboxFor(control) : null),
          1800,
          100
        );

        if (listbox) {
          log(`${label}: opened via "${strategy.name}"`);

          return listbox;
        }
      }

      log(`${label}: could not open programmatically, asking for a click`);
    }

    return waitForManualOpen(control, label, progressText);
  };

  const ensureClosed = async (control) => {
    if (!isOpen(control)) {
      return;
    }

    pressKey(control, { key: 'Escape', code: 'Escape', keyCode: 27 });

    if (await waitFor(() => !isOpen(control), 1000, 100)) {
      return;
    }

    realClick(control);
    await waitFor(() => !isOpen(control), 1000, 100);
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
   *
   * The preferred source is aria-posinset. A trailing number in option.id is
   * retained solely as a last fallback because it is an implementation detail
   * of a component library and may change at any time.
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
    'все марки',
    'все модели',
    'любая марка',
    'любая модель',
    'выберите марку',
    'выберите модель'
  ];

  const isPlaceholderOption = (name) =>
    PLACEHOLDER_OPTIONS.includes(normalizeKey(name));

  /** Splits "Corolla (1 234)" into a name and a listing count. */
  const parseOption = (option, rowHeight) => {
    const rawText = normalize(option.textContent);

    if (!rawText) {
      return null;
    }

    const countMatch = rawText.match(
      /^(.*?)\s+\(([\d\s\u00a0\u202f]+)\)$/
    );

    return {
      name: countMatch ? normalize(countMatch[1]) : rawText,
      count: countMatch
        ? Number(countMatch[2].replace(/[\s\u00a0\u202f]/g, ''))
        : null,
      index: getOptionIndex(option, rowHeight),
      rawText
    };
  };

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

      await sleep(120);
    }

    return false;
  };

  /**
   * Only a window of rows may exist in the DOM at any time, so the list has
   * to be scrolled to the bottom while rows are harvested along the way.
   *
   * Identity is the normalized name. Drom renders a "popular" block before
   * the full alphabetical list, so the same brand or model legitimately
   * appears twice; a name-keyed map collapses those duplicates instead of
   * emitting them. This applies to both dropdowns.
   */
  const collectAllOptions = async (listbox) => {
    const scroller = getScrollableElement(listbox);
    const rowHeight = detectRowHeight(listbox);
    const collection = new Map();

    // Distinct DOM positions per name, used to tell a genuine duplicate
    // (the popular block) from the same row re-observed while scrolling.
    const positions = new Map();

    const collectVisibleOptions = () => {
      listbox.querySelectorAll('[role="option"]').forEach((option) => {
        const parsed = parseOption(option, rowHeight);

        if (!parsed || isPlaceholderOption(parsed.name)) {
          return;
        }

        const key = normalizeKey(parsed.name);
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

        // Keep the listing count wherever it appears, and the smallest
        // known position, which is the cheapest one to scroll back to.
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

      scroller.scrollTop = nextTop;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

      await sleep(CONFIG.pauseAfterScroll);
      collectVisibleOptions();

      scrollSteps += 1;
    }

    await sleep(CONFIG.pauseAfterScroll * 2);
    collectVisibleOptions();

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(CONFIG.pauseAfterScroll);

    const entries = [...collection.values()]
      .map((entry) => ({
        ...entry,
        // Best effort: an entry rendered at two distinct positions is one
        // that appears both in the popular block and in the full list.
        popular: (positions.get(normalizeKey(entry.name))?.size || 1) > 1
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

        return left.name.localeCompare(right.name, 'ru');
      });

    return {
      entries,
      reachedBottom,
      scrollSteps
    };
  };

  /**
   * Options are matched by text only. Position is never used as identity:
   * it comes from the UI implementation (aria-posinset, data-index, an id
   * suffix, a translateY offset) and any of those may be window-relative
   * rather than list-relative, which silently selects the wrong row.
   */
  const findOptionByEntry = (listbox, entry, rowHeight) => {
    const options = [...listbox.querySelectorAll('[role="option"]')];
    const entryKey = normalizeKey(entry.name);

    return (
      options.find((option) => {
        const parsed = parseOption(option, rowHeight);

        return parsed && normalizeKey(parsed.name) === entryKey;
      }) || null
    );
  };

  /** Scrolls a virtualised row into existence so it can be clicked. */
  const revealOption = async (listbox, entry) => {
    const scroller = getScrollableElement(listbox);
    const rowHeight = detectRowHeight(listbox);
    const clientHeight = scroller.clientHeight || 350;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - clientHeight);

    if (entry.index !== null) {
      scroller.scrollTop = Math.max(
        0,
        Math.min(entry.index * rowHeight - clientHeight / 2, maxScrollTop)
      );

      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(CONFIG.pauseAfterScroll);

      const estimatedOption = findOptionByEntry(listbox, entry, rowHeight);

      if (estimatedOption) {
        return estimatedOption;
      }
    }

    // The position estimate missed, so walk the list in steps and match text.
    const step = Math.max(70, Math.floor(clientHeight * 0.5));

    for (let top = 0; top <= maxScrollTop; top += step) {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(CONFIG.pauseAfterScroll);

      const option = findOptionByEntry(listbox, entry, rowHeight);

      if (option) {
        return option;
      }
    }

    return null;
  };

  /* ================================================================== */
  /* Storage and export                                                 */
  /* ================================================================== */

  const createEmptyState = () => ({
    schemaVersion: STATE_SCHEMA_VERSION,
    sourceOrigin: window.location.origin,
    sourceUrlInitial: window.location.href,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    brands: {}
  });

  const migrateLegacyState = (legacy) => {
    const state = createEmptyState();

    Object.entries(legacy || {}).forEach(([brand, models]) => {
      state.brands[brand] = {
        status: 'done',
        brandListings: null,
        models: Array.isArray(models) ? models : [],
        collectedAt: null,
        attempts: 0,
        reviewReasons: ['Migrated from __drom_scrape_v1'],
        diagnostics: null
      };
    });

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
      log('could not read v2 progress:', error);
    }

    try {
      const legacy = JSON.parse(
        localStorage.getItem(LEGACY_STORAGE_KEY) || 'null'
      );

      if (legacy && typeof legacy === 'object') {
        log('migrating progress from v1 storage');

        return migrateLegacyState(legacy);
      }
    } catch (error) {
      log('could not read legacy progress:', error);
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

  const escapeMarkdown = (value) =>
    String(value)
      .replace(/\|/g, '\\|')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');

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

  const buildMarkdown = () => {
    const brandEntries = getBrandEntries();

    const doneCount = brandEntries.filter(
      ([, value]) => value.status === 'done'
    ).length;

    const reviewCount = brandEntries.filter(
      ([, value]) => value.status === 'review'
    ).length;

    const lines = [
      '# Car brands and models',
      '',
      `> Source: ${state.sourceUrlInitial}`,
      `> Collected: ${state.updatedAt || new Date().toISOString()}`,
      `> Brands processed: ${brandEntries.length}`,
      `> Done: ${doneCount}`,
      `> Review required: ${reviewCount}`,
      ''
    ];

    brandEntries.forEach(([brand, brandData]) => {
      const models = brandData.models || [];

      lines.push(`## ${escapeMarkdown(brand)}`, '');

      if (brandData.status === 'review') {
        lines.push(
          `> ⚠ Review: ${brandData.reviewReasons.join('; ') || 'unknown reason'}`,
          ''
        );
      }

      lines.push('| Model | Listings |', '|---|---:|');

      if (models.length === 0) {
        lines.push('| No data | |');
      } else {
        models.forEach(({ model, count }) => {
          lines.push(
            `| ${escapeMarkdown(model)} | ${count === null ? '' : count} |`
          );
        });
      }

      lines.push('');
    });

    return lines.join('\n');
  };

  /**
   * Flat, iterable shape: one array of brands, each carrying its own
   * models and review state. Easier to map, filter and sort than a pair of
   * parallel objects keyed by brand name.
   */
  const buildExportPayload = () => {
    const brands = getBrandEntries().map(([name, data]) => {
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
        models: models.map((entry) => ({
          name: entry.model,
          count: entry.count
        }))
      };
    });

    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      source: state.sourceUrlInitial,
      collectedAt: state.updatedAt || new Date().toISOString(),
      stats: {
        brands: brands.length,
        done: brands.filter((brand) => brand.status === 'done').length,
        review: brands.filter((brand) => brand.status === 'review').length,
        models: brands.reduce((sum, brand) => sum + brand.modelCount, 0)
      },
      brands
    };
  };

  const exportAll = () => {
    const suffix = timestampForFilename();

    download(
      buildMarkdown(),
      `drom-brands-models-${suffix}.md`,
      'text/markdown;charset=utf-8'
    );

    download(
      JSON.stringify(buildExportPayload(), null, 2),
      `drom-brands-models-${suffix}.json`,
      'application/json;charset=utf-8'
    );
  };

  window.__dromExport = exportAll;
  window.__dromStop = false;

  /* ================================================================== */
  /* Main routine                                                       */
  /* ================================================================== */

  let suspiciousBrands = [];
  let fatalError = null;

  try {
    setStatus('Locating filter fields...');

    let brandControl = findBrandControl();

    if (!brandControl) {
      throw new Error(
        'Filter fields not found. Open a listing page such as ' +
          'https://auto.drom.ru/toyota/all/'
      );
    }

    log('brand field:', brandControl);
    log('model field:', findModelControl());
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
    const matchedMarkers = BRAND_MARKERS.filter((marker) => names.has(marker));

    if (matchedMarkers.length < 3) {
      console.error('First 10 options:', allBrands.slice(0, 10));

      throw new Error(
        'This does not look like the brand list, so the wrong field was ' +
          'probably picked up. Check the options above against the element ' +
          'logged as "brand field".'
      );
    }

    await ensureClosed(brandControl);

    const onlyBrands = CONFIG.onlyBrands.map(normalizeKey).filter(Boolean);

    const shouldSkipBrand = (brandName) => {
      if (!CONFIG.resume) {
        return false;
      }

      const previous = state.brands[brandName];

      if (!previous) {
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

    if (queue.length === 0) {
      setStatus('Nothing left to do, everything is already collected.');

      return;
    }

    console.log(`Queued: ${queue.length}`);

    /**
     * Once a brand is applied, its placeholder usually becomes
     * "Volvo (1234)". Compare the brand exactly after removing the listing
     * count; startsWith() can produce false positive matches.
     */
    const getSelectedBrandName = (control) => {
      const placeholder = normalize(control?.getAttribute('placeholder'));

      return normalize(
        placeholder.replace(/\s+\([\d\s\u00a0\u202f]+\)$/, '')
      );
    };

    const waitForBrandApplied = async (brandName) => {
      const expected = normalizeKey(brandName);

      return waitFor(
        () => {
          const control =
            brandControl && brandControl.isConnected
              ? brandControl
              : findBrandControl();

          if (!control) {
            return false;
          }

          return normalizeKey(getSelectedBrandName(control)) === expected;
        },
        12000,
        150
      );
    };

    /**
     * Selecting a brand is verified twice: the option text is checked
     * before the click, and the filter field is checked after it.
     *
     * Without the second check a click that did not register leaves the
     * previous brand selected, and every following brand silently gets
     * that brand's model list.
     */
    const selectBrand = async (brandEntry, progress) => {
      let selected = null;

      for (
        let attempt = 1;
        attempt <= CONFIG.brandSelectAttempts;
        attempt += 1
      ) {
        if (!brandControl || !brandControl.isConnected) {
          brandControl = findBrandControl();
        }

        if (!brandControl) {
          throw new Error('Brand control disappeared after a page re-render.');
        }

        const listbox = await ensureOpen(brandControl, 'BRAND', progress);

        if (!listbox) {
          throw new Error('Brand list did not open.');
        }

        if (!(await waitFor(() => hasOptions(listbox), 5000, 100))) {
          throw new Error('Brand list opened but has no options.');
        }

        const option = await revealOption(listbox, brandEntry);

        if (!option) {
          log(
            `brand option not found on attempt ${attempt}: ${brandEntry.name}`
          );

          await ensureClosed(brandControl);
          continue;
        }

        const optionName = normalizeKey(
          parseOption(option, detectRowHeight(listbox))?.name
        );

        if (optionName !== normalizeKey(brandEntry.name)) {
          log(
            `refusing to click "${optionName}" while looking for ` +
              `"${brandEntry.name}"`
          );

          await ensureClosed(brandControl);
          continue;
        }

        realClick(option);
        await sleep(250);
        await ensureClosed(brandControl);

        if (await waitForBrandApplied(brandEntry.name)) {
          return { applied: true, attempts: attempt };
        }

        selected = getSelectedBrandName(
          brandControl && brandControl.isConnected
            ? brandControl
            : findBrandControl()
        );

        log(
          `brand not applied on attempt ${attempt}, field shows "${selected}"`
        );

        await waitForNetworkIdle();
        await sleep(CONFIG.afterBrandSettle);
      }

      return { applied: false, selected };
    };

    let previousModelSignature = null;

    for (let number = 0; number < queue.length; number += 1) {
      if (window.__dromStop) {
        console.warn('Stopped on request.');
        break;
      }

      const brandEntry = queue[number];
      const previousRun = state.brands[brandEntry.name];

      const progress =
        `Brand ${number + 1} of ${queue.length}\n` +
        `${brandEntry.name}\n` +
        `Processed so far: ${Object.keys(state.brands).length}`;

      const reviewReasons = [];
      let collected = [];
      let diagnostics = null;
      let accepted = false;
      let attemptsUsed = 0;

      try {
        setStatus(`${progress}\n\nOpening the brand list...`);

        const selection = await selectBrand(brandEntry, progress);

        if (!selection.applied) {
          throw new Error(
            `Could not switch the filter to "${brandEntry.name}" after ` +
              `${CONFIG.brandSelectAttempts} attempt(s). The field still ` +
              `shows "${selection.selected || 'unknown'}", so the brand was ` +
              `skipped rather than scraped with another brand's models.`
          );
        }

        const brandApplied = true;

        // Selecting a brand reloads the model list. Opening it too early may
        // return the previous brand's models, so wait for several signals.
        setStatus(`${progress}\n\nWaiting for the model list to reload...`);

        const networkIdle = await waitForNetworkIdle();

        if (!networkIdle) {
          reviewReasons.push(
            'Network activity did not become idle before model collection.'
          );
        }

        await sleep(CONFIG.afterBrandSettle);

        for (
          let attempt = 1;
          attempt <= CONFIG.modelAttempts && !accepted;
          attempt += 1
        ) {
          attemptsUsed = attempt;

          let modelControl = null;

          try {
            modelControl = await waitFor(findModelControl, 12000, 200);

            if (!modelControl) {
              reviewReasons.push('Model filter field was not found.');
              break;
            }

            setStatus(
              `${progress}\n\nOpening the model list` +
                (attempt > 1 ? ` (attempt ${attempt})...` : '...')
            );

            const modelListbox = await ensureOpen(
              modelControl,
              'MODEL',
              progress
            );

            if (!modelListbox) {
              reviewReasons.push('Model dropdown did not open.');
              continue;
            }

            const modelOptionsReady = await waitFor(
              () => hasOptions(modelListbox),
              8000,
              100
            );

            if (!modelOptionsReady) {
              reviewReasons.push(
                `Model list had no visible options on attempt ${attempt}.`
              );

              continue;
            }

            const modelListStable = await waitForListStable(modelListbox);

            if (!modelListStable) {
              reviewReasons.push(
                `Model list did not become stable on attempt ${attempt}.`
              );
            }

            await sleep(CONFIG.pauseAfterModelOpen);

            setStatus(`${progress}\n\nCollecting models...`);

            const modelSnapshot = await collectAllOptions(modelListbox);

            collected = modelSnapshot.entries;
            diagnostics = {
              brandApplied,
              networkIdle,
              modelListStable,
              reachedBottom: modelSnapshot.reachedBottom,
              scrollSteps: modelSnapshot.scrollSteps,
              attempt
            };

            if (!modelSnapshot.reachedBottom) {
              reviewReasons.push(
                `Virtualised model list was not confirmed at the bottom ` +
                  `after ${modelSnapshot.scrollSteps} scroll steps.`
              );
            }

            if (collected.length === 0) {
              reviewReasons.push(
                `No model options collected on attempt ${attempt}.`
              );

              await waitForNetworkIdle();
              await sleep(CONFIG.afterBrandSettle * 2);

              continue;
            }

            const modelSignature = collected
              .map((entry) => normalizeKey(entry.rawText || entry.name))
              .sort()
              .join('|');

            // The same model set for neighboring brands is unusual and can
            // indicate that the UI did not reload. It is not automatically
            // rejected: shared sets may be legitimate, so this becomes a
            // review signal instead of a destructive retry loop.
            if (
              previousModelSignature !== null &&
              modelSignature === previousModelSignature
            ) {
              reviewReasons.push(
                'The collected model set matches the previous brand. ' +
                  'Verify this brand manually.'
              );
            }

            previousModelSignature = modelSignature;
            accepted = true;
          } catch (error) {
            reviewReasons.push(
              `Model collection attempt ${attempt} failed: ${error.message}`
            );

            console.warn(
              `[drom] ${brandEntry.name}: model collection attempt ${attempt} failed`,
              error
            );

            await waitForNetworkIdle();
            await sleep(CONFIG.afterBrandSettle * 2);
          } finally {
            if (modelControl) {
              await ensureClosed(modelControl);
            }
          }
        }

        if (!accepted) {
          reviewReasons.push(
            `Could not collect a non-empty model list after ` +
              `${CONFIG.modelAttempts} attempt(s).`
          );
        }
      } catch (error) {
        reviewReasons.push(`Brand processing failed: ${error.message}`);

        console.warn(`[drom] ${brandEntry.name}: processing failed`, error);
      } finally {
        const modelsFromCurrentRun = collected.map((entry) => ({
          model: entry.name,
          count: entry.count
        }));

        /**
         * If a review retry failed completely, retain previously collected
         * non-empty data instead of silently replacing it with an empty array.
         */
        const shouldPreservePreviousModels =
          modelsFromCurrentRun.length === 0 &&
          Array.isArray(previousRun?.models) &&
          previousRun.models.length > 0;

        const models = shouldPreservePreviousModels
          ? previousRun.models
          : modelsFromCurrentRun;

        if (shouldPreservePreviousModels) {
          reviewReasons.push(
            'Previous non-empty model data was preserved because the retry ' +
              'did not collect any models.'
          );
        }

        const uniqueReviewReasons = unique(reviewReasons);

        const status =
          accepted &&
          uniqueReviewReasons.length === 0 &&
          models.length > 0
            ? 'done'
            : 'review';

        state.brands[brandEntry.name] = {
          status,
          brandListings: brandEntry.count,
          models,
          collectedAt: new Date().toISOString(),
          attempts: (previousRun?.attempts || 0) + attemptsUsed,
          reviewReasons: uniqueReviewReasons,
          diagnostics
        };

        if (status === 'review') {
          suspiciousBrands.push(brandEntry.name);
        }

        save();

        console.log(
          `[${number + 1}/${queue.length}] ${brandEntry.name}: ` +
            `${models.length} models, status: ${status}` +
            (uniqueReviewReasons.length > 0
              ? ` (${uniqueReviewReasons.length} warning(s))`
              : '')
        );
      }
    }

    const doneCount = Object.values(state.brands).filter(
      (brand) => brand.status === 'done'
    ).length;

    const reviewCount = Object.values(state.brands).filter(
      (brand) => brand.status === 'review'
    ).length;

    if (window.__dromStop) {
      setStatus(
        `Stopped on request.\n` +
          `Done: ${doneCount}\n` +
          `Need review: ${reviewCount}\n\n` +
          'Partial result has been saved.'
      );
    } else {
      setStatus(
        `Done.\n` +
          `Brands processed: ${Object.keys(state.brands).length}\n` +
          `Done: ${doneCount}\n` +
          `Need review: ${reviewCount}\n\n` +
          (CONFIG.autoExport
            ? 'Files downloaded.'
            : 'Run window.__dromExport() to download files.')
      );
    }
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
        console.warn('[drom] Could not export files automatically:', error);
      }
    }

    networkTracker.release();

    const uniqueSuspiciousBrands = unique(suspiciousBrands);

    if (uniqueSuspiciousBrands.length > 0) {
      console.warn(
        '[drom] Brands requiring review:',
        uniqueSuspiciousBrands
      );
    }

    if (fatalError) {
      console.warn(
        '[drom] You can export partial data with window.__dromExport().'
      );
    }

    console.log(
      `[drom] Finished. Re-download: window.__dromExport(). ` +
        `Reset v2 progress: localStorage.removeItem("${STORAGE_KEY}").`
    );

    setTimeout(() => hud.remove(), 15000);
  }
})();