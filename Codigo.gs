// =====================================================
//  MESA DE AYUDA CON TICKETS — Google Apps Script
//  Configuración: NO va en el código. Se guarda en
//  Configuración del proyecto → Propiedades del script:
//    SHEET_ID        ID de la hoja de tickets
//    CORREO_SOPORTE  correo de la cuenta que atiende
//    WHATSAPP_URL    (opcional) webhook que reenvía el aviso a WhatsApp
//    WHATSAPP_TOKEN  (opcional) clave Bearer de ese webhook
//    FORM_SHEET_ID   (opcional) hoja de respuestas del formulario de campo
//    FORM_WEB_URL    (opcional) URL de la aplicación web publicada
// =====================================================
const CFG = PropertiesService.getScriptProperties();
const SHEET_ID = CFG.getProperty('SHEET_ID');
const YO = CFG.getProperty('CORREO_SOPORTE');
const NOMBRE_EQUIPO = 'MESA DE AYUDA - SISTEMAS';

// ---------- WhatsApp (opcional): dejar vacío para desactivar ----------
const WHATSAPP_URL = CFG.getProperty('WHATSAPP_URL') || '';
const WHATSAPP_TOKEN = CFG.getProperty('WHATSAPP_TOKEN') || '';

// ---------- Filtros de remitentes y asuntos ----------
// Remitentes que nunca generan ticket (agregue aquí correos internos o de sistemas).
const IGNORAR = /no-?reply|mailer-daemon|postmaster|notification|google\.com/i;
// Incluye los asuntos de NUESTROS propios correos (confirmación y cierre) y los
// rebotes, para que las respuestas/rebotes pegados a esos hilos nunca se
// conviertan en un ticket.
const IGNORAR_ASUNTO = /Se comparti[oó] un formulario contigo|ENCUESTA DE SATISFACCI[OÓ]N|TICKET DE SOPORTE ASIGNADO|TICKET CERRADO|Delivery Status Notification/i;

const MENSAJE_INICIAL =
  'Cordial saludo,\n\n' +
  'Hemos recibido su correo. Para generar su ticket de atención, responda este mismo mensaje diligenciando TODOS los campos:\n\n' +
  'Nombre completo:\n\n' +
  'Correo:\n\n' +
  'Punto donde se presenta la solicitud:\n\n' +
  'Detalle de la solicitud:\n\n' +
  'Nota: No se generará el ticket si algún campo queda vacío. Al recibir la información completa, le enviaremos su número de ticket.\n\n' +
  'Quedamos atentos para darle solución lo más pronto posible.\n\n' +
  NOMBRE_EQUIPO;

// Puntos de atención: nombre exacto + palabras clave para reconocerlos
const PUNTOS = [
  { nombre: 'Sede principal', claves: ['principal', 'sede central'] },
  { nombre: 'Punto Norte', claves: ['norte'] },
  { nombre: 'Punto Sur', claves: ['sur'] },
  { nombre: 'Brigadas', claves: ['brigadas?'] },
  { nombre: 'Zona rural', claves: ['rural'] }
];

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

const TITULOS = [
  ['nombre', /^nombre(?:\s+completo)?\s*:\s*(.*)$/i],
  ['correo', /^(?:correo|e-?mail)(?:\s+electr[oó]nico)?\s*:\s*(.*)$/i],
  ['punto', /^punto(?:\s+donde\s+se\s+presenta\s+la\s+solicitud)?\s*:\s*(.*)$/i],
  ['detalle', /^detalle(?:\s+de\s+la\s+solicitud)?\s*:\s*(.*)$/i]
];

const CORTES = /^(nota\s*:|quedamos atentos|mesa de ayuda|(de|from|para|to|enviado|sent|asunto|subject)\s*:|-+\s*(original|forwarded))|(escribi[oó]|wrote)\s*:?\s*$|^(?:(?:el|on)\s+)+(lun|mar|mi[eé]|jue|vie|s[aá]b|dom|mon|tue|wed|thu|fri|sat|sun)/i;
const RUIDO = /^(buen[oa]s?(\s+(d[ií]as|tardes|noches))?|hola|cordial saludo|saludos|gracias|enviado desde.*)[\s,.!]*$/i;

// =====================================================
//  FUNCIÓN PRINCIPAL (la que corre cada 5 minutos)
// =====================================================
// Errores pasajeros de Google ("We're sorry, a server error occurred...",
// cuotas momentáneas, tiempos de espera). No son culpa del script: se
// reintentan y, si persisten, se dejan para la siguiente vuelta (5 min).
const TRANSITORIO = /server error|try again|too many times|timed? ?out|temporarily|service unavailable|internal error|backend error|reading from storage|writing to storage|error code internal|error del servidor|vuelve a intentarlo|int[eé]ntelo/i;
// Solo se avisa por correo si Google lleva fallando este número de vueltas
// seguidas (6 x 5 min = 30 min). Una falla aislada ya no genera correo.
const MAX_FALLAS_SEGUIDAS = 6;

function procesarCorreos() {
  // Evita que el disparador de 5 minutos y una resincronización manual
  // revisen los correos al mismo tiempo (crearían tickets duplicados).
  const lock = LockService.getUserLock();
  let tengoLock = false;
  try { tengoLock = lock.tryLock(1000); } catch (_) {}
  if (!tengoLock) { Logger.log('Ya hay una revisión de correos en curso; se omite esta.'); return false; }
  try {
    procesarCorreosInterno();
    contadorFallas_(0);
  } catch (e) {
    if (!TRANSITORIO.test(String(e))) throw e; // error real: correo de Google
    const n = contadorFallas_(+1);
    Logger.log('Falla pasajera de Google (' + n + ' seguida(s)): ' + e);
    if (n >= MAX_FALLAS_SEGUIDAS) {
      contadorFallas_(0);
      throw new Error('Google lleva ' + n + ' ejecuciones seguidas fallando: ' + e);
    }
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
  return true;
}

// Lleva la cuenta de fallas seguidas en las Propiedades del script.
// Si el propio almacenamiento de Google está fallando ("error occurred while
// reading from storage"), no se lanza nada: se registra y se sigue.
// delta = 0 reinicia la cuenta; delta = +1 suma una falla. Devuelve la cuenta.
function contadorFallas_(delta) {
  try {
    const props = PropertiesService.getScriptProperties();
    const actual = Number(props.getProperty('fallas_seguidas') || 0);
    if (delta === 0) {
      if (actual) props.deleteProperty('fallas_seguidas');
      return 0;
    }
    props.setProperty('fallas_seguidas', String(actual + delta));
    return actual + delta;
  } catch (e) {
    Logger.log('No se pudo actualizar el contador de fallas (almacenamiento de Google): ' + e);
    return 0;
  }
}

function procesarCorreosInterno() {
  const L = {
    pend: reintentar(() => etiqueta('Pendiente-datos')),
    tick: reintentar(() => etiqueta('Ticket-generado')),
    ign: reintentar(() => etiqueta('Ignorado-auto'))
  };
  // Cada hilo se procesa aislado: si Gmail rechaza una operación sobre uno
  // ("Gmail operation not allowed", etc.), se registra y se sigue con los demás.
  const errores = [];

  // 1. Correos nuevos: pedir los datos
  reintentar(() => GmailApp.search('in:inbox newer_than:10h -label:Pendiente-datos -label:Ticket-generado -label:Ignorado-auto'))
    .forEach(hilo => {
      try { procesarNuevo(hilo, L); }
      catch (e) { registrarError(errores, 'Nuevo', hilo, e); }
    });

  // 2. Hilos pendientes: ver si ya respondieron con los datos
  const hoja = reintentar(() => SpreadsheetApp.openById(SHEET_ID).getSheets()[0]);
  if (!hoja) throw new Error('No encuentro la hoja de cálculo. Revisa el SHEET_ID.');

  reintentar(() => GmailApp.search('label:Pendiente-datos -label:Ticket-generado newer_than:14d'))
    .forEach(hilo => {
      try { procesarPendiente(hilo, hoja, L); }
      catch (e) { registrarError(errores, 'Pendiente', hilo, e); }
    });

  // 3. Tickets cerrados en la hoja: avisar a la persona
  try { revisarCierres(hoja); }
  catch (e) { Logger.log('ERROR Cierres | ' + e); errores.push('Cierres | ' + e); }

  // Solo los errores REALES generan el correo de Google. Los pasajeros ya
  // quedaron en el registro y ese hilo se vuelve a procesar en 5 minutos.
  const graves = errores.filter(linea => !TRANSITORIO.test(linea));
  if (graves.length) {
    throw new Error(graves.length + ' hilo(s) con error:\n' + graves.join('\n'));
  }
}

// Ejecuta fn y, si Google responde con un error pasajero, espera y reintenta
// (2 s, luego 5 s). Un error que no es pasajero se lanza de inmediato.
function reintentar(fn) {
  const esperas = [2000, 5000];
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      if (i >= esperas.length || !TRANSITORIO.test(String(e))) throw e;
      Logger.log('Reintentando tras falla pasajera: ' + e);
      Utilities.sleep(esperas[i]);
    }
  }
}

// ---------- Paso 1: un hilo nuevo ----------
function procesarNuevo(hilo, L) {
  const msgs = hilo.getMessages();
  const asunto = hilo.getFirstMessageSubject();

  // 1º IGNORAR, antes que cualquier otra cosa. Se revisa quién escribió el
  // primer Y el último mensaje, más el asunto. Antes esta revisión iba
  // después del chequeo de "hilo con respuesta nuestra", y un rebote
  // (mailer-daemon) pegado a un hilo nuestro se saltaba el filtro.
  const remitente = msgs[0].getFrom();
  const ultimoRemitente = msgs[msgs.length - 1].getFrom();
  if (IGNORAR.test(remitente) || IGNORAR.test(ultimoRemitente) || IGNORAR_ASUNTO.test(asunto)) {
    Logger.log('Ignorado: ' + remitente + ' | ' + asunto);
    hilo.addLabel(L.ign);
    return;
  }

  if (msgs.some(m => m.getFrom().toLowerCase().includes(YO))) {
    Logger.log('Hilo con respuesta previa, pasa a pendiente: ' + asunto);
    hilo.addLabel(L.pend);
    return;
  }

  // La etiqueta va ANTES de responder: si la respuesta falla, el hilo no
  // vuelve a entrar al paso 1 y no se envían plantillas repetidas.
  Logger.log('Plantilla enviada a: ' + remitente);
  hilo.addLabel(L.pend);
  hilo.reply(FORM_WEB_URL
    ? MENSAJE_INICIAL.replace('Quedamos atentos',
        'Si lo prefiere, puede registrar su solicitud directamente en este formulario, sin responder este correo:\n' +
        FORM_WEB_URL + '\n\nQuedamos atentos')
    : MENSAJE_INICIAL);
}

// ---------- Paso 2: un hilo pendiente ----------
function procesarPendiente(hilo, hoja, L) {
  const msgs = hilo.getMessages();
  const ultimo = msgs[msgs.length - 1];
  if (ultimo.getFrom().toLowerCase().includes(YO)) return;

  // Guarda del paso 2: si el último mensaje es de un remitente ignorable
  // (rebote, no-reply...) o el hilo es de nuestros propios avisos, NO se
  // extrae nada ni se crea ticket. El hilo queda pendiente: si la persona
  // responde de verdad después, ese mensaje sí se procesa.
  if (IGNORAR.test(ultimo.getFrom()) || IGNORAR_ASUNTO.test(hilo.getFirstMessageSubject())) {
    Logger.log('Pendiente omitido (último mensaje ignorable): ' + ultimo.getFrom());
    return;
  }

  const r = extraerDatos(ultimo.getPlainBody(), ultimo.getFrom());

  if (!r.ok) {
    Logger.log('Faltan datos (' + r.faltantes.join(', ') + ') en: ' + hilo.getFirstMessageSubject());
    hilo.reply(
      'Cordial saludo,\n\n' +
      'No pudimos generar su ticket porque falta la siguiente información: ' + r.faltantes.join(', ') + '.\n\n' +
      'Por favor responda este mensaje con los datos completos (nombre completo, correo, punto donde se presenta la solicitud y detalle de la solicitud).\n\n' +
      NOMBRE_EQUIPO
    );
    return;
  }

  const d = r.datos;

  // Etiquetas PRIMERO, hoja después. Antes era al revés: si Gmail rechazaba
  // el cambio de etiqueta, la fila ya existía y el hilo seguía pendiente, así
  // que en la siguiente vuelta se creaba un ticket DUPLICADO.
  // Se agrega Ticket-generado antes de quitar Pendiente-datos: con solo la
  // primera operación ya queda excluido de la búsqueda del paso 2.
  hilo.addLabel(L.tick);
  hilo.removeLabel(L.pend);

  let ticket;
  try {
    ticket = siguienteTicket();
    // Columnas: Ticket | Fecha | Nombre | Correo | Punto | Detalle | Asignado a | Estado | Fecha de cierre | Enlace | Cierre notificado
    // "Asignado a" queda vacío: se elige a mano en la hoja según disponibilidad.
    hoja.appendRow([ticket, new Date(), d.nombre, d.correo, d.punto, d.detalle, '', 'Nuevo', '', hilo.getPermalink(), '']);
  } catch (e) {
    // No se pudo registrar: se devuelve el hilo a pendiente para reintentar.
    // (Si el número ya se había generado, ese número queda sin usar.)
    try { hilo.removeLabel(L.tick); hilo.addLabel(L.pend); } catch (_) {}
    throw new Error('No se pudo registrar el ticket ' + (ticket || '') + ': ' + e);
  }
  Logger.log('Ticket creado: ' + ticket);

  // Confirmación a la persona (correo nuevo con asunto propio)
  try {
    GmailApp.sendEmail(
      emailDe(ultimo.getFrom()) || d.correo,
      'TICKET DE SOPORTE ASIGNADO - ' + ticket,
      'Cordial saludo,\n\n' +
      'Su solicitud fue registrada con el número de ticket ' + ticket + '.\n\n' +
      'Por favor conserve este número para cualquier consulta.\n\n' +
      'Se le dará atención lo más pronto posible, gracias.\n\n' +
      NOMBRE_EQUIPO,
      { name: NOMBRE_EQUIPO }
    );
  } catch (e) { Logger.log('Error enviando confirmación de ' + ticket + ': ' + e); }

  // Aviso interno (WhatsApp al grupo)
  avisarNuevoTicket(ticket, d);
}

function registrarError(errores, paso, hilo, e) {
  let asunto = '(sin asunto)';
  try { asunto = hilo.getFirstMessageSubject(); } catch (_) {}
  const linea = paso + ' | ' + asunto + ' | ' + e;
  Logger.log('ERROR ' + linea);
  errores.push(linea);
}

// =====================================================
//  AVISOS
// =====================================================
function avisarNuevoTicket(ticket, d) {
  const resumen = d.detalle.length > 200 ? d.detalle.substring(0, 200) + '...' : d.detalle;

  // WhatsApp al grupo: solo datos mínimos (sin nombre ni correo de la persona)
  enviarWhatsApp(
    '🆕 *Nuevo ticket ' + ticket + '*\n' +
    'Punto: ' + d.punto + '\n' +
    'Asignación manual, dependiendo de disponibilidad\n' +
    'Detalle: ' + resumen
  );
}

function revisarCierres(hoja) {
  const filas = hoja.getDataRange().getValues();
  // Registro propio de cierres ya avisados (Propiedades del script), además de
  // la columna K. Así un cierre se avisa UNA sola vez aunque la columna K no
  // guarde el valor (tipo de columna, fórmula, alguien la borra...). Antes,
  // si K quedaba vacía, se reenviaba el correo y el WhatsApp cada 5 minutos.
  const props = PropertiesService.getScriptProperties();
  const avisados = props.getProperties();

  // Primera vez con este registro: los tickets que YA están cerrados se dan por
  // avisados (sin enviar nada), para no reenviar cierres viejos.
  if (!avisados['cierres_inicializado']) {
    const iniciales = { cierres_inicializado: new Date().toISOString() };
    for (let i = 1; i < filas.length; i++) {
      const tk = String(filas[i][0] || '').trim();
      if (tk && String(filas[i][7]).trim().toLowerCase() === 'cerrado') iniciales['cierre_' + tk] = 'inicial';
    }
    props.setProperties(iniciales);
    Logger.log('Registro de cierres creado con ' + (Object.keys(iniciales).length - 1) + ' tickets ya cerrados.');
    return;
  }

  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    const ticket = String(f[0] || '').trim(), nombre = f[2], correo = f[3], estado = f[7], fechaCierre = f[8], notificado = f[10];
    if (!ticket) continue;
    const clave = 'cierre_' + ticket;
    const cerrado = String(estado).trim().toLowerCase() === 'cerrado';

    // Si lo reabrieron, se olvida el aviso para poder avisar el próximo cierre.
    if (!cerrado) {
      if (avisados[clave]) { try { props.deleteProperty(clave); } catch (_) {} }
      continue;
    }
    if (notificado || avisados[clave]) continue;

    try {
      // 1º marcar como avisado (si esto falla, NO se envía nada y se reintenta luego)
      props.setProperty(clave, new Date().toISOString());
      hoja.getRange(i + 1, 11).setValue('Sí - ' + Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy HH:mm'));
      if (!fechaCierre) hoja.getRange(i + 1, 9).setValue(new Date()); // Fecha de cierre

      // 2º avisar
      if (correo && EMAIL.test(correo)) {
        GmailApp.sendEmail(
          correo,
          'TICKET CERRADO - ' + ticket,
          'Cordial saludo' + (nombre ? ', ' + nombre : '') + ',\n\n' +
          'Le informamos que su solicitud con número de ticket ' + ticket + ' fue atendida y se encuentra CERRADA.\n\n' +
          'Si el inconveniente persiste, responda este correo indicando el número de ticket.\n\n' +
          NOMBRE_EQUIPO,
          { name: NOMBRE_EQUIPO }
        );
      }
      enviarWhatsApp('✅ *Ticket ' + ticket + ' cerrado*');
      Logger.log('Cierre notificado: ' + ticket);
    } catch (e) { Logger.log('Error notificando cierre de ' + ticket + ': ' + e); }
  }
}

function enviarWhatsApp(texto) {
  if (!WHATSAPP_URL) return; // desactivado
  try {
    const resp = UrlFetchApp.fetch(WHATSAPP_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN },
      payload: JSON.stringify({ mensaje: texto }),
      muteHttpExceptions: true
    });
    // Antes un fallo (túnel caído, URL vieja) pasaba en silencio. Ahora queda
    // en el registro de Ejecuciones con el código HTTP.
    const code = resp.getResponseCode();
    if (code === 200) Logger.log('WhatsApp enviado');
    else Logger.log('WhatsApp FALLÓ (HTTP ' + code + '): ' + resp.getContentText().substring(0, 200));
  } catch (e) { Logger.log('WhatsApp FALLÓ (sin conexión con el túnel): ' + e); }
}

// =====================================================
//  REENVÍO MANUAL DEL AVISO
//  Para cuando un ticket se creó con el túnel caído y el aviso no llegó.
//  Cambia el número y ejecuta reenviarAviso desde el editor.
// =====================================================
const TICKET_A_REENVIAR = 'SC-2026-0013';

function reenviarAviso() {
  const hoja = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const fila = hoja.getDataRange().getValues()
    .find(f => String(f[0]).trim() === TICKET_A_REENVIAR);
  if (!fila) throw new Error('No encuentro ' + TICKET_A_REENVIAR + ' en la hoja.');
  avisarNuevoTicket(fila[0], { punto: String(fila[4]), detalle: String(fila[5]) });
}

// =====================================================
//  FORMULARIO DE SUPERVISORES (cargue / descargue de encuestas)
//  Cada respuesta del formulario crea un ticket directamente, con la misma
//  numeración SC-AAAA-NNNN, en la hoja de tickets y con aviso a WhatsApp.
//  El disparador se conecta a la HOJA DE RESPUESTAS del formulario.
//
//  Instalación (una sola vez): ejecuta instalarDisparadorFormulario desde el
//  editor y acepta los permisos.
// =====================================================
const FORM_SHEET_ID = CFG.getProperty('FORM_SHEET_ID');
const ORIGEN_FORM = 'Formulario supervisores';

function instalarDisparadorFormulario() {
  // Quita disparadores anteriores de esta función para no duplicar tickets.
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'alEnviarFormulario')
    .forEach(t => ScriptApp.deleteTrigger(t));
  const ss = SpreadsheetApp.openById(FORM_SHEET_ID);
  ScriptApp.newTrigger('alEnviarFormulario').forSpreadsheet(ss).onFormSubmit().create();
  Logger.log('Disparador instalado en la hoja de respuestas: ' + ss.getName());
}

// Nombres cortos para las columnas del formulario "Registro y Control de
// Cargue y Descargue de DMC". Las columnas que no estén aquí pasan al
// Detalle con su título original.
const ETIQUETAS_FORM = [
  [/asignacion de encuestador/, 'Encuestador'],
  [/dispositivo/, 'DMC N°'],
  [/^fecha/, 'Fecha'],
  [/cantidad de encuestas/, 'Encuestas para cargar/descargar']
];

// Arma, para una fila de la hoja de respuestas, el mismo evento que manda
// Google al enviarse el formulario.
function hojaRespuestas_() {
  const hojas = SpreadsheetApp.openById(FORM_SHEET_ID).getSheets();
  return hojas.find(h => h.getFormUrl && h.getFormUrl()) || hojas[0];
}
function eventoDeFila_(hojaResp, fila) {
  const encabezados = hojaResp.getRange(1, 1, 1, hojaResp.getLastColumn()).getValues()[0];
  const valores = hojaResp.getRange(fila, 1, 1, encabezados.length).getDisplayValues()[0];
  const namedValues = {};
  encabezados.forEach((t, i) => { if (t) namedValues[t] = [valores[i]]; });
  return { range: hojaResp.getRange(fila, 1), namedValues: namedValues };
}

// PRUEBA desde el editor: crea el ticket de la ÚLTIMA fila de la hoja de
// respuestas como si se acabara de enviar. Ojo: crea un ticket real.
function probarUltimaRespuesta() {
  const h = hojaRespuestas_();
  alEnviarFormulario(eventoDeFila_(h, h.getLastRow()));
}

// Crea tickets para TODAS las respuestas que ya estaban en la hoja antes de
// instalar el disparador. Se puede ejecutar varias veces: las filas que ya
// tienen ticket se saltan, así que nunca duplica.
function cargarRespuestasAnteriores() {
  const h = hojaRespuestas_();
  let creados = 0;
  for (let fila = 2; fila <= h.getLastRow(); fila++) {
    const ev = eventoDeFila_(h, fila);
    const vacia = Object.keys(ev.namedValues).every(t => !String(ev.namedValues[t][0]).trim());
    if (vacia) continue;
    const clave = 'form_' + h.getSheetId() + '_' + fila;
    if (PropertiesService.getScriptProperties().getProperty(clave)) {
      Logger.log('Fila ' + fila + ': ya tenía ticket, se salta');
      continue;
    }
    alEnviarFormulario(ev);
    creados++;
    Utilities.sleep(1500); // pausa para no mandar los avisos de WhatsApp de golpe
  }
  Logger.log('Tickets creados: ' + creados);
}

function alEnviarFormulario(e) {
  if (!e || !e.range) {
    throw new Error('Esta función no se ejecuta a mano: la llama el formulario al enviarse. ' +
      'Para probar desde el editor usa probarUltimaRespuesta.');
  }
  const props = PropertiesService.getScriptProperties();

  // Google a veces dispara onFormSubmit dos veces para la misma respuesta:
  // se marca cada fila procesada para no crear dos tickets.
  const clave = 'form_' + e.range.getSheet().getSheetId() + '_' + e.range.getRow();
  if (props.getProperty(clave)) { Logger.log('Respuesta ya procesada: ' + clave); return; }
  props.setProperty(clave, String(Date.now()));

  // Lee TODAS las columnas por su título, sin depender del orden.
  const respuestas = Object.keys(e.namedValues || {})
    .map(t => ({ titulo: t.trim(), valor: [].concat(e.namedValues[t]).join(', ').trim() }))
    .filter(x => x.valor && !/^(marca temporal|timestamp)$/.test(norm(x.titulo)));

  const buscar = re => (respuestas.find(x => re.test(norm(x.titulo))) || {}).valor || '';
  const correo = emailDe(buscar(/correo|e-?mail/));
  // "Supervisor responsable" (las columnas "Asignación de encuestador
  // supervisor..." NO cuentan como nombre: van al detalle).
  const esNombre = t => /^supervisor|^nombre/.test(norm(t));
  const esCorreo = t => /correo|e-?mail/.test(norm(t));

  const d = {
    nombre: buscar(/^supervisor|^nombre/) || correo || '(sin nombre)',
    correo: correo,
    punto: canonizarPunto(buscar(/punto|sede|lugar/)) || 'Cargue/Descargue DMC',
    detalle: '[' + ORIGEN_FORM + ']\n' +
      respuestas
        .filter(x => !esNombre(x.titulo) && !esCorreo(x.titulo) && !/punto|sede|lugar/.test(norm(x.titulo)))
        .map(x => {
          const et = ETIQUETAS_FORM.find(([re]) => re.test(norm(x.titulo)));
          return (et ? et[1] : x.titulo) + ': ' + x.valor;
        })
        .join('\n')
  };

  const hoja = reintentar(() => SpreadsheetApp.openById(SHEET_ID).getSheets()[0]);
  let ticket;
  try {
    ticket = siguienteTicket();
    // Columnas: Ticket | Fecha | Nombre | Correo | Punto | Detalle | Asignado a | Estado | Fecha de cierre | Enlace | Cierre notificado
    reintentar(() => hoja.appendRow([ticket, new Date(), d.nombre, d.correo, d.punto, d.detalle, '', 'Nuevo', '', ORIGEN_FORM, '']));
  } catch (err) {
    props.deleteProperty(clave); // permite reprocesarla
    throw new Error('No se pudo registrar la respuesta del formulario: ' + err);
  }
  Logger.log('Ticket creado desde formulario: ' + ticket);

  // Confirmación al supervisor (solo si el formulario recoge su correo)
  if (d.correo) {
    try {
      GmailApp.sendEmail(
        d.correo,
        'TICKET DE SOPORTE ASIGNADO - ' + ticket,
        'Cordial saludo,\n\n' +
        'Su solicitud de cargue/descargue de encuestas fue registrada con el número de ticket ' + ticket + '.\n\n' +
        'Por favor conserve este número para cualquier consulta.\n\n' +
        'Se le dará atención lo más pronto posible, gracias.\n\n' +
        NOMBRE_EQUIPO,
        { name: NOMBRE_EQUIPO }
      );
    } catch (err) { Logger.log('Error enviando confirmación de ' + ticket + ': ' + err); }
  }

  avisarNuevoTicket(ticket, d);
}

// =====================================================
//  LECTURA FLEXIBLE DE LA RESPUESTA
// =====================================================
function extraerDatos(cuerpo, remitente) {
  const a = leerConTitulos(cuerpo);
  const b = leerSinTitulos(cuerpo);
  let datos = llenos(b) > llenos(a) ? b : a;

  if (!datos.correo) datos.correo = emailDe(remitente);
  datos.punto = canonizarPunto(datos.punto);

  const nombres = { nombre: 'nombre completo', correo: 'correo', punto: 'punto donde se presenta la solicitud', detalle: 'detalle de la solicitud' };
  const faltantes = Object.keys(nombres).filter(k => !datos[k]).map(k => nombres[k]);
  return { ok: faltantes.length === 0, datos: datos, faltantes: faltantes };
}

function leerConTitulos(cuerpo) {
  const lineas = cuerpo.split(/\r?\n/).map(l => l.replace(/^[>\s]+/, '').trim());
  const entradas = [];
  let actual = null;

  lineas.forEach(l => {
    if (CORTES.test(l)) { actual = null; return; }
    for (const [campo, re] of TITULOS) {
      const m = l.match(re);
      if (m) {
        actual = { campo: campo, texto: m[1] || '' };
        entradas.push(actual);
        return;
      }
    }
    if (actual && l) actual.texto += (actual.texto ? '\n' : '') + l;
  });

  const res = { nombre: '', correo: '', punto: '', detalle: '' };
  Object.keys(res).forEach(campo => {
    const con = entradas.filter(e => e.campo === campo && e.texto.trim());
    if (con.length) res[campo] = con[con.length - 1].texto.trim();
  });
  res.correo = emailDe(res.correo);
  return res;
}

function leerSinTitulos(cuerpo) {
  const nuevas = [];
  for (const c of cuerpo.split(/\r?\n/)) {
    const t = c.trim();
    if (t.startsWith('>') || CORTES.test(t)) break;
    if (t && !RUIDO.test(t)) nuevas.push(t);
  }

  let correo = '';
  const i = nuevas.findIndex(l => EMAIL.test(l));
  if (i >= 0) {
    correo = emailDe(nuevas[i]);
    nuevas.splice(i, 1);
  }
  return { nombre: nuevas[0] || '', correo: correo, punto: nuevas[1] || '', detalle: nuevas.slice(2).join('\n') };
}

function llenos(d) {
  return ['nombre', 'correo', 'punto', 'detalle'].filter(k => d[k]).length;
}

function emailDe(texto) {
  const m = (texto || '').match(EMAIL);
  return m ? m[0] : '';
}

function norm(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function canonizarPunto(texto) {
  if (!texto) return '';
  const n = norm(texto);
  for (const p of PUNTOS) {
    for (const k of p.claves) {
      if (new RegExp('\\b' + k + '\\b').test(n)) return p.nombre;
    }
  }
  return texto;
}

// =====================================================
//  UTILIDADES
// =====================================================
function siguienteTicket() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const props = PropertiesService.getScriptProperties();
    const anio = new Date().getFullYear();
    const n = Number(props.getProperty('contador_' + anio) || 0) + 1;
    props.setProperty('contador_' + anio, n);
    return 'SC-' + anio + '-' + String(n).padStart(4, '0');
  } finally {
    lock.releaseLock();
  }
}

function etiqueta(nombre) {
  return GmailApp.getUserLabelByName(nombre) || GmailApp.createLabel(nombre);
}

// =====================================================
//  TICKETS MANUALES
//  Para solicitudes que llegan por teléfono, en persona o por WhatsApp.
//  Se escribe solo el texto de la solicitud; el ticket sigue la misma línea:
//  numeración SC-AAAA-NNNN, misma hoja, estado "Nuevo", asignación manual y
//  aviso al grupo de WhatsApp.
//
//  Dos formas de abrirlo:
//   A) Menú "Tickets" en la hoja de tickets: ejecuta UNA VEZ instalarMenuTickets
//      y vuelve a abrir la hoja.
//   B) Página web (sirve en el celular): Implementar > Nueva implementación >
//      Aplicación web, y guarda el enlace que te da.
// =====================================================
const ORIGEN_MANUAL = 'Manual';

function instalarMenuTickets() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'agregarMenuTickets')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('agregarMenuTickets')
    .forSpreadsheet(SpreadsheetApp.openById(SHEET_ID))
    .onOpen()
    .create();
  Logger.log('Menú instalado. Cierra y vuelve a abrir la hoja de tickets.');
}

function agregarMenuTickets() {
  SpreadsheetApp.getUi()
    .createMenu('Tickets')
    .addItem('Nuevo ticket manual', 'abrirTicketManual')
    .addItem('Resincronizar correos', 'resincronizarCorreos')
    .addToUi();
}

// Revisa YA el correo (lo mismo que hace el disparador cada 5 minutos), para
// que los tickets que llegaron por correo aparezcan antes de crear uno manual.
function resincronizarCorreos() {
  const ui = SpreadsheetApp.getUi();
  const r = resincronizar_();
  ui.alert('Resincronizar correos', r.mensaje, ui.ButtonSet.OK);
}

function resincronizar_() {
  const hoja = reintentar(() => SpreadsheetApp.openById(SHEET_ID).getSheets()[0]);
  const antes = hoja.getLastRow();
  let corrio;
  try { corrio = procesarCorreos(); }
  catch (e) { return { nuevos: 0, mensaje: 'La revisión terminó con error: ' + e.message }; }
  if (!corrio) return { nuevos: 0, mensaje: 'Ya había una revisión de correos en curso. Intenta de nuevo en un minuto.' };
  const nuevos = Math.max(0, hoja.getLastRow() - antes);
  return { nuevos: nuevos, mensaje: nuevos ? 'Listo: se crearon ' + nuevos + ' ticket(s) nuevos desde el correo.' : 'Listo: no había tickets nuevos en el correo.' };
}

// Busca tickets que NO estén cerrados (últimos 30 días) que se parezcan a la
// solicitud: mismo correo, mismo nombre, o mismo punto con un detalle parecido.
function buscarTicketsParecidos_(d) {
  const filas = reintentar(() => SpreadsheetApp.openById(SHEET_ID).getSheets()[0].getDataRange().getValues());
  const limite = Date.now() - 30 * 24 * 3600 * 1000;
  const palabras = t => new Set(norm(t).split(/[^a-z0-9]+/).filter(w => w.length >= 4));
  const pd = palabras(d.detalle);
  const nom = norm(d.nombre).replace(/\s+/g, ' ').trim();
  const res = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    const [ticket, fecha, nombre, correo, punto, detalle, , estado] = f;
    if (!ticket || String(estado).trim().toLowerCase() === 'cerrado') continue;
    if (fecha instanceof Date && fecha.getTime() < limite) continue;
    const n2 = norm(nombre).replace(/\s+/g, ' ').trim();
    const mismoCorreo = d.correo && String(correo).toLowerCase() === d.correo.toLowerCase();
    const mismoNombre = nom.length >= 5 && n2 && (n2.includes(nom) || nom.includes(n2));
    let parecido = false;
    if (String(punto) === d.punto && pd.size) {
      const p2 = palabras(detalle);
      const comunes = [...pd].filter(w => p2.has(w)).length;
      parecido = comunes / Math.min(pd.size, p2.size || 1) >= 0.5;
    }
    if (mismoCorreo || mismoNombre || parecido) {
      res.push({
        ticket: String(ticket),
        fecha: fecha instanceof Date ? Utilities.formatDate(fecha, 'America/Bogota', 'dd/MM/yyyy HH:mm') : String(fecha),
        nombre: String(nombre), punto: String(punto), estado: String(estado || 'Nuevo'),
        detalle: String(detalle).slice(0, 120),
        motivo: mismoCorreo ? 'mismo correo' : mismoNombre ? 'mismo nombre' : 'mismo punto y detalle parecido'
      });
    }
  }
  return res;
}

function abrirTicketManual() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(htmlTicketManual_(false)).setWidth(520).setHeight(680),
    'Nuevo ticket manual'
  );
}

// Página web (Implementar > Aplicación web)

// La llama el formulario. Devuelve el número de ticket creado.
function crearTicketManual(f) {
  const d = {
    nombre: String(f.nombre || '').trim(),
    correo: emailDe(String(f.correo || '')),
    punto: canonizarPunto(String(f.punto || '').trim()),
    detalle: String(f.detalle || '').trim()
  };
  const faltan = ['nombre', 'punto', 'detalle'].filter(k => !d[k]);
  if (faltan.length) throw new Error('Falta: ' + faltan.join(', '));

  // Comprobación previa: primero se revisa el correo (por si la persona ya
  // escribió y su ticket aún no se había creado) y luego se buscan tickets
  // parecidos. Si hay, se muestran y se pide confirmar.
  if (!f.confirmado) {
    const sync = resincronizar_();
    const parecidos = buscarTicketsParecidos_(d);
    if (parecidos.length) return { duplicados: parecidos, sync: sync.mensaje };
  }

  let quien = '';
  try { quien = Session.getActiveUser().getEmail(); } catch (_) {}

  const hoja = reintentar(() => SpreadsheetApp.openById(SHEET_ID).getSheets()[0]);
  const ticket = siguienteTicket();
  // Columnas: Ticket | Fecha | Nombre | Correo | Punto | Detalle | Asignado a | Estado | Fecha de cierre | Enlace | Cierre notificado
  reintentar(() => hoja.appendRow([ticket, new Date(), d.nombre, d.correo, d.punto, d.detalle, '', 'Nuevo', '',
    ORIGEN_MANUAL + (quien ? ' - ' + quien : ''), '']));
  Logger.log('Ticket manual creado: ' + ticket);

  if (d.correo && f.enviarCorreo) {
    try {
      GmailApp.sendEmail(
        d.correo,
        'TICKET DE SOPORTE ASIGNADO - ' + ticket,
        'Cordial saludo,\n\n' +
        'Su solicitud fue registrada con el número de ticket ' + ticket + '.\n\n' +
        'Por favor conserve este número para cualquier consulta.\n\n' +
        'Se le dará atención lo más pronto posible, gracias.\n\n' +
        NOMBRE_EQUIPO,
        { name: NOMBRE_EQUIPO }
      );
    } catch (e) { Logger.log('Error enviando confirmación de ' + ticket + ': ' + e); }
  }

  avisarNuevoTicket(ticket, d);
  return { ticket: ticket };
}

function htmlTicketManual_(esPagina) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const opciones = PUNTOS.map(p => '<option value="' + esc(p.nombre) + '">' + esc(p.nombre) + '</option>').join('');
  return '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
  '<style>' +
  'body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b;background:#fff}' +
  '.w{max-width:480px;margin:0 auto;padding:' + (esPagina ? '24px 16px' : '4px 8px') + '}' +
  'h1{font-size:20px;margin:0 0 4px;color:#A21D2E}p.s{margin:0 0 16px;color:#555;font-size:13px}' +
  'label{display:block;font-size:13px;font-weight:bold;margin:12px 0 4px}' +
  'input,select,textarea{width:100%;box-sizing:border-box;font:inherit;font-size:15px;padding:10px;border:1px solid #bbb;border-radius:8px}' +
  'textarea{min-height:110px;resize:vertical}' +
  '.chk{display:flex;gap:8px;align-items:center;font-weight:normal;margin-top:12px}.chk input{width:auto}' +
  'button{margin-top:18px;width:100%;padding:12px;font-size:16px;font-weight:bold;color:#fff;background:#E31E2C;border:0;border-radius:8px;cursor:pointer}' +
  'button:disabled{background:#999}' +
  '#msg{margin-top:14px;padding:12px;border-radius:8px;display:none;font-size:14px}' +
  '.ok{background:#e6f4ea;color:#1e5e2e}.err{background:#fde8e8;color:#8a1c1c}' +
  '.warn{background:#fff4e0;color:#5a3b00}.dup{margin:10px 0;padding:8px 10px;background:#fff;border-radius:6px;font-size:13px}.dup em{color:#777}' +
  '.acc{display:flex;gap:8px}.acc button{margin-top:8px;font-size:14px;padding:10px}.acc .sec{background:#fff;color:#A21D2E;border:1px solid #A21D2E}' +
  '</style></head><body><div class="w">' +
  (esPagina ? '<h1>Nuevo ticket</h1><p class="s">Mesa de ayuda · Sistemas</p>' : '') +
  '<form id="f" onsubmit="enviar(event)">' +
  '<label for="nombre">Nombre completo *</label><input id="nombre" name="nombre" required>' +
  '<label for="correo">Correo (opcional)</label><input id="correo" name="correo" type="email">' +
  '<label for="punto">Punto donde se presenta la solicitud *</label>' +
  '<select id="punto" name="punto" required><option value="">Seleccione…</option>' + opciones + '</select>' +
  '<label for="detalle">Detalle de la solicitud *</label><textarea id="detalle" name="detalle" required></textarea>' +
  '<label class="chk"><input type="checkbox" id="enviarCorreo" checked> Enviar el número de ticket al correo</label>' +
  '<button id="b" type="submit">Crear ticket</button>' +
  '</form><div id="msg" role="status"></div></div>' +
  '<script>' +
  'var datos=null;' +
  'function enviar(ev){ev.preventDefault();datos={nombre:v("nombre"),correo:v("correo"),punto:v("punto"),detalle:v("detalle"),enviarCorreo:document.getElementById("enviarCorreo").checked};llamar("Revisando correos y tickets…");}' +
  'function llamar(txt){var b=document.getElementById("b");b.disabled=true;b.textContent=txt;ocultar();' +
  'google.script.run.withSuccessHandler(resultado).withFailureHandler(function(e){mostrar("No se pudo crear: "+e.message,"err");listo();}).crearTicketManual(datos);}' +
  'function resultado(r){listo();if(r.duplicados){duplicados(r);return;}mostrar("Ticket "+r.ticket+" creado y avisado al grupo.","ok");document.getElementById("f").reset();datos=null;}' +
  'function duplicados(r){var m=document.getElementById("msg");m.innerHTML="";m.className="warn";m.style.display="block";' +
  'el(m,"strong","Ya hay "+r.duplicados.length+" ticket(s) abiertos parecidos:");' +
  'r.duplicados.forEach(function(t){var d=el(m,"div","");d.className="dup";el(d,"strong",t.ticket+" · "+t.estado);el(d,"div",t.fecha+" · "+t.nombre+" · "+t.punto);el(d,"div",t.detalle);el(d,"em","("+t.motivo+")");});' +
  'var p=el(m,"div","");p.className="acc";' +
  'var s=el(p,"button","Crear de todas formas");s.type="button";s.onclick=function(){datos.confirmado=true;llamar("Creando…");};' +
  'var c=el(p,"button","Cancelar");c.type="button";c.className="sec";c.onclick=ocultar;}' +
  'function el(p,tag,txt){var e=document.createElement(tag);if(txt)e.textContent=txt;p.appendChild(e);return e;}' +
  'function v(id){return document.getElementById(id).value;}' +
  'function listo(){var b=document.getElementById("b");b.disabled=false;b.textContent="Crear ticket";}' +
  'function ocultar(){var m=document.getElementById("msg");m.style.display="none";m.innerHTML="";}' +
  'function mostrar(t,c){var m=document.getElementById("msg");m.textContent=t;m.className=c;m.style.display="block";}' +
  '</script></body></html>';
}


// =====================================================
//  FORMULARIO WEB DE SOLICITUDES (para quien pide soporte)
//  Reemplaza el ir y venir de correos: la persona llena el formulario una
//  vez y el ticket se crea al instante. La trazabilidad queda en Gmail: se le
//  envía un correo con todos los datos, ese hilo queda en Recibidos con la
//  etiqueta Ticket-generado y su enlace va en la columna "Enlace al correo".
//  Si la persona responde ese correo, la respuesta llega a ese mismo hilo.
//
//  Publicación: Implementar > Nueva implementación > Aplicación web
//   - Ejecutar como: Yo (la cuenta de soporte)
//   - Quién tiene acceso: Cualquier persona
//  Luego pega el enlace (termina en /exec) en FORM_WEB_URL: así la plantilla
//  de respuesta automática también lo ofrece.
// =====================================================
const FORM_WEB_URL = CFG.getProperty('FORM_WEB_URL') || '';
const ORIGEN_WEB = 'Formulario web';

function doGet() {
  return HtmlService.createHtmlOutput(htmlFormularioWeb_())
    .setTitle('Solicitud de soporte - Mesa de ayuda')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// La llama el formulario web. Solo devuelve el número del ticket: nunca datos
// de otros tickets, porque esta página es pública.
function crearTicketWeb(f) {
  f = f || {};
  if (String(f.sitio || '').trim()) return { ticket: 'OK' }; // trampa para robots: se descarta en silencio

  const d = {
    nombre: String(f.nombre || '').trim().slice(0, 150),
    correo: emailDe(String(f.correo || '')).toLowerCase(),
    punto: canonizarPunto(String(f.punto || '').trim()).slice(0, 150),
    detalle: String(f.detalle || '').trim().slice(0, 3000)
  };
  const nombres = { nombre: 'nombre completo', correo: 'correo válido', punto: 'punto', detalle: 'detalle de la solicitud' };
  const faltan = Object.keys(nombres).filter(k => !d[k]).map(k => nombres[k]);
  if (faltan.length) throw new Error('Falta: ' + faltan.join(', ') + '.');

  const hoja = reintentar(() => SpreadsheetApp.openById(SHEET_ID).getSheets()[0]);

  // Doble envío (doble clic, recargar la página): si el mismo correo mandó
  // el mismo detalle en los últimos 15 minutos, se devuelve ese ticket.
  const filas = reintentar(() => hoja.getDataRange().getValues());
  const hace15 = Date.now() - 15 * 60 * 1000;
  for (let i = filas.length - 1; i >= 1; i--) {
    const [tk, fecha, , correo, , detalle] = filas[i];
    if (!(fecha instanceof Date) || fecha.getTime() < hace15) break;
    if (String(correo).toLowerCase() === d.correo && String(detalle).trim() === d.detalle) return { ticket: String(tk) };
  }

  const ticket = siguienteTicket();

  // Correo de confirmación con TODOS los datos: es la trazabilidad en Gmail.
  let enlace = ORIGEN_WEB;
  try {
    const msg = GmailApp.createDraft(
      d.correo,
      'TICKET DE SOPORTE ASIGNADO - ' + ticket,
      'Cordial saludo, ' + d.nombre + '.\n\n' +
      'Su solicitud fue registrada con el número de ticket ' + ticket + '.\n\n' +
      'Nombre completo: ' + d.nombre + '\n' +
      'Correo: ' + d.correo + '\n' +
      'Punto donde se presenta la solicitud: ' + d.punto + '\n' +
      'Detalle de la solicitud:\n' + d.detalle + '\n\n' +
      'Por favor conserve este número para cualquier consulta. Si necesita agregar algo, responda este mismo correo.\n\n' +
      'Se le dará atención lo más pronto posible, gracias.\n\n' +
      NOMBRE_EQUIPO,
      { name: NOMBRE_EQUIPO }
    ).send();
    const hilo = msg.getThread();
    // Ticket-generado: el revisor de correos nunca lo convierte en otro ticket.
    hilo.addLabel(etiqueta('Ticket-generado'));
    hilo.moveToInbox();
    enlace = hilo.getPermalink();
  } catch (e) { Logger.log('Error enviando confirmación web de ' + ticket + ': ' + e); }

  // Columnas: Ticket | Fecha | Nombre | Correo | Punto | Detalle | Asignado a | Estado | Fecha de cierre | Enlace | Cierre notificado
  reintentar(() => hoja.appendRow([ticket, new Date(), d.nombre, d.correo, d.punto, d.detalle, '', 'Nuevo', '', enlace, '']));
  Logger.log('Ticket web creado: ' + ticket);

  avisarNuevoTicket(ticket, d);
  return { ticket: ticket };
}

function htmlFormularioWeb_() {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const opciones = PUNTOS.map(p => '<option value="' + esc(p.nombre) + '">' + esc(p.nombre) + '</option>').join('');
  return '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
  '<style>' +
  'body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b;background:#f4f4f2}' +
  '.top{background:#A21D2E;color:#fff;padding:20px 16px 56px;border-bottom:8px solid #E31E2C}' +
  '.top .in{max-width:520px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:12px}' +
  '.marca{font-size:26px;font-weight:bold}.ent{font-size:12px;font-weight:bold;text-align:right;line-height:1.3}' +
  '.card{max-width:520px;margin:-40px auto 32px;background:#fff;border-radius:14px;padding:24px 20px;box-shadow:0 2px 10px rgba(0,0,0,.08)}' +
  '@media(max-width:560px){.card{margin:-40px 12px 24px}}' +
  'h1{font-size:22px;margin:0 0 6px}p.s{margin:0 0 8px;color:#555;font-size:14px;line-height:1.4}' +
  'label{display:block;font-size:14px;font-weight:bold;margin:16px 0 6px}' +
  'input,select,textarea{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:12px;border:1px solid #bbb;border-radius:8px;background:#fff}' +
  'input:focus,select:focus,textarea:focus{outline:2px solid #E31E2C;border-color:#E31E2C}' +
  'textarea{min-height:130px;resize:vertical}.ayuda{font-size:12px;color:#666;margin-top:4px}' +
  '.trampa{position:absolute;left:-9999px}' +
  'button{margin-top:22px;width:100%;padding:14px;font-size:17px;font-weight:bold;color:#fff;background:#E31E2C;border:0;border-radius:8px;cursor:pointer}' +
  'button:disabled{background:#999}' +
  '#msg{margin-top:16px;padding:14px;border-radius:8px;display:none;font-size:15px;line-height:1.4}' +
  '.err{background:#fde8e8;color:#8a1c1c}' +
  '#listo{display:none;text-align:center}#listo .num{font-size:30px;font-weight:bold;color:#A21D2E;margin:12px 0}' +
  '#listo button{background:#fff;color:#A21D2E;border:1px solid #A21D2E}' +
  '.pie{text-align:center;font-size:12px;color:#777;margin-bottom:24px}' +
  '</style></head><body>' +
  '<div class="top"><div class="in"><div class="marca">Mesa de ayuda</div><div class="ent">SISTEMAS</div></div></div>' +
  '<div class="card"><div id="forma">' +
  '<h1>Solicitud de soporte</h1><p class="s">Área de Sistemas. Diligencie todos los campos y recibirá su número de ticket al instante y en su correo.</p>' +
  '<form id="f" onsubmit="enviar(event)">' +
  '<label for="nombre">Nombre completo</label><input id="nombre" required autocomplete="name">' +
  '<label for="correo">Correo electrónico</label><input id="correo" type="email" required autocomplete="email"><div class="ayuda">Aquí le llegará el número de ticket y la respuesta.</div>' +
  '<label for="punto">Punto donde se presenta la solicitud</label><select id="punto" required><option value="">Seleccione…</option>' + opciones + '</select>' +
  '<label for="detalle">Detalle de la solicitud</label><textarea id="detalle" required placeholder="Describa qué necesita o qué está fallando"></textarea>' +
  '<div class="trampa" aria-hidden="true"><label for="sitio">No llenar</label><input id="sitio" tabindex="-1" autocomplete="off"></div>' +
  '<button id="b" type="submit">Enviar solicitud</button>' +
  '</form><div id="msg" role="alert"></div></div>' +
  '<div id="listo" role="status"><h1>Solicitud registrada</h1><p class="s">Su número de ticket es:</p><div class="num" id="num"></div>' +
  '<p class="s">También se lo enviamos a su correo. Consérvelo para cualquier consulta.</p>' +
  '<button type="button" onclick="otra()">Registrar otra solicitud</button></div></div>' +
  '<div class="pie">MESA DE AYUDA · SISTEMAS</div>' +
  '<script>' +
  'function v(id){return document.getElementById(id).value;}' +
  'function enviar(ev){ev.preventDefault();var b=document.getElementById("b");b.disabled=true;b.textContent="Enviando…";document.getElementById("msg").style.display="none";' +
  'google.script.run.withSuccessHandler(function(r){document.getElementById("forma").style.display="none";document.getElementById("num").textContent=r.ticket;document.getElementById("listo").style.display="block";listo();})' +
  '.withFailureHandler(function(e){var m=document.getElementById("msg");m.textContent="No se pudo registrar: "+e.message+" Intente de nuevo.";m.className="err";m.style.display="block";listo();})' +
  '.crearTicketWeb({nombre:v("nombre"),correo:v("correo"),punto:v("punto"),detalle:v("detalle"),sitio:v("sitio")});}' +
  'function listo(){var b=document.getElementById("b");b.disabled=false;b.textContent="Enviar solicitud";}' +
  'function otra(){document.getElementById("f").reset();document.getElementById("listo").style.display="none";document.getElementById("forma").style.display="block";}' +
  '</script></body></html>';
}
