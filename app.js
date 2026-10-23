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
  catalogoListo: false,
  catalogoCargando: false,

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
  enviando: false,         // hay un registro viajando al servidor
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
}

async function onLogout() {
  const ok = app.caja
    ? await confirmar('Salir', 'La caja ' + app.caja + ' quedará abierta con ' + app.cantidad + ' libros. ¿Salir igual?', 'Salir', 'btn-danger')
    : true;
  if (!ok) return;

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
  app.catalogo = [];
  app.indiceIsbn = new Map();
  app.catalogoListo = false;
  app.catalogoCargando = false;

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
      </div>
      ${c.usuarioCierre ? `<div class="small text-muted mb-2">Cerrada por ${escaparHtml(c.usuarioCierre)}${c.fechaCierre ? ' · ' + escaparHtml(c.fechaCierre) : ''}</div>` : ''}
      ${c.libros.length
        ? '<ul class="list-group">' + c.libros.map((l) => itemContenidoHtml(l, true)).join('') + '</ul>'
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

/**
 * Fila de la lista de contenido de una caja: { codigo, titulo, editorial, veces }.
 * Con `quitable`, agrega un botón para sacar un ejemplar.
 */
function itemContenidoHtml(l, quitable) {
  const repetido = l.veces > 1;
  return `
    <li class="list-group-item d-flex justify-content-between align-items-center gap-2 ${repetido ? 'item-repetido' : ''}">
      <div class="text-truncate flex-grow-1">
        <div class="fw-semibold text-truncate">${escaparHtml(l.titulo || l.codigo)}</div>
        <div class="resultado-isbn text-truncate">
          ${l.editorial ? escaparHtml(l.editorial) + ' · ' : ''}${esCodigo(l.codigo) ? escaparHtml(etiquetaCodigo(l.codigo)) : 'Sin código'}
        </div>
      </div>
      ${repetido ? `<span class="badge text-bg-warning flex-shrink-0"><i class="bi bi-exclamation-triangle"></i> ×${l.veces}</span>` : ''}
      ${quitable ? `<button type="button" class="btn btn-outline-danger btn-quitar flex-shrink-0"
          data-quitar="${escaparHtml(l.codigo)}" data-titulo="${escaparHtml(l.titulo || l.codigo)}"
          aria-label="Sacar un ejemplar de la caja" title="Sacar un ejemplar"><i class="bi bi-dash-lg"></i></button>` : ''}
    </li>`;
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

/** Descarga el catálogo y construye los índices de búsqueda. */
async function cargarCatalogo() {
  if (app.catalogoCargando || app.catalogoListo || !app.sesion) return;
  app.catalogoCargando = true;

  $('estado-catalogo').textContent = 'cargando…';
  $('estado-catalogo').className = 'fw-semibold text-warning';
  $('btn-reintentar-catalogo').classList.add('d-none');

  try {
    const filas = await llamarServidor('getCatalogo', app.sesion.token);

    // La búsqueda manual es por título o editorial (el código se usa al escanear).
    // `isbn` guarda el código del catálogo, sea ISBN o ISSN.
    app.catalogo = filas.map(([isbn, titulo, editorial]) => ({
      isbn: String(isbn || ''),
      titulo: String(titulo || ''),
      editorial: String(editorial || ''),
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

    app.catalogoListo = true;
    $('estado-catalogo').textContent = app.catalogo.length.toLocaleString('es-AR') + ' títulos listos';
    $('estado-catalogo').className = 'fw-semibold text-success';
    actualizarInfoBusqueda();
    if (app.caja) renderContenido(); // completa títulos de registros viejos
  } catch (e) {
    if (manejarErrorSesion(e)) return;
    $('estado-catalogo').textContent = 'no se pudo cargar';
    $('estado-catalogo').className = 'fw-semibold text-danger';
    $('btn-reintentar-catalogo').classList.remove('d-none');
    toast('No se pudo cargar el catálogo: ' + e.message, 'danger');
  } finally {
    app.catalogoCargando = false;
  }
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
  else abrirCajaSeleccionada(elegida.id);
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
async function abrirCajaSeleccionada(idCaja) {
  mostrarCargando('Abriendo caja ' + idCaja + '…');
  try {
    const info = await llamarServidor('abrirCaja', app.sesion.token, idCaja);
    app.caja = info.id;
    app.cantidad = info.cantidad;
    app.limite = info.max || app.limite;
    app.contenido = (info.contenido || []).map((l) => completarDesdeCatalogo({
      valor: l.codigo, titulo: l.titulo, editorial: l.editorial, origen: 'previo', hora: ''
    }));

    $('caja-id').textContent = info.id;
    $('contador-max').textContent = app.limite;
    $('input-busqueda').value = '';
    $('resultados-busqueda').innerHTML = '';
    actualizarContador(false);
    renderContenido();
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
      agrupado.push({ codigo: l.valor, titulo: l.titulo, editorial: l.editorial, veces: 0 });
    }
    agrupado[indice.get(l.valor)].veces++;
  });

  const repetidos = agrupado.filter((l) => l.veces > 1).length;
  $('contenido-resumen').innerHTML = app.contenido.length
    ? `${app.contenido.length} libro(s) · ${agrupado.length} título(s)` +
      (repetidos ? ` · <span class="text-warning-emphasis fw-semibold"><i class="bi bi-exclamation-triangle"></i> ${repetidos} repetido(s)</span>` : '')
    : '';

  lista.innerHTML = agrupado.length
    ? agrupado.map((l) => itemContenidoHtml(l, true)).join('')
    : '<li class="list-group-item text-muted small">La caja todavía está vacía.</li>';
}

/**
 * Saca un ejemplar de un libro de la caja en curso.
 * @param {string} valor               Código (o título) con el que se registró.
 * @param {boolean} pedirConfirmacion  false para "Deshacer" (ya es una acción explícita).
 */
async function sacarLibroDeCaja(valor, pedirConfirmacion) {
  if (!app.caja || !valor) return;
  if (app.enviando) {
    toast('Esperá a que termine de guardarse el último libro.', 'warning');
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

function onClickContenido(evento) {
  const boton = evento.target.closest('[data-quitar]');
  if (boton) sacarLibroDeCaja(boton.dataset.quitar, true);
}

/* ============================================================================
 *  REGISTRO DE LIBROS
 * ========================================================================== */

/**
 * Envía un libro al servidor. Es el punto común para escáner, código tipeado y
 * búsqueda por título. Antes de enviar avisa si el libro ya está en la caja o
 * si se supera el límite sugerido, y pide confirmación.
 * @param {{valor:string, titulo?:string, editorial?:string, origen:string}} libro
 * @return {Promise<boolean>} true si se registró.
 */
async function ingresarLibro(libro) {
  if (!app.caja) return false;

  if (app.enviando) {
    setFeedback('proceso', 'Esperá un momento…', 'Se está guardando el libro anterior.');
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

  app.enviando = true;
  setFeedback('proceso', 'Guardando…', descripcion);

  try {
    const r = await llamarServidor('registrarLibro', app.sesion.token, app.caja,
      libro.valor, libro.titulo || '', libro.editorial || '');

    app.cantidad = r.cantidad;
    app.limite = r.max || app.limite;
    $('contador-max').textContent = app.limite;
    app.contenido.push({
      valor: libro.valor,
      titulo: libro.titulo,
      editorial: libro.editorial,
      origen: libro.origen,
      hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
    });

    actualizarContador();
    renderContenido();

    if (r.vecesEnCaja > 1) {
      destello('alerta');
      setFeedback('alerta', `Registrado como repetido (×${r.vecesEnCaja}) · ${r.cantidad}/${app.limite}`, descripcion, libro.valor);
    } else if (r.excedido) {
      destello('alerta');
      setFeedback('alerta', `Registrado · supera el límite (${r.cantidad}/${app.limite})`, descripcion, libro.valor);
    } else {
      destello('exito');
      setFeedback('exito', `¡Registrado! (${r.cantidad}/${app.limite})`, descripcion, libro.valor);
    }

    if (r.cantidad === app.limite) {
      toast(`Llegaste al límite sugerido de ${app.limite} libros. Podés cerrar la caja.`, 'warning');
    }
    return true;
  } catch (e) {
    if (manejarErrorSesion(e)) return false;
    destello('error');

    if (e.codigo === 'CAJA_CERRADA') {
      setFeedback('error', 'Caja cerrada', e.message);
      toast(e.message, 'warning');
      setTimeout(mostrarMenu, 1800);
      return false;
    }

    setFeedback('error', 'No se registró el libro', e.message + ' Volvé a intentarlo.');

    // Si fue un problema de red/timeout, el registro pudo haberse guardado igual:
    // se resincroniza el contador con el servidor.
    if (e.codigo === 'TIMEOUT' || e.codigo === 'RED') resincronizarCaja();
    return false;
  } finally {
    app.enviando = false;
  }
}

/** Vuelve a leer la cantidad real de libros de la caja desde el servidor. */
async function resincronizarCaja() {
  if (!app.caja) return;
  try {
    const info = await llamarServidor('abrirCaja', app.sesion.token, app.caja);
    if (info.cantidad !== app.cantidad) {
      app.cantidad = info.cantidad;
      app.contenido = (info.contenido || []).map((l) => ({
        valor: l.codigo, titulo: l.titulo, editorial: l.editorial, origen: 'previo', hora: ''
      }));
      actualizarContador();
      renderContenido();
      toast('Contador actualizado desde el servidor: ' + info.cantidad + ' libro(s).', 'info');
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

/** Pantalla de confirmación luego de cerrar la caja manualmente. */
async function finalizarCaja() {
  const idCaja = app.caja;
  const cantidad = app.cantidad;

  $('completada-titulo').textContent = 'Caja cerrada';
  $('completada-detalle').textContent = `Caja ${idCaja} · ${cantidad} libro(s)`;
  $('overlay-completada').classList.add('visible');
  beep(880, 0.12); setTimeout(() => beep(1320, 0.18), 140);
  vibrar([100, 50, 100, 50, 200]);

  app.caja = null;

  setTimeout(() => {
    $('overlay-completada').classList.remove('visible');
    if (app.sesion) mostrarMenu();
  }, 2500);
}

async function onCerrarManual() {
  if (!app.caja) return;
  if (app.enviando || app.leyendoFoto) {
    toast('Esperá a que termine de guardarse el último libro.', 'warning');
    return;
  }
  if (app.cantidad === 0) {
    toast('La caja no tiene libros. Si te equivocaste de caja, usá "Volver al menú".', 'warning');
    return;
  }

  const ok = await confirmar(
    'Cerrar caja',
    `Vas a cerrar la caja <b>${escaparHtml(app.caja)}</b> con <b>${app.cantidad}</b> libro(s) (límite sugerido: ${app.limite}).` +
      (app.contenido.length !== new Set(app.contenido.map((l) => l.valor)).size
        ? '<div class="alert alert-warning py-2 my-2"><i class="bi bi-exclamation-triangle-fill"></i> La caja tiene libros repetidos.</div>'
        : '<br>') +
      'Esta acción no se puede deshacer desde la app.',
    'Cerrar caja',
    'btn-danger'
  );
  if (!ok) return;

  mostrarCargando('Cerrando caja…');
  try {
    const r = await llamarServidor('cerrarCaja', app.sesion.token, app.caja);
    app.cantidad = r.cantidad;
    ocultarCargando();
    if (r.yaEstabaCerrada) toast('La caja ya había sido cerrada por ' + (r.usuarioCierre || 'otro usuario') + '.', 'info');
    await finalizarCaja();
  } catch (e) {
    ocultarCargando();
    if (manejarErrorSesion(e)) return;
    toast('No se pudo cerrar la caja: ' + e.message, 'danger');
  }
}

async function onVolverMenu() {
  if (app.enviando || app.leyendoFoto) {
    toast('Esperá a que termine de guardarse el último libro.', 'warning');
    return;
  }
  const ok = app.cantidad > 0
    ? await confirmar('Volver al menú',
        `La caja <b>${escaparHtml(app.caja)}</b> quedará <b>disponible</b> con ${app.cantidad} libro(s). Podés retomarla después.`,
        'Volver', 'btn-primary')
    : true;
  if (ok) mostrarMenu();
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
 *  UTILIDADES DE UI
 * ========================================================================== */

/**
 * Modal de confirmación basado en Bootstrap. Devuelve Promise<boolean>.
 * `mensajeHtml` debe venir ya escapado si contiene datos ingresados.
 */
function confirmar(titulo, mensajeHtml, textoAceptar, claseBoton) {
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

  // Menú operario
  $('btn-actualizar-cajas').addEventListener('click', cargarCajas);
  $('input-buscar-caja').addEventListener('input', renderCajas);
  $('input-buscar-caja').addEventListener('keydown', onEnterBuscarCaja);
  $('lista-cajas').addEventListener('click', onClickCaja);

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
  $('btn-deshacer').addEventListener('click', () => sacarLibroDeCaja(app.deshacer, false));
  $('btn-volver-menu').addEventListener('click', onVolverMenu);

  // Conexión
  window.addEventListener('online', () => { actualizarEstadoConexion(); toast('Conexión restablecida.', 'success'); });
  window.addEventListener('offline', actualizarEstadoConexion);
  actualizarEstadoConexion();

  // Desbloquea el audio en el primer toque (requisito de los navegadores móviles).
  document.addEventListener('touchstart', () => beep(1, 0.001), { once: true, passive: true });

  restaurarSesion();
});
