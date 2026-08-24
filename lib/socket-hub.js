/** Tipos de empleado que reciben aviso de pedido de mostrador. */
const TIPO_CAJERO = 8;
const TIPO_BODEGA = 5;
/** Tipos que reciben solicitudes de autorización pendientes. */
const TIPO_ADMIN = 1;
const TIPO_SUPERVISOR = 2;

function roomTipo(empnit, codtipo) {
  return `tipo:${String(empnit).trim()}:${Number(codtipo)}`;
}

function roomEmpresa(empnit) {
  return `emp:${String(empnit).trim()}`;
}

function formatMoneyGtq(value) {
  const n = Number(value);
  const amount = Number.isFinite(n) ? n : 0;
  return amount.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
}

function buildPedidoMostradorMensaje(nombreCliente, monto) {
  const nombre = String(nombreCliente || 'Cliente').trim() || 'Cliente';
  return `Nuevo Pedido de ${nombre} de un monto de ${formatMoneyGtq(monto)}`;
}

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log('[Socket.IO] Cliente conectado:', socket.id);
    socket.emit('welcome', { message: 'Conectado a OnneB POS', id: socket.id });

    socket.on('session:register', (payload = {}) => {
      const empnit = String(payload.empnit || payload.EMPNIT || '').trim();
      const codtipo = Number(payload.codtipoempleado ?? payload.codtipo);
      if (!empnit || !Number.isFinite(codtipo) || codtipo <= 0) return;

      if (socket.data.empnit && socket.data.codtipo) {
        socket.leave(roomTipo(socket.data.empnit, socket.data.codtipo));
        socket.leave(roomEmpresa(socket.data.empnit));
      }

      socket.data.empnit = empnit;
      socket.data.codtipo = codtipo;
      socket.data.codempleado = payload.codempleado ?? null;
      socket.join(roomTipo(empnit, codtipo));
      socket.join(roomEmpresa(empnit));
    });

    socket.on('ping', () => {
      socket.emit('pong', { ts: Date.now() });
    });

    socket.on('disconnect', () => {
      console.log('[Socket.IO] Cliente desconectado:', socket.id);
    });
  });
}

function emitNuevoPedidoMostrador(io, empnit, payload) {
  if (!io || !empnit) return;
  const data = {
    tipo: 'pedido-mostrador',
    empnit: String(empnit).trim(),
    ...payload,
  };
  // Solo bodega (no caja): el toast en cajero interfería con documentos abiertos.
  io.to(roomTipo(empnit, TIPO_BODEGA)).emit('pedido:nuevo', data);
}

/** Productos enviados a cocina desde comanda CRS → vista Despachos en Cocina. */
function emitCocinaNuevo(io, empnit, payload) {
  if (!io || !empnit) return;
  const data = {
    tipo: 'cocina-nuevo',
    empnit: String(empnit).trim(),
    ...payload,
  };
  io.to(roomEmpresa(empnit)).emit('cocina:nuevo', data);
}

function emitAutorizacionNueva(io, empnit, payload) {
  if (!io || !empnit) return;
  const data = {
    event: 'nueva',
    empnit: String(empnit).trim(),
    ...payload,
  };
  // Empresa completa: el cliente filtra toast por tipo admin/supervisor.
  // Así funciona aunque el socket del admin no esté solo en room tipo:1/2.
  io.to(roomEmpresa(empnit)).emit('autorizacion:nueva', data);
  io.to(roomTipo(empnit, TIPO_ADMIN)).emit('autorizacion:nueva', data);
  io.to(roomTipo(empnit, TIPO_SUPERVISOR)).emit('autorizacion:nueva', data);
  io.to(roomEmpresa(empnit)).emit('autorizacion:lista', data);
}

function emitAutorizacionAutorizada(io, empnit, payload) {
  if (!io || !empnit) return;
  const data = {
    event: 'autorizada',
    empnit: String(empnit).trim(),
    id: payload?.id != null ? Number(payload.id) : payload?.id,
    ...payload,
  };
  if (data.id != null && !Number.isFinite(Number(data.id))) {
    data.id = payload.id;
  }
  io.to(roomEmpresa(empnit)).emit('autorizacion:autorizada', data);
  io.to(roomEmpresa(empnit)).emit('autorizacion:lista', data);
}

module.exports = {
  TIPO_CAJERO,
  TIPO_BODEGA,
  TIPO_ADMIN,
  TIPO_SUPERVISOR,
  formatMoneyGtq,
  buildPedidoMostradorMensaje,
  registerSocketHandlers,
  emitNuevoPedidoMostrador,
  emitCocinaNuevo,
  emitAutorizacionNueva,
  emitAutorizacionAutorizada,
};
