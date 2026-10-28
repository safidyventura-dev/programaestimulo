/**
 * ============================================================================
 *  PROGRAMA ESTÍMULO 2026 · Lógica del frontend (web/app.js)
 * ============================================================================
 *  La interfaz se publica fuera de Apps Script (GitHub Pages) para poder usar
 *  la cámara en vivo; el backend sigue siendo Código.gs, al que se llama por
 *  la API JSON (doPost) del mismo deployment.
 *
 *  - Sesión: token guardado en sessionStorage (sobrevive a recargas de pestaña).
 *  - Catálogo: se descarga una sola vez al iniciar sesión y se busca en memoria.
 *  - Toda llamada al servidor pasa por `llamarServidor()`, que maneja errores,
 *    timeouts y sesiones vencidas de forma centralizada.
 * ============================================================================
 */

/** URL /exec del deployment de Apps Script (backend). */
const API_URL = 'https://script.google.com/macros/s/AKfycbxrJ42FJsOY3mYKaKTHqxF4-_gXlmRq7RrJwRs3ie2mjl5ID3rDChCR6CzsT9nqizgLBg/exec';

/** Tiempo máximo de espera de una llamada al servidor. */
const TIMEOUT_SERVIDOR_MS = 30000;

/** Lado máximo (px) al que se reduce la foto antes de decodificarla (más rápido). */
const LADO_MAX_FOTO_PX = 1600;

/** Máximo de resultados a mostrar en la búsqueda por título. */
const MAX_RESULTADOS_BUSQUEDA = 30;

/** RegEx de ISBN: 13 dígitos (978/979) o 10 dígitos (el último puede ser X). */
const REGEX_ISBN = /^(?:97[89]\d{10}|\d{9}[\dX])$/;

/** RegEx de ISSN: 8 caracteres (el último puede ser X). */
const REGEX_ISSN = /^\d{7}[\dX]$/;

/** Código de barras EAN-13 de publicaciones periódicas: 977 + ISSN sin verificador + 2 dígitos + verificador. */
const REGEX_EAN_ISSN = /^977\d{10}$/;

const CLAVE_SESION = 'pe_sesion';

/* ----------------------------------------------------------------------------
 *  ESTADO GLOBAL
 * -------------------------------------------------------------------------- */
const app = {
  sesion: null,            // { token, usuario, rol }
  catalogo: [],            // [{ isbn, titulo, editorial, norm, normTitulo }]
  indiceIsbn: new Map(),   // isbn (10 y 13) o issn -> item del catálogo
  codigosBloqueados: new Map(), // código mal impreso -> items del catálogo que lo traen impreso
  catalogoListo: false,
  catalogoCargando: false,
  sinCodigo: [],           // libros que se cargan por título (sin código de barras): [{ valor, titulo, editorial }]
  sinCodigoVerTodos: false,

  /** Límite sugerido (blando) de libros por caja; se actualiza desde el servidor. */
  limite: 20,

  cajas: [],               // todas las cajas: [{ id, cerrada, cantidad, usuarioCierre }]

  camara: null,            // instancia Html5Qrcode de la cámara en vivo
  camaraActiva: false,
  camaraIniciando: false,
  procesandoLectura: false,
  ultimaLectura: '',       // último código leído (para no registrarlo dos veces seguidas)
  ultimaLecturaTs: 0,
  linterna: false,
  buscandoLinterna: false, // probando otras cámaras traseras para encontrar flash

  caja: null,              // id de la caja en curso
  cantidad: 0,             // libros cargados en la caja en curso
  enviando: false,         // se está sacando un libro (o varios) de la caja
  cola: [],                // lecturas sin guardar: [{ id, caja, valor, titulo, editorial }]
  cierres: [],             // ids de cajas que se cerraron sin conexión (se cierran al volver)
  colaEnviando: null,      // Set de ids que están viajando al servidor ahora
  colaTimer: null,         // reintento programado
  colaReintentos: 0,
  colaSinConexion: false,  // el último intento falló por red
  edicion: false,          // Admin editando una caja ya armada (puede estar cerrada)
  contenido: [],           // libros de la caja en curso: [{ valor, titulo, editorial, origen, hora }]

  lectorFoto: null,        // instancia Html5Qrcode usada para leer fotos
  leyendoFoto: false,

  intervaloAdmin: null,
  audioCtx: null
};

/* ----------------------------------------------------------------------------
 *  ATAJOS DEL DOM
 * -------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

/* ============================================================================
 *  COMUNICACIÓN CON EL SERVIDOR
 * ========================================================================== */

/**
 * Llama a una función de Código.gs por la API (doPost) con timeout y manejo de errores.
 * El cuerpo va como text/plain para evitar el preflight CORS de Apps Script.
 * @param {string} funcion  Nombre de la función de Código.gs
 * @param {...*} args       Argumentos
 */
async function llamarServidor(funcion, ...args) {
  if (!navigator.onLine) {
    throw crearError('SIN_CONEXION', 'No hay conexión a internet. Revisá el Wi-Fi o los datos móviles.');
  }

  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), TIMEOUT_SERVIDOR_MS);

  let respuesta;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: funcion, args: args }),
      redirect: 'follow',
      signal: control.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    respuesta = await r.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      throw crearError('TIMEOUT', 'El servidor tardó demasiado en responder. Revisá la conexión.');
    }
    throw crearError('RED', 'Falló la conexión con el servidor. Intentá de nuevo.');
  } finally {
    clearTimeout(temporizador);
  }

  if (!respuesta || !respuesta.ok) throw normalizarError(new Error(respuesta && respuesta.error));
  return respuesta.result;
}

function crearError(codigo, mensaje) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  return e;
}

/** Convierte cualquier error del servidor en { codigo, message } legible. */
function normalizarError(error) {
  let msg = (error && (error.message || String(error))) || 'Error desconocido';
  msg = msg.replace(/^(Exception|Error|ScriptError):\s*/i, '');

  if (msg.indexOf('SESION_EXPIRADA') !== -1) {
    return crearError('SESION_EXPIRADA', 'Tu sesión venció. Volvé a ingresar.');
  }
  if (msg.indexOf('CAJA_CERRADA') !== -1) {
    return crearError('CAJA_CERRADA', msg.replace(/^.*CAJA_CERRADA:\s*/, ''));
  }
  if (/NetworkError|Failed to fetch|HTTP 0|connection/i.test(msg)) {
    return crearError('RED', 'Falló la conexión con el servidor. Intentá de nuevo.');
  }
  return crearError('SERVIDOR', msg);
}

/** Manejo común: si la sesión venció, vuelve al login. Devuelve true si lo manejó. */
function manejarErrorSesion(error) {
  if (error && error.codigo === 'SESION_EXPIRADA') {
    toast(error.message, 'danger');
    cerrarSesionLocal();
    return true;
  }
  return false;
}

/* ============================================================================
 *  NAVEGACIÓN ENTRE PANTALLAS
 * ========================================================================== */

function mostrarPantalla(id) {
  document.querySelectorAll('.pantalla').forEach((p) => p.classList.remove('activa'));
  $(id).classList.add('activa');
  $('barra').classList.toggle('d-none', id === 'pantalla-login');
  window.scrollTo(0, 0);
}

function mostrarCargando(texto) {
  $('cargando-texto').textContent = texto || 'Cargando…';
  $('cargando').classList.add('visible');
}

function ocultarCargando() {
  $('cargando').classList.remove('visible');
}

/* ============================================================================
 *  LOGIN / LOGOUT / SESIÓN
 * ========================================================================== */

async function onSubmitLogin(evento) {
  evento.preventDefault();

  const usuario = $('login-usuario').value.trim();
  const password = $('login-password').value;
  const error = $('login-error');
  error.classList.add('d-none');

  if (!usuario || !password) {
    mostrarErrorLogin('Completá usuario y contraseña.');
    return;
  }

  estadoBotonLogin(true);
  try {
    const sesion = await llamarServidor('login', usuario, password);
    $('login-password').value = '';
    iniciarSesion(sesion);
  } catch (e) {
    mostrarErrorLogin(e.message);
  } finally {
    estadoBotonLogin(false);
  }
}

function mostrarErrorLogin(mensaje) {
  const error = $('login-error');
  error.textContent = mensaje;
  error.classList.remove('d-none');
  vibrar([60, 40, 60]);
}

function estadoBotonLogin(cargando) {
  const btn = $('btn-login');
  btn.disabled = cargando;
  btn.querySelector('.spinner-border').classList.toggle('d-none', !cargando);
  btn.querySelector('.texto').textContent = cargando ? 'Ingresando…' : 'Ingresar';
}

/** Guarda la sesión y redirige según el rol. */
function iniciarSesion(sesion) {
  app.sesion = { token: sesion.token, usuario: sesion.usuario, rol: sesion.rol };
  if (sesion.maxLibros) app.limite = sesion.maxLibros;
  guardarSesionLocal(app.sesion);
  cargarColaLocal();

  $('barra-usuario').textContent = sesion.usuario + ' · ' + sesion.rol;

  $('menu-usuario').textContent = sesion.usuario;

  if (sesion.rol === 'Admin') {
    irAlPanel();
  } else {
    irAlEmpaquetado();
  }
}

/** Panel de control (solo Admin). */
function irAlPanel() {
  mostrarPantalla('pantalla-admin');
  cargarPanelAdmin();
  detenerAutoRefrescoAdmin();
  app.intervaloAdmin = setInterval(cargarPanelAdmin, 60000);
}

/** Flujo de armado de cajas (Operario, o Admin que también quiere cargar libros). */
function irAlEmpaquetado() {
  detenerAutoRefrescoAdmin();
  mostrarMenu();
  cargarCatalogo(); // en segundo plano
  cargarSinCodigo();
}

async function onLogout() {
  const ok = app.caja
    ? await confirmar('Salir', 'La caja ' + app.caja + ' quedará abierta con ' + app.cantidad + ' libros. ¿Salir igual?', 'Salir', 'btn-danger')
    : true;
  if (!ok) return;

  await esperarCola('Guardando', null);
  if (app.cola.length || app.cierres.length) {
    const partes = [];
    if (app.cola.length) partes.push(`<b>${app.cola.length} libro(s)</b> sin guardar`);
    if (app.cierres.length) partes.push(`<b>${app.cierres.length} caja(s)</b> sin cerrar`);
    const salir = await confirmar('Cambios sin enviar',
      `Hay ${partes.join(' y ')} por falta de conexión.<br><br>` +
        'Si salís, quedan en este celular y se envían la próxima vez que entres con tu usuario.',
      'Salir igual', 'btn-danger', 'Quedarme');
    if (!salir) return;
  }

  const token = app.sesion && app.sesion.token;
  cerrarSesionLocal();
  if (token) llamarServidor('logout', token).catch(() => {}); // no bloqueante
}

/** Limpia todo el estado del navegador y vuelve al login. */
function cerrarSesionLocal() {
  detenerAutoRefrescoAdmin();
  detenerCamara();
  borrarSesionLocal();

  app.sesion = null;
  app.caja = null;
  app.cantidad = 0;
  app.contenido = [];
  // La cola queda en el almacenamiento del celular para el próximo ingreso.
  clearTimeout(app.colaTimer);
  app.cola = [];
  app.cierres = [];
  app.colaEnviando = null;
  app.colaSinConexion = false;
  app.colaReintentos = 0;
  app.catalogo = [];
  app.indiceIsbn = new Map();
  app.codigosBloqueados = new Map();
  app.resumen = null;
  app.catalogoListo = false;
  app.catalogoCargando = false;
  app.sinCodigo = [];
  app.sinCodigoVerTodos = false;
  renderSinCodigo();

  ocultarCargando();
  $('overlay-completada').classList.remove('visible');
  mostrarPantalla('pantalla-login');
  setTimeout(() => $('login-usuario').focus(), 50);
}

function guardarSesionLocal(sesion) {
  try { sessionStorage.setItem(CLAVE_SESION, JSON.stringify(sesion)); } catch (e) { /* sin almacenamiento */ }
}

function leerSesionLocal() {
  try { return JSON.parse(sessionStorage.getItem(CLAVE_SESION) || 'null'); } catch (e) { return null; }
}

function borrarSesionLocal() {
  try { sessionStorage.removeItem(CLAVE_SESION); } catch (e) { /* sin almacenamiento */ }
}

/** Al abrir la app, intenta recuperar una sesión previa (por ejemplo tras recargar). */
async function restaurarSesion() {
  const guardada = leerSesionLocal();
  if (!guardada || !guardada.token) return;

  mostrarCargando('Recuperando sesión…');
  try {
    const sesion = await llamarServidor('validarSesion', guardada.token);
    iniciarSesion(sesion);
  } catch (e) {
    borrarSesionLocal();
    if (e.codigo !== 'SESION_EXPIRADA') toast(e.message, 'danger');
  } finally {
    ocultarCargando();
  }
}

/* ============================================================================
 *  PANEL ADMIN
 * ========================================================================== */

async function cargarPanelAdmin() {
  if (!app.sesion || app.sesion.rol !== 'Admin') return;

  const btn = $('btn-admin-refrescar');
  btn.disabled = true;
  try {
    const d = await llamarServidor('getPanelAdmin', app.sesion.token);
    $('admin-error').classList.add('d-none');

    $('admin-fecha').textContent = d.fecha;
    $('admin-actualizado').textContent = d.actualizado;
    $('kpi-cerradas-hoy').textContent = d.cajasCerradasHoy;
    $('kpi-libros-hoy').textContent = d.librosHoy;
    $('kpi-disponibles').textContent = d.cajasDisponibles;
    $('kpi-cerradas-total').textContent = d.cajasCerradasTotal + ' / ' + d.cajasTotal;

    $('tabla-operarios').innerHTML = d.porOperario.length
      ? d.porOperario.map((o) => `
          <tr>
            <td><i class="bi bi-person"></i> ${escaparHtml(o.usuario)}</td>
            <td class="text-end fw-bold">${o.cajas}</td>
            <td class="text-end">${o.libros}</td>
          </tr>`).join('')
      : '<tr><td colspan="3" class="text-center text-muted py-3">Sin actividad registrada hoy.</td></tr>';

    $('tabla-ultimas').innerHTML = d.ultimasCerradas.length
      ? d.ultimasCerradas.map((c) => `
          <tr>
            <td>${escaparHtml(c.hora)}</td>
            <td class="fw-semibold">${escaparHtml(c.id)}</td>
            <td>${escaparHtml(c.usuario)}</td>
            <td class="text-end">
              <span class="badge ${claseBadgeLimite(c.libros, d.maxLibros)}">${c.libros}/${d.maxLibros}</span>
            </td>
          </tr>`).join('')
      : '<tr><td colspan="4" class="text-center text-muted py-3">Todavía no se cerraron cajas hoy.</td></tr>';
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    $('admin-error').textContent = 'No se pudo cargar el panel: ' + e.message;
    $('admin-error').classList.remove('d-none');
  } finally {
    btn.disabled = false;
  }
}

function detenerAutoRefrescoAdmin() {
  if (app.intervaloAdmin) clearInterval(app.intervaloAdmin);
  app.intervaloAdmin = null;
}

/** Verde = justo en el límite, amarillo = por debajo, rojo = lo supera. */
function claseBadgeLimite(cantidad, limite) {
  if (cantidad > limite) return 'text-bg-danger';
  return cantidad === limite ? 'text-bg-success' : 'text-bg-warning';
}

/** Panel admin → "Consultar caja": muestra el contenido de cualquier caja. */
function onConsultarCaja(evento) {
  evento.preventDefault();
  const idCaja = $('input-consulta-caja').value.trim();
  if (idCaja) consultarCaja(idCaja);
}

async function consultarCaja(idCaja) {
  const destino = $('resultado-consulta-caja');
  const btn = $('btn-consultar-caja');
  btn.disabled = true;
  destino.innerHTML = '<div class="text-muted small py-2">Buscando…</div>';
  try {
    const c = await llamarServidor('getContenidoCaja', app.sesion.token, idCaja);
    app.cajaConsultada = c.id;
    const repetidos = c.libros.filter((l) => l.veces > 1).length;
    destino.innerHTML = `
      <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
        <span class="fw-bold">${escaparHtml(c.id)}</span>
        <span class="badge ${c.estado === 'Cerrada' ? 'text-bg-secondary' : 'text-bg-primary'}">${escaparHtml(c.estado)}</span>
        <span class="badge ${claseBadgeLimite(c.cantidad, c.max)}">${c.cantidad}/${c.max} libros</span>
        ${repetidos ? `<span class="badge text-bg-warning"><i class="bi bi-exclamation-triangle"></i> ${repetidos} repetido(s)</span>` : ''}
        ${app.sesion.rol === 'Admin' ? `<button type="button" class="btn btn-outline-primary btn-sm btn-editar-caja ms-auto" style="min-height:36px;">
          <i class="bi bi-pencil-square"></i> Editar contenido</button>` : ''}
      </div>
      ${c.usuarioCierre ? `<div class="small text-muted mb-2">Cerrada por ${escaparHtml(c.usuarioCierre)}${c.fechaCierre ? ' · ' + escaparHtml(c.fechaCierre) : ''}</div>` : ''}
      ${c.libros.length
        ? barraSeleccionHtml() +
          '<ul class="list-group">' + c.libros.map((l) => itemContenidoHtml(l, true)).join('') + '</ul>'
        : '<div class="text-muted small">La caja está vacía.</div>'}`;
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    destino.innerHTML = `<div class="alert alert-danger py-2 mb-0">${escaparHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

/** Panel admin: botón "sacar" en la caja consultada (también sirve para cajas cerradas). */
async function onQuitarEnConsulta(evento) {
  if (evento.target.closest('.btn-sacar-seleccion')) return sacarSeleccionEnConsulta();
  const boton = evento.target.closest('[data-quitar]');
  if (!boton || !app.cajaConsultada) return;
  const codigo = boton.dataset.quitar;
  const titulo = boton.dataset.titulo || codigo;

  const ok = await confirmar('Sacar libro',
    `¿Sacar <b>1 ejemplar</b> de <b>${escaparHtml(titulo)}</b> de la caja <b>${escaparHtml(app.cajaConsultada)}</b>?`,
    'Sacar', 'btn-danger');
  if (!ok) return;

  boton.disabled = true;
  try {
    await llamarServidor('quitarLibro', app.sesion.token, app.cajaConsultada, codigo);
    toast('Se sacó "' + titulo + '" de la caja ' + app.cajaConsultada + '.', 'success');
    consultarCaja(app.cajaConsultada);
  } catch (e) {
    boton.disabled = false;
    if (manejarErrorSesion(e)) return;
    toast('No se pudo sacar el libro: ' + e.message, 'danger');
  }
}

/** Panel admin: saca de una vez todos los libros marcados de la caja consultada. */
async function sacarSeleccionEnConsulta() {
  const contenedor = $('resultado-consulta-caja');
  const idCaja = app.cajaConsultada;
  const codigos = await confirmarSacarSeleccion(contenedor, idCaja);
  if (!codigos) return;

  mostrarCargando('Sacando libros…');
  try {
    const r = await llamarServidor('quitarLibros', app.sesion.token, idCaja, codigos);
    ocultarCargando();
    toast(`Se sacaron ${r.quitados} libro(s) de la caja ${idCaja}.`, 'success');
    if (app.caja === idCaja) resincronizarCaja();
    consultarCaja(idCaja);
  } catch (e) {
    ocultarCargando();
    if (manejarErrorSesion(e)) return;
    toast('No se pudieron sacar los libros: ' + e.message, 'danger');
  }
}

/**
 * Fila de la lista de contenido de una caja: { codigo, titulo, editorial, veces }.
 * Con `quitable`, agrega una casilla de selección y un botón para sacar un ejemplar.
 */
function itemContenidoHtml(l, quitable) {
  const repetido = l.veces > 1;
  return `
    <li class="list-group-item d-flex justify-content-between align-items-center gap-2 ${repetido ? 'item-repetido' : ''}">
      ${quitable ? `<input type="checkbox" class="form-check-input sel-libro flex-shrink-0 m-0"
          data-codigo="${escaparHtml(l.codigo)}" data-veces="${l.veces}"
          aria-label="Seleccionar ${escaparHtml(l.titulo || l.codigo)}">` : ''}
      <div class="text-truncate flex-grow-1">
        <div class="fw-semibold text-truncate">${escaparHtml(l.titulo || l.codigo)}</div>
        <div class="resultado-isbn text-truncate">
          ${l.editorial ? escaparHtml(l.editorial) + ' · ' : ''}${esCodigo(l.codigo) ? escaparHtml(etiquetaCodigo(l.codigo)) : 'Sin código'}
        </div>
      </div>
      ${l.pendientes ? `<span class="text-warning-emphasis flex-shrink-0" title="Guardando…" aria-label="Guardando">
          <span class="spinner-border spinner-border-sm"></span></span>` : ''}
      ${repetido ? `<span class="badge text-bg-warning flex-shrink-0"><i class="bi bi-exclamation-triangle"></i> ×${l.veces}</span>` : ''}
      ${quitable ? `<button type="button" class="btn btn-outline-danger btn-quitar flex-shrink-0"
          data-quitar="${escaparHtml(l.codigo)}" data-titulo="${escaparHtml(l.titulo || l.codigo)}"
          aria-label="Sacar un ejemplar de la caja" title="Sacar un ejemplar"><i class="bi bi-dash-lg"></i></button>` : ''}
    </li>`;
}

/* ----------------------------------------------------------------------------
 *  SELECCIÓN MÚLTIPLE PARA VACIAR CAJAS
 *  La barra va arriba de la lista; la lista (`.sel-libro`) y la barra viven
 *  dentro del mismo contenedor, así sirve igual en la caja en curso y en la
 *  consulta del panel admin.
 * -------------------------------------------------------------------------- */

function barraSeleccionHtml() {
  return `
    <div class="barra-seleccion d-flex align-items-center justify-content-between gap-2">
      <label class="form-check d-flex align-items-center gap-2 m-0 py-1">
        <input type="checkbox" class="form-check-input sel-todos m-0">
        <span class="form-check-label small fw-semibold">Marcar todos</span>
      </label>
      <button type="button" class="btn btn-danger btn-sm btn-sacar-seleccion" disabled style="min-height:36px;">
        <i class="bi bi-trash3"></i> Sacar <span class="sel-cuenta">0</span>
      </button>
    </div>`;
}

/** Códigos marcados dentro de `contenedor` y cuántos ejemplares suman. */
function seleccionEn(contenedor) {
  const marcadas = [...contenedor.querySelectorAll('.sel-libro:checked')];
  return {
    codigos: marcadas.map((c) => c.dataset.codigo),
    ejemplares: marcadas.reduce((s, c) => s + Number(c.dataset.veces || 1), 0)
  };
}

/** Sincroniza "Marcar todos" (incluido el estado intermedio) y el botón de sacar. */
function actualizarBarraSeleccion(contenedor) {
  const barra = contenedor.querySelector('.barra-seleccion');
  if (!barra) return;
  const casillas = contenedor.querySelectorAll('.sel-libro');
  const { codigos, ejemplares } = seleccionEn(contenedor);
  const todos = barra.querySelector('.sel-todos');
  todos.checked = casillas.length > 0 && codigos.length === casillas.length;
  todos.indeterminate = codigos.length > 0 && codigos.length < casillas.length;
  todos.disabled = casillas.length === 0;
  barra.querySelector('.sel-cuenta').textContent = ejemplares ? `${ejemplares} libro(s)` : '';
  barra.querySelector('.btn-sacar-seleccion').disabled = codigos.length === 0;
}

/** Maneja los cambios de casillas dentro de `contenedor`. */
function onCambioSeleccion(evento) {
  const contenedor = evento.currentTarget;
  if (evento.target.classList.contains('sel-todos')) {
    contenedor.querySelectorAll('.sel-libro').forEach((c) => { c.checked = evento.target.checked; });
  }
  if (evento.target.matches('.sel-todos, .sel-libro')) actualizarBarraSeleccion(contenedor);
}

/** Tocar cualquier parte de la fila (salvo sus botones) marca o desmarca su casilla. */
function onTocarFila(evento) {
  if (evento.target.closest('button, input, label')) return;
  const fila = evento.target.closest('.list-group-item');
  const casilla = fila && fila.querySelector('.sel-libro');
  if (!casilla) return;
  casilla.checked = !casilla.checked;
  casilla.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Pide confirmación para sacar la selección. Devuelve los códigos, o null si se canceló. */
async function confirmarSacarSeleccion(contenedor, idCaja) {
  const { codigos, ejemplares } = seleccionEn(contenedor);
  if (!codigos.length) return null;
  const todos = codigos.length === contenedor.querySelectorAll('.sel-libro').length;
  const ok = await confirmar(todos ? 'Vaciar caja' : 'Sacar libros',
    `¿Sacar <b>${ejemplares} libro(s)</b> (${codigos.length} título(s), con todos sus ejemplares) ` +
      `de la caja <b>${escaparHtml(idCaja)}</b>?` +
      (todos ? '<div class="small text-body-secondary mt-2">La caja queda vacía.</div>' : ''),
    todos ? 'Vaciar caja' : 'Sacar', 'btn-danger');
  return ok ? codigos : null;
}

/** true si el valor registrado es un ISBN/ISSN (y no un título). */
function esCodigo(valor) {
  return /^[0-9X]{8,13}$/.test(String(valor || ''));
}

/** "ISBN 978…" o "ISSN 1234-5678" según el largo del código. */
function etiquetaCodigo(codigo) {
  if (!esCodigo(codigo)) return 'Sin código';
  return codigo.length === 8
    ? 'ISSN ' + codigo.slice(0, 4) + '-' + codigo.slice(4)
    : 'ISBN ' + codigo;
}

/* ============================================================================
 *  CATÁLOGO EN MEMORIA
 * ========================================================================== */

/**
 * Muestra el estado del catálogo en el menú y en la pantalla de caja.
 * @param {'cargando'|'ok'|'error'} tipo
 */
function estadoCatalogo(tipo, texto) {
  const color = { cargando: 'text-warning', ok: 'text-success', error: 'text-danger' }[tipo];
  ['estado-catalogo', 'estado-catalogo-caja'].forEach((id) => {
    $(id).textContent = texto;
    $(id).className = 'fw-semibold ' + color;
  });
  $('btn-reintentar-catalogo').classList.toggle('d-none', tipo !== 'error');
  const btn = $('btn-actualizar-catalogo');
  btn.disabled = tipo === 'cargando';
  btn.querySelector('.spinner-border').classList.toggle('d-none', tipo !== 'cargando');
  btn.querySelector('.bi').classList.toggle('d-none', tipo === 'cargando');
}

/**
 * Descarga el catálogo y construye los índices de búsqueda.
 * Con `forzar` lo vuelve a bajar aunque ya esté cargado (p. ej. se agregaron
 * títulos a la planilla); mientras tanto se sigue usando el catálogo anterior.
 */
async function cargarCatalogo(forzar = false) {
  if (app.catalogoCargando || !app.sesion) return;
  if (app.catalogoListo && forzar !== true) return;
  app.catalogoCargando = true;
  const cantidadAnterior = app.catalogo.length;

  estadoCatalogo('cargando', app.catalogoListo ? 'actualizando…' : 'cargando…');

  try {
    const filas = await llamarServidor('getCatalogo', app.sesion.token);

    // La búsqueda manual es por título o editorial (el código se usa al escanear).
    // `isbn` guarda el código del catálogo, sea ISBN o ISSN.
    const recargado = app.catalogoListo;
    app.catalogo = filas.map(([isbn, titulo, editorial, tipo, impresos]) => ({
      isbn: String(isbn || ''),
      titulo: String(titulo || ''),
      editorial: String(editorial || ''),
      tipo: String(tipo || ''),
      impresos: Array.isArray(impresos) ? impresos : [],
      normTitulo: normalizarTexto(titulo),
      norm: normalizarTexto(titulo + ' ' + (editorial || ''))
    }));

    // Índice por código (los ISBN se indexan en sus dos formas: 10 y 13 dígitos).
    app.indiceIsbn = new Map();
    app.catalogo.forEach((item) => {
      if (!item.isbn) return;
      app.indiceIsbn.set(item.isbn, item);
      if (item.isbn.length === 8) return; // ISSN
      const alt = item.isbn.length === 10 ? isbn10a13(item.isbn) : isbn13a10(item.isbn);
      if (alt && !app.indiceIsbn.has(alt)) app.indiceIsbn.set(alt, item);
    });

    reconstruirBloqueados();

    app.catalogoListo = true;
    if ($('pantalla-libro').classList.contains('activa') && !app.intercambio) renderLibroDetalle();
    estadoCatalogo('ok', app.catalogo.length.toLocaleString('es-AR') + ' títulos listos');
    actualizarInfoBusqueda();
    if ($('input-busqueda').value) onInputBusqueda(); // refresca resultados ya mostrados
    if (app.caja) renderContenido(); // completa títulos de registros viejos

    if (recargado) {
      const nuevos = app.catalogo.length - cantidadAnterior;
      toast(nuevos > 0
        ? `Catálogo actualizado: ${nuevos.toLocaleString('es-AR')} título(s) nuevo(s).`
        : 'Catálogo actualizado.', 'success');
    }
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    if (app.catalogoListo) {
      // Falló la actualización: se sigue usando el catálogo que ya estaba.
      estadoCatalogo('ok', app.catalogo.length.toLocaleString('es-AR') + ' títulos listos');
      toast('No se pudo actualizar el catálogo: ' + e.message, 'danger');
    } else {
      estadoCatalogo('error', 'no se pudo cargar');
      toast('No se pudo cargar el catálogo: ' + e.message, 'danger');
    }
  } finally {
    app.catalogoCargando = false;
  }
}

/** Índice de códigos mal impresos (en sus dos formas, si es ISBN) → libros que los traen. */
function reconstruirBloqueados() {
  app.codigosBloqueados = new Map();
  app.catalogo.forEach((item) => {
    item.impresos.forEach((codigo) => {
      const alt = codigo.length === 10 ? isbn10a13(codigo) : codigo.length === 13 ? isbn13a10(codigo) : null;
      [codigo, alt].filter(Boolean).forEach((c) => {
        if (!app.codigosBloqueados.has(c)) app.codigosBloqueados.set(c, []);
        app.codigosBloqueados.get(c).push(item);
      });
    });
  });
}

/** Minúsculas, sin tildes y con espacios simples. */
function normalizarTexto(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Filtra el catálogo: todas las palabras escritas deben aparecer en el título o
 * la editorial (en cualquier orden). Los títulos que empiezan con la búsqueda van primero.
 */
function buscarEnCatalogo(consulta) {
  const q = normalizarTexto(consulta);
  if (q.length < 2) return [];

  const palabras = q.split(' ');
  const resultados = [];

  for (let i = 0; i < app.catalogo.length; i++) {
    const item = app.catalogo[i];
    let coincide = true;
    for (let j = 0; j < palabras.length; j++) {
      if (item.norm.indexOf(palabras[j]) === -1) { coincide = false; break; }
    }
    if (coincide) {
      resultados.push(item);
      if (resultados.length >= 300) break; // tope de seguridad
    }
  }

  resultados.sort((a, b) => {
    const pa = a.normTitulo.startsWith(q) ? 0 : 1;
    const pb = b.normTitulo.startsWith(q) ? 0 : 1;
    return pa - pb || a.titulo.localeCompare(b.titulo, 'es');
  });

  return resultados;
}

function onInputBusqueda() {
  const consulta = $('input-busqueda').value;
  const contenedor = $('resultados-busqueda');

  if (!app.catalogoListo) {
    contenedor.innerHTML = '';
    actualizarInfoBusqueda();
    return;
  }

  if (normalizarTexto(consulta).length < 2) {
    contenedor.innerHTML = '';
    actualizarInfoBusqueda();
    return;
  }

  const resultados = buscarEnCatalogo(consulta);
  const visibles = resultados.slice(0, MAX_RESULTADOS_BUSQUEDA);

  if (!resultados.length) {
    $('busqueda-info').textContent = 'Sin resultados para "' + consulta + '".';
    contenedor.innerHTML = '';
    return;
  }

  $('busqueda-info').textContent = resultados.length > visibles.length
    ? `Mostrando ${visibles.length} de ${resultados.length}+ resultados. Escribí más para afinar.`
    : `${resultados.length} resultado(s). Tocá un título para cargarlo.`;

  const palabras = normalizarTexto(consulta).split(' ');
  contenedor.innerHTML = visibles.map((item, idx) => `
    <button type="button" class="list-group-item list-group-item-action" data-idx="${idx}">
      <div class="fw-semibold">${resaltar(item.titulo || '(sin título)', palabras)}</div>
      <div class="resultado-isbn">
        ${item.editorial ? resaltar(item.editorial, palabras) + ' · ' : ''}${escaparHtml(etiquetaCodigo(item.isbn))}
      </div>
    </button>`).join('');

  // Guardamos la lista visible para resolver el clic sin volver a buscar.
  contenedor._items = visibles;
}

function onClickResultado(evento) {
  const boton = evento.target.closest('[data-idx]');
  if (!boton) return;
  const item = $('resultados-busqueda')._items[Number(boton.dataset.idx)];
  if (!item) return;

  // Seleccionar un título actúa igual que escanear su código.
  ingresarLibro({
    valor: item.isbn || item.titulo,
    titulo: item.titulo,
    editorial: item.editorial,
    origen: 'busqueda'
  }).then((ok) => {
    if (ok) {
      $('input-busqueda').value = '';
      $('resultados-busqueda').innerHTML = '';
      actualizarInfoBusqueda();
    }
  });
}

/* ============================================================================
 *  SELECTOR RÁPIDO "SIN CÓDIGO"
 *  Los libros que se cargan por título (no traen código de barras impreso),
 *  de los más cargados a los menos, para anotarlos con un toque sin buscar.
 * ========================================================================== */

/** Cuántos se muestran antes de "Ver todos". */
const SIN_CODIGO_VISIBLES = 6;

async function cargarSinCodigo() {
  if (!app.sesion) return;
  try {
    const filas = await llamarServidor('getSinCodigo', app.sesion.token);
    const servidor = filas.map(([valor, titulo, editorial]) => ({
      valor: String(valor || ''), titulo: String(titulo || ''), editorial: String(editorial || '')
    }));
    // Los que se cargaron en este celular y todavía no llegaron al servidor quedan al final.
    const locales = app.sinCodigo.filter((l) => !servidor.some((s) => s.valor === l.valor));
    app.sinCodigo = servidor.concat(locales);
    renderSinCodigo();
  } catch (e) {
    manejarErrorSesion(e); // si falla, el selector sigue como estaba (es solo un atajo)
  }
}

/** Suma a la lista un libro recién elegido por título (sin reordenar lo que ya se ve). */
function sumarSinCodigo(libro) {
  if (app.sinCodigo.some((l) => l.valor === libro.valor)) return;
  app.sinCodigo.push({ valor: libro.valor, titulo: libro.titulo || libro.valor, editorial: libro.editorial || '' });
  renderSinCodigo();
}

function renderSinCodigo() {
  const contenedor = $('sin-codigo');
  contenedor.classList.toggle('d-none', !app.sinCodigo.length);
  if (!app.sinCodigo.length) { contenedor.innerHTML = ''; return; }

  const visibles = app.sinCodigoVerTodos ? app.sinCodigo : app.sinCodigo.slice(0, SIN_CODIGO_VISIBLES);
  const ocultos = app.sinCodigo.length - visibles.length;
  contenedor.innerHTML = `
    <div class="small fw-semibold text-body-secondary mb-2">
      <i class="bi bi-lightning-charge"></i> Sin código de barras · tocá para cargar
    </div>
    <div class="d-flex flex-wrap gap-2">
      ${visibles.map((l, idx) => `
        <button type="button" class="btn btn-outline-secondary chip-sin-codigo" data-sin-codigo="${idx}"
          title="${escaparHtml(l.titulo + (l.editorial ? ' · ' + l.editorial : ''))}">
          <span class="chip-titulo">${escaparHtml(l.titulo)}</span>
          ${l.editorial ? `<span class="d-block text-truncate small text-body-secondary">${escaparHtml(l.editorial)}</span>` : ''}
        </button>`).join('')}
      ${ocultos > 0 || app.sinCodigoVerTodos ? `
        <button type="button" class="btn btn-link btn-sm w-100" data-sin-codigo-todos>
          ${app.sinCodigoVerTodos ? 'Ver menos' : `Ver todos (${app.sinCodigo.length})`}
        </button>` : ''}
    </div>`;
}

function onClickSinCodigo(evento) {
  if (evento.target.closest('[data-sin-codigo-todos]')) {
    app.sinCodigoVerTodos = !app.sinCodigoVerTodos;
    renderSinCodigo();
    return;
  }
  const boton = evento.target.closest('[data-sin-codigo]');
  if (!boton) return;
  const libro = app.sinCodigo[Number(boton.dataset.sinCodigo)];
  if (libro) ingresarLibro({ valor: libro.valor, titulo: libro.titulo, editorial: libro.editorial, origen: 'rapido' });
}

function actualizarInfoBusqueda() {
  $('busqueda-info').textContent = app.catalogoListo
    ? `Buscá entre ${app.catalogo.length.toLocaleString('es-AR')} títulos por título o editorial (mínimo 2 letras), o tipeá/escaneá el código y Enter.`
    : 'El catálogo todavía se está cargando…';
}

/** Resalta las palabras buscadas dentro del título (sin romper el escapado HTML). */
function resaltar(titulo, palabras) {
  let html = escaparHtml(titulo);
  palabras.filter((p) => p.length >= 2).forEach((p) => {
    // Construye una regex tolerante a tildes: "a" coincide con "á", etc.
    const patron = p.split('').map((c) => {
      const mapa = { a: '[aáàä]', e: '[eéèë]', i: '[iíìï]', o: '[oóòö]', u: '[uúùü]', n: '[nñ]' };
      return mapa[c] || c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    html = html.replace(new RegExp('(' + patron + ')(?![^<]*>)', 'gi'), '<mark>$1</mark>');
  });
  return html;
}

/* ============================================================================
 *  VALIDACIÓN DE ISBN / ISSN
 * ========================================================================== */

/**
 * Limpia y valida un ISBN o ISSN (formato por RegEx + dígito verificador).
 * Un código de barras EAN-13 que empieza con 977 se convierte a su ISSN.
 * @return {{tipo:'ISBN'|'ISSN', codigo:string}|null}
 */
function validarCodigo(texto) {
  const limpio = String(texto || '').replace(/[\s-]/g, '').toUpperCase();

  if (REGEX_EAN_ISSN.test(limpio)) {
    return verificadorEan13(limpio) ? { tipo: 'ISSN', codigo: ean977aIssn(limpio) } : null;
  }
  if (REGEX_ISSN.test(limpio)) {
    return verificadorIssn(limpio) ? { tipo: 'ISSN', codigo: limpio } : null;
  }
  if (!REGEX_ISBN.test(limpio)) return null;
  const valido = limpio.length === 13 ? verificadorIsbn13(limpio) : verificadorIsbn10(limpio);
  return valido ? { tipo: 'ISBN', codigo: limpio } : null;
}

/** El verificador de un ISBN-13 es el mismo que el de cualquier EAN-13. */
function verificadorEan13(codigo) {
  return verificadorIsbn13(codigo);
}

function verificadorIssn(issn) {
  let suma = 0;
  for (let i = 0; i < 7; i++) suma += Number(issn[i]) * (8 - i);
  const ultimo = issn[7] === 'X' ? 10 : Number(issn[7]);
  return (suma + ultimo) % 11 === 0;
}

/** 977 + 7 dígitos del ISSN + 2 de variante + verificador → ISSN de 8 caracteres. */
function ean977aIssn(ean) {
  const base = ean.slice(3, 10);
  let suma = 0;
  for (let i = 0; i < 7; i++) suma += Number(base[i]) * (8 - i);
  const dv = (11 - (suma % 11)) % 11;
  return base + (dv === 10 ? 'X' : String(dv));
}

function verificadorIsbn13(isbn) {
  let suma = 0;
  for (let i = 0; i < 12; i++) suma += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (suma % 10)) % 10 === Number(isbn[12]);
}

function verificadorIsbn10(isbn) {
  let suma = 0;
  for (let i = 0; i < 9; i++) suma += Number(isbn[i]) * (10 - i);
  const ultimo = isbn[9] === 'X' ? 10 : Number(isbn[9]);
  return (suma + ultimo) % 11 === 0;
}

function isbn10a13(isbn10) {
  if (!/^\d{9}[\dX]$/.test(isbn10)) return null;
  const base = '978' + isbn10.slice(0, 9);
  let suma = 0;
  for (let i = 0; i < 12; i++) suma += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  return base + ((10 - (suma % 10)) % 10);
}

function isbn13a10(isbn13) {
  if (!/^978\d{10}$/.test(isbn13)) return null;
  const base = isbn13.slice(3, 12);
  let suma = 0;
  for (let i = 0; i < 9; i++) suma += Number(base[i]) * (10 - i);
  const dv = (11 - (suma % 11)) % 11;
  return base + (dv === 10 ? 'X' : String(dv));
}

/** Busca un ISBN (10 o 13 dígitos) o ISSN en el catálogo en memoria. */
function buscarIsbnEnCatalogo(isbn) {
  return app.indiceIsbn.get(isbn) || null;
}

/* ============================================================================
 *  MENÚ PRINCIPAL Y SELECCIÓN DE CAJA
 * ========================================================================== */

function mostrarMenu() {
  app.caja = null;
  app.cantidad = 0;
  app.contenido = [];
  app.edicion = false;
  aplicarModoEdicion();
  detenerCamara();
  $('btn-volver-panel').classList.toggle('d-none', !(app.sesion && app.sesion.rol === 'Admin'));
  mostrarPantalla('pantalla-menu');
  cargarCajas();
}

/** Descarga todas las cajas con su estado y arma la lista. */
async function cargarCajas() {
  $('cajas-resumen').textContent = 'Cargando cajas…';
  $('btn-actualizar-cajas').disabled = true;
  try {
    const r = await llamarServidor('getCajas', app.sesion.token);
    app.limite = r.limite || app.limite;
    app.cajas = r.cajas;
    $('seleccion-vacia').classList.toggle('d-none', !!app.cajas.length);
    renderCajas();
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    $('cajas-resumen').textContent = 'No se pudieron obtener las cajas.';
    toast('No se pudieron obtener las cajas: ' + e.message, 'danger');
  } finally {
    $('btn-actualizar-cajas').disabled = false;
  }
}

/** Número de la caja (CBA-0093 → 93), o null si el ID no tiene dígitos. */
function numeroCaja(id) {
  const m = String(id).match(/(\d+)\D*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Filtra las cajas por lo tipeado: "93", "093" o "cba-0093" encuentran CBA-0093.
 * Orden: disponibles primero (vacías y en curso), después las que ya llegaron
 * al límite y al fondo las cerradas.
 */
function filtrarCajas(consulta) {
  const q = String(consulta || '').trim().toLowerCase();
  const soloNumero = /^\d+$/.test(q) ? Number(q) : null;

  const lista = app.cajas.filter((c) => {
    if (!q) return true;
    if (soloNumero !== null) {
      const n = numeroCaja(c.id);
      return n === soloNumero || String(n).startsWith(String(soloNumero));
    }
    return c.id.toLowerCase().includes(q);
  });

  const grupo = (c) => (c.cerrada ? 2 : c.cantidad >= app.limite ? 1 : 0);
  return lista.sort((a, b) => {
    const exactaA = soloNumero !== null && numeroCaja(a.id) === soloNumero ? 0 : 1;
    const exactaB = soloNumero !== null && numeroCaja(b.id) === soloNumero ? 0 : 1;
    return grupo(a) - grupo(b) || exactaA - exactaB ||
      a.id.localeCompare(b.id, 'es', { numeric: true });
  });
}

function renderCajas() {
  const lista = filtrarCajas($('input-buscar-caja').value);
  const disponibles = app.cajas.filter((c) => !c.cerrada).length;
  const cerradas = app.cajas.length - disponibles;
  $('cajas-resumen').textContent = `${disponibles} disponible(s) · ${cerradas} cerrada(s)` +
    ($('input-buscar-caja').value.trim() ? ` · ${lista.length} coincidencia(s)` : '');

  if (!lista.length) {
    $('lista-cajas').innerHTML = app.cajas.length
      ? '<div class="list-group-item text-body-secondary small">No hay cajas con ese número.</div>'
      : '';
    return;
  }

  let html = '';
  let separadorCerradas = false;
  lista.forEach((c) => {
    if (c.cerrada && !separadorCerradas) {
      separadorCerradas = true;
      html += '<div class="list-group-item separador-lista">Cerradas</div>';
    }
    html += `
      <button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 ${c.cerrada ? 'caja-cerrada' : ''}"
              data-caja="${escaparHtml(c.id)}">
        <span class="caja-id">${escaparHtml(c.id)}</span>
        ${badgeEstadoCaja(c)}
      </button>`;
  });
  $('lista-cajas').innerHTML = html;
}

function badgeEstadoCaja(c) {
  if (!c.cerrada && app.cierres.includes(c.id)) {
    return `<span class="badge text-bg-warning"><i class="bi bi-wifi-off"></i> Cerrando… · ${c.cantidad + pendientesDeCaja(c.id)}</span>`;
  }
  if (c.cerrada) {
    return `<span class="badge text-bg-secondary"><i class="bi bi-lock-fill"></i> Cerrada · ${c.cantidad}</span>`;
  }
  if (!c.cantidad) return '<span class="badge text-bg-success">Vacía</span>';
  if (c.cantidad >= app.limite) {
    return `<span class="badge text-bg-warning"><i class="bi bi-exclamation-circle"></i> Llena · ${c.cantidad}/${app.limite}</span>`;
  }
  return `<span class="badge text-bg-info">En curso · ${c.cantidad}/${app.limite}</span>`;
}

/** Clic en una caja de la lista. Las cerradas muestran su contenido (solo lectura). */
async function onClickCaja(evento) {
  const boton = evento.target.closest('[data-caja]');
  if (!boton) return;
  const caja = app.cajas.find((c) => c.id === boton.dataset.caja);
  if (!caja) return;

  if (caja.cerrada) {
    await mostrarCajaCerrada(caja.id);
    return;
  }
  if (app.cierres.includes(caja.id)) {
    toast(`La caja ${caja.id} ya se cerró en este celular; se termina de cerrar cuando vuelva la conexión.`, 'info');
    return;
  }
  abrirCajaSeleccionada(caja.id);
}

/** Enter en el buscador de cajas: abre la coincidencia exacta (o la única que quede). */
function onEnterBuscarCaja(evento) {
  if (evento.key !== 'Enter') return;
  evento.preventDefault();
  const lista = filtrarCajas($('input-buscar-caja').value);
  const q = $('input-buscar-caja').value.trim();
  const exacta = lista.find((c) => /^\d+$/.test(q) ? numeroCaja(c.id) === Number(q) : c.id.toLowerCase() === q.toLowerCase());
  const elegida = exacta || (lista.length === 1 ? lista[0] : null);
  if (!elegida) {
    vibrar(80);
    return;
  }
  if (elegida.cerrada) mostrarCajaCerrada(elegida.id);
  else if (app.cierres.includes(elegida.id)) {
    toast(`La caja ${elegida.id} ya se cerró en este celular; se termina de cerrar cuando vuelva la conexión.`, 'info');
  } else abrirCajaSeleccionada(elegida.id);
}

/** Modal con el contenido de una caja cerrada. */
async function mostrarCajaCerrada(idCaja) {
  mostrarCargando('Buscando contenido de ' + idCaja + '…');
  try {
    const c = await llamarServidor('getContenidoCaja', app.sesion.token, idCaja);
    ocultarCargando();
    await confirmar(
      'Caja ' + c.id + ' · cerrada',
      `<div class="small text-body-secondary mb-2">Cerrada por ${escaparHtml(c.usuarioCierre || '—')}${c.fechaCierre ? ' · ' + escaparHtml(c.fechaCierre) : ''} · ${c.cantidad} libro(s)</div>` +
      (c.libros.length ? '<ul class="list-group">' + c.libros.map((l) => itemContenidoHtml(l, false)).join('') + '</ul>' : '<div class="text-body-secondary">Sin libros.</div>'),
      'Aceptar', 'btn-secondary'
    );
  } catch (e) {
    ocultarCargando();
    if (manejarErrorSesion(e)) return;
    toast(e.message, 'danger');
  }
}

/** Abre la caja elegida y pasa a la pantalla de carga de libros. */
/**
 * @param {boolean=} edicion  Solo Admin: editar el contenido de una caja ya armada
 *                            (puede estar cerrada y sigue cerrada).
 */
async function abrirCajaSeleccionada(idCaja, edicion = false) {
  // Si quedaron libros de esta caja sin guardar, se intenta guardarlos antes de leerla.
  await esperarCola('Guardando', idCaja);
  mostrarCargando('Abriendo caja ' + idCaja + '…');
  try {
    const info = await llamarServidor('abrirCaja', app.sesion.token, idCaja, edicion);
    detenerAutoRefrescoAdmin();
    app.caja = info.id;
    app.edicion = edicion;
    aplicarModoEdicion(info.estado);
    aplicarContenidoServidor(info);
    app.limite = info.max || app.limite;

    $('caja-id').textContent = info.id;
    $('contador-max').textContent = app.limite;
    $('input-busqueda').value = '';
    $('resultados-busqueda').innerHTML = '';
    actualizarContador(false);
    renderContenido();
    actualizarEstadoCola();
    actualizarInfoBusqueda();
    setFeedback('neutral', 'Listo para cargar libros',
      info.cantidad ? `La caja ya tenía ${info.cantidad} libro(s). Continuá cargando.` : 'Escaneá el código o buscá por título / editorial.');

    $('input-buscar-caja').value = '';
    mostrarPantalla('pantalla-caja');
    $('modo-escaner').checked = true;
    cambiarModo('escaner');
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    toast(e.message, 'danger');
    if (e.codigo === 'CAJA_CERRADA') cargarCajas(); // refresca la lista
  } finally {
    ocultarCargando();
  }
}

/* ============================================================================
 *  PANTALLA DE CAJA: MODOS, CONTADOR Y FEEDBACK
 * ========================================================================== */

function cambiarModo(modo) {
  const esEscaner = modo === 'escaner';
  $('panel-escaner').classList.toggle('d-none', !esEscaner);
  $('panel-busqueda').classList.toggle('d-none', esEscaner);

  if (esEscaner) {
    iniciarCamara();
  } else {
    detenerCamara();
    setTimeout(() => $('input-busqueda').focus(), 100);
  }
}

function actualizarContador(animar = true) {
  $('contador').textContent = app.cantidad;
  const pct = Math.min(100, Math.round((app.cantidad / app.limite) * 100));
  const barra = $('barra-progreso');
  barra.style.width = pct + '%';
  barra.className = 'progress-bar ' + (app.cantidad > app.limite ? 'bg-danger' : app.cantidad === app.limite ? 'bg-warning' : 'bg-success');
  $('contador').classList.toggle('text-danger', app.cantidad > app.limite);

  if (animar) {
    const c = $('contador');
    c.classList.remove('pulso');
    void c.offsetWidth; // reinicia la animación
    c.classList.add('pulso');
  }
}

/**
 * Actualiza el recuadro de feedback.
 * @param {'neutral'|'exito'|'error'|'proceso'|'alerta'} tipo
 * @param {string=} deshacer  Valor del libro recién registrado: muestra el botón "Deshacer".
 */
function setFeedback(tipo, titulo, detalle, deshacer) {
  app.deshacer = deshacer || null;
  $('btn-deshacer').classList.toggle('d-none', !deshacer);
  const iconos = {
    neutral: 'bi-info-circle',
    exito: 'bi-check-circle-fill',
    error: 'bi-x-octagon-fill',
    proceso: 'bi-hourglass-split',
    alerta: 'bi-exclamation-triangle-fill'
  };
  const caja = $('feedback-ingreso');
  caja.className = `feedback-${tipo} p-3 mb-3 d-flex align-items-center gap-2`;
  $('feedback-icono').className = `bi ${iconos[tipo]} fs-4`;
  $('feedback-titulo').textContent = titulo;
  $('feedback-detalle').textContent = detalle || '';
}

/** Destello de color a pantalla completa + sonido + vibración. */
function destello(tipo) {
  const d = $('destello');
  d.className = tipo;
  requestAnimationFrame(() => requestAnimationFrame(() => { d.className = ''; }));

  if (tipo === 'exito') {
    beep(1046, 0.09);
    vibrar(80);
  } else if (tipo === 'alerta') {
    beep(660, 0.12); setTimeout(() => beep(660, 0.12), 180);
    vibrar([80, 60, 80, 60, 80]);
  } else {
    beep(220, 0.25);
    vibrar([120, 60, 120]);
  }
}

/** Completa título/editorial con el catálogo (registros viejos sin esas columnas). */
function completarDesdeCatalogo(libro) {
  if (libro.titulo) return libro;
  const item = buscarIsbnEnCatalogo(libro.valor);
  if (item) {
    libro.titulo = item.titulo;
    libro.editorial = libro.editorial || item.editorial;
  } else if (!esCodigo(libro.valor)) {
    libro.titulo = libro.valor; // se registró por título
  }
  return libro;
}

/** Cuántas veces está un código (o título) en la caja en curso. */
function vecesEnCaja(valor) {
  return app.contenido.filter((l) => l.valor === valor).length;
}

/** Lista completa de la caja en curso, agrupada por libro, con los repetidos resaltados. */
function renderContenido() {
  const lista = $('contenido-caja');
  app.contenido.forEach(completarDesdeCatalogo);

  const agrupado = [];
  const indice = new Map();
  // Lo último cargado arriba.
  app.contenido.slice().reverse().forEach((l) => {
    if (!indice.has(l.valor)) {
      indice.set(l.valor, agrupado.length);
      agrupado.push({ codigo: l.valor, titulo: l.titulo, editorial: l.editorial, veces: 0, pendientes: 0 });
    }
    const g = agrupado[indice.get(l.valor)];
    g.veces++;
    if (l.pendiente) g.pendientes++;
  });

  const repetidos = agrupado.filter((l) => l.veces > 1).length;
  $('contenido-resumen').innerHTML = app.contenido.length
    ? `${app.contenido.length} libro(s) · ${agrupado.length} título(s)` +
      (repetidos ? ` · <span class="text-warning-emphasis fw-semibold"><i class="bi bi-exclamation-triangle"></i> ${repetidos} repetido(s)</span>` : '')
    : '';

  // Se conservan las casillas marcadas al volver a dibujar (p. ej. al escanear otro libro).
  const marcados = new Set(seleccionEn(lista).codigos);
  lista.innerHTML = agrupado.length
    ? agrupado.map((l) => itemContenidoHtml(l, true)).join('')
    : '<li class="list-group-item text-muted small">La caja todavía está vacía.</li>';
  lista.querySelectorAll('.sel-libro').forEach((c) => { c.checked = marcados.has(c.dataset.codigo); });

  const barra = $('barra-contenido');
  if (!barra.firstElementChild) barra.innerHTML = barraSeleccionHtml();
  barra.classList.toggle('d-none', !agrupado.length);
  actualizarBarraSeleccion($('tarjeta-contenido'));
}

/** Saca de una vez todos los libros marcados de la caja en curso. */
async function sacarSeleccionDeCaja() {
  if (!app.caja) return;
  if (app.enviando) {
    toast('Esperá a que termine de sacarse el libro de la caja.', 'warning');
    return;
  }
  const codigos = await confirmarSacarSeleccion($('tarjeta-contenido'), app.caja);
  if (!codigos) return;
  if (!(await esperarCola())) return; // primero se guarda lo pendiente

  app.enviando = true;
  setFeedback('proceso', 'Sacando libros de la caja…', `${codigos.length} título(s)`);
  try {
    const r = await llamarServidor('quitarLibros', app.sesion.token, app.caja, codigos);
    const sacados = new Set(codigos);
    app.contenido = app.contenido.filter((l) => !sacados.has(l.valor));
    app.cantidad = r.cantidad;
    actualizarContador();
    renderContenido();
    setFeedback('neutral', `Se sacaron ${r.quitados} libro(s) (${r.cantidad}/${app.limite})`,
      r.cantidad ? 'Los demás libros siguen en la caja.' : 'La caja quedó vacía.');
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    destello('error');
    if (e.codigo === 'CAJA_CERRADA') {
      setFeedback('error', 'Caja cerrada', e.message);
      setTimeout(mostrarMenu, 1800);
      return;
    }
    setFeedback('error', 'No se pudieron sacar los libros', e.message);
    resincronizarCaja();
  } finally {
    app.enviando = false;
  }
}

/**
 * Saca un ejemplar de un libro de la caja en curso.
 * @param {string} valor               Código (o título) con el que se registró.
 * @param {boolean} pedirConfirmacion  false para "Deshacer" (ya es una acción explícita).
 */
async function sacarLibroDeCaja(valor, pedirConfirmacion) {
  if (!app.caja || !valor) return;
  if (app.enviando) {
    toast('Esperá a que termine de sacarse el libro de la caja.', 'warning');
    return;
  }

  const libro = app.contenido.slice().reverse().find((l) => l.valor === valor);
  const descripcion = (libro && libro.titulo) || valor;

  if (pedirConfirmacion) {
    const veces = vecesEnCaja(valor);
    const ok = await confirmar('Sacar libro',
      `¿Sacar <b>1 ejemplar</b> de <b>${escaparHtml(descripcion)}</b> de la caja <b>${escaparHtml(app.caja)}</b>?` +
      (veces > 1 ? `<div class="small text-body-secondary mt-2">Hay ${veces} ejemplares; quedarán ${veces - 1}.</div>` : ''),
      'Sacar', 'btn-danger');
    if (!ok) return;
  }
  if (!(await esperarCola())) return; // primero se guarda lo pendiente

  app.enviando = true;
  setFeedback('proceso', 'Sacando de la caja…', descripcion);
  try {
    const r = await llamarServidor('quitarLibro', app.sesion.token, app.caja, valor);

    // Se quita el último ejemplar cargado (igual que en el servidor).
    for (let i = app.contenido.length - 1; i >= 0; i--) {
      if (app.contenido[i].valor === valor) { app.contenido.splice(i, 1); break; }
    }
    app.cantidad = r.cantidad;
    actualizarContador();
    renderContenido();
    setFeedback('neutral', `Libro sacado de la caja (${r.cantidad}/${app.limite})`, descripcion);
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    destello('error');
    if (e.codigo === 'CAJA_CERRADA') {
      setFeedback('error', 'Caja cerrada', e.message);
      setTimeout(mostrarMenu, 1800);
      return;
    }
    setFeedback('error', 'No se pudo sacar el libro', e.message);
    resincronizarCaja();
  } finally {
    app.enviando = false;
  }
}

/**
 * "Deshacer" del último libro anotado. Si todavía no salió del celular se
 * borra de la cola sin ir al servidor; si ya se guardó (o está viajando), se saca.
 */
async function deshacerLectura(id) {
  if (!app.caja || !id) return;
  const libro = app.contenido.find((l) => l.id === id);
  if (!libro) return;

  const enCola = app.cola.some((l) => l.id === id);
  const viajando = app.colaEnviando && app.colaEnviando.has(id);
  if (enCola && !viajando) {
    quitarDeCola(new Set([id]));
    app.contenido = app.contenido.filter((l) => l.id !== id);
    app.cantidad--;
    actualizarContador();
    renderContenido();
    actualizarEstadoCola();
    setFeedback('neutral', `Libro sacado de la caja (${app.cantidad}/${app.limite})`, libro.titulo || libro.valor);
    return;
  }
  await sacarLibroDeCaja(libro.valor, false);
}

function onClickContenido(evento) {
  const boton = evento.target.closest('[data-quitar]');
  if (boton) sacarLibroDeCaja(boton.dataset.quitar, true);
}

/* ============================================================================
 *  REGISTRO DE LIBROS
 * ========================================================================== */

/**
 * Anota un libro en la caja en curso y lo deja en la cola de guardado. Es el punto común para escáner, código tipeado y
 * búsqueda por título. Antes de enviar avisa si el libro ya está en la caja o
 * si se supera el límite sugerido, y pide confirmación.
 * @param {{valor:string, titulo?:string, editorial?:string, origen:string}} libro
 * @return {Promise<boolean>} true si se anotó.
 */
async function ingresarLibro(libro) {
  if (!app.caja) return false;

  if (app.enviando) {
    setFeedback('proceso', 'Esperá un momento…', 'Se están sacando libros de la caja.');
    return false;
  }

  const descripcion = libro.titulo || libro.valor;

  // 1) Repetido en la misma caja.
  const veces = vecesEnCaja(libro.valor);
  if (veces > 0) {
    destello('alerta');
    setFeedback('alerta', 'Libro repetido en esta caja', descripcion);
    const ok = await confirmar(
      'Libro repetido',
      `<div class="alert alert-warning mb-2"><i class="bi bi-exclamation-triangle-fill"></i>
        <b>${escaparHtml(descripcion)}</b> ya está en la caja <b>${escaparHtml(app.caja)}</b>
        (${veces} ${veces === 1 ? 'vez' : 'veces'}).</div>¿Querés agregar otro ejemplar?`,
      'Agregar otro ejemplar', 'btn-warning'
    );
    if (!ok) {
      setFeedback('neutral', 'No se agregó el repetido', descripcion);
      return false;
    }
  }

  // 2) Límite sugerido (blando).
  if (app.cantidad >= app.limite) {
    destello('alerta');
    const ok = await confirmar(
      'Límite superado',
      `La caja <b>${escaparHtml(app.caja)}</b> ya tiene <b>${app.cantidad}</b> libro(s) y el límite sugerido es <b>${app.limite}</b>.<br><br>¿Agregar igual?`,
      'Agregar igual', 'btn-warning'
    );
    if (!ok) {
      setFeedback('neutral', 'Ingreso cancelado', 'Podés cerrar la caja con el botón de abajo.');
      return false;
    }
  }

  // 3) Se anota en el celular al instante y se guarda en segundo plano (cola).
  const lectura = {
    id: nuevoIdLectura(),
    caja: app.caja,
    valor: libro.valor,
    titulo: libro.titulo || '',
    editorial: libro.editorial || '',
    origen: libro.origen || '',
    edicion: app.edicion
  };
  app.contenido.push({
    id: lectura.id,
    pendiente: true,
    valor: libro.valor,
    titulo: libro.titulo,
    editorial: libro.editorial,
    origen: libro.origen,
    hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
  });
  app.cantidad++;
  encolarLectura(lectura);
  if (libro.origen === 'busqueda') sumarSinCodigo(libro);

  actualizarContador();
  renderContenido();

  const vecesAhora = veces + 1;
  if (vecesAhora > 1) {
    destello('alerta');
    setFeedback('alerta', `Anotado como repetido (×${vecesAhora}) · ${app.cantidad}/${app.limite}`, descripcion, lectura.id);
  } else if (app.cantidad > app.limite) {
    destello('alerta');
    setFeedback('alerta', `Anotado · supera el límite (${app.cantidad}/${app.limite})`, descripcion, lectura.id);
  } else {
    destello('exito');
    setFeedback('exito', `¡Anotado! (${app.cantidad}/${app.limite})`, descripcion, lectura.id);
  }

  // Sin await: el modal queda abierto (y la cámara sin leer) hasta que el operario elija.
  // Al editar una caja armada no se sugiere cerrarla.
  if (app.cantidad === app.limite && !app.edicion) sugerirCerrarCaja();
  return true;
}

/* ============================================================================
 *  COLA DE GUARDADO
 *  Los libros se anotan en el celular al instante y se mandan al servidor en
 *  segundo plano, en orden y en lotes. La cola también se guarda en el
 *  almacenamiento del celular para no perder nada si se cierra la página.
 *  Cada lectura lleva un id único: si un envío se reintenta (timeout, red) el
 *  servidor no la vuelve a escribir.
 * ========================================================================== */

/** Máximo de libros por envío. */
const LOTE_COLA = 25;
/** Espera entre reintentos cuando falla la red (ms): 2 s, 5 s, 10 s, 20 s y luego 30 s. */
const ESPERAS_REINTENTO_MS = [2000, 5000, 10000, 20000, 30000];

function nuevoIdLectura() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function claveCola() {
  return 'pe_cola_' + ((app.sesion && app.sesion.usuario) || '');
}

function guardarColaLocal() {
  try {
    if (app.cola.length || app.cierres.length) {
      localStorage.setItem(claveCola(), JSON.stringify({ lecturas: app.cola, cierres: app.cierres }));
    } else {
      localStorage.removeItem(claveCola());
    }
  } catch (e) { /* sin almacenamiento: la cola vive solo en memoria */ }
}

/** Al iniciar sesión: recupera libros y cierres que quedaron sin enviar (p. ej. se cerró la página). */
function cargarColaLocal() {
  let guardado = null;
  try { guardado = JSON.parse(localStorage.getItem(claveCola()) || 'null'); } catch (e) { /* dato corrupto */ }
  // Versiones anteriores guardaban solo la lista de lecturas.
  app.cola = Array.isArray(guardado) ? guardado : (guardado && guardado.lecturas) || [];
  app.cierres = (guardado && !Array.isArray(guardado) && guardado.cierres) || [];

  if (app.cola.length || app.cierres.length) {
    const partes = [];
    if (app.cola.length) partes.push(`${app.cola.length} libro(s) sin guardar`);
    if (app.cierres.length) partes.push(`${app.cierres.length} caja(s) sin cerrar`);
    toast(`De una sesión anterior quedaron ${partes.join(' y ')}. Enviándolos…`, 'info');
    procesarCola();
  }
  actualizarEstadoCola();
}

/**
 * Deja el cierre de una caja para cuando vuelva la conexión: se manda solo,
 * después de que se guarden todos sus libros pendientes.
 */
function encolarCierre(idCaja) {
  if (!app.cierres.includes(idCaja)) app.cierres.push(idCaja);
  guardarColaLocal();
  procesarCola();
}

/** Red, timeout o servidor ocupado: vale la pena reintentar. */
function esErrorReintentable(e) {
  return ['RED', 'TIMEOUT', 'SIN_CONEXION'].includes(e.codigo) || /ocupado/i.test(e.message || '');
}

function encolarLectura(lectura) {
  app.cola.push(lectura);
  guardarColaLocal();
  procesarCola();
}

/** Pendientes de una caja, o de todas con `null` (incluye los que están viajando). */
function pendientesDeCaja(idCaja) {
  return idCaja ? app.cola.filter((l) => l.caja === idCaja).length : app.cola.length;
}

/**
 * Manda lo próximo de la cola: primero los cierres de cajas cuyos libros ya
 * están todos guardados, si no, un lote de libros. Se llama sola mientras quede algo.
 */
async function procesarCola() {
  if (app.colaEnviando || (!app.cola.length && !app.cierres.length) || !app.sesion) {
    actualizarEstadoCola();
    return;
  }
  clearTimeout(app.colaTimer);
  app.colaTimer = null;

  const cierre = app.cierres.find((c) => !pendientesDeCaja(c));
  if (cierre) return procesarCierre(cierre);

  // Un lote es siempre de una sola caja (la primera de la cola).
  const caja = app.cola[0].caja;
  const lote = app.cola.filter((l) => l.caja === caja).slice(0, LOTE_COLA);
  app.colaEnviando = new Set(lote.map((l) => l.id));
  actualizarEstadoCola();

  try {
    const r = await llamarServidor('registrarLibros', app.sesion.token, caja,
      lote.map(({ id, valor, titulo, editorial, origen }) => ({ id, valor, titulo, editorial, origen })),
      lote.some((l) => l.edicion)); // edición de una caja armada (solo Admin)

    quitarDeCola(app.colaEnviando);
    app.colaReintentos = 0;
    app.colaSinConexion = false;

    if (app.caja === caja) {
      app.contenido.forEach((l) => { if (l.id && !app.cola.some((c) => c.id === l.id)) l.pendiente = false; });
      // El servidor manda la cantidad real guardada; se suman los que siguen en la cola.
      app.cantidad = r.cantidad + pendientesDeCaja(caja);
      app.limite = r.max || app.limite;
      $('contador-max').textContent = app.limite;
      actualizarContador(false);
      renderContenido();
    }
  } catch (e) {
    const enviados = app.colaEnviando;
    app.colaEnviando = null;
    if (manejarErrorSesion(e)) return; // la cola queda guardada para el próximo ingreso

    if (e.codigo === 'CAJA_CERRADA' || (e.codigo === 'SERVIDOR' && !/ocupado/i.test(e.message))) {
      // No se va a poder guardar reintentando: se avisa qué libros hay que volver a cargar.
      descartarLecturas(caja, enviados, e);
      return;
    }

    // Red, timeout o servidor ocupado: se reintenta solo (el id evita duplicados).
    programarReintento();
    return;
  } finally {
    if (app.colaEnviando) app.colaEnviando = null;
  }

  if (app.cola.length || app.cierres.length) procesarCola();
  else actualizarEstadoCola();
}

function programarReintento() {
  app.colaSinConexion = true;
  const espera = ESPERAS_REINTENTO_MS[Math.min(app.colaReintentos, ESPERAS_REINTENTO_MS.length - 1)];
  app.colaReintentos++;
  app.colaTimer = setTimeout(procesarCola, espera);
  actualizarEstadoCola();
}

/** Cierra en el servidor una caja que quedó con el cierre pendiente. */
async function procesarCierre(idCaja) {
  app.colaEnviando = new Set(['cierre:' + idCaja]);
  actualizarEstadoCola();
  try {
    const r = await llamarServidor('cerrarCaja', app.sesion.token, idCaja);
    app.cierres = app.cierres.filter((c) => c !== idCaja);
    guardarColaLocal();
    app.colaReintentos = 0;
    app.colaSinConexion = false;
    toast(r.yaEstabaCerrada
      ? `La caja ${idCaja} ya estaba cerrada por ${r.usuarioCierre || 'otro usuario'}.`
      : `Caja ${idCaja} cerrada (${r.cantidad} libros). Estaba pendiente por falta de conexión.`, 'success');
  } catch (e) {
    app.colaEnviando = null;
    if (manejarErrorSesion(e)) return; // el cierre queda guardado para el próximo ingreso
    if (esErrorReintentable(e)) {
      programarReintento();
      return;
    }
    // P. ej. la caja quedó vacía: no tiene sentido reintentar.
    app.cierres = app.cierres.filter((c) => c !== idCaja);
    guardarColaLocal();
    toast(`No se pudo cerrar la caja ${idCaja}: ${e.message}`, 'danger');
  } finally {
    app.colaEnviando = null;
  }

  if ($('pantalla-menu').classList.contains('activa')) cargarCajas();
  if (app.cola.length || app.cierres.length) procesarCola();
  else actualizarEstadoCola();
}

function quitarDeCola(ids) {
  app.cola = app.cola.filter((l) => !ids.has(l.id));
  guardarColaLocal();
}

/** Libros que el servidor rechazó: se sacan de la caja en pantalla y se avisa cuáles eran. */
function descartarLecturas(caja, ids, error) {
  const descartados = app.cola.filter((l) => ids.has(l.id));
  quitarDeCola(ids);

  if (app.caja === caja) {
    app.contenido = app.contenido.filter((l) => !ids.has(l.id));
    app.cantidad = Math.max(0, app.cantidad - descartados.length);
    actualizarContador(false);
    renderContenido();
  }
  actualizarEstadoCola();

  destello('error');
  const lista = '<ul class="mb-0">' + descartados.map((l) => `<li>${escaparHtml(l.titulo || l.valor)}</li>`).join('') + '</ul>';
  const cerrada = error.codigo === 'CAJA_CERRADA';
  confirmar('Libros sin guardar',
    `<div class="alert alert-danger py-2"><i class="bi bi-x-octagon-fill"></i> ${escaparHtml(error.message)}</div>` +
      `Estos ${descartados.length} libro(s) <b>no se guardaron</b> en la caja <b>${escaparHtml(caja)}</b>:${lista}` +
      (cerrada ? '<div class="mt-2">Cargalos en otra caja.</div>' : '<div class="mt-2">Volvé a escanearlos.</div>'),
    'Entendido', 'btn-primary', 'Cerrar'
  ).then(() => { if (cerrada && app.caja === caja) mostrarMenu(); });
}

/**
 * Espera a que se guarde todo lo pendiente de la caja en curso, mostrando el
 * progreso. Devuelve false si no se pudo (sin conexión), para no seguir.
 */
async function esperarCola(texto, caja = app.caja) {
  if (!pendientesDeCaja(caja)) return true;

  mostrarCargando((texto || 'Guardando') + ` ${pendientesDeCaja(caja)} libro(s) pendientes…`);
  try {
    let intentado = false;
    while (pendientesDeCaja(caja) && app.sesion) {
      if (!app.colaEnviando) {
        if (intentado && app.colaSinConexion) break; // falló un intento: no se bloquea al operario
        procesarCola(); // sin esperar el reintento programado
        intentado = true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    ocultarCargando();
  }

  const quedan = pendientesDeCaja(caja);
  if (quedan) {
    toast(`Todavía hay ${quedan} libro(s) sin guardar. Revisá la conexión; se siguen reintentando solos.`, 'warning');
    return false;
  }
  return true;
}

/** Indicador "Todo guardado / Guardando N… / Sin conexión" en la pantalla de caja. */
function actualizarEstadoCola() {
  const el = $('estado-guardado');
  if (!el) return;
  const n = app.caja ? pendientesDeCaja(app.caja) : app.cola.length;
  if (!n) {
    el.className = 'small text-success';
    el.innerHTML = '<i class="bi bi-cloud-check"></i> Todo guardado';
  } else if (app.colaSinConexion && !app.colaEnviando) {
    el.className = 'small text-danger fw-semibold';
    el.innerHTML = `<i class="bi bi-wifi-off"></i> ${n} sin guardar · reintentando…`;
  } else {
    el.className = 'small text-warning-emphasis fw-semibold';
    el.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Guardando ${n}…`;
  }
}

/**
 * Arma el contenido de la caja en curso con lo que devolvió el servidor más
 * los libros de la cola que todavía no se guardaron.
 */
function aplicarContenidoServidor(info) {
  const enCola = app.cola.filter((l) => l.caja === app.caja);
  app.contenido = (info.contenido || []).map((l) => completarDesdeCatalogo({
    valor: l.codigo, titulo: l.titulo, editorial: l.editorial, origen: 'previo', hora: ''
  })).concat(enCola.map((l) => ({
    id: l.id, pendiente: true, valor: l.valor, titulo: l.titulo, editorial: l.editorial, origen: 'cola', hora: ''
  })));
  app.cantidad = info.cantidad + enCola.length;
}

/** Vuelve a leer la cantidad real de libros de la caja desde el servidor. */
async function resincronizarCaja() {
  if (!app.caja) return;
  try {
    const info = await llamarServidor('abrirCaja', app.sesion.token, app.caja, app.edicion);
    const antes = app.cantidad;
    aplicarContenidoServidor(info);
    actualizarContador(false);
    renderContenido();
    if (app.cantidad !== antes) {
      toast('Contador actualizado desde el servidor: ' + app.cantidad + ' libro(s).', 'info');
    }
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    if (e.codigo === 'CAJA_CERRADA') {
      toast(e.message, 'warning');
      mostrarMenu();
    }
  }
}

/**
 * Valida un ISBN/ISSN, lo busca en el catálogo y lo registra.
 * Si no está en el catálogo, pide confirmación.
 */
async function procesarCodigo(texto, origen) {
  // Antes de validar: un código mal impreso puede no pasar el dígito verificador.
  const limpio = String(texto || '').replace(/[\s-]/g, '').toUpperCase();
  if (app.codigosBloqueados.has(limpio)) {
    avisarCodigoBloqueado(limpio);
    return false;
  }

  const v = validarCodigo(texto);
  if (!v) {
    destello('error');
    setFeedback('error', 'Código no válido', `"${String(texto).trim()}" no es un ISBN (10/13 dígitos) ni un ISSN (8) válido.`);
    return false;
  }

  const item = buscarIsbnEnCatalogo(v.codigo);
  if (item) {
    return ingresarLibro({ valor: item.isbn, titulo: item.titulo, editorial: item.editorial, origen });
  }

  // No figura en el catálogo (o el catálogo aún no cargó): confirmar.
  const etiqueta = escaparHtml(etiquetaCodigo(v.codigo));
  const motivo = app.catalogoListo
    ? `El <b>${etiqueta}</b> no figura en el catálogo oficial del programa.`
    : `El catálogo todavía no terminó de cargar, no se pudo verificar el <b>${etiqueta}</b>.`;

  const ok = await confirmar(v.tipo + ' no encontrado', motivo + '<br><br>¿Querés registrarlo igual?', 'Registrar igual', 'btn-warning');
  if (ok) return ingresarLibro({ valor: v.codigo, titulo: '', editorial: '', origen });

  setFeedback('neutral', 'Ingreso cancelado', 'Probá de nuevo o buscá el libro por título.');
  return false;
}

/**
 * El código está impreso por error en algún libro (y puede ser el de otro libro
 * del catálogo): no se registra nada y se pasa al buscador para elegir por título.
 */
function avisarCodigoBloqueado(codigo) {
  const libros = [buscarIsbnEnCatalogo(codigo), ...app.codigosBloqueados.get(codigo)]
    .filter((l, i, todos) => l && todos.indexOf(l) === i);
  const titulos = libros.map((l) => '«' + (l.titulo || l.isbn) + '»');
  const lista = titulos.length > 1 ? titulos.slice(0, -1).join(', ') + ' y ' + titulos[titulos.length - 1] : titulos[0];

  destello('alerta');
  setFeedback('alerta', 'Código bloqueado: buscá el libro por título',
    `El código ${etiquetaCodigo(codigo)} está impreso en ${lista}. Escribí el título del libro que tenés en la mano.`);
  // Fuera del procesamiento de la lectura, para no pelear con la pausa de la cámara.
  setTimeout(() => {
    $('input-busqueda').value = '';
    $('resultados-busqueda').innerHTML = '';
    $('modo-busqueda').checked = true;
    cambiarModo('busqueda');
  }, 0);
}

/**
 * Enter en el buscador: si lo escrito es un ISBN/ISSN (tipeado a mano o con un
 * lector de código de barras USB/Bluetooth, que "escribe" el código y Enter),
 * se registra directo. Si hay un único resultado de búsqueda, se elige ese.
 */
async function onEnterBusqueda(evento) {
  if (evento.key !== 'Enter') return;
  evento.preventDefault();
  const input = $('input-busqueda');
  const texto = input.value.trim();
  if (!texto) return;

  if (/^[\d\s-]+[Xx]?$/.test(texto)) {
    const ok = await procesarCodigo(texto, 'escaner');
    if (ok || validarCodigo(texto)) {
      input.value = '';
      $('resultados-busqueda').innerHTML = '';
      actualizarInfoBusqueda();
    }
    input.focus();
    return;
  }

  const items = $('resultados-busqueda')._items || [];
  if (items.length === 1) $('resultados-busqueda').querySelector('[data-idx]').click();
}

/* ============================================================================
 *  CIERRE DE CAJA (automático y manual)
 * ========================================================================== */

/**
 * Pantalla de confirmación luego de cerrar la caja manualmente.
 * @param {boolean=} pendiente  Sin conexión: el cierre quedó en la cola.
 */
async function finalizarCaja(pendiente = false) {
  const idCaja = app.caja;
  const cantidad = app.cantidad;

  $('completada-titulo').textContent = pendiente ? 'Caja lista para cerrar' : 'Caja cerrada';
  $('completada-detalle').textContent = pendiente
    ? `Caja ${idCaja} · ${cantidad} libro(s). No hay conexión: se cierra sola cuando vuelva.`
    : `Caja ${idCaja} · ${cantidad} libro(s)`;
  $('overlay-completada').classList.add('visible');
  beep(880, 0.12); setTimeout(() => beep(1320, 0.18), 140);
  vibrar([100, 50, 100, 50, 200]);

  app.caja = null;
  const desdeEdicion = app.edicion; // Admin: se vuelve al panel con la caja consultada

  setTimeout(() => {
    $('overlay-completada').classList.remove('visible');
    if (!app.sesion) return;
    if (desdeEdicion) salirDeEdicion(idCaja);
    else mostrarMenu();
  }, 2500);
}

async function onCerrarManual() {
  if (!app.caja) return;
  if (app.enviando || app.leyendoFoto) {
    toast('Esperá a que termine de sacarse el libro de la caja.', 'warning');
    return;
  }
  if (app.cantidad === 0) {
    toast('La caja no tiene libros. Si te equivocaste de caja, usá "Volver al menú".', 'warning');
    return;
  }

  const ok = await confirmar(
    'Cerrar caja',
    `Vas a cerrar la caja <b>${escaparHtml(app.caja)}</b> con <b>${app.cantidad}</b> libro(s) (límite sugerido: ${app.limite}).` +
      avisoRepetidosHtml() +
      'Esta acción no se puede deshacer desde la app.',
    'Cerrar caja',
    'btn-danger'
  );
  if (ok) await cerrarCajaActual();
}

/** Aviso (o salto de línea) para los modales de cierre según haya repetidos en la caja. */
function avisoRepetidosHtml() {
  return app.contenido.length !== new Set(app.contenido.map((l) => l.valor)).size
    ? '<div class="alert alert-warning py-2 my-2"><i class="bi bi-exclamation-triangle-fill"></i> La caja tiene libros repetidos.</div>'
    : '<br>';
}

/**
 * Al llegar justo al límite sugerido se ofrece cerrar la caja ahí mismo.
 * Mientras el modal está abierto la cámara no lee (app.modalAbierto).
 */
async function sugerirCerrarCaja() {
  const ok = await confirmar(
    'Caja completa',
    `La caja <b>${escaparHtml(app.caja)}</b> llegó al límite sugerido de <b>${app.limite}</b> libros.` +
      avisoRepetidosHtml() +
      '¿La cerrás ahora? Si cerrás, no se puede deshacer desde la app.',
    'Cerrar caja',
    'btn-danger',
    'Seguir escaneando'
  );
  if (ok) await cerrarCajaActual();
}

async function cerrarCajaActual() {
  if (!app.caja) return;
  const idCaja = app.caja;

  // Sin conexión: el cierre queda en la cola y se manda solo cuando vuelva,
  // después de que se guarden los libros pendientes de la caja.
  if (!(await esperarCola('Antes de cerrar: guardando'))) {
    if (!app.sesion) return; // venció la sesión: ya se volvió al login
    encolarCierre(idCaja);
    await finalizarCaja(true);
    return;
  }

  mostrarCargando('Cerrando caja…');
  try {
    const r = await llamarServidor('cerrarCaja', app.sesion.token, idCaja);
    app.cantidad = r.cantidad;
    ocultarCargando();
    if (r.yaEstabaCerrada) toast('La caja ya había sido cerrada por ' + (r.usuarioCierre || 'otro usuario') + '.', 'info');
    await finalizarCaja();
  } catch (e) {
    ocultarCargando();
    if (manejarErrorSesion(e)) return;
    if (esErrorReintentable(e)) {
      encolarCierre(idCaja);
      await finalizarCaja(true);
      return;
    }
    toast('No se pudo cerrar la caja: ' + e.message, 'danger');
  }
}

async function onVolverMenu() {
  if (app.enviando || app.leyendoFoto) {
    toast('Esperá a que termine de sacarse el libro de la caja.', 'warning');
    return;
  }
  if (app.edicion) return terminarEdicion();
  const ok = app.cantidad > 0
    ? await confirmar('Volver al menú',
        `La caja <b>${escaparHtml(app.caja)}</b> quedará <b>disponible</b> con ${app.cantidad} libro(s). Podés retomarla después.`,
        'Volver', 'btn-primary')
    : true;
  if (!ok) return;
  // Se intenta guardar lo pendiente; si no hay conexión se sigue reintentando desde el menú.
  await esperarCola();
  mostrarMenu();
}

/* ============================================================================
 *  EDICIÓN DE CAJAS ARMADAS (solo Admin)
 *  Usa la misma pantalla de carga: se escanea o busca para agregar y se sacan
 *  libros desde la lista. La caja conserva su estado (si estaba cerrada, sigue
 *  cerrada) y al terminar se vuelve al panel con la caja consultada.
 * ========================================================================== */

/** Panel admin → "Editar contenido" de la caja consultada. */
function onEditarCajaConsultada() {
  if (!app.sesion || app.sesion.rol !== 'Admin' || !app.cajaConsultada) return;
  cargarCatalogo(); // el panel no lo necesita, pero para agregar libros sí
  abrirCajaSeleccionada(app.cajaConsultada, true);
}

/** Muestra u oculta lo propio del modo edición en la pantalla de caja. */
function aplicarModoEdicion(estado) {
  const edicion = !!app.edicion;
  $('aviso-edicion').classList.toggle('d-none', !edicion);
  if (edicion) {
    $('aviso-edicion-detalle').textContent = estado === 'Cerrada'
      ? 'La caja está cerrada y sigue cerrada: los cambios se guardan igual.'
      : 'La caja está abierta: los operarios también pueden seguir cargándola.';
  }
  // Una caja abierta se puede cerrar también desde la edición; una cerrada, no hace falta.
  const cerrada = edicion && estado === 'Cerrada';
  $('btn-cerrar-manual').classList.toggle('d-none', cerrada);
  $('btn-volver-menu').innerHTML = edicion
    ? '<i class="bi bi-check2-circle"></i> Terminar edición y volver al panel' +
      (cerrada ? '' : ' (la caja queda abierta)')
    : '<i class="bi bi-arrow-left"></i> Volver al menú (la caja queda abierta)';
  $('btn-volver-menu').className = !edicion ? 'btn btn-link text-secondary'
    : cerrada ? 'btn btn-primary btn-lg' : 'btn btn-outline-primary';
}

async function terminarEdicion() {
  const idCaja = app.caja;
  if (!(await esperarCola())) return; // sin conexión: se queda editando hasta que se guarde
  salirDeEdicion(idCaja);
  toast('Edición de la caja ' + idCaja + ' terminada.', 'success');
}

/** Vuelve al panel admin mostrando la caja que se estaba editando. */
function salirDeEdicion(idCaja) {
  detenerCamara();
  app.caja = null;
  app.cantidad = 0;
  app.contenido = [];
  app.edicion = false;
  aplicarModoEdicion();

  irAlPanel();
  $('input-consulta-caja').value = idCaja;
  consultarCaja(idCaja);
}

/* ============================================================================
 *  ESCANEO CONTINUO CON LA CÁMARA EN VIVO (html5-qrcode)
 *  Cada código leído se registra solo; mientras se procesa (o hay un modal
 *  abierto, p. ej. por un repetido) la cámara queda en pausa. El mismo código
 *  no se vuelve a registrar mientras siga frente a la cámara.
 * ========================================================================== */

/** Tiempo que el mismo código tiene que dejar de verse para volver a leerse. */
const PAUSA_MISMO_CODIGO_MS = 2500;

function formatosEscaner() {
  const F = Html5QrcodeSupportedFormats;
  return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39];
}

/** La cámara debe estar prendida solo en la pantalla de caja, modo escáner y pestaña visible. */
function camaraDebeEstarActiva() {
  return !!app.caja &&
    $('modo-escaner').checked &&
    $('pantalla-caja').classList.contains('activa') &&
    document.visibilityState === 'visible';
}

async function iniciarCamara() {
  if (app.camaraActiva || app.camaraIniciando || !camaraDebeEstarActiva()) return;
  if (typeof Html5Qrcode === 'undefined') {
    estadoCamara('error', 'No se pudo cargar el lector de códigos. Revisá la conexión o buscá por título.');
    return;
  }

  app.camaraIniciando = true;
  estadoCamara('cargando', 'Iniciando cámara…');
  try {
    if (!app.camara) {
      app.camara = new Html5Qrcode('lector-vivo', {
        formatsToSupport: formatosEscaner(),
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false
      });
    }
    // Si antes se encontró una cámara trasera con linterna, se usa esa directamente.
    const idGuardado = camaraConLinternaGuardada();
    try {
      await arrancarCamara(idGuardado);
    } catch (e) {
      if (!idGuardado) throw e;
      guardarCamaraConLinterna(null); // esa cámara ya no existe o no responde
      await arrancarCamara(null);
    }
    app.camaraActiva = true;
    estadoCamara('ok');
    configurarLinterna();

    // Si mientras arrancaba el usuario cambió de modo o salió de la caja.
    if (!camaraDebeEstarActiva()) await detenerCamara();
  } catch (e) {
    const nombre = (e && e.name) || String(e);
    const mensaje = /NotAllowed|Permission/i.test(nombre)
      ? 'No hay permiso para usar la cámara. Habilitalo desde el candado de la barra de direcciones y tocá "Activar cámara".'
      : /NotFound|Overconstrained/i.test(nombre)
        ? 'No se encontró una cámara en este dispositivo.'
        : 'No se pudo iniciar la cámara. Probá de nuevo o usá la búsqueda por título.';
    estadoCamara('error', mensaje);
  } finally {
    app.camaraIniciando = false;
  }
}

/**
 * Arranca html5-qrcode. Con `deviceId` usa esa cámara puntual; si no, la trasera por defecto.
 * (html5-qrcode usa `videoConstraints` en lugar del primer argumento cuando está presente.)
 */
async function arrancarCamara(deviceId) {
  const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const videoConstraints = deviceId
    ? { ...base, deviceId: { exact: deviceId } }
    : { ...base, facingMode: { ideal: 'environment' } };
  await app.camara.start(
    { facingMode: 'environment' },
    {
      fps: 12,
      // Recuadro ancho y bajo: el formato de un código de barras.
      qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(h * 0.55, w * 0.45)) }),
      videoConstraints
    },
    onLecturaCamara,
    () => { /* frame sin código: normal */ }
  );
}

async function detenerCamara() {
  if (!app.camara || !app.camaraActiva) return;
  app.camaraActiva = false;
  app.linterna = false;
  actualizarBotonLinterna();
  $('btn-linterna').classList.add('d-none');
  try { await app.camara.stop(); } catch (e) { /* ya estaba detenida */ }
}

/**
 * @param {'cargando'|'ok'|'error'} tipo
 */
function estadoCamara(tipo, texto) {
  const capa = $('camara-estado');
  capa.classList.toggle('oculto', tipo === 'ok');
  capa.querySelector('.spinner-border').classList.toggle('d-none', tipo !== 'cargando');
  $('btn-reintentar-camara').classList.toggle('d-none', tipo !== 'error');
  $('camara-estado-texto').textContent = texto || '';
}

async function onLecturaCamara(texto) {
  const ahora = Date.now();
  // No se lee mientras hay otro proceso o un aviso abierto (p. ej. "¿Sacar libro?").
  if (app.procesandoLectura || app.enviando || app.modalAbierto) return;

  // El mismo libro sigue frente a la cámara: no se repite.
  if (texto === app.ultimaLectura && ahora - app.ultimaLecturaTs < PAUSA_MISMO_CODIGO_MS) {
    app.ultimaLecturaTs = ahora;
    return;
  }

  app.ultimaLectura = texto;
  app.ultimaLecturaTs = ahora;
  app.procesandoLectura = true;
  $('visor-camara').classList.add('leyendo');
  try { app.camara.pause(true); } catch (e) { /* no estaba escaneando */ }

  try {
    await procesarCodigo(texto, 'escaner');
  } finally {
    app.ultimaLecturaTs = Date.now();
    $('visor-camara').classList.remove('leyendo');
    try { if (app.camaraActiva) app.camara.resume(); } catch (e) { /* no estaba en pausa */ }
    app.procesandoLectura = false;
  }
}

/* ----------------------------------------------------------------------------
 *  LINTERNA
 *  Muchos celulares tienen varias cámaras traseras y el navegador elige una
 *  (gran angular, macro…) que no tiene flash. Además, en varios Android las
 *  capacidades del video recién aparecen un momento después de arrancar.
 *  Por eso el botón se muestra siempre y, si la cámara actual no tiene linterna,
 *  se prueba con las otras cámaras traseras y se recuerda la que sí la tiene.
 * -------------------------------------------------------------------------- */

const CLAVE_CAMARA_LINTERNA = 'pe_camara_linterna';

function camaraConLinternaGuardada() {
  try { return localStorage.getItem(CLAVE_CAMARA_LINTERNA) || null; } catch (e) { return null; }
}

function guardarCamaraConLinterna(id) {
  try {
    if (id) localStorage.setItem(CLAVE_CAMARA_LINTERNA, id);
    else localStorage.removeItem(CLAVE_CAMARA_LINTERNA);
  } catch (e) { /* sin almacenamiento */ }
}

/** Pista de video que está usando la cámara en vivo. */
function pistaVideo() {
  const video = document.querySelector('#lector-vivo video');
  const stream = video && video.srcObject;
  return (stream && stream.getVideoTracks && stream.getVideoTracks()[0]) || null;
}

/** ¿La pista soporta linterna? Reintenta un rato porque algunos Android la informan tarde. */
async function pistaTieneLinterna(intentos = 4) {
  for (let i = 0; i < intentos; i++) {
    const pista = pistaVideo();
    if (pista && typeof pista.getCapabilities === 'function') {
      const cap = pista.getCapabilities() || {};
      if (cap.torch) return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function aplicarLinterna(prender) {
  const pista = pistaVideo();
  if (!pista) throw new Error('sin cámara');
  try {
    await pista.applyConstraints({ advanced: [{ torch: prender }] });
  } catch (e) {
    await pista.applyConstraints({ torch: prender }); // sintaxis alternativa de algunos navegadores
  }
}

function actualizarBotonLinterna() {
  const btn = $('btn-linterna');
  btn.classList.toggle('btn-warning', app.linterna);
  btn.classList.toggle('btn-dark', !app.linterna);
  btn.setAttribute('aria-pressed', String(app.linterna));
}

/** Muestra el botón de linterna siempre que la cámara esté andando. */
function configurarLinterna() {
  app.linterna = false;
  actualizarBotonLinterna();
  $('btn-linterna').classList.remove('d-none');
}

/** Cámaras traseras distintas de la actual, para buscar una que tenga flash. */
async function otrasCamarasTraseras() {
  const pista = pistaVideo();
  const actual = pista && pista.getSettings ? pista.getSettings().deviceId : null;
  let camaras = [];
  try { camaras = await Html5Qrcode.getCameras(); } catch (e) { return []; }
  const otras = camaras.filter((c) => c.id !== actual);
  const traseras = otras.filter((c) => /back|rear|trasera|posterior|environment|0, facing back/i.test(c.label));
  return traseras.length ? traseras : otras;
}

/** Recorre las otras cámaras traseras hasta dar con una que tenga linterna. */
async function buscarCamaraConLinterna() {
  const candidatas = await otrasCamarasTraseras();
  for (const cam of candidatas) {
    if (!app.camaraActiva) return false; // el operario salió de la pantalla mientras se buscaba
    try { await app.camara.stop(); } catch (e) { /* ya estaba detenida */ }
    try {
      await arrancarCamara(cam.id);
      if (await pistaTieneLinterna()) {
        guardarCamaraConLinterna(cam.id);
        return true;
      }
    } catch (e) { /* esa cámara no arrancó: se prueba la siguiente */ }
  }
  // Ninguna tiene linterna: se vuelve a la cámara por defecto.
  try { await app.camara.stop(); } catch (e) { /* ya estaba detenida */ }
  if (app.camaraActiva) await arrancarCamara(null);
  return false;
}

async function onLinterna() {
  if (!app.camaraActiva || app.buscandoLinterna) return;
  const btn = $('btn-linterna');

  if (app.linterna) {
    try { await aplicarLinterna(false); } catch (e) { /* se apagó sola */ }
    app.linterna = false;
    actualizarBotonLinterna();
    return;
  }

  app.buscandoLinterna = true;
  btn.disabled = true;
  try {
    let soportada = await pistaTieneLinterna();
    if (!soportada) {
      estadoCamara('cargando', 'Buscando una cámara con linterna…');
      soportada = await buscarCamaraConLinterna();
      estadoCamara('ok');
    }
    if (!soportada) {
      toast('Este celular no deja prender la linterna desde el navegador. ' +
            'Con poca luz usá "Usar foto": la cámara del celular sí tiene flash.', 'warning');
      return;
    }
    await aplicarLinterna(true);
    app.linterna = true;
    actualizarBotonLinterna();
  } catch (e) {
    if (pistaVideo()) {
      estadoCamara('ok');
    } else {
      // La cámara quedó apagada al probar otras: se ofrece reactivarla.
      app.camaraActiva = false;
      btn.classList.add('d-none');
      estadoCamara('error', 'Se apagó la cámara al buscar la linterna. Tocá "Activar cámara".');
    }
    toast('No se pudo prender la linterna. Probá con "Usar foto".', 'warning');
  } finally {
    app.buscandoLinterna = false;
    btn.disabled = false;
  }
}

function onVisibilidad() {
  if (document.visibilityState === 'hidden') detenerCamara();
  else if (camaraDebeEstarActiva()) iniciarCamara();
}

/* ============================================================================
 *  ESCANEO POR FOTO (respaldo si la cámara en vivo no funciona)
 *  Abre la cámara nativa del celular (<input type="file" capture>) y decodifica la foto.
 * ========================================================================== */

async function onFotoSeleccionada(evento) {
  const input = evento.target;
  const archivo = input.files && input.files[0];
  input.value = ''; // permite volver a sacar/elegir otra foto

  if (!archivo || !app.caja) return;
  if (app.enviando || app.leyendoFoto) {
    toast('Esperá a que termine de guardarse el libro anterior.', 'warning');
    return;
  }
  if (typeof Html5Qrcode === 'undefined') {
    setFeedback('error', 'Escáner no disponible', 'No se pudo cargar la librería. Revisá la conexión o buscá por título.');
    return;
  }

  app.leyendoFoto = true;
  estadoBotonFoto(true);
  setFeedback('proceso', 'Leyendo el código…', 'Analizando la foto.');

  let codigo = null;
  try {
    codigo = await leerCodigoDeFoto(archivo);
  } catch (e) {
    destello('error');
    setFeedback('error', 'No se pudo leer el código',
      'Sacá otra foto más cerca, enfocada y con buena luz, o buscá el libro por título.');
    return;
  } finally {
    app.leyendoFoto = false;
    estadoBotonFoto(false);
  }

  await procesarCodigo(codigo, 'escaner');
}

/** Intenta decodificar primero una versión reducida (rápida) y luego la original. */
async function leerCodigoDeFoto(archivo) {
  if (!app.lectorFoto) {
    const F = Html5QrcodeSupportedFormats;
    app.lectorFoto = new Html5Qrcode('lector-archivo', {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false
    });
  }

  try {
    const reducida = await reducirImagen(archivo, LADO_MAX_FOTO_PX);
    return await app.lectorFoto.scanFile(reducida, false);
  } catch (e) {
    return await app.lectorFoto.scanFile(archivo, false);
  }
}

/** Reduce la foto a `ladoMax` px (las fotos de celular de 12 MP son lentas de procesar). */
function reducirImagen(archivo, ladoMax) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, ladoMax / Math.max(img.width, img.height));
      if (escala === 1) { URL.revokeObjectURL(url); resolve(archivo); return; }

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);

      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('No se pudo procesar la foto')); return; }
        resolve(new File([blob], 'foto.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.92);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir la foto')); };
    img.src = url;
  });
}

function estadoBotonFoto(cargando) {
  const btn = $('btn-foto');
  btn.classList.toggle('disabled', cargando);
  btn.innerHTML = cargando
    ? '<span class="spinner-border spinner-border-sm me-2"></span> Leyendo código…'
    : '<i class="bi bi-camera"></i> ¿No anda la cámara en vivo? Usar foto';
}

/* ============================================================================
 *  TEMA CLARO / OSCURO
 *  Por defecto sigue al sistema; si el usuario lo cambia, se recuerda.
 * ========================================================================== */

function preferenciaTema() {
  try { return localStorage.getItem('pe_tema') || 'auto'; } catch (e) { return 'auto'; }
}

function aplicarTema(tema) {
  const oscuro = tema === 'dark' ||
    (tema === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-bs-theme', oscuro ? 'dark' : 'light');
  document.querySelectorAll('.btn-tema').forEach((b) => {
    b.innerHTML = oscuro ? '<i class="bi bi-sun"></i>' : '<i class="bi bi-moon-stars"></i>';
    b.title = oscuro ? 'Pasar a modo claro' : 'Pasar a modo oscuro';
  });
  document.querySelector('meta[name="theme-color"]').setAttribute('content', oscuro ? '#073763' : '#0b5394');
}

function onCambiarTema() {
  const oscuro = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const nuevo = oscuro ? 'light' : 'dark';
  try { localStorage.setItem('pe_tema', nuevo); } catch (e) { /* sin almacenamiento */ }
  aplicarTema(nuevo);
}


/* ============================================================================
 *  LIBROS POR CAJA
 *  Una tarjeta por libro con en cuántas cajas está (* = repetido en alguna).
 *  Al tocarla se ve en qué cajas está y, abajo, en cuáles no. Tocando una caja
 *  se cambia un libro por otro: la caja conserva su cantidad y su estado (si
 *  estaba cerrada, sigue cerrada). Lo pueden usar Operarios y Admin.
 * ========================================================================== */

/** Valor del filtro de tipo para los libros sin Tipo en el catálogo. */
const SIN_TIPO = '__sin_tipo__';

function irALibros() {
  app.librosVolverA = document.querySelector('.pantalla.activa').id;
  detenerAutoRefrescoAdmin();
  cargarCatalogo(); // para buscar el libro que entra en un cambio
  mostrarPantalla('pantalla-libros');
  cargarResumenLibros();
}

function volverDeLibros() {
  if (app.librosVolverA === 'pantalla-admin') irAlPanel();
  else mostrarMenu();
}

async function cargarResumenLibros() {
  const btn = $('btn-libros-actualizar');
  btn.disabled = true;
  if (!app.resumen) $('libros-resumen').textContent = 'Cargando…';
  try {
    const r = await llamarServidor('getResumenLibros', app.sesion.token);
    app.resumen = r;
    app.limite = r.limite || app.limite;
    app.resumenCajas = new Map(r.cajas.map((c) => [c.id, c]));
    app.resumenLibros = new Map(r.libros.map((l) => [l.codigo, l]));
    actualizarFiltroTipos();
    renderLibros();
    if ($('pantalla-libro').classList.contains('activa')) renderLibroDetalle();
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    $('libros-resumen').textContent = 'No se pudo cargar el listado.';
    toast('No se pudo cargar el listado de libros: ' + e.message, 'danger');
  } finally {
    btn.disabled = false;
  }
}

function actualizarFiltroTipos() {
  const select = $('libros-tipo');
  const actual = select.value;
  const tipos = [...new Set(app.resumen.libros.map((l) => l.tipo || SIN_TIPO))]
    .sort((a, b) => (a === SIN_TIPO) - (b === SIN_TIPO) || a.localeCompare(b, 'es'));
  select.innerHTML = '<option value="">Todos los tipos</option>' + tipos.map((t) =>
    `<option value="${escaparHtml(t)}">${escaparHtml(t === SIN_TIPO ? 'Sin tipo' : t)}</option>`).join('');
  select.value = tipos.includes(actual) ? actual : '';
  select.classList.toggle('d-none', tipos.length < 2);
}

function esAudiolibro(tipo) {
  return /audio/i.test(tipo || '');
}

function badgeTipo(tipo) {
  if (!tipo) return '';
  return esAudiolibro(tipo)
    ? `<span class="badge text-bg-info"><i class="bi bi-headphones"></i> ${escaparHtml(tipo)}</span>`
    : `<span class="badge text-bg-secondary"><i class="bi bi-book"></i> ${escaparHtml(tipo)}</span>`;
}

/** "🎧 7 · Texto 13" según el Tipo de los libros de una caja (vacío si no hay tipos cargados). */
function mezclaTiposHtml(tipos) {
  const entradas = Object.entries(tipos || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entradas.some(([t]) => t)) return '';
  return entradas.map(([t, n]) => esAudiolibro(t)
    ? `<span title="${escaparHtml(t)}"><i class="bi bi-headphones"></i> ${n}</span>`
    : `<span>${escaparHtml(t || 'Sin tipo')} ${n}</span>`).join(' · ');
}

function renderLibros() {
  if (!app.resumen) return;
  const palabras = normalizarTexto($('libros-buscar').value).split(' ').filter(Boolean);
  const tipo = $('libros-tipo').value;
  const soloRepetidos = $('libros-solo-repetidos').checked;
  const orden = $('libros-orden').value;

  const lista = app.resumen.libros.filter((l) => {
    if (soloRepetidos && !l.cajas.some(([, v]) => v > 1)) return false;
    if (tipo && (l.tipo || SIN_TIPO) !== tipo) return false;
    const texto = normalizarTexto(l.titulo + ' ' + l.editorial) + ' ' + l.codigo.toLowerCase();
    return palabras.every((p) => texto.includes(p));
  });
  const porTitulo = (a, b) => (a.titulo || a.codigo).localeCompare(b.titulo || b.codigo, 'es');
  lista.sort((a, b) => orden === 'titulo' ? porTitulo(a, b)
    : (orden === 'menos' ? a.cajas.length - b.cajas.length : b.cajas.length - a.cajas.length) || porTitulo(a, b));

  const total = app.resumen.libros.length;
  $('libros-resumen').textContent = (lista.length === total
    ? `${total} título(s).`
    : `${lista.length} de ${total} título(s).`) + ' Tocá uno para ver sus cajas.';
  $('grilla-libros').innerHTML = lista.length
    ? lista.map(tarjetaLibroHtml).join('')
    : '<div class="text-body-secondary small" style="grid-column: 1 / -1;">No hay libros que coincidan.</div>';
}

/**
 * Ejemplares repartidos en cajas contra los comprados (columna Comprados del
 * Catalogo), o null si no se cargó cuántos se compraron.
 * @return {{clase:'completo'|'sobran'|'excedido', texto:string}|null}
 */
function estadoComprados(l) {
  if (l.comprados == null) return null;
  const repartidos = l.cajas.reduce((s, [, v]) => s + v, 0);
  const dif = l.comprados - repartidos;
  return {
    clase: dif === 0 ? 'completo' : dif > 0 ? 'sobran' : 'excedido',
    texto: `${repartidos} de ${l.comprados}` + (dif > 0 ? ` · sobran ${dif}` : dif < 0 ? ` · ${-dif} de más` : '')
  };
}

function tarjetaLibroHtml(l) {
  const ejemplares = l.cajas.reduce((s, [, v]) => s + v, 0);
  const repetido = l.cajas.some(([, v]) => v > 1);
  const comprados = estadoComprados(l);
  return `
    <button type="button" class="tarjeta-libro ${repetido ? 'con-repetido' : ''} ${comprados ? 'estado-' + comprados.clase : ''}"
            data-libro="${escaparHtml(l.codigo)}">
      <span class="tl-titulo">${escaparHtml(l.titulo || l.codigo)}</span>
      ${l.editorial ? `<span class="small text-body-secondary text-truncate">${escaparHtml(l.editorial)}</span>` : ''}
      <span class="mt-auto pt-1">${badgeTipo(l.tipo)}</span>
      <span class="d-flex align-items-baseline gap-1">
        <span class="tl-cajas">${l.cajas.length}${repetido ? '<span class="asterisco">*</span>' : ''}</span>
        <span class="small text-body-secondary">${l.cajas.length === 1 ? 'caja' : 'cajas'}${!comprados && ejemplares !== l.cajas.length ? ` · ${ejemplares} ej.` : ''}</span>
      </span>
      ${comprados ? `<span class="small fw-semibold tl-comprados">${comprados.texto}</span>` : ''}
    </button>`;
}

function onClickLibro(evento) {
  const boton = evento.target.closest('[data-libro]');
  const libro = boton && app.resumenLibros.get(boton.dataset.libro);
  if (!libro) return;
  app.libroSel = libro;
  app.intercambio = null;
  mostrarPantalla('pantalla-libro');
  renderLibroDetalle();
}

/** El libro elegido con sus datos al día (si lo sacaron de todas las cajas, sin cajas). */
function libroActual() {
  return app.resumenLibros.get(app.libroSel.codigo) || Object.assign({}, app.libroSel, { cajas: [] });
}

/** Ítem del catálogo de un valor registrado (código, o título si no tiene código). */
function itemCatalogoDe(valor) {
  return buscarIsbnEnCatalogo(valor) || app.catalogo.find((i) => !i.isbn && i.titulo === valor) || null;
}

function renderLibroDetalle() {
  if (!app.libroSel || !app.resumen) return;
  if (app.intercambio) { renderIntercambio(); return; }

  const l = libroActual();
  const veces = new Map(l.cajas);
  const item = itemCatalogoDe(l.codigo);
  const tipo = l.tipo || (item && item.tipo) || '';
  const ejemplares = l.cajas.reduce((s, [, v]) => s + v, 0);
  const repetidas = l.cajas.filter(([, v]) => v > 1).length;
  const comprados = estadoComprados(l);
  const claseComprados = { completo: 'text-bg-success', sobran: 'text-bg-warning', excedido: 'text-bg-danger' };
  const porId = (a, b) => a.id.localeCompare(b.id, 'es', { numeric: true });

  const esta = app.resumen.cajas.filter((c) => veces.has(c.id))
    .sort((a, b) => veces.get(b.id) - veces.get(a.id) || porId(a, b));
  // Primero las que tienen menos libros de su mismo tipo: las mejores para mechar.
  const mismoTipo = (c) => c.tipos[tipo] || 0;
  const noEsta = app.resumen.cajas.filter((c) => !veces.has(c.id))
    .sort((a, b) => mismoTipo(a) - mismoTipo(b) || a.cantidad - b.cantidad || porId(a, b));

  $('libro-detalle').innerHTML = `
    <div class="card tarjeta-contador mb-3"><div class="card-body">
      <div class="h5 fw-bold mb-1">${escaparHtml(l.titulo || l.codigo)}</div>
      <div class="resultado-isbn mb-2">${l.editorial ? escaparHtml(l.editorial) + ' · ' : ''}${escaparHtml(etiquetaCodigo(l.codigo))}</div>
      <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
        ${badgeTipo(tipo)}
        <span class="badge text-bg-primary">En ${l.cajas.length} caja(s)</span>
        ${comprados
          ? `<span class="badge ${claseComprados[comprados.clase]}">Repartidos ${comprados.texto}</span>`
          : ejemplares !== l.cajas.length ? `<span class="badge text-bg-light border">${ejemplares} ejemplares</span>` : ''}
        ${repetidas ? `<span class="badge text-bg-warning"><i class="bi bi-exclamation-triangle"></i> Repetido en ${repetidas} caja(s)</span>` : ''}
      </div>
      ${(item ? item.impresos : []).map((c) => `
        <div class="alert alert-warning py-1 px-2 mb-2 d-flex align-items-center gap-2 small">
          <i class="bi bi-slash-circle"></i>
          <span class="flex-grow-1">Trae impreso <b>${escaparHtml(etiquetaCodigo(c))}</b> · código bloqueado</span>
          <button type="button" class="btn btn-sm btn-outline-secondary" style="min-height:32px;"
                  data-quitar-impreso="${escaparHtml(c)}">Desbloquear</button>
        </div>`).join('')}
      ${item ? `<button type="button" class="btn btn-outline-warning btn-sm" style="min-height:36px;" data-accion="impreso">
          <i class="bi bi-upc"></i> El código impreso en este libro está mal</button>` : ''}
    </div></div>

    <h3 class="h6 fw-bold mb-0">Está en ${esta.length} caja(s)</h3>
    <div class="small text-body-secondary mb-2">Tocá una caja para sacar este libro y poner otro.</div>
    <div class="list-group lista-cajas-libro">
      ${esta.map((c) => filaCajaLibroHtml(c, veces.get(c.id))).join('') ||
        '<div class="list-group-item small text-body-secondary">No está en ninguna caja.</div>'}
    </div>

    <div class="separador-no-esta">
      <h3 class="h6 fw-bold mb-0">No está en ${noEsta.length} caja(s)</h3>
      <div class="small text-body-secondary">
        ${tipo ? `Primero las que tienen menos libros de tipo ${escaparHtml(tipo)}. ` : ''}Tocá una para sacar un libro y poner este.
      </div>
    </div>
    <div class="list-group lista-cajas-libro lista-no-esta mb-4">
      ${noEsta.map((c) => filaCajaLibroHtml(c, 0)).join('') ||
        '<div class="list-group-item small text-body-secondary">Está en todas las cajas.</div>'}
    </div>`;
}

function filaCajaLibroHtml(c, veces) {
  const clase = c.cerrada ? 'text-bg-secondary' : c.cantidad > app.limite ? 'text-bg-danger' : 'text-bg-info';
  return `
    <button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2 ${veces > 1 ? 'item-repetido' : ''}"
            data-caja-libro="${escaparHtml(c.id)}">
      <span class="flex-grow-1 text-truncate">
        <span class="caja-id">${escaparHtml(c.id)}</span>
        ${veces ? `<span class="fw-semibold ms-1">×${veces}${veces > 1 ? '<span class="asterisco">*</span>' : ''}</span>` : ''}
        <span class="d-block mezcla-tipos text-truncate">${mezclaTiposHtml(c.tipos)}</span>
      </span>
      <span class="badge ${clase}">${c.cerrada ? '<i class="bi bi-lock-fill"></i> ' : ''}${c.cantidad}/${app.limite}</span>
      <i class="bi bi-chevron-right text-body-secondary"></i>
    </button>`;
}

/* ----------------------------------------------------------------------------
 *  CAMBIAR UN LIBRO POR OTRO EN UNA CAJA
 *  - La caja tiene el libro elegido → sale ese y se busca cuál entra.
 *  - La caja no lo tiene → entra ese y se elige cuál sale de su contenido.
 * -------------------------------------------------------------------------- */

async function abrirIntercambio(idCaja) {
  const tiene = libroActual().cajas.some(([id]) => id === idCaja);
  const intercambio = { caja: idCaja, tiene: tiene, contenido: [] };
  if (!tiene) {
    mostrarCargando('Buscando contenido de ' + idCaja + '…');
    try {
      intercambio.contenido = (await llamarServidor('getContenidoCaja', app.sesion.token, idCaja)).libros;
    } catch (e) {
      if (!manejarErrorSesion(e)) toast(e.message, 'danger');
      return;
    } finally {
      ocultarCargando();
    }
  }
  app.intercambio = intercambio;
  renderLibroDetalle();
  window.scrollTo(0, 0);
  if (tiene) setTimeout(() => $('intercambio-buscar').focus(), 50);
}

function renderIntercambio() {
  const l = libroActual();
  const it = app.intercambio;
  const c = app.resumenCajas.get(it.caja) || { id: it.caja, cerrada: false, cantidad: 0, tipos: {} };
  const titulo = escaparHtml(l.titulo || l.codigo);

  let html = `
    <div class="card tarjeta-contador mb-3"><div class="card-body">
      <div class="d-flex align-items-center gap-2 mb-1">
        <span class="h5 fw-bold mb-0">${escaparHtml(c.id)}</span>
        <span class="badge ${c.cerrada ? 'text-bg-secondary' : 'text-bg-info'}">${c.cerrada ? '<i class="bi bi-lock-fill"></i> Cerrada' : 'Abierta'} · ${c.cantidad}/${app.limite}</span>
      </div>
      <div class="mezcla-tipos mb-2">${mezclaTiposHtml(c.tipos)}</div>
      <div>${it.tiene
        ? `<i class="bi bi-dash-circle text-danger"></i> Sale <b>${titulo}</b>. Elegí el libro que entra en su lugar.`
        : `<i class="bi bi-plus-circle text-success"></i> Entra <b>${titulo}</b>. Elegí el libro que sale.`}</div>
      ${c.cerrada ? '<div class="small text-body-secondary mt-1">La caja está cerrada y sigue cerrada.</div>' : ''}
      <button type="button" class="btn btn-link px-0" data-intercambio-cancelar>Cancelar</button>
    </div></div>`;

  if (it.tiene) {
    html += `
      <div class="position-relative mb-2">
        <i class="bi bi-search position-absolute text-body-secondary" style="left:14px; top:50%; transform:translateY(-50%);"></i>
        <input type="search" class="form-control form-control-lg ps-5" id="intercambio-buscar"
               placeholder="Libro que entra: título, editorial o ISBN" autocomplete="off" autocapitalize="none" spellcheck="false">
      </div>
      <div class="small text-body-secondary mb-2" id="intercambio-info">
        ${app.catalogoListo ? 'Escribí al menos 2 letras.' : 'El catálogo todavía se está cargando…'}
      </div>
      <div class="list-group mb-4" id="intercambio-resultados"></div>`;
  } else if (!it.contenido.length) {
    html += '<div class="alert alert-secondary">La caja está vacía: no hay ningún libro para sacar.</div>';
  } else {
    html += '<div class="list-group mb-4">' + it.contenido.map((x, idx) => {
      const tipo = (app.resumenLibros.get(x.codigo) || itemCatalogoDe(x.codigo) || {}).tipo || '';
      return `
        <button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2 ${x.veces > 1 ? 'item-repetido' : ''}"
                data-sacar-idx="${idx}">
          <span class="flex-grow-1 text-truncate">
            <span class="d-block fw-semibold text-truncate">${escaparHtml(x.titulo || x.codigo)}</span>
            <span class="d-block resultado-isbn text-truncate">${x.editorial ? escaparHtml(x.editorial) + ' · ' : ''}${escaparHtml(etiquetaCodigo(x.codigo))}</span>
          </span>
          ${badgeTipo(tipo)}
          ${x.veces > 1 ? `<span class="badge text-bg-warning">×${x.veces}</span>` : ''}
          <i class="bi bi-box-arrow-right text-danger"></i>
        </button>`;
    }).join('') + '</div>';
  }
  $('libro-detalle').innerHTML = html;
}

/** Busca el libro que entra (por título/editorial o por código). */
function onBuscarIntercambio() {
  const texto = $('intercambio-buscar').value;
  const limpio = texto.replace(/[\s-]/g, '').toUpperCase();
  const actual = libroActual().codigo;
  const encontrados = /^[0-9X]{8,13}$/.test(limpio)
    ? [buscarIsbnEnCatalogo(limpio)].filter(Boolean)
    : buscarEnCatalogo(texto);
  const visibles = encontrados.filter((i) => (i.isbn || i.titulo) !== actual).slice(0, MAX_RESULTADOS_BUSQUEDA);
  const contenedor = $('intercambio-resultados');
  contenedor._items = visibles;

  $('intercambio-info').textContent = !app.catalogoListo ? 'El catálogo todavía se está cargando…'
    : normalizarTexto(texto).length < 2 ? 'Escribí al menos 2 letras.'
    : !visibles.length ? 'Sin resultados.'
    : 'Tocá el libro que entra. Al lado, en cuántas cajas está hoy.';

  const palabras = normalizarTexto(texto).split(' ');
  contenedor.innerHTML = visibles.map((i, idx) => {
    const r = app.resumenLibros.get(i.isbn || i.titulo);
    const enCajas = r ? r.cajas.length : 0;
    const comprados = r && estadoComprados(r);
    return `
      <button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2" data-poner-idx="${idx}">
        <span class="flex-grow-1 text-truncate">
          <span class="d-block fw-semibold text-truncate">${resaltar(i.titulo || '(sin título)', palabras)}</span>
          <span class="d-block resultado-isbn text-truncate">${i.editorial ? escaparHtml(i.editorial) + ' · ' : ''}${escaparHtml(etiquetaCodigo(i.isbn))}</span>
        </span>
        ${badgeTipo(i.tipo)}
        <span class="badge ${comprados && comprados.clase === 'sobran' ? 'text-bg-success' : 'text-bg-light border'}">
          ${comprados ? comprados.texto : enCajas + ' caja(s)'}</span>
      </button>`;
  }).join('');
}

/** @param {{codigo:string, titulo:string}} sale  @param {{valor:string, titulo:string, editorial:string}} entra */
async function ejecutarIntercambio(idCaja, sale, entra) {
  const caja = app.resumenCajas.get(idCaja);
  const ok = await confirmar('Cambiar libro',
    `En la caja <b>${escaparHtml(idCaja)}</b>:<br>` +
      `<i class="bi bi-dash-circle text-danger"></i> sale <b>${escaparHtml(sale.titulo)}</b> (1 ejemplar)<br>` +
      `<i class="bi bi-plus-circle text-success"></i> entra <b>${escaparHtml(entra.titulo || entra.valor)}</b>` +
      (caja && caja.cerrada ? '<div class="small text-body-secondary mt-2">La caja está cerrada y sigue cerrada.</div>' : ''),
    'Cambiar', 'btn-primary');
  if (!ok) return;

  mostrarCargando('Cambiando libro…');
  try {
    await llamarServidor('intercambiarLibro', app.sesion.token, idCaja, sale.codigo, entra);
    app.intercambio = null;
    toast(`Caja ${idCaja}: salió "${sale.titulo}" y entró "${entra.titulo || entra.valor}".`, 'success');
    await cargarResumenLibros();
  } catch (e) {
    if (!manejarErrorSesion(e)) toast('No se pudo cambiar el libro: ' + e.message, 'danger');
  } finally {
    ocultarCargando();
  }
}

function onClickLibroDetalle(evento) {
  const t = evento.target;
  const it = app.intercambio;
  const l = libroActual();

  const caja = t.closest('[data-caja-libro]');
  if (caja) return abrirIntercambio(caja.dataset.cajaLibro);
  if (t.closest('[data-intercambio-cancelar]')) {
    app.intercambio = null;
    return renderLibroDetalle();
  }
  if (t.closest('[data-accion="impreso"]')) return onCodigoImpresoMal();
  const desbloquear = t.closest('[data-quitar-impreso]');
  if (desbloquear) return onDesbloquearCodigo(desbloquear.dataset.quitarImpreso);

  const poner = t.closest('[data-poner-idx]');
  if (poner && it) {
    const i = $('intercambio-resultados')._items[Number(poner.dataset.ponerIdx)];
    if (i) ejecutarIntercambio(it.caja, { codigo: l.codigo, titulo: l.titulo || l.codigo },
      { valor: i.isbn || i.titulo, titulo: i.titulo, editorial: i.editorial });
    return;
  }
  const sacar = t.closest('[data-sacar-idx]');
  if (sacar && it) {
    const x = it.contenido[Number(sacar.dataset.sacarIdx)];
    if (x) ejecutarIntercambio(it.caja, { codigo: x.codigo, titulo: x.titulo || x.codigo },
      { valor: l.codigo, titulo: l.titulo, editorial: l.editorial });
  }
}

function onVolverDeLibro() {
  if (app.intercambio) {
    app.intercambio = null;
    renderLibroDetalle();
    return;
  }
  mostrarPantalla('pantalla-libros');
}

/* ----------------------------------------------------------------------------
 *  CÓDIGOS MAL IMPRESOS
 *  Algunos libros traen impreso el código de otro libro del catálogo. Ese
 *  código se bloquea: al escanearlo no se registra nada y se pide el título.
 * -------------------------------------------------------------------------- */

async function onCodigoImpresoMal() {
  const l = libroActual();
  const item = itemCatalogoDe(l.codigo);
  if (!item) return;

  const pedido = confirmar('Código impreso mal',
    `<p class="mb-2">Escribí el código que trae impreso <b>${escaparHtml(l.titulo || l.codigo)}</b> (el que está mal).</p>
     <input type="text" class="form-control form-control-lg" id="input-codigo-impreso" inputmode="numeric"
            autocomplete="off" spellcheck="false" placeholder="Código impreso en el libro">
     <div class="small text-body-secondary mt-2">Ese código queda bloqueado: al escanearlo, la app no registra nada y pide buscar el libro por título.</div>`,
    'Continuar', 'btn-warning');
  setTimeout(() => { const i = $('input-codigo-impreso'); if (i) i.focus(); }, 400);
  if (!(await pedido)) return;

  const codigo = $('input-codigo-impreso').value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9X]{8,13}$/.test(codigo)) {
    toast('El código tiene que tener entre 8 y 13 dígitos.', 'danger');
    return;
  }
  if (codigo === item.isbn) {
    toast('Ese es el código correcto del libro, no uno mal impreso.', 'warning');
    return;
  }

  const otro = buscarIsbnEnCatalogo(codigo);
  const ok = await confirmar('Bloquear código',
    (otro && otro !== item
      ? `El <b>${escaparHtml(etiquetaCodigo(codigo))}</b> es el código de <b>${escaparHtml(otro.titulo)}</b>, que también está en el catálogo.<br><br>`
      : '') +
    `Desde ahora, al escanear o tipear <b>${escaparHtml(etiquetaCodigo(codigo))}</b> habrá que buscar el libro por título.` +
    '<div class="small text-body-secondary mt-2">Los libros que ya se cargaron con ese código no cambian: revisalos en sus cajas.</div>',
    'Bloquear código', 'btn-warning');
  if (ok) guardarCodigoImpreso(item, codigo, false);
}

async function onDesbloquearCodigo(codigo) {
  const item = itemCatalogoDe(libroActual().codigo);
  if (!item) return;
  const ok = await confirmar('Desbloquear código',
    `¿Desbloquear <b>${escaparHtml(etiquetaCodigo(codigo))}</b>? Al escanearlo se va a volver a registrar el libro que tenga ese código en el catálogo.`,
    'Desbloquear', 'btn-primary');
  if (ok) guardarCodigoImpreso(item, codigo, true);
}

async function guardarCodigoImpreso(item, codigo, quitar) {
  mostrarCargando(quitar ? 'Desbloqueando código…' : 'Bloqueando código…');
  try {
    const r = await llamarServidor('marcarCodigoImpreso', app.sesion.token, item.isbn || item.titulo, codigo, quitar);
    item.impresos = r.impresos;
    reconstruirBloqueados(); // vale ya en este celular; los demás lo toman al actualizar el catálogo
    toast(quitar ? 'Código desbloqueado.' : 'Código bloqueado.', 'success');
    renderLibroDetalle();
  } catch (e) {
    if (!manejarErrorSesion(e)) toast('No se pudo guardar: ' + e.message, 'danger');
  } finally {
    ocultarCargando();
  }
}

/* ============================================================================
 *  UTILIDADES DE UI
 * ========================================================================== */

/**
 * Modal de confirmación basado en Bootstrap. Devuelve Promise<boolean>.
 * `mensajeHtml` debe venir ya escapado si contiene datos ingresados.
 */
function confirmar(titulo, mensajeHtml, textoAceptar, claseBoton, textoCancelar) {
  return new Promise((resolve) => {
    const el = $('modal-confirmar');
    const modal = bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static', keyboard: false });
    let respuesta = false;
    app.modalAbierto = true;

    $('confirmar-titulo').textContent = titulo;
    $('confirmar-mensaje').innerHTML = mensajeHtml;
    const si = $('confirmar-si');
    si.textContent = textoAceptar || 'Aceptar';
    si.className = 'btn btn-lg flex-fill ' + (claseBoton || 'btn-primary');
    $('confirmar-no').textContent = textoCancelar || 'Cancelar';

    const onSi = () => { respuesta = true; modal.hide(); };
    const onNo = () => { respuesta = false; modal.hide(); };
    const onCerrado = () => {
      si.removeEventListener('click', onSi);
      $('confirmar-no').removeEventListener('click', onNo);
      el.removeEventListener('hidden.bs.modal', onCerrado);
      app.modalAbierto = false;
      resolve(respuesta);
    };

    si.addEventListener('click', onSi);
    $('confirmar-no').addEventListener('click', onNo);
    el.addEventListener('hidden.bs.modal', onCerrado);
    modal.show();
  });
}

/** Notificación breve en la parte inferior. tipo: success|danger|warning|info */
function toast(mensaje, tipo = 'info') {
  const claseTexto = (tipo === 'warning' || tipo === 'info') ? 'text-dark' : 'text-white';
  const div = document.createElement('div');
  div.className = `toast align-items-center border-0 bg-${tipo} ${claseTexto}`;
  div.setAttribute('role', 'alert');
  div.innerHTML = `
    <div class="d-flex">
      <div class="toast-body fw-semibold">${escaparHtml(mensaje)}</div>
      <button type="button" class="btn-close me-2 m-auto ${claseTexto === 'text-white' ? 'btn-close-white' : ''}"
              data-bs-dismiss="toast" aria-label="Cerrar" style="min-height:auto;"></button>
    </div>`;
  $('toasts').appendChild(div);
  const t = new bootstrap.Toast(div, { delay: tipo === 'danger' ? 6000 : 3500 });
  div.addEventListener('hidden.bs.toast', () => div.remove());
  t.show();
}

function escaparHtml(texto) {
  return String(texto == null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function vibrar(patron) {
  try { if (navigator.vibrate) navigator.vibrate(patron); } catch (e) { /* no soportado */ }
}

/** Pitido corto con Web Audio (sin archivos externos). */
function beep(frecuencia, duracionSeg) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!app.audioCtx) app.audioCtx = new Ctx();
    const ctx = app.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frecuencia;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duracionSeg);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duracionSeg);
  } catch (e) { /* audio no disponible */ }
}

function actualizarEstadoConexion() {
  $('sin-conexion').classList.toggle('visible', !navigator.onLine);
}

/* ============================================================================
 *  INICIALIZACIÓN
 * ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // Login
  $('form-login').addEventListener('submit', onSubmitLogin);
  $('btn-ver-password').addEventListener('click', () => {
    const input = $('login-password');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    $('btn-ver-password').innerHTML = visible ? '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
  });
  $('btn-logout').addEventListener('click', onLogout);

  // Admin
  $('btn-admin-refrescar').addEventListener('click', cargarPanelAdmin);
  $('btn-admin-empaquetar').addEventListener('click', irAlEmpaquetado);
  $('btn-volver-panel').addEventListener('click', irAlPanel);
  $('form-consulta-caja').addEventListener('submit', onConsultarCaja);
  $('resultado-consulta-caja').addEventListener('click', onQuitarEnConsulta);
  $('resultado-consulta-caja').addEventListener('click', (e) => {
    if (e.target.closest('.btn-editar-caja')) onEditarCajaConsultada();
  });
  $('resultado-consulta-caja').addEventListener('click', onTocarFila);
  $('resultado-consulta-caja').addEventListener('change', onCambioSeleccion);

  // Menú operario
  $('btn-actualizar-cajas').addEventListener('click', cargarCajas);
  $('input-buscar-caja').addEventListener('input', renderCajas);
  $('input-buscar-caja').addEventListener('keydown', onEnterBuscarCaja);
  $('lista-cajas').addEventListener('click', onClickCaja);

  // Libros por caja
  document.querySelectorAll('.btn-ir-libros').forEach((b) => b.addEventListener('click', irALibros));
  $('btn-libros-volver').addEventListener('click', volverDeLibros);
  $('btn-libros-actualizar').addEventListener('click', cargarResumenLibros);
  $('libros-buscar').addEventListener('input', renderLibros);
  ['libros-orden', 'libros-tipo', 'libros-solo-repetidos'].forEach((id) => $(id).addEventListener('change', renderLibros));
  $('grilla-libros').addEventListener('click', onClickLibro);
  $('btn-libro-volver').addEventListener('click', onVolverDeLibro);
  $('libro-detalle').addEventListener('click', onClickLibroDetalle);
  $('libro-detalle').addEventListener('input', (e) => {
    if (e.target.id === 'intercambio-buscar') onBuscarIntercambio();
  });

  // Cámara
  $('btn-reintentar-camara').addEventListener('click', iniciarCamara);
  $('btn-linterna').addEventListener('click', onLinterna);
  document.addEventListener('visibilitychange', onVisibilidad);

  // Tema
  aplicarTema(preferenciaTema());
  document.querySelectorAll('.btn-tema').forEach((b) => b.addEventListener('click', onCambiarTema));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (preferenciaTema() === 'auto') aplicarTema('auto');
  });
  $('btn-reintentar-catalogo').addEventListener('click', cargarCatalogo);
  $('btn-actualizar-catalogo').addEventListener('click', () => { cargarCatalogo(true); cargarSinCodigo(); });
  $('sin-codigo').addEventListener('click', onClickSinCodigo);

  // Pantalla de caja
  document.querySelectorAll('input[name="modo"]').forEach((radio) => {
    radio.addEventListener('change', (e) => cambiarModo(e.target.value));
  });
  $('input-foto').addEventListener('change', onFotoSeleccionada);
  $('input-busqueda').addEventListener('input', onInputBusqueda);
  $('input-busqueda').addEventListener('keydown', onEnterBusqueda);
  $('resultados-busqueda').addEventListener('click', onClickResultado);
  $('btn-cerrar-manual').addEventListener('click', onCerrarManual);
  $('contenido-caja').addEventListener('click', onClickContenido);
  $('tarjeta-contenido').addEventListener('click', onTocarFila);
  $('tarjeta-contenido').addEventListener('change', onCambioSeleccion);
  $('barra-contenido').addEventListener('click', (e) => {
    if (e.target.closest('.btn-sacar-seleccion')) sacarSeleccionDeCaja();
  });
  $('btn-deshacer').addEventListener('click', () => deshacerLectura(app.deshacer));
  $('btn-volver-menu').addEventListener('click', onVolverMenu);

  // Conexión
  window.addEventListener('online', () => {
    actualizarEstadoConexion();
    toast('Conexión restablecida.', 'success');
    procesarCola(); // sin esperar el próximo reintento
  });
  window.addEventListener('offline', actualizarEstadoConexion);
  actualizarEstadoConexion();

  // Aviso del navegador si se intenta cerrar o recargar con libros sin guardar.
  window.addEventListener('beforeunload', (e) => {
    if (!app.cola.length && !app.cierres.length) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Desbloquea el audio en el primer toque (requisito de los navegadores móviles).
  document.addEventListener('touchstart', () => beep(1, 0.001), { once: true, passive: true });

  restaurarSesion();
});
