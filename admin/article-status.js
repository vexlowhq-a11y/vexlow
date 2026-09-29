/*
  Estados editoriales de un artículo — FUENTE ÚNICA
  ================================================================
  Igual que admin/image-licenses.js con las licencias de imagen: acá
  vive la ÚNICA definición de qué estados existen y qué significa cada
  uno para la exposición pública del sitio (página propia, sitemap,
  listados, AdSense). La usan:
    - admin/pipeline.js (para decidir qué validar antes de guardar)
    - admin/server.js (para decidir qué archivo generar/borrar por
      artículo al guardar)
    - admin/pagegen.js (para las grillas de categoría/portada/sitemap)
  Su espejo exacto en Python es un bloque de funciones equivalente
  al principio de admin/generate_pages.py (no se puede compartir un
  módulo entre Node y Python, así que la paridad se sostiene con la
  prueba automática de admin/test-parity.js — cualquier cambio acá
  DEBE reflejarse ahí también).

  Historial (protección permanente del panel, sept. 2026):
  - Hasta acá, un artículo solo tenía dos estados de facto: con cuerpo
    = publicado, draftIncomplete=true = borrador sin publicar. No
    existía un paso intermedio de revisión humana entre "se generó con
    IA/RSS" y "está en articulos.json apareciendo en el sitio".
  - Se agrega `status` (draft/review/approved/published/redirected)
    como el campo explícito que gobierna esto. Los 169 artículos reales
    de antes de este cambio NO tienen `status` -- se tratan como
    'published' por compatibilidad (ver effectiveStatus): no hace falta
    tocarlos uno por uno para que el sitio siga funcionando igual.
*/

var EDITORIAL_STATUSES = ['draft', 'review', 'approved', 'published', 'redirected'];

// Estado "efectivo" de un artículo, resolviendo compatibilidad con
// datos de antes de este esquema:
// - Si trae un `status` reconocido, se usa tal cual.
// - Si no, pero tiene `draftIncomplete: true` (fase 4, 2026-09-12), es
//   'draft' -- incompleto, guardado pero nunca publicado.
// - Si no tiene ninguno de los dos campos, es un artículo de antes de
//   este esquema (o un objeto suelto sin metadata editorial): se trata
//   como 'published' para no desaparecer del sitio solo por no tener
//   el campo nuevo.
function effectiveStatus(article) {
  if (article && EDITORIAL_STATUSES.indexOf(article.status) !== -1) return article.status;
  if (article && article.draftIncomplete) return 'draft';
  return 'published';
}

// ¿Genera una página de ARTÍCULO real (con su contenido propio) y
// participa de los listados normales? Solo 'published'. 'redirected'
// genera una página, pero no es "contenido" -- ver isRedirectArticle.
function isPublicArticle(article) {
  return effectiveStatus(article) === 'published';
}

// ¿Genera una página de REDIRECCIÓN hacia otro artículo? Requiere
// tanto el estado como el campo redirectTo (sin uno de los dos no hay
// nada a donde redirigir).
function isRedirectArticle(article) {
  return effectiveStatus(article) === 'redirected' && !!(article && article.redirectTo);
}

// "Listable": debe aparecer en portada, categorías, Trending, Latest,
// buscador interno y sitemap.xml. Un artículo published+noindex sigue
// teniendo página propia navegable (isPublicArticle=true) pero nunca
// queda enlazado ni en el sitemap -- mismo criterio que ya regía antes
// de este cambio para "noindex", ahora factorizado acá para no
// duplicarlo en cada listado.
function isListable(article) {
  return isPublicArticle(article) && !(article && article.noindex);
}

// ¿Debe cargar AdSense? Mismo criterio que isListable() (auditoría
// 2026-09-11: un noindex no debe monetizarse aunque sea navegable por
// URL directa; un draft/review/approved/redirect no es contenido
// terminado y tampoco debería).
function loadsAdsense(article) {
  return isListable(article);
}

module.exports = {
  EDITORIAL_STATUSES: EDITORIAL_STATUSES,
  effectiveStatus: effectiveStatus,
  isPublicArticle: isPublicArticle,
  isRedirectArticle: isRedirectArticle,
  isListable: isListable,
  loadsAdsense: loadsAdsense
};
