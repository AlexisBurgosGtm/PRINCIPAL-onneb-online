/**
 * Diseñador visual de plantillas de impresión (contenteditable + bloques).
 * Conserva tokens Mustache {{...}} / {{{...}}} como chips no editables.
 */
const FormatoImpresionDesigner = {
  TOKEN_RE: /(\{\{\{[\w./#^]+\}\}\}|\{\{[\w./#^]+\}\})/g,

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  htmlToDesign(html) {
    const src = String(html || '');
    return src.replace(this.TOKEN_RE, (token) => {
      const safe = this.escapeHtml(token);
      return `<span class="fi-token" contenteditable="false" data-token="${safe}">${safe}</span>`;
    });
  },

  designToHtml(designHtml) {
    const wrap = document.createElement('div');
    wrap.innerHTML = String(designHtml || '');
    wrap.querySelectorAll('.fi-token[data-token]').forEach((el) => {
      const token = el.getAttribute('data-token') || el.textContent || '';
      el.replaceWith(document.createTextNode(token));
    });
    return wrap.innerHTML;
  },

  paperWidthPx(papel) {
    return String(papel || 'CARTA').toUpperCase() === 'TICKET' ? 302 : 794;
  },

  designerChromeCss() {
    return `
.fi-token{
  display:inline-block;background:#e0f2fe;color:#075985;border:1px solid #7dd3fc;
  border-radius:3px;padding:0 4px;margin:0 1px;font-family:ui-monospace,Consolas,monospace;
  font-size:11px;line-height:1.4;cursor:default;user-select:none;white-space:nowrap
}
.fi-token:hover{background:#bae6fd}
body.fi-designing{outline:1px dashed #94a3b8;min-height:120px;cursor:text}
body.fi-designing *:hover{outline:1px dotted #cbd5e1}
body.fi-designing .fi-token:hover{outline:none}
`;
  },

  buildFrameHtml({ bodyHtml, css, papel }) {
    const width = this.paperWidthPx(papel);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=${width}, initial-scale=1">
<style>
html,body{zoom:1!important;transform:none!important;margin:0;padding:0;background:#fff}
body{font-family:Segoe UI,Helvetica,Arial,sans-serif;padding:16px;font-size:12px;color:#111;box-sizing:border-box;width:${width}px}
${css || ''}
${this.designerChromeCss()}
</style></head>
<body class="fi-designing" contenteditable="true">${bodyHtml}</body></html>`;
  },

  BLOCKS: [
    {
      id: 'header',
      label: 'Encabezado empresa',
      html: `<header class="report-header">
  <div class="report-brand">
    {{#EMPRESA.LOGO_URL}}<div class="report-brand-logo"><img src="{{{EMPRESA.LOGO_URL}}}" alt="Logo" class="report-logo"></div>{{/EMPRESA.LOGO_URL}}
    <div class="report-brand-text">
      <div class="report-empresa-nombre">{{EMPRESA.NOMBRE}}</div>
      <h1 class="report-title">{{TITLE}}</h1>
    </div>
  </div>
</header>`,
    },
    {
      id: 'meta',
      label: 'Datos del documento',
      html: `<div class="doc-meta-grid">
  <div class="doc-meta-item"><strong>Documento:</strong> {{DOC.DOCUMENTO_LABEL}}</div>
  <div class="doc-meta-item"><strong>Fecha:</strong> {{DOC.FECHA}}</div>
  {{#DOC.SERIE}}<div class="doc-meta-item"><strong>Serie:</strong> {{DOC.SERIE}}</div>{{/DOC.SERIE}}
  {{#DOC.NUMERO}}<div class="doc-meta-item"><strong>Número:</strong> {{DOC.NUMERO}}</div>{{/DOC.NUMERO}}
  <div class="doc-meta-item"><strong>Cliente:</strong> {{DOC.DOC_NOMCLIE}}</div>
  <div class="doc-meta-item"><strong>NIT:</strong> {{DOC.DOC_NIT}}</div>
  <div class="doc-meta-item"><strong>Dirección:</strong> {{DOC.DOC_DIRCLIE}}</div>
  <div class="doc-meta-item"><strong>Pago:</strong> {{DOC.CONCRE_LABEL}}</div>
  {{#DOC.VENDEDOR}}<div class="doc-meta-item"><strong>Vendedor:</strong> {{DOC.VENDEDOR}}</div>{{/DOC.VENDEDOR}}
  {{#DOC.VENDEDOR_TELEFONO}}<div class="doc-meta-item"><strong>Tel. vendedor:</strong> {{DOC.VENDEDOR_TELEFONO}}</div>{{/DOC.VENDEDOR_TELEFONO}}
</div>`,
    },
    {
      id: 'lines',
      label: 'Tabla de líneas',
      html: `<table class="doc-lines-table">
  <thead>
    <tr>
      <th>Cód.</th>
      <th>Descripción</th>
      <th class="text-end">Med.</th>
      <th class="text-end">Cant.</th>
      <th class="text-end">Precio</th>
      <th class="text-end">Total</th>
    </tr>
  </thead>
  <tbody>
    {{#LINES}}
    <tr>
      <td>{{CODPROD}}</td>
      <td>{{DESPROD}}</td>
      <td class="text-end">{{CODMEDIDA}}</td>
      <td class="text-end">{{CANTIDAD}}</td>
      <td class="text-end">{{PRECIO_FMT}}</td>
      <td class="text-end">{{TOTALPRECIO_FMT}}</td>
    </tr>
    {{/LINES}}
  </tbody>
</table>`,
    },
    {
      id: 'totals',
      label: 'Totales',
      html: `<div class="doc-totals">
  <div class="doc-totals-row grand">
    <span>Total</span>
    <span>{{TOTALES.TOTALPRECIO_FMT}}</span>
  </div>
</div>`,
    },
    {
      id: 'footer',
      label: 'Pie de página',
      html: `<div class="doc-footer">{{FOOTER}}</div>`,
    },
    {
      id: 'obs',
      label: 'Observaciones',
      html: `{{#DOC.OBS}}<p class="doc-obs"><em>{{DOC.OBS}}</em></p>{{/DOC.OBS}}`,
    },
    {
      id: 'fel',
      label: 'Datos FEL',
      html: `{{#DOC.FEL_UUDI}}<div class="doc-meta-item"><strong>FEL UUID:</strong> {{DOC.FEL_UUDI}}</div>
<div class="doc-meta-item"><strong>Serie FEL:</strong> {{DOC.FEL_SERIE}}</div>
<div class="doc-meta-item"><strong>Número FEL:</strong> {{DOC.FEL_NUMERO}}</div>{{/DOC.FEL_UUDI}}`,
    },
    {
      id: 'fel-qr',
      label: 'QR FEL (URL + UUID)',
      html: `{{#DOC.FEL_UUDI}}<div class="fi-fel-qr" style="text-align:center;margin:8px 0">
  <img src="{{{DOC.FEL_QR_IMG}}}" alt="QR FEL" width="140" height="140" style="width:140px;height:140px;object-fit:contain">
  <div style="font-size:8px;margin-top:4px;text-transform:uppercase">ESCANEA EL CÓDIGO DESDE TU CELULAR</div>
</div>{{/DOC.FEL_UUDI}}`,
    },
    {
      id: 'text',
      label: 'Texto libre',
      html: `<p>Escriba aquí su texto…</p>`,
    },
  ],

  FIELD_TYPES: [
    { id: 'var', label: 'Campo de texto' },
    {
      id: 'fel-qr',
      label: 'QR FEL (URL FEL + UUID)',
      insertHtml: `{{#DOC.FEL_UUDI}}<img class="fi-fel-qr-img" src="{{{DOC.FEL_QR_IMG}}}" alt="QR FEL" width="140" height="140" style="width:140px;height:140px;object-fit:contain">{{/DOC.FEL_UUDI}}`,
    },
  ],

  toolbarHtml() {
    return `
      <div class="fi-visual-toolbar btn-toolbar flex-wrap gap-1" role="toolbar">
        <div class="btn-group btn-group-sm" role="group">
          <button type="button" class="btn btn-outline-secondary" data-cmd="bold" title="Negrita"><i class="fa-solid fa-bold"></i></button>
          <button type="button" class="btn btn-outline-secondary" data-cmd="italic" title="Cursiva"><i class="fa-solid fa-italic"></i></button>
          <button type="button" class="btn btn-outline-secondary" data-cmd="underline" title="Subrayado"><i class="fa-solid fa-underline"></i></button>
        </div>
        <div class="btn-group btn-group-sm" role="group">
          <button type="button" class="btn btn-outline-secondary" data-cmd="justifyLeft" title="Izquierda"><i class="fa-solid fa-align-left"></i></button>
          <button type="button" class="btn btn-outline-secondary" data-cmd="justifyCenter" title="Centro"><i class="fa-solid fa-align-center"></i></button>
          <button type="button" class="btn btn-outline-secondary" data-cmd="justifyRight" title="Derecha"><i class="fa-solid fa-align-right"></i></button>
        </div>
        <div class="btn-group btn-group-sm" role="group">
          <button type="button" class="btn btn-outline-secondary" data-cmd="insertUnorderedList" title="Lista"><i class="fa-solid fa-list-ul"></i></button>
          <button type="button" class="btn btn-outline-secondary" data-cmd="removeFormat" title="Limpiar formato"><i class="fa-solid fa-eraser"></i></button>
        </div>
        <select class="form-select form-select-sm fi-font-size" style="width:auto" title="Tamaño">
          <option value="">Tamaño</option>
          <option value="1">Pequeño</option>
          <option value="3">Normal</option>
          <option value="5">Grande</option>
          <option value="7">Muy grande</option>
        </select>
        <select class="form-select form-select-sm fi-insert-var" style="width:auto;max-width:11rem" title="Insertar campo">
          <option value="">+ Campo…</option>
        </select>
        <select class="form-select form-select-sm fi-insert-field-type" style="width:auto;max-width:14rem" title="Tipo de campo especial">
          <option value="">+ Tipo campo…</option>
          <option value="fel-qr">QR FEL (URL + UUID)</option>
        </select>
        <select class="form-select form-select-sm fi-insert-block" style="width:auto;max-width:12rem" title="Insertar bloque">
          <option value="">+ Bloque…</option>
          ${this.BLOCKS.map((b) => `<option value="${b.id}">${this.escapeHtml(b.label)}</option>`).join('')}
        </select>
      </div>`;
  },

  fillVarSelect(selectEl, groups) {
    if (!selectEl) return;
    const opts = ['<option value="">+ Campo…</option>'];
    (groups || []).forEach((g) => {
      opts.push(`<optgroup label="${this.escapeHtml(g.name)}">`);
      (g.vars || []).forEach((v) => {
        if (String(v).includes('bloque')) return;
        opts.push(`<option value="${this.escapeHtml(v)}">${this.escapeHtml(v)}</option>`);
      });
      opts.push('</optgroup>');
    });
    selectEl.innerHTML = opts.join('');
  },
};
