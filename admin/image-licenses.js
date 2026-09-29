/*
  Licencias de imagen autorizadas para VexlowHQ — FUENTE ÚNICA
  ================================================================
  Único lugar donde se define qué valores de `imageLicense` puede llevar
  una imagen para pasar el control de publicación, y qué licencias
  exigen atribución visible. Nadie más duplica esta lista: admin/pipeline.js
  la usa para bloquear el guardado (POST /api/articles en admin/server.js),
  y admin/server.js la expone en GET /api/image-licenses para que el
  panel (admin/admin.js, que corre en el navegador sin require()) arme
  el <select> del formulario sin reescribirla a mano en un segundo lugar.

  Historial (auditoría forense de imágenes, sept. 2026):
  - Hasta el 2026-09-11 el pipeline escribía la licencia 'generada-con-ia'
    a cualquier imagen generada por admin/image-gen.js, SIN guardar
    herramienta/modelo/fecha/prompt por artículo. Una auditoría posterior
    encontró que el campo imageLicense por sí solo no demuestra el origen
    real del archivo -- de las 154 imágenes marcadas así, solo 130 tenían
    evidencia estructural real (ruta img/temas/<slug>.jpg, exclusiva de
    ese proceso); las otras 24 no coincidían con ningún proceso del
    código y se retiraron (ver INFORME-FORENSE-IMAGENES-Y-CORRECCIONES-FINAL.md).
  - Esas 130 imágenes no se pueden re-demostrar retroactivamente (no hay
    prompt ni log guardado de cada una) -- se reclasificaron como
    'owner-attested-ai-generated': Leonardo Beltrán, dueño de VexlowHQ,
    atestigua que son imágenes generadas con IA para el sitio y no
    descargadas de un medio externo, pero sin el detalle técnico que sí
    se exige de acá en adelante para toda imagen nueva.
  - Desde el 2026-09-12, toda imagen generada por el proceso real
    (admin/image-gen.js) guarda su propio registro de procedencia
    (herramienta, modelo, fecha, prompt) en el momento de generarla, y
    se marca 'ai-generated-commercial-use' -- una licencia que si el día
    de mañana se audita de nuevo, sí se puede demostrar con ese registro.
*/

// Licencias que pueden salir a una página pública, siempre que además
// pasen el resto de validateImagePublication() (archivo real, ruta no
// temporal, extensión/MIME coherente, etc.) -- "como mínimo" las que
// pidió la auditoría de sept. 2026; se puede ampliar, nunca duplicar en
// otro archivo.
var AUTHORIZED_LICENSES = [
  'ai-generated-commercial-use',
  'owner-attested-ai-generated',
  'own-original',
  'public-domain',
  'cc0',
  'cc-by',
  'cc-by-sa',
  'editorial-permission-verified'
];

// Valores viejos, ya usados en artículos publicados antes de esta
// auditoría, que se siguen aceptando (no se reclasifican en masa sin
// evidencia) pero que el formulario del panel ya no ofrece para
// artículos nuevos. Se normalizan al equivalente nuevo en normalizeLicense().
var LEGACY_ALIASES = {
  'propia': 'own-original',
  // No debería quedar ningún artículo con este valor después de la
  // migración del 2026-09-12 (ver script de migración en el informe) --
  // el alias queda solo como red de seguridad, no como opción activa.
  'generada-con-ia': 'ai-generated-commercial-use'
};

// Licencias que EXIGEN atribución visible (autor/fuente, URL de origen y
// texto de crédito) -- "Encontrada en Google", "RSS", "prensa" o
// "Internet" nunca cuentan como fuente válida (ver INVALID_ATTRIBUTION_SOURCES).
var LICENSES_REQUIRING_ATTRIBUTION = ['cc-by', 'cc-by-sa', 'editorial-permission-verified'];

// Fuentes/atribuciones que NUNCA son válidas, aunque alguien las tipee a
// mano en el campo de fuente o crédito.
var INVALID_ATTRIBUTION_SOURCES = /^(encontrada en google|google|google images|imagenes de google|rss|feed rss|prensa|internet|buscador|search|search engine|google search|web)$/i;

function normalizeLicense(license) {
  var norm = String(license || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, norm) ? LEGACY_ALIASES[norm] : norm;
}

function isKnownLicense(license) {
  if (!license) return false;
  var norm = String(license || '').trim().toLowerCase();
  return AUTHORIZED_LICENSES.indexOf(norm) !== -1 || Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, norm);
}

function licenseRequiresAttribution(license) {
  return LICENSES_REQUIRING_ATTRIBUTION.indexOf(normalizeLicense(license)) !== -1;
}

module.exports = {
  AUTHORIZED_LICENSES: AUTHORIZED_LICENSES,
  LEGACY_ALIASES: LEGACY_ALIASES,
  LICENSES_REQUIRING_ATTRIBUTION: LICENSES_REQUIRING_ATTRIBUTION,
  INVALID_ATTRIBUTION_SOURCES: INVALID_ATTRIBUTION_SOURCES,
  normalizeLicense: normalizeLicense,
  isKnownLicense: isKnownLicense,
  licenseRequiresAttribution: licenseRequiresAttribution
};
