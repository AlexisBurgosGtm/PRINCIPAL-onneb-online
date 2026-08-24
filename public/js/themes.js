/**
 * OnneB POS — selector de temas visuales
 */
const OnnebThemes = {
  STORAGE_KEY: 'onneb-theme',
  DEFAULT: 'purple',

  themes: [
    { id: 'purple', label: 'Estilo Onne B', swatchClass: 'theme-swatch-purple' },
    { id: 'carbon', label: 'Carbono', swatchClass: 'theme-swatch-carbon' },
    { id: 'blue', label: 'Blanco · Azul', swatchClass: 'theme-swatch-blue' },
    { id: 'bw', label: 'Blanco y negro', swatchClass: 'theme-swatch-bw' },
    { id: 'mustard', label: 'Blanco · Mostaza', swatchClass: 'theme-swatch-mustard' },
    { id: 'fire', label: 'Fuego', swatchClass: 'theme-swatch-fire' },
    { id: 'winter', label: 'Invierno', swatchClass: 'theme-swatch-winter' },
    { id: 'summer', label: 'Verano', swatchClass: 'theme-swatch-summer' },
    { id: 'autumn', label: 'Otoño', swatchClass: 'theme-swatch-autumn' },
    { id: 'valentine', label: 'Día del cariño', swatchClass: 'theme-swatch-valentine' },
    { id: 'nature', label: 'Naturaleza', swatchClass: 'theme-swatch-nature' },
    { id: 'fs', label: 'FS', swatchClass: 'theme-swatch-fs' },
  ],

  pickerTargets: [
    { panelId: 'theme-picker-panel', btnId: 'btn-theme-toggle' },
    { panelId: 'theme-picker-panel-login', btnId: 'btn-theme-toggle-login' },
  ],

  getCurrent() {
    const id = document.documentElement.getAttribute('data-theme') || this.DEFAULT;
    return this.themes.some((t) => t.id === id) ? id : this.DEFAULT;
  },

  _parseRgb(color) {
    if (!color) return [255, 255, 255];
    const v = color.trim();
    if (v.startsWith('#')) {
      let h = v.slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      if (h.length >= 6) {
        return [
          parseInt(h.slice(0, 2), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16),
        ];
      }
    }
    const rgb = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
    return [255, 255, 255];
  },

  _luminance([r, g, b]) {
    const lin = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  },

  _mixRgb(base, bg, ratio) {
    const t = 1 - ratio;
    return base.map((c, i) => Math.round(c * ratio + bg[i] * t));
  },

  _contrastText(rgb) {
    const lum = this._luminance(rgb);
    const whiteContrast = 1.05 / (lum + 0.05);
    const blackContrast = (lum + 0.05) / 0.05;
    return whiteContrast >= blackContrast ? '#ffffff' : '#1a1a1a';
  },

  _getCssRgb(root, name, fallback) {
    const raw = getComputedStyle(root).getPropertyValue(name).trim();
    return this._parseRgb(raw || fallback || '#ffffff');
  },

  _updateContrastVars() {
    const root = document.documentElement;
    const tokens = [
      '--btn-fg-primary',
      '--btn-fg-success',
      '--btn-fg-danger',
      '--btn-fg-warning',
      '--btn-fg-info',
      '--btn-fg-muted',
      '--btn-fg-purple',
      '--btn-fg-guardar',
      '--fab-action-fg',
    ];

    tokens.forEach((outVar) => {
      root.style.setProperty(outVar, '#ffffff');
    });
  },

  apply(themeId) {
    const valid = this.themes.some((t) => t.id === themeId);
    const id = valid ? themeId : this.DEFAULT;
    document.documentElement.setAttribute('data-theme', id);
    try {
      localStorage.setItem(this.STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const colors = {
        purple: '#7c3aed',
        carbon: '#18181b',
        blue: '#2563eb',
        bw: '#404040',
        mustard: '#ca8a04',
        fire: '#ef4444',
        winter: '#0ea5e9',
        summer: '#f59e0b',
        autumn: '#ea580c',
        valentine: '#ec4899',
        nature: '#16a34a',
        fs: '#ea580c',
      };
      meta.setAttribute('content', colors[id] || colors.purple);
    }
    requestAnimationFrame(() => this._updateContrastVars());
    this.syncPickerUI();
  },

  loadSaved() {
    let saved = this.DEFAULT;
    try {
      saved = localStorage.getItem(this.STORAGE_KEY) || this.DEFAULT;
    } catch {
      /* ignore */
    }
    this.apply(saved);
  },

  renderPickerHtml() {
    const current = this.getCurrent();
    const options = this.themes
      .map(
        (t) => `
        <button type="button" class="theme-option${t.id === current ? ' is-active' : ''}"
          data-theme-id="${t.id}" aria-pressed="${t.id === current}">
          <span class="theme-swatch ${t.swatchClass}" aria-hidden="true"></span>
          <span>${t.label}</span>
        </button>`
      )
      .join('');
    return `<div class="theme-picker-title">Tema visual</div>${options}`;
  },

  syncPickerUI() {
    const html = this.renderPickerHtml();
    this.pickerTargets.forEach(({ panelId }) => {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      panel.innerHTML = html;
      panel.querySelectorAll('[data-theme-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.apply(btn.getAttribute('data-theme-id'));
          this.closeAllPickers();
        });
      });
    });
  },

  openPicker(btnId, panelId) {
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!panel) return;
    this.closeAllPickers();
    this.syncPickerUI();
    panel.classList.add('is-open');
    btn?.setAttribute('aria-expanded', 'true');
  },

  closeAllPickers() {
    this.pickerTargets.forEach(({ panelId, btnId }) => {
      document.getElementById(panelId)?.classList.remove('is-open');
      document.getElementById(btnId)?.setAttribute('aria-expanded', 'false');
    });
  },

  togglePicker(btnId, panelId) {
    const panel = document.getElementById(panelId);
    if (panel?.classList.contains('is-open')) this.closeAllPickers();
    else this.openPicker(btnId, panelId);
  },

  bindEvents() {
    this.pickerTargets.forEach(({ panelId, btnId }) => {
      document.getElementById(btnId)?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePicker(btnId, panelId);
      });
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.theme-picker-wrap')) this.closeAllPickers();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeAllPickers();
    });
  },

  init() {
    this.loadSaved();
    this.bindEvents();
  },
};

if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) {
  requestAnimationFrame(() => OnnebThemes._updateContrastVars());
}
