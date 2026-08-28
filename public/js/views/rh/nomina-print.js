/**
 * Impresión de planillas de nómina (interna e IGSS).
 */
const NominaPrint = {
  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return 'Q 0.00';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  statusLabel(code) {
    const map = { B: 'Borrador', C: 'Calculada', F: 'Cerrada', A: 'Anulada' };
    return map[String(code || '').toUpperCase()] || code || '—';
  },

  async printPlanillaResumen({ header, lines, titulo, showPatronal = false }) {
    const incluidas = (lines || []).filter((l) => String(l.INCLUIDO || 'SI').toUpperCase() === 'SI');
    const rows = incluidas
      .map(
        (l) => `<tr>
          <td>${PrintReport.escapeHtml(l.CODEMPLEADO)}</td>
          <td>${PrintReport.escapeHtml(l.NOMEMPLEADO)}</td>
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(l.TOTAL_INGRESOS))}</td>
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(l.IGSS_LABORAL))}</td>
          ${showPatronal ? `<td class="text-end">${PrintReport.escapeHtml(this.formatMoney(l.IGSS_PATRONAL))}</td>` : ''}
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(l.TOTAL_DEDUCCIONES))}</td>
          <td class="text-end fw-semibold">${PrintReport.escapeHtml(this.formatMoney(l.NETO_PAGAR))}</td>
        </tr>`
      )
      .join('');
    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: titulo || 'Planilla de nómina',
        subtitleHtml: `
          <p><strong>Período:</strong> ${PrintReport.escapeHtml(header.MES)}/${PrintReport.escapeHtml(header.ANIO)} · ${PrintReport.escapeHtml(header.PERIODO_TIPO || '')}</p>
          <p><strong>Estado:</strong> ${PrintReport.escapeHtml(this.statusLabel(header.STATUS))}</p>
          <p><strong>Descripción:</strong> ${PrintReport.escapeHtml(header.DESCRIPCION || '—')}</p>
          ${showPatronal ? `<p><strong>IGSS patronal total:</strong> ${PrintReport.escapeHtml(this.formatMoney(header.TOTAL_IGSS_PAT))}</p>` : ''}
        `,
      })}
      <table class="table table-sm table-bordered">
        <thead><tr>
          <th>Cód.</th><th>Empleado</th><th class="text-end">Ingresos</th><th class="text-end">IGSS lab.</th>
          ${showPatronal ? '<th class="text-end">IGSS pat.</th>' : ''}
          <th class="text-end">Deducciones</th><th class="text-end">Neto</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="text-center text-muted">Sin empleados incluidos</td></tr>'}</tbody>
        <tfoot>
          <tr class="fw-semibold">
            <td colspan="2" class="text-end">Totales</td>
            <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(header.TOTAL_INGRESOS))}</td>
            <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(header.TOTAL_IGSS_LAB))}</td>
            ${showPatronal ? `<td class="text-end">${PrintReport.escapeHtml(this.formatMoney(header.TOTAL_IGSS_PAT))}</td>` : ''}
            <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(header.TOTAL_DEDUCCIONES))}</td>
            <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(header.TOTAL_NETO))}</td>
          </tr>
        </tfoot>
      </table>`;
    await PrintReport.openAndPrint(
      () => PrintReport.wrapDocument({ title: titulo || 'Planilla', bodyHtml, extraStyles: 'table{font-size:12px;}' }),
      'width=980,height=760'
    );
  },

  async printReciboEmpleado({ header, line, titulo }) {
    const salarioQ =
      line.SALARIOQ != null
        ? Number(line.SALARIOQ)
        : (Number(line.SALARIO_BASE) || 0) * ((Number(line.DIAS_LABORADOS) || 0) / 30);
    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: titulo || 'Recibo de nómina',
        subtitleHtml: `
          <p><strong>${PrintReport.escapeHtml(line.NOMEMPLEADO || '')}</strong></p>
          <p>DPI: ${PrintReport.escapeHtml(line.DPI || '—')} · IGSS: ${PrintReport.escapeHtml(line.IGSS || '—')}</p>
          <p>Período ${PrintReport.escapeHtml(header.MES)}/${PrintReport.escapeHtml(header.ANIO)}</p>
        `,
      })}
      <table class="table table-sm">
        <tr><td>Salario</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.SALARIO_BASE))}</td></tr>
        <tr><td>Días</td><td class="text-end">${PrintReport.escapeHtml(line.DIAS_LABORADOS ?? '—')}</td></tr>
        <tr><td>SalarioQ ((Salario/30)×Días)</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(salarioQ))}</td></tr>
        <tr><td>Departamento</td><td class="text-end">${PrintReport.escapeHtml(line.DEPARTAMENTO || '—')}</td></tr>
        <tr><td>Bono ley</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.BONO_LEY ?? line.BONIFICACION))}</td></tr>
        <tr><td>Bono adicional</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.BONO_ADICIONAL))}</td></tr>
        <tr><td>Otros ingresos</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.OTROS_INGRESOS))}</td></tr>
        <tr class="fw-semibold"><td>Total ingresos</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.TOTAL_INGRESOS))}</td></tr>
        <tr><td>Deducciones</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.OTRAS_DEDUCCIONES))}</td></tr>
        <tr><td>IGSS laboral</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.IGSS_LABORAL))}</td></tr>
        <tr><td>ISR</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.ISR))}</td></tr>
        <tr class="fw-semibold"><td>Total deducciones</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.TOTAL_DEDUCCIONES))}</td></tr>
        <tr class="fw-bold"><td>Neto a pagar</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(line.NETO_PAGAR))}</td></tr>
      </table>`;
    await PrintReport.openAndPrint(
      () => PrintReport.wrapDocument({ title: 'Recibo nómina', bodyHtml }),
      'width=720,height=680'
    );
  },

  formatFecha(value) {
    if (!value) return '—';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const d = String(value.getDate()).padStart(2, '0');
      const m = String(value.getMonth() + 1).padStart(2, '0');
      return `${d}/${m}/${value.getFullYear()}`;
    }
    const s = String(value).slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return String(value);
  },

  async printValeEmpleado(vale) {
    await PrintReport.ensureLogo();
    const saldo =
      Number.isFinite(Number(vale?.SALDO))
        ? Number(vale.SALDO)
        : Math.max(0, (Number(vale?.MONTO) || 0) - (Number(vale?.ABONOS) || 0));
    const pendiente = saldo > 0.005;
    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: 'Vale a empleado',
        subtitleHtml: `
          <p><strong>No. vale:</strong> ${PrintReport.escapeHtml(vale.ID)}</p>
          <p><strong>Fecha:</strong> ${PrintReport.escapeHtml(this.formatFecha(vale.FECHA))}</p>
        `,
      })}
      <table class="table table-sm">
        <tr><td>Empleado</td><td class="text-end fw-semibold">${PrintReport.escapeHtml(vale.NOMEMPLEADO || vale.CODEMP || '—')}</td></tr>
        <tr><td>Código empleado</td><td class="text-end">${PrintReport.escapeHtml(vale.CODEMP || '—')}</td></tr>
        <tr><td>Acreditación</td><td class="text-end">${PrintReport.escapeHtml(
          vale.GENERADO_TIPO
            ? `${vale.GENERADO_TIPO}${vale.ACREDITACION_DESC ? ` · ${vale.ACREDITACION_DESC}` : ''}`
            : vale.DESCAJA || vale.CODCAJA || '—'
        )}</td></tr>
        ${
          vale.GENERADO_CODDOC || vale.GENERADO_CORRELATIVO
            ? `<tr><td>Documento generado</td><td class="text-end">${PrintReport.escapeHtml(
                [vale.GENERADO_CODDOC, vale.GENERADO_CORRELATIVO].filter((x) => x != null && x !== '').join('-')
              )}</td></tr>`
            : ''
        }
        <tr><td>Descripción</td><td class="text-end">${PrintReport.escapeHtml(vale.DESCRIPCION || '—')}</td></tr>
        <tr class="fw-semibold"><td>Monto del vale</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(vale.MONTO))}</td></tr>
        <tr><td>Abonos</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(vale.ABONOS || 0))}</td></tr>
        <tr class="fw-bold"><td>Saldo pendiente</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(saldo))}</td></tr>
        <tr><td>Estado</td><td class="text-end">${PrintReport.escapeHtml(pendiente ? 'Pendiente' : 'Finalizado')}</td></tr>
      </table>
      <div style="margin-top:2.5rem;display:flex;justify-content:space-between;gap:2rem;">
        <div style="flex:1;text-align:center;border-top:1px solid #333;padding-top:.4rem;">Entregó</div>
        <div style="flex:1;text-align:center;border-top:1px solid #333;padding-top:.4rem;">Recibió</div>
      </div>`;
    await PrintReport.openAndPrint(
      () =>
        PrintReport.wrapDocument({
          title: `Vale #${vale.ID || ''}`,
          bodyHtml,
          extraStyles: 'table{font-size:13px;} td{padding:6px 8px;}',
        }),
      'width=720,height=780'
    );
  },

  async printAbonoVale({ pago, vale }) {
    await PrintReport.ensureLogo();
    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: 'Abono a vale de empleado',
        subtitleHtml: `
          <p><strong>No. abono:</strong> ${PrintReport.escapeHtml(pago.ID)}</p>
          <p><strong>Fecha de pago:</strong> ${PrintReport.escapeHtml(this.formatFecha(pago.FECHA || pago.FECHA_PAGO))}</p>
        `,
      })}
      <table class="table table-sm">
        <tr><td>Vale</td><td class="text-end fw-semibold">#${PrintReport.escapeHtml(pago.IDVALE || vale?.ID || '—')}</td></tr>
        <tr><td>Empleado</td><td class="text-end">${PrintReport.escapeHtml(vale?.NOMEMPLEADO || pago.NOMEMPLEADO || vale?.CODEMP || pago.CODEMP || '—')}</td></tr>
        <tr><td>Caja del abono</td><td class="text-end">${PrintReport.escapeHtml(pago.DESCAJA || pago.CODCAJA || vale?.DESCAJA || vale?.CODCAJA || '—')}</td></tr>
        <tr><td>Descripción del vale</td><td class="text-end">${PrintReport.escapeHtml(vale?.DESCRIPCION || pago.VALE_DESC || '—')}</td></tr>
        <tr class="fw-bold"><td>Importe abonado</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(pago.MONTO || pago.ABONO))}</td></tr>
        <tr><td>Monto original del vale</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(vale?.MONTO))}</td></tr>
        <tr><td>Abonos acumulados</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(vale?.ABONOS))}</td></tr>
        <tr><td>Saldo del vale</td><td class="text-end">${PrintReport.escapeHtml(this.formatMoney(vale?.SALDO))}</td></tr>
      </table>
      <div style="margin-top:2.5rem;display:flex;justify-content:space-between;gap:2rem;">
        <div style="flex:1;text-align:center;border-top:1px solid #333;padding-top:.4rem;">Recibió caja</div>
        <div style="flex:1;text-align:center;border-top:1px solid #333;padding-top:.4rem;">Empleado</div>
      </div>`;
    await PrintReport.openAndPrint(
      () =>
        PrintReport.wrapDocument({
          title: `Abono vale #${pago.ID || ''}`,
          bodyHtml,
          extraStyles: 'table{font-size:13px;} td{padding:6px 8px;}',
        }),
      'width=720,height=780'
    );
  },

  async printValeCaja(vale) {
    await PrintReport.ensureLogo();
    const novale = vale?.NOVALE ?? vale?.ID ?? '';
    const enCorte = String(vale?.CORTE || 'NO').trim().toUpperCase() === 'SI';
    const importeFmt = PrintReport.escapeHtml(this.formatMoney(vale.IMPORTE ?? vale.MONTO));
    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: 'Vale de caja',
        subtitleHtml: `
          <p><strong>No. vale:</strong> ${PrintReport.escapeHtml(novale)}</p>
          <p><strong>Fecha:</strong> ${PrintReport.escapeHtml(this.formatFecha(vale.FECHA))}</p>
          <p class="small text-muted mb-0">Salida de efectivo · integra al corte de caja</p>
        `,
      })}
      <table class="table table-sm vale-caja-table">
        <tr><td>Caja</td><td class="text-end fw-semibold">${PrintReport.escapeHtml(vale.DESCAJA || vale.CODCAJA || '—')}</td></tr>
        <tr><td>Tipo</td><td class="text-end">${PrintReport.escapeHtml(vale.TIPO || '—')}</td></tr>
        <tr><td>Recibe</td><td class="text-end">${PrintReport.escapeHtml(vale.RECIBE || '—')}</td></tr>
        <tr><td>Descripción</td><td class="text-end">${PrintReport.escapeHtml(vale.DESCRIPCION || '—')}</td></tr>
        <tr class="vale-caja-importe-row">
          <td>Importe (efectivo)</td>
          <td class="text-end vale-caja-importe">${importeFmt}</td>
        </tr>
        <tr><td>Estado corte</td><td class="text-end">${PrintReport.escapeHtml(
          enCorte ? `Incluido en corte #${vale.NOCORTE || ''}` : 'Pendiente de corte'
        )}</td></tr>
      </table>
      <div class="vale-caja-firmas">
        <div class="vale-caja-firma">Entregó caja</div>
        <div class="vale-caja-firma">Recibió</div>
      </div>`;
    await PrintReport.openAndPrint(
      () =>
        PrintReport.wrapDocument({
          title: `Vale de caja #${novale}`,
          bodyHtml,
          extraStyles: `
            table.vale-caja-table{font-size:13px;}
            table.vale-caja-table td{padding:6px 8px;}
            .vale-caja-importe{
              color:#c62828 !important;
              font-size:1.45rem !important;
              font-weight:700 !important;
              line-height:1.2;
            }
            .vale-caja-importe-row td:first-child{
              vertical-align:middle;
            }
            .vale-caja-firmas{
              margin-top:5.5rem;
              display:flex;
              justify-content:space-between;
              gap:2.5rem;
            }
            .vale-caja-firma{
              flex:1;
              text-align:center;
              border-top:1px solid #333;
              padding-top:.55rem;
              min-height:3.25rem;
            }
          `,
        }),
      'width=720,height=780'
    );
  },
};
