const NominaInternaView = createNominaDocView({
  prefix: 'nomina-interna',
  apiPath: '/api/nomina/interna',
  title: 'Nómina interna',
  printTitle: 'Planilla de nómina interna',
  reciboTitle: 'Recibo de nómina interna',
  showIgssExport: false,
  showPatronal: false,
  requireSalarioBase: true,
  layoutInterna: true,
  periodoOptions: [
    { value: 'MENSUAL', label: 'MENSUAL (mes)' },
    { value: 'QUINCENAL', label: 'QUINCENAL (15 dias)' },
    { value: 'CATORCENAL', label: 'CATORCENAL (14 dias)' },
    { value: 'SEMANAL', label: 'SEMANAL (7 dias)' },
  ],
});

const NominaIgssView = createNominaDocView({
  prefix: 'nomina-igss',
  apiPath: '/api/nomina/igss',
  title: 'Planilla IGSS',
  printTitle: 'Planilla IGSS — Guatemala',
  reciboTitle: 'Detalle empleado — IGSS',
  showIgssExport: true,
  showPatronal: true,
});
