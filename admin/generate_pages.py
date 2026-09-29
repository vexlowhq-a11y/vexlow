# -*- coding: utf-8 -*-
"""
Generador de páginas — VexlowHQ
================================
Genera:
  - Páginas de categoría y de tema, dentro de categoria/
  - Páginas de artículo individuales, dentro de categoria/{categoria}/
  - Páginas estáticas (About VexlowHQ, Legal, etc.) sueltas en la raíz

Sitio en inglés (público de EE.UU.).

Cómo correrlo (doble clic en regenerate-pages.bat, o desde la terminal):
    python admin/generate_pages.py

No hace falta instalar nada, usa solo la librería estándar de Python.
"""

import hashlib
import html
import json
import os
import re
import time

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(PROJECT, "img")
DATA_DIR = os.path.join(PROJECT, "data")
CATEGORIA_DIR = os.path.join(PROJECT, "categoria")
ARTICULOS_JSON = os.path.join(DATA_DIR, "articulos.json")
ARTICULOS_ASSET = "data/articulos.js"
SOURCE_INDEX = os.path.join(PROJECT, "index.html")
SITE_URL = "https://vexlowhq.com"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".avif", ".svg"}

# Estados editoriales de un artículo -- ESPEJO EXACTO de admin/article-status.js
# ==============================================================================
# No se puede compartir un módulo entre Node y Python, así que este bloque
# tiene que reproducir función por función lo que hay en article-status.js.
# Cualquier cambio ahí DEBE reflejarse acá también -- lo verifica
# admin/test-parity.js corriendo ambos generadores sobre los mismos datos y
# comparando el árbol de salida byte a byte.
EDITORIAL_STATUSES = ["draft", "review", "approved", "published", "redirected"]


def effective_status(article):
    """Estado "efectivo", resolviendo compatibilidad con datos de antes de
    este esquema (ver article-status.js para la explicación completa)."""
    status = article.get("status") if article else None
    if status in EDITORIAL_STATUSES:
        return status
    if article and article.get("draftIncomplete"):
        return "draft"
    return "published"


def is_public_article(article):
    """¿Genera una página de ARTÍCULO real y participa de los listados
    normales? Solo 'published'."""
    return effective_status(article) == "published"


def is_redirect_article(article):
    """¿Genera una página de REDIRECCIÓN hacia otro artículo?"""
    return effective_status(article) == "redirected" and bool(article and article.get("redirectTo"))


def is_listable(article):
    """Debe aparecer en portada/categorías/Trending/Latest/buscador/sitemap."""
    return is_public_article(article) and not (article and article.get("noindex"))


def loads_adsense(article):
    """¿Debe cargar AdSense? Mismo criterio que is_listable()."""
    return is_listable(article)

# Por debajo de esta cantidad de artículos propios, una página de categoría
# se marca noindex,follow y se saca del sitemap -- hasta que tenga contenido
# propio suficiente para sostenerse sola (ver generate(), fase de categorías).
MIN_CATEGORY_ARTICLES = 5
SITE_NAME = "VexlowHQ"
DEFAULT_AUTHOR = "Leonardo Beltran"
LOGO_PATH = "img/vexlow-logo.png"  # relativo a la raíz del sitio

# Las categorías viven en data/categories.json -- la misma fuente que
# usa el panel de administración (admin/pagegen.js) para poder agregar,
# renombrar o eliminar categorías sin tocar este script. CATEGORY_SLUGS/
# CATEGORY_LABELS/DESCRIPTIONS se derivan acá una sola vez (este script
# es un comando de una sola corrida, no un servidor de larga duración,
# así que no hace falta releer el archivo en cada uso como sí hace el
# panel) manteniendo la forma que ya esperaba el resto del script.
CATEGORIES_FILE = os.path.join(DATA_DIR, "categories.json")
with open(CATEGORIES_FILE, "r", encoding="utf-8") as _f:
    _CATEGORIES_DATA = json.load(_f)

CATEGORY_SLUGS = []
CATEGORY_LABELS = {}
DESCRIPTIONS = {}
for _cat in _CATEGORIES_DATA:
    _entry = {"slug": _cat["slug"], "icon": _cat["icon"]}
    if _cat.get("hasNote"):
        _entry["has_note"] = True
    if _cat.get("imgFolder"):
        _entry["img_folder"] = _cat["imgFolder"]
    # publicMinArticles (auditoria 2026-09-12, categorias ocultas hasta
    # tener contenido real: Cybersecurity/Guides) y retiredForNewContent
    # (auditoria 2026-09-12, Sports/Entertainment dejan de aceptar
    # noticias nuevas) se llevan tal cual desde data/categories.json --
    # ver is_category_publicly_visible() mas abajo y CATEGORIES_ACCEPTING_NEW_CONTENT.
    if _cat.get("publicMinArticles"):
        _entry["public_min_articles"] = _cat["publicMinArticles"]
    if _cat.get("retiredForNewContent"):
        _entry["retired_for_new_content"] = True
    CATEGORY_SLUGS.append(_entry)
    CATEGORY_LABELS[_cat["slug"]] = _cat["label"]
    DESCRIPTIONS[_cat["slug"]] = _cat.get("description", "")

# Categorías habilitadas para contenido NUEVO (panel: selector de
# categoría al crear/editar un artículo, buscador de temas nuevos en
# feeds.js) -- auditoria 2026-09-12. Sports y Entertainment quedan fuera
# de esta lista (retiredForNewContent) pero conservan sus artículos
# existentes, su página de categoría y sus enlaces internos intactos --
# esto NO cambia su indexación ni borra nada, solo deja de ofrecerlas
# para escribir notas nuevas. Ver la misma lista en pagegen.js (Node),
# CATEGORIES_ACCEPTING_NEW_CONTENT, que tiene que coincidir exactamente.
CATEGORIES_ACCEPTING_NEW_CONTENT = [
    c["slug"] for c in CATEGORY_SLUGS
    if c["slug"] != "trending" and not c.get("retired_for_new_content")
]


def is_category_publicly_visible(cat, count_by_slug):
    """ Una categoria con publicMinArticles (Cybersecurity/Guides mientras
        no tengan contenido real, auditoria 2026-09-12) no aparece en nav/
        footer/chips ni genera su pagina de categoria hasta alcanzar ese
        minimo de articulos publicables e indexables (mismo criterio que
        cat_items/articles_by_category: publicado y no noindex). Toda
        categoria SIN publicMinArticles se comporta exactamente igual que
        antes (siempre visible) -- esto incluye Sports/Entertainment, que
        siguen totalmente visibles y navegables, solo dejan de aceptar
        notas nuevas (ver CATEGORIES_ACCEPTING_NEW_CONTENT arriba). Mismo
        criterio, mismo nombre de función en espíritu, que
        isCategoryPubliclyVisible en pagegen.js (Node). """
    minimum = cat.get("public_min_articles")
    if not minimum:
        return True
    return count_by_slug.get(cat["slug"], 0) >= minimum

UI_STRINGS = {
    "home": "Home", "loading": "Loading…",
    "trending_note": "These are the articles marked as Trending from the admin panel. If none are marked yet, you'll see the most recent stories across all categories.",
    "search_placeholder": "Search a topic by name...", "no_topic_results": "We couldn't find a topic with that name.",
    "see_full_coverage": "See full coverage →", "topics_we_cover": "📌 Topics we cover",
    "all_coverage_of": "All VexlowHQ coverage of {topic}.",
    "everything_about": "Everything we've published about {topic}, in one place.",
    "latest_news": "📰 Latest News", "most_talked_about": "📰 What's Trending",
    "byline": "Leonardo Beltran", "share": "Share",
    "want_more_about": "Want more news about <strong>{topic}</strong>?",
    "you_might_also_like": "📌 You might also like",
    "months": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    "date_format": "{month} {d}, {y}",
    "view_more_cards": "See full coverage",
}


# ============================================================================
# STATIC_PAGES — páginas sueltas de una sola pantalla (About VexlowHQ, Legal,
# etc.), viven en la raíz del sitio, igual que index.html.
# ============================================================================
STATIC_PAGES = [
    {"slug": "about-vexlowhq", "label": "About VexlowHQ"},
    {"slug": "editorial-policy", "label": "Editorial Policy"},
    {"slug": "contact", "label": "Contact"},
    {"slug": "advertise", "label": "Advertise With Us"},
    {"slug": "privacy", "label": "Privacy"},
    {"slug": "terms", "label": "Terms"},
    {"slug": "cookies", "label": "Cookies"},
]

STATIC_PAGE_DESCRIPTIONS = {
    "about-vexlowhq": "Who we are and what VexlowHQ is.",
    "editorial-policy": "How we choose, write, and correct what we publish.",
    "contact": "How to get in touch with VexlowHQ.",
    "advertise": "Ad placements and contact info for advertisers.",
    "privacy": "What information we collect and how we use it.",
    "terms": "Terms and conditions for using VexlowHQ.",
    "cookies": "What cookies we use and how to manage them.",
}

# Lista de categorías (sin Trending, que es más una vista que un tema) en
# prosa, para las páginas estáticas de about/etc -- se arma dinámicamente
# desde data/categories.json en vez de quedar hardcodeada, para no tener
# que acordarse de editar esto también al agregar/sacar una categoría.
_NUMBER_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
                 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve"}


def _category_labels_list():
    return [CATEGORY_LABELS[c["slug"]] for c in CATEGORY_SLUGS if c["slug"] != "trending"]


# Marcadores (paridad Node/Python, 2026-09-27): estas dos frases de prosa
# (about-vexlowhq.html/advertise.html) enumeran las categorías desde
# data/categories.json igual que el nav -- pero admin/pagegen.js (Node)
# nunca reescribe el CUERPO de las páginas institucionales, solo su
# sidebar/footer/consent compartidos (ver syncSharedShellPage). Sin un
# marcador que delimite exactamente la parte dinámica, un rename de
# categoría (ej.: Entertainment -> Movies, TV & Anime) quedaba
# desincronizado para siempre en estas dos frases del lado Node, aunque
# el nav ya estuviera correcto -- es la misma causa raíz que el nav
# viejo, aplicada a estas dos oraciones puntuales. pagegen.js porta
# category_list_sentence()/category_list_lowercase_sentence() carácter
# por carácter (incluida esta envoltura de marcadores) y usa los mismos
# marcadores para parchear en el lugar -- ver syncCategoryListSentences().
CATEGORY_LIST_SENTENCE_START = "<!-- CATEGORY_LIST_SENTENCE:START -->"
CATEGORY_LIST_SENTENCE_END = "<!-- CATEGORY_LIST_SENTENCE:END -->"
CATEGORY_LIST_LOWERCASE_START = "<!-- CATEGORY_LIST_LOWERCASE:START -->"
CATEGORY_LIST_LOWERCASE_END = "<!-- CATEGORY_LIST_LOWERCASE:END -->"


def _category_list_sentence():
    labels = _category_labels_list()
    if len(labels) > 1:
        joined = ", ".join(labels[:-1]) + ", and " + labels[-1]
    else:
        joined = labels[0] if labels else ""
    count_word = _NUMBER_WORDS.get(len(labels), str(len(labels)))
    sentence = "We publish across {} categories: {}. Every day we add news, guides, and analysis built for readers who want to stay current without hunting across a dozen sites.".format(count_word, joined)
    return CATEGORY_LIST_SENTENCE_START + sentence + CATEGORY_LIST_SENTENCE_END


def _category_list_lowercase_sentence():
    labels = [l.lower() for l in _category_labels_list()]
    if len(labels) > 1:
        joined = ", ".join(labels[:-1]) + ", and " + labels[-1]
    else:
        joined = labels[0] if labels else ""
    return CATEGORY_LIST_LOWERCASE_START + joined + CATEGORY_LIST_LOWERCASE_END


STATIC_PAGE_BODIES = {
    "about-vexlowhq": [
        ("p", "VexlowHQ started with a simple idea: bring the most interesting things happening in the world into one place, whether that's artificial intelligence, a big game launch, a scientific discovery, or the story everyone's talking about on social media."),
        ("h2", "What we cover"),
        ("p", _category_list_sentence()),
        ("h2", "Who's behind it"),
        ("p", "VexlowHQ was created and is maintained by Leonardo Beltran, a web developer who has been building software professionally since graduating in 2016. That technical background — working with modern web technologies and digital systems day to day — shapes how VexlowHQ approaches AI tools, software trends, and tech developments: every article is reviewed with a developer's eye for accuracy and real-world relevance before it goes live."),
        ("h2", "How we work"),
        ("p", "We're an independent, still-small project. We use AI tools to help us research and draft faster, but every story is reviewed before it goes live. Being upfront about that is part of doing this right, even at our size."),
        ("h2", "Where we're headed"),
        ("p", "The goal is simple: grow one story at a time, keep raising the bar on quality, and build a source people can trust to keep them current without wasting their time."),
    ],
    "editorial-policy": [
        ("h2", "How we choose what to publish"),
        ("p", "We prioritize timely, relevant stories that matter to our readers: major launches, tech breakthroughs, sports results, and the moments generating real conversation in each of our categories."),
        ("h2", "Our use of AI"),
        ("p", "Part of our writing process is assisted by AI tools to speed up research and drafting. Nothing goes live without human review: we check facts, edit, and refine the text before publishing. We're saying this here because we believe readers deserve to know."),
        ("h2", "Corrections"),
        ("p", "If you spot an error in a story, reach out through our <a href=\"contact.html\">contact page</a> and we'll fix it as soon as we can. For significant corrections, we leave a visible note on the updated article."),
        ("h2", "Advertising and content"),
        ("p", "VexlowHQ is supported by advertising (including Google AdSense). Ads are always clearly labeled and kept separate from editorial content. If we ever publish sponsored content, it will be clearly marked as such."),
    ],
    "contact": [
        ("p", "Have a correction, a suggestion, or just want to reach out? This is the place."),
        ("h2", "General inquiries"),
        ("p", "Email us at <a href=\"mailto:contact@vexlowhq.com\">contact@vexlowhq.com</a> and we'll get back to you as soon as we can."),
        ("h2", "Advertising inquiries"),
        ("p", "Looking to advertise on VexlowHQ? Visit <a href=\"advertise.html\">Advertise With Us</a> or email us directly at <a href=\"mailto:ads@vexlowhq.com\">ads@vexlowhq.com</a>."),
    ],
    "advertise": [
        ("h2", "Why advertise on VexlowHQ"),
        ("p", "VexlowHQ is a content discovery site covering {} — built for a general audience that wants to stay current.".format(_category_list_lowercase_sentence())),
        ("h2", "Available formats"),
        ("ul", [
            "Display ad placements integrated into the article feed and category pages.",
            "Placement targeting specific categories based on your target audience.",
            "Sponsored content, always clearly labeled as such.",
        ]),
        ("h2", "How to get started"),
        ("p", "Email <a href=\"mailto:ads@vexlowhq.com\">ads@vexlowhq.com</a> and tell us what you're looking for — we'll follow up with options and availability."),
    ],
    "privacy": [
        ("h2", "Information we collect"),
        ("p", "VexlowHQ doesn't require you to register or create an account to read our content. We don't collect personal data directly, beyond the standard technical information any website receives from a visit (like browser type or the page you came from)."),
        ("h2", "Cookies and advertising"),
        ("p", "We use first-party and third-party cookies to run the site and to show advertising. We use Google Analytics (GA4) to measure aggregate traffic and understand how the site is used, and we use or may use Google AdSense, which uses cookies to serve ads based on your prior visits to this and other websites."),
        ("ul", [
            "Essential cookies: needed for the site to work correctly.",
            "Analytics cookies: help us understand how the site is used, in aggregate and anonymously.",
            "Advertising cookies: used by Google AdSense and other providers to show relevant ads.",
        ]),
        ("h2", "Consent Mode and your choices"),
        ("p", "VexlowHQ uses Google's Consent Mode, which is set to deny ad storage, ad personalization, and analytics storage by default for every visitor, unless and until you explicitly grant consent through our consent banner. Our consent management platform is published and active in Google AdSense; its integration with this site is being verified following our most recent deployment. Until that verification is complete, no advertising or analytics cookies that require consent are set. Once verified, you'll be able to review or withdraw your consent at any time using the \"Privacy Preferences\" link in the site footer. You can also delete or block cookies from your browser settings at any time, and manage Google's personalized advertising at <a href=\"https://adssettings.google.com\" target=\"_blank\" rel=\"noopener\">adssettings.google.com</a>."),
        ("h2", "Changes to this policy"),
        ("p", "We may update this privacy policy from time to time. We'll post any significant changes on this same page."),
        ("h2", "Contact"),
        ("p", "If you have questions about this policy, email us at <a href=\"mailto:contact@vexlowhq.com\">contact@vexlowhq.com</a>."),
    ],
    "terms": [
        ("h2", "Acceptance of terms"),
        ("p", "By using VexlowHQ, you agree to these terms of use. If you don't agree, please don't use the site."),
        ("h2", "Use of content"),
        ("p", "Content published on VexlowHQ is for informational and entertainment purposes only. It should not be treated as professional, financial, medical, or legal advice."),
        ("h2", "Intellectual property"),
        ("p", "Text, graphics, and the design of VexlowHQ are the property of VexlowHQ unless otherwise noted. Reproducing content without permission isn't allowed, beyond brief quotes with proper attribution and a link back to the original story."),
        ("h2", "Links to other sites"),
        ("p", "VexlowHQ may include links to third-party sites. We're not responsible for the content or privacy practices of those sites."),
        ("h2", "Limitation of liability"),
        ("p", "We do our best to keep published information accurate, but we don't guarantee it's always error-free. VexlowHQ isn't liable for decisions made based on the site's content."),
        ("h2", "Changes to these terms"),
        ("p", "We may change these terms at any time. Changes take effect as soon as they're posted on this page."),
        ("h2", "Contact"),
        ("p", "Questions about these terms? Email us at <a href=\"mailto:contact@vexlowhq.com\">contact@vexlowhq.com</a>."),
    ],
    "cookies": [
        ("h2", "What cookies are"),
        ("p", "Cookies are small text files that websites store in your browser to remember information about your visit."),
        ("h2", "Cookies we use"),
        ("ul", [
            "Essential: let the site function (e.g., remembering your light/dark mode preference).",
            "Analytics: we use Google Analytics (GA4) to help us understand which content performs best, in aggregate.",
            "Advertising: used by Google AdSense and other ad providers to show relevant advertising based on your interests.",
        ]),
        ("h2", "Consent Mode and managing cookies"),
        ("p", "VexlowHQ uses Google's Consent Mode, which blocks non-essential (analytics and advertising) cookies by default for every visitor, unless and until you explicitly grant consent. Our consent banner is published and active in Google AdSense; its integration with this site is being verified following our most recent deployment. Until that verification is complete, no cookie that requires consent is set. Once verified, you'll be able to review or change your choice at any time using the \"Privacy Preferences\" link in the site footer. You can also delete or block cookies from your browser settings at any time — note that blocking some cookies may affect how the site works — and manage Google's personalized advertising at <a href=\"https://adssettings.google.com\" target=\"_blank\" rel=\"noopener\">adssettings.google.com</a>."),
        ("h2", "More information"),
        ("p", "For more details on how we handle your information, see our <a href=\"privacy.html\">Privacy Policy</a>."),
    ],
}


def camel_to_label(name):
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    return spaced.replace("_", " ").replace("-", " ").strip()


# ============================================================================
# Nav de categorías (sidebar, footer, chips de filtro) -- se reconstruye acá
# desde data/categories.json cada vez que se corre el generador, en vez de
# quedar escrito a mano en index.html, así una categoría agregada/renombrada/
# eliminada desde el panel se ve en todo el sitio con solo publicar.
# ============================================================================

def build_category_nav_html(visible_cats=None):
    if visible_cats is None:
        visible_cats = CATEGORY_SLUGS
    items = [
        '      <div class="cat-item">\n'
        '        <div class="cat-row">\n'
        '          <a class="cat-link" href="index.html" data-cat="index"><span class="ic">🏠</span>Home</a>\n'
        '        </div>\n'
        '      </div>',
        '      <div class="cat-item">\n'
        '        <div class="cat-row">\n'
        '          <a class="cat-link" href="play/index.html" data-cat="play"><span class="ic">🎮</span>Games</a>\n'
        '        </div>\n'
        '      </div>',
    ]
    for cat in visible_cats:
        slug = cat["slug"]
        label = html.escape(CATEGORY_LABELS[slug])
        items.append(
            '      <div class="cat-item">\n'
            '        <div class="cat-row">\n'
            '          <a class="cat-link" href="categoria/{slug}/index.html" data-cat="{slug}"><span class="ic">{icon}</span>{label}</a>\n'
            '        </div>\n'
            '      </div>'.format(slug=slug, icon=cat["icon"], label=label)
        )
    return "\n\n".join(items) + "\n"


def build_footer_categories_html(visible_cats=None):
    if visible_cats is None:
        visible_cats = CATEGORY_SLUGS
    mid = (len(visible_cats) + 1) // 2
    first_half = visible_cats[:mid]
    second_half = visible_cats[mid:]

    def links_for(cats):
        return "\n".join(
            '          <a href="categoria/{slug}/index.html">{label}</a>'.format(
                slug=c["slug"], label=html.escape(CATEGORY_LABELS[c["slug"]])
            )
            for c in cats
        )

    return (
        '<div class="footer-col">\n'
        '          <h4>Categories</h4>\n'
        '{links1}\n'
        '        </div>\n'
        '        <div class="footer-col">\n'
        '          <h4>More categories</h4>\n'
        '{links2}\n'
        '        </div>\n        '
    ).format(links1=links_for(first_half), links2=links_for(second_half))


def build_filter_chips_html(visible_cats=None):
    if visible_cats is None:
        visible_cats = CATEGORY_SLUGS
    chips = ['        <button type="button" class="filter-chip active" data-filter="all">All</button>']
    for cat in visible_cats:
        if cat["slug"] == "trending":
            continue
        chips.append(
            '        <button type="button" class="filter-chip" data-filter="{slug}">{icon} {label}</button>'.format(
                slug=cat["slug"], icon=cat["icon"], label=html.escape(CATEGORY_LABELS[cat["slug"]])
            )
        )
    return "\n".join(chips) + "\n      "


def replace_between(html_text, start_marker, end_marker, new_inner):
    start = html_text.index(start_marker) + len(start_marker)
    end = html_text.index(end_marker, start)
    return html_text[:start] + "\n" + new_inner + html_text[end:]


# Google Consent Mode v2 + carga de GA4/AdSense -- bloque UNICO, centralizado
# aqui (auditoria global, 2026-09-09). Antes este mismo bloque estaba pegado
# a mano en 11 lugares distintos de este archivo (uno por plantilla) mas 2
# en pagegen.js -- 13 puntos independientes donde una futura edicion podia
# quedar inconsistente. Ahora se define una sola vez y se inserta via
# {consent_ads_block} en cada plantilla ".format()"; pagegen.js define el
# mismo contenido, caracter por caracter, en su propia constante
# CONSENT_BASE_BLOCK / ADSENSE_SCRIPT_TAG (ver la nota alli para como se
# mantienen sincronizadas).
#
# Un solo dataLayer/gtag: el "consent default" (denegado) se fija ANTES de
# solicitar gtag.js y adsbygoogle.js (los <script async> de abajo), tal como
# exige Consent Mode v2 -- las llamadas a gtag() quedan encoladas en
# dataLayer hasta que gtag.js las procese al cargar. Una sola carga de GA4
# (gtag.js) por pagina, siempre. AdSense (adsbygoogle.js) es CONDICIONAL
# (auditoria 2026-09-11, control de monetizacion): el bloque se partio en
# dos piezas -- CONSENT_BASE_BLOCK (GA4 + Consent Mode, siempre presente,
# nunca cambia segun la pagina) y ADSENSE_SCRIPT_TAG (la carga de
# adsbygoogle.js, que se agrega o se omite segun corresponda). La funcion
# consent_block_for(load_ads) devuelve una u otra combinacion; CONSENT_ADS_BLOCK
# se mantiene como alias de consent_block_for(True) para no tocar los
# puntos de uso que siempre deben llevar anuncios (portada, categorias,
# paginas de juegos, y las paginas estaticas que no sean privacy/cookies).
# Los artículos con noindex=true (auditoria editorial en curso o fusionados
# con redirect) y las paginas privacy.html/cookies.html llaman a
# consent_block_for(False) -- sin adsbygoogle.js, sin bloques publicitarios,
# pero con GA4/Consent Mode intactos.
#
# Estado (actualizado 2026-09-11): CMP publicada en AdSense; integracion con
# el nuevo Consent Mode pendiente de prueba posterior al deploy. Se confirmo
# directamente en la cuenta de AdSense que el mensaje "European regulations
# message - vexlowhq.com" existe, esta en Estado: Publicado, en ingles + 31
# idiomas (ultima modificacion 2026-08-15). Lo que todavia NO esta
# confirmado es que `window.googlefc` se inyecte y conecte correctamente con
# las llamadas gtag('consent','update', ...) de abajo en el sitio ya
# desplegado -- eso requiere la prueba manual descrita en
# verificacion-consentimiento-post-activacion.md. Hasta confirmar esa
# prueba, el consentimiento se queda en "denied" por defecto para todos los
# usuarios (no solo EEE/UK/Suiza) cada vez que `window.googlefc` todavia no
# esta presente, lo cual es la postura mas conservadora posible y nunca
# carga cookies de anuncios/analitica sin consentimiento explicito.
#
# "Reabrir preferencias": el enlace "Privacy Preferences" del footer (ver
# build_footer o el pie de index.html) llama a
# window.vexlowReopenConsentPreferences(), definida abajo. Si `window.googlefc`
# ya esta disponible (CMP integrada y cargada en esa visita), esa funcion abre
# el dialogo real de revocacion de consentimiento de Google (API publica y
# documentada: `googlefc.showRevocationMessage()`). Si todavia no esta
# disponible -- por ejemplo, porque la integracion en produccion aun no se
# probo -- informa al usuario en vez de fallar silenciosamente.
CONSENT_BASE_BLOCK = """<script>
  /* Google Consent Mode v2 -- unica inicializacion de dataLayer/gtag de toda
     la pagina. Consentimiento por defecto: denegado para TODAS las
     regiones (postura conservadora mientras no se confirme que la CMP
     publicada en AdSense esta integrada y funcionando en produccion),
     hasta que el usuario decida vía la CMP.

     Modo preview local (auditoria 2026-09-12): en localhost/127.0.0.1 no
     se cargan externamente gtag.js, el script de AdSense (adsbygoogle)
     ni Funding Choices/googlefc (bloqueo a nivel de solicitud de red -- los <script src>
     reales nunca se insertan en el DOM -- no un ocultamiento visual con
     CSS) para no ensuciar Analytics ni gastar cuota de anuncios con
     trafico de desarrollo. En cualquier otro hostname (produccion,
     previews de Vercel, etc.) el comportamiento no cambia: se sigue
     cargando todo exactamente igual que antes. */
  window.VEXLOW_PREVIEW_LOCAL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  gtag('consent', 'default', {
    'ad_storage': 'denied',
    'ad_user_data': 'denied',
    'ad_personalization': 'denied',
    'analytics_storage': 'denied',
    'wait_for_update': 500
  });
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
  window.vexlowReopenConsentPreferences = function () {
    if (window.googlefc && typeof window.googlefc.showRevocationMessage === 'function') {
      window.googlefc.showRevocationMessage();
    } else {
      alert('Las preferencias de privacidad no estan disponibles en este momento. Mientras tanto, VexlowHQ no carga cookies de anuncios ni de analitica de personalizacion sin tu consentimiento.');
    }
  };
  window.vexlowLoadExternalScript = function (src, crossOrigin) {
    if (window.VEXLOW_PREVIEW_LOCAL) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    if (crossOrigin) { s.crossOrigin = crossOrigin; }
    document.head.appendChild(s);
  };
  if (window.VEXLOW_PREVIEW_LOCAL) {
    console.log('[VexlowHQ Preview] Ads, CMP and Analytics disabled on localhost');
  } else {
    window.vexlowLoadExternalScript('https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K');
  }
</script>
<!-- Estado (2026-09-11): CMP publicada en AdSense (mensaje "European
     regulations message - vexlowhq.com", Estado: Publicado, ingles + 31
     idiomas, ultima modificacion 2026-08-15). Pendiente: verificar
     posterior al deploy que `window.googlefc` se inyecta correctamente y
     que conecta con las llamadas gtag('consent', 'update', ...) de arriba
     (procedimiento completo en verificacion-consentimiento-post-activacion.md).
     Hasta confirmar esa prueba, Consent Mode se queda en el valor por
     defecto "denied" de arriba para todas las regiones cada vez que
     `window.googlefc` no este presente. -->
"""

# Carga de AdSense -- se agrega o se omite segun consent_block_for(load_ads)
# de abajo. NUNCA se inserta en paginas noindex (auditoria editorial en
# curso o articulos fusionados con redirect) ni en privacy.html/cookies.html
# (auditoria 2026-09-11, control de monetizacion en paginas no indexables).
# Se inserta via window.vexlowLoadExternalScript (definida en
# CONSENT_BASE_BLOCK, que siempre precede a este bloque) en vez de un
# <script src> estatico, para que quede sujeto al mismo bloqueo de red en
# localhost/127.0.0.1 (auditoria 2026-09-12, modo preview local).
ADSENSE_SCRIPT_TAG = (
    "<script>window.vexlowLoadExternalScript('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"
    "?client=ca-pub-9714873159823978', 'anonymous');</script>\n"
)


def consent_block_for(load_ads):
    """ Bloque de <head> a insertar via {consent_ads_block}: GA4 + Consent
        Mode siempre presentes; adsbygoogle.js solo si load_ads es True.
        load_ads=False para articulos noindex y para privacy.html/cookies.html. """
    return CONSENT_BASE_BLOCK + (ADSENSE_SCRIPT_TAG if load_ads else "")


# Alias para los puntos de uso que siempre llevan anuncios (portada,
# categorias, paginas de juegos, y las paginas estaticas que no sean
# privacy/cookies) -- no hace falta tocarlos, se comportan igual que antes.
CONSENT_ADS_BLOCK = consent_block_for(True)


# Cache-busting DETERMINISTA para los <script src="...js?v=..."> de las
# paginas de juegos (auditoria 2026-09-11): antes se usaba
# str(int(time.time())) -- un timestamp del momento en que corria el
# generador, que cambiaba en CADA regeneracion aunque el .js del juego no
# se haya tocado. Eso hacia que "correr el generador dos veces seguidas
# sin cambios" nunca diera cero diferencias en las 6 paginas de juegos, lo
# cual ensucia cualquier verificacion de sincronizacion basada en hashes.
# Ahora la version es un hash corto (10 hex) del contenido real del/los
# archivo(s) .js del juego: cambia solo cuando ese asset cambia, e
# idéntico input (mismos .js) siempre da idéntico output.
def js_asset_version(*relative_js_paths):
    h = hashlib.sha256()
    for rel in relative_js_paths:
        try:
            with open(os.path.join(PROJECT, rel), "rb") as f:
                h.update(f.read())
        except OSError:
            # Si el archivo no existe (no debería pasar en un checkout
            # normal), no rompemos la generación -- el hash simplemente
            # no incluye ese archivo, y sigue siendo determinista.
            pass
    return h.hexdigest()[:10]


CATEGORY_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{label} — VexlowHQ</title>
<meta name="description" content="{desc}">
{robots_meta}<link rel="stylesheet" href="{asset_prefix}css/style.css">
<link rel="icon" type="image/x-icon" href="{asset_prefix}favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="{asset_prefix}favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="{asset_prefix}favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="{asset_prefix}apple-touch-icon.png">
{seo_head}
{consent_ads_block}</head>
<body data-category="{slug}">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../../index.html">{home}</a><span class="sep">/</span><span class="current">{label}</span>
    </nav>

    <div class="category-header">
      <span class="ic-badge">{icon}</span>
      <div>
        <h1>{icon} {label}</h1>
        <p>{desc}</p>
        <span class="count" id="categoryCount">{count_label}</span>
      </div>
    </div>
{note_block}
{search_block}
{topics_block}
{feed_block}
{footer_block}

  </main>
</div>

<script src="{asset_prefix}{articulos_asset}"></script>
<script src="{asset_prefix}js/script.js"></script>
</body>
</html>
"""



def apply_inline(text):
    """ "**texto**" -> <strong>texto</strong>, dentro de párrafos, subtítulos,
        ítems de lista y pies de foto (nunca dentro del atributo alt). """
    return re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)


def render_article_body(body, asset_prefix=""):
    html = ""
    for block in body:
        kind, content = block[0], block[1]
        if kind == "p":
            html += "      <p>{}</p>\n".format(apply_inline(content))
        elif kind == "h2":
            html += "      <h2>{}</h2>\n".format(apply_inline(content))
        elif kind == "ul":
            html += "      <ul>\n"
            for item in content:
                html += "        <li>{}</li>\n".format(apply_inline(item))
            html += "      </ul>\n"
        elif kind == "ad":
            pass  # los espacios publicitarios se sacaron del sitio hasta tener AdSense aprobado
        elif kind == "img":
            alt, src = content
            alt_esc = alt.replace('"', "&quot;")
            html += '      <figure class="article-inline-image"><img src="{}{}" alt="{}" loading="lazy">'.format(asset_prefix, src, alt_esc)
            if alt:
                html += "<figcaption>{}</figcaption>".format(apply_inline(alt))
            html += "</figure>\n"
    return html


def youtube_embed_url(url):
    if not url:
        return None
    m = re.search(r"(?:youtube\.com/(?:watch\?v=|embed/|shorts/)|youtu\.be/)([a-zA-Z0-9_-]{11})", url)
    return "https://www.youtube.com/embed/" + m.group(1) if m else None


def video_embed_url(url):
    """ Primero prueba si es un link de YouTube (arma la URL de embed
        canónica). Si no, y el link ya es una URL http(s) válida, se usa
        directo como src del iframe — así funcionan links de embed de
        Vimeo, JWPlayer, y otros reproductores de video. """
    if not url:
        return None
    yt = youtube_embed_url(url)
    if yt:
        return yt
    if re.match(r"^https?://", url.strip()):
        return url.strip()
    return None


def image_credit_html_for(art):
    """ Crédito visible bajo la imagen destacada -- solo si el artículo
        trae 'imageCredit' cargado (inventario de imágenes, auditoría de
        derechos de sept. 2026). No inventa un crédito si no está
        registrado: mejor sin caption que uno incorrecto. """
    if not art.get("imageCredit"):
        return ""
    return '      <p class="image-credit" style="font-size:12px;color:var(--text-muted,#777);margin:4px 0 0;">{}</p>\n'.format(art["imageCredit"])


def banner_html_for(art, cat, asset_prefix):
    embed_url = video_embed_url(art.get("videoUrl") or art.get("video"))
    if embed_url:
        return (
            '      <div class="article-banner video-wrap">\n'
            '        <iframe src="{}" title="{}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>\n'
            '      </div>\n'
        ).format(embed_url, art["title"].replace('"', "&quot;"))
    if art.get("image"):
        # La imagen se mantiene como fondo CSS (decisión de diseño ya
        # tomada), pero es informativa -- necesita un equivalente
        # accesible para lectores de pantalla. No hay un campo "alt"
        # propio todavía, así que se usa el título del artículo (mejor
        # una descripción genérica pero real que ninguna).
        alt_text = (art.get("imageAlt") or art["title"]).replace('"', "&quot;")
        return '      <div class="article-banner media {}" role="img" aria-label="{}" style="background-image:url(\'{}{}\');background-size:cover;background-position:center;"></div>\n'.format(cat["slug"], alt_text, asset_prefix, art["image"]) + image_credit_html_for(art)
    return '      <div class="article-banner media {}">{}</div>\n'.format(cat["slug"], cat["icon"])


def related_articles_for(article, all_articles, limit=4):
    """ Notas relacionadas para el bloque "You might also like" al pie
        de cada artículo -- más enlaces internos y más info por página
        sin tocar el cuerpo redactado por la IA ni gastar nada extra.
        Prioridad 1: mismo `topic` (más específico, ej. "gtavi",
        "spacex"). Si faltan para completar el cupo, se rellena con
        artículos de la misma categoría, ambos ordenados por fecha
        descendente (lo más reciente primero). """
    slug = article.get("slug")
    topic = article.get("topic") or ""
    category = article.get("category")

    same_topic = [a for a in all_articles if a.get("slug") != slug and topic and a.get("topic") == topic]
    same_topic.sort(key=lambda a: a.get("date", ""), reverse=True)
    picked = same_topic[:limit]

    if len(picked) < limit:
        picked_slugs = {a["slug"] for a in picked}
        same_cat = [a for a in all_articles if a.get("slug") != slug and a.get("slug") not in picked_slugs and a.get("category") == category]
        same_cat.sort(key=lambda a: a.get("date", ""), reverse=True)
        picked += same_cat[: limit - len(picked)]

    return picked


def render_related_block(related, current_cat_slug, asset_prefix, heading):
    """ Renderiza el mismo markup de tarjeta (.card/.media/.body) que ya
        arma buildCard() en js/script.js para los rieles de Home/categoría
        -- pero server-side y con enlaces reales en el HTML crudo, para
        que quede como contenido/enlace interno real de la página (no
        algo que solo aparece si corre el JS). """
    if not related:
        return ""
    cards = []
    for r in related:
        r_cat = r.get("category", "")
        href = r["slug"] + ".html" if r_cat == current_cat_slug else "../{}/{}.html".format(r_cat, r["slug"])
        title_esc = html.escape(r.get("title", ""))
        if r.get("image"):
            media = '<span class="media {}" style="background-image:url(\'{}{}\');background-size:cover;background-position:center;"></span>'.format(r_cat, asset_prefix, r["image"])
        else:
            media = '<span class="media {}">{}</span>'.format(r_cat, r.get("icon", ""))
        meta = "{} · {} · {}".format(html.escape(r.get("categoryLabel", "")), html.escape(r.get("readTime", "")), format_date(r.get("date", "")))
        cards.append(
            '          <a class="card" href="{href}">{media}\n'
            '            <div class="body"><h3>{title}</h3><div class="meta">{meta}</div></div>\n'
            '          </a>\n'.format(href=href, media=media, title=title_esc, meta=meta)
        )
    return (
        '      <div class="related-articles">\n'
        '        <h2>{heading}</h2>\n'
        '        <div class="rail-grid">\n'
        + "".join(cards) +
        '        </div>\n'
        '      </div>\n'
    ).format(heading=heading)


def build_feed_card_html(art, asset_prefix, href, show_category=False):
    """ Tarjeta de artículo (.card), mismo markup que buildCard() en
        js/script.js -- pero volcada al HTML crudo en la generación, no
        solo agregada después por JS. Se usa en grillas de categoría y
        en los rieles de la portada. """
    cat_slug = art.get("category", "")
    title_esc = html.escape(art.get("title", ""))
    if art.get("image"):
        media = '<span class="media {}" style="background-image:url(\'{}{}\');background-size:cover;background-position:center;"></span>'.format(cat_slug, asset_prefix, art["image"])
    else:
        media = '<span class="media {}">{}</span>'.format(cat_slug, art.get("icon", ""))
    meta_bits = []
    if show_category:
        meta_bits.append(html.escape(art.get("categoryLabel", "")))
    if art.get("readTime"):
        meta_bits.append(html.escape(art["readTime"]))
    meta_bits.append(format_date(art.get("date", "")))
    meta = " · ".join(meta_bits)
    return (
        '          <a class="card" href="{href}">{media}\n'
        '            <div class="body"><h3>{title}</h3><div class="meta">{meta}</div></div>\n'
        '          </a>\n'
    ).format(href=href, media=media, title=title_esc, meta=meta)


def build_cards_grid_html(articles_list, asset_prefix, href_for, show_category=False):
    return "".join(
        build_feed_card_html(a, asset_prefix, href_for(a), show_category=show_category)
        for a in articles_list
    )


def count_label_for(n):
    return "{} article{}".format(n, "" if n == 1 else "s")


def trending_articles(all_articles):
    """ Mismo criterio que trendingArticles() en js/script.js: artículos
        marcados a mano desde el panel; si todavía no se marcó ninguno,
        los más recientes de todas las categorías para no dejar la
        sección vacía. """
    marked = [a for a in all_articles if a.get("trending")]
    marked.sort(key=lambda a: a.get("date", ""), reverse=True)
    if marked:
        return marked
    return sorted(all_articles, key=lambda a: a.get("date", ""), reverse=True)


def og_meta_block(url, title, description, image_url, page_type="article"):
    """ canonical + Open Graph + Twitter Card -- ninguna página propia
        del sitio los tenía; sin esto Google/AdSense y cualquier vista
        previa (compartir en redes) no tienen forma de saber cuál es la
        URL canónica real de cada artículo/categoría. """
    esc_title = html.escape(title, quote=True)
    esc_desc = html.escape(description or "", quote=True)
    lines = [
        '<link rel="canonical" href="{}">'.format(url),
        '<meta property="og:type" content="{}">'.format(page_type),
        '<meta property="og:site_name" content="{}">'.format(SITE_NAME),
        '<meta property="og:title" content="{}">'.format(esc_title),
        '<meta property="og:description" content="{}">'.format(esc_desc),
        '<meta property="og:url" content="{}">'.format(url),
    ]
    if image_url:
        lines.append('<meta property="og:image" content="{}">'.format(image_url))
    lines.append('<meta name="twitter:card" content="{}">'.format("summary_large_image" if image_url else "summary"))
    lines.append('<meta name="twitter:title" content="{}">'.format(esc_title))
    lines.append('<meta name="twitter:description" content="{}">'.format(esc_desc))
    if image_url:
        lines.append('<meta name="twitter:image" content="{}">'.format(image_url))
    return "\n".join(lines)


def json_ld_script(data):
    # separators=(',', ':') -- compact, matches JS's JSON.stringify(data) default
    # exactly (fixed 2026-09-07: previously used json.dumps' default spaced
    # separators, which byte-differed from pagegen.js's output for category
    # index pages -- see global editorial audit generator-consistency check).
    return '<script type="application/ld+json">' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '</script>'


def breadcrumb_json_ld(items):
    """ items: lista de (nombre, url) desde Home hasta la página actual. """
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": name, "item": url}
            for i, (name, url) in enumerate(items)
        ],
    }


def article_json_ld(art, cat, url, image_url):
    data = {
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        "headline": art["title"],
        "description": art.get("dek", ""),
        "datePublished": art["date"],
        "dateModified": art.get("dateModified") or art["date"],
        "author": {"@type": "Person", "name": DEFAULT_AUTHOR, "url": SITE_URL + "/about-vexlowhq.html"},
        "publisher": {
            "@type": "Organization",
            "name": SITE_NAME,
            "logo": {"@type": "ImageObject", "url": SITE_URL + "/" + LOGO_PATH},
        },
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
        "articleSection": cat["label"],
    }
    if image_url:
        data["image"] = [image_url]
    return data


ARTICLE_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — VexlowHQ</title>
<meta name="description" content="{dek}">
{robots_meta}<link rel="stylesheet" href="{asset_prefix}css/style.css">
<link rel="icon" type="image/x-icon" href="{asset_prefix}favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="{asset_prefix}favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="{asset_prefix}favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="{asset_prefix}apple-touch-icon.png">
{seo_head}
{consent_ads_block}</head>
<body data-category="{cat_slug}">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../../index.html">{home}</a><span class="sep">/</span><a href="index.html">{cat_label}</a>{topic_crumb}<span class="sep">/</span><span class="current">{title_short}</span>
    </nav>

    <article class="article-page">
      <span class="chip">{cat_icon} {cat_label}</span>
      <h1>{title}</h1>
      <p class="dek">{dek}</p>
      <div class="article-meta">
        <span>{byline}</span><span class="dot">·</span><span>{date_label}</span>{updated_html}<span class="dot">·</span><span>{read_time}</span>
      </div>
{correction_html}
{banner_html}
      <div class="article-body">
{body_html}      </div>
{source_html}
      <div class="article-reactions" data-article-slug="{slug}">
        <span>React</span>
        <button type="button" class="reaction-btn" data-reaction="like" aria-label="Like this article">👍 <span class="reaction-count" data-count="like">0</span></button>
        <button type="button" class="reaction-btn" data-reaction="fire" aria-label="Fire reaction">🔥 <span class="reaction-count" data-count="fire">0</span></button>
        <button type="button" class="reaction-btn" data-reaction="dislike" aria-label="Dislike this article">👎 <span class="reaction-count" data-count="dislike">0</span></button>
      </div>

      <div class="article-share">
        <span>{share}</span>
        <a href="#" data-share="x" aria-label="Share on X">X</a>
        <a href="#" data-share="whatsapp" aria-label="Share on WhatsApp">W</a>
        <a href="#" data-share="facebook" aria-label="Share on Facebook">F</a>
        <a href="#" data-share="copy" aria-label="Copy link">🔗</a>
      </div>

      <div class="article-continue">
        <p>{want_more}</p>
        <a class="see-all" href="{topic_href}">{see_full_coverage}</a>
      </div>

{related_block}
    </article>

{footer_block}

  </main>
</div>

<script src="{asset_prefix}{articulos_asset}"></script>
<script src="{asset_prefix}js/script.js"></script>
</body>
</html>
"""

STATIC_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — VexlowHQ</title>
<meta name="description" content="{desc}">
<link rel="stylesheet" href="{asset_prefix}css/style.css">
<link rel="icon" type="image/x-icon" href="{asset_prefix}favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="{asset_prefix}favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="{asset_prefix}favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="{asset_prefix}apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="{slug}">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="index.html">{home}</a><span class="sep">/</span><span class="current">{title}</span>
    </nav>

    <article class="article-page">
      <h1>{title}</h1>
      <div class="article-body" style="margin-top: 22px;">
{body_html}      </div>
    </article>

{footer_block}

  </main>
</div>

<script src="{asset_prefix}{articulos_asset}"></script>
<script src="{asset_prefix}js/script.js"></script>
</body>
</html>
"""


PLAY_HUB_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Our Games — VexlowHQ</title>
<meta name="description" content="Quick, addictive games to take a break — a new trivia question every day, plus more games on the way.">
<link rel="stylesheet" href="../css/style.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="play">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../index.html">Home</a><span class="sep">/</span><span class="current">Games</span>
    </nav>

    <article class="article-page">
      <h1>🎮 Our Games</h1>
      <p class="play-intro">Quick, addictive games to take a break — a new trivia question every day, plus more on the way.</p>

      <div class="games-grid">
        <a class="game-card" href="trivia.html">
          <img class="game-card-cover" src="../img/games/trivia-cover.jpg" alt="Daily Trivia" width="64" height="64" loading="lazy">
          <span class="game-card-desc">One quick question a day about AI, gaming, science, entertainment and more.</span>
        </a>
        <a class="game-card" href="dash.html">
          <img class="game-card-cover" src="../img/games/dash-cover.jpg" alt="Vex Dash" width="64" height="64" loading="lazy">
          <span class="game-card-desc">Tap to jump, dodge the spikes, beat your best score.</span>
        </a>
        <a class="game-card" href="snake.html">
          <img class="game-card-cover" src="../img/games/snake-cover.jpg" alt="Neon Snake Survival" width="64" height="64" loading="lazy">
          <span class="game-card-desc">Swipe to steer, eat the orbs, don't run into yourself.</span>
        </a>
        <a class="game-card" href="orbit.html">
          <img class="game-card-cover" src="../img/games/orbit-cover.jpg" alt="Neon Orbit" width="64" height="64" loading="lazy">
          <span class="game-card-desc">Tap to flip your orbit and dodge the blocks closing in.</span>
        </a>
        <a class="game-card" href="gravity.html">
          <img class="game-card-cover" src="../img/games/gravity-cover.jpg" alt="Gravity Flip" width="64" height="64" loading="lazy">
          <span class="game-card-desc">A rhythm platformer level — cube, ship, ball, key and secret coins.</span>
        </a>
        <a class="game-card" href="pulse.html">
          <img class="game-card-cover" src="../img/games/pulse-cover.jpg" alt="Color Pulse" width="64" height="64" loading="lazy">
          <span class="game-card-desc">Tap to cycle your color and match each gate as it arrives.</span>
        </a>
        <a class="game-card" href="wordsearch.html">
          <img class="game-card-cover" src="../img/games/wordsearch-cover.jpg" alt="Word Search" width="64" height="64" loading="lazy">
          <span class="game-card-desc">Drag to find every word before the clock catches up — English or Spanish.</span>
        </a>
      </div>

    </article>

{footer_block}

  </main>
</div>

<script src="../{articulos_asset}"></script>
<script src="../js/script.js"></script>
</body>
</html>
"""

PLAY_TRIVIA_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Daily Trivia — VexlowHQ Games</title>
<meta name="description" content="One quick trivia question a day, picked from AI, gaming, science, entertainment and more. Come back tomorrow for a new one.">
<link rel="stylesheet" href="../css/style.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="play">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../index.html">Home</a><span class="sep">/</span><a href="index.html">Games</a><span class="sep">/</span><span class="current">Daily Trivia</span>
    </nav>

    <article class="article-page">
      <h1>🧠 Daily Trivia</h1>
      <p class="play-intro">One trivia question a day, picked from the stuff we cover — AI, gaming, science, entertainment and more. Answer once, come back tomorrow for a new one.</p>

      <div id="triviaGame">Loading today's question…</div>

      <section class="game-guide">
        <h2>How to play</h2>
        <p>One trivia question shows up each day, pulled from the same beat we cover across the site — AI, technology, science, gaming, entertainment, sports, social media, and business. Pick an answer and you'll see immediately whether you got it right. You get one attempt per question, then it's locked until tomorrow's question replaces it.</p>
        <h2>Tips &amp; strategy</h2>
        <ul>
          <li>Questions are usually tied to something recent or well-known in that category, so a guess based on what's been in the news lately is often a reasonable bet if you're unsure.</li>
          <li>There's only one question a day, so there's no advantage to rushing — take the extra few seconds to read the full question before you answer.</li>
          <li>Come back at the same time each day if you want to build a streak; the question resets daily, not on a rolling 24-hour timer from your last answer.</li>
        </ul>
        <h2>Tech specs</h2>
        <ul class="game-tech-specs">
          <li><b>Type</b>Daily quiz, one question</li>
          <li><b>Frequency</b>New question every day</li>
          <li><b>Categories</b>AI, Technology, Science &amp; Space, Gaming, Entertainment, Sports, Social Media, Business</li>
        </ul>
      </section>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>
    </article>

{footer_block}

  </main>
</div>

<script src="../{articulos_asset}"></script>
<script src="../js/script.js"></script>
<script src="../js/play.js"></script>
</body>
</html>
"""

PLAY_DASH_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vex Dash — VexlowHQ Games</title>
<meta name="description" content="Tap to jump, dodge the spikes, beat your best score. A quick, addictive runner game — free to play, no download.">
<link rel="stylesheet" href="../css/style.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="play">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../index.html">Home</a><span class="sep">/</span><a href="index.html">Games</a><span class="sep">/</span><span class="current">Vex Dash</span>
    </nav>

    <article class="article-page">
      <h1>🔺 Vex Dash</h1>
      <p class="play-intro">Tap or click to jump. Dodge the spikes, survive as long as you can. Tap once to start.</p>

      <div class="dash-wrap">
        <canvas id="dashCanvas" width="800" height="360" aria-label="Vex Dash game"></canvas>
        <div class="dash-hud">
          <span id="dashScore">Score: 0</span>
          <span id="dashBest">Best: 0</span>
          <button type="button" id="dashMute" class="dash-mute" aria-label="Mute sound">🔊</button>
        </div>
        <div class="dash-overlay" id="dashOverlay">
          <p id="dashOverlayText">Tap or press Space to start</p>
        </div>
      </div>

      <div class="dash-letters">
        <span class="dash-letters-label">Jump to collect the letters:</span>
        <span class="dash-letters-tiles" id="dashLettersTiles"></span>
      </div>

      <div class="dash-name-modal hidden" id="dashNameModal">
        <div class="dash-name-card">
          <h2>🏆 Enter your name</h2>
          <p>This is what shows up on the Vex Dash leaderboard.</p>
          <input type="text" id="dashNameInput" class="dash-name-input" maxlength="14" placeholder="Player" autocomplete="off">
          <div class="dash-name-actions">
            <button type="button" id="dashNameSkip" class="dash-name-skip">Skip</button>
            <button type="button" id="dashNameSave" class="dash-name-save">Save &amp; Play</button>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="dashAdBreak">
        <div class="dash-name-card">
          <h2>⏸️ Quick break</h2>
          <button type="button" id="dashAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h2>🏆 Top Scores</h2>
        <ol class="dash-leaderboard-list" id="dashLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="dashYouRank" hidden></p>
      </div>

      <section class="game-guide">
        <h2>How to play</h2>
        <p>Vex Dash is a single-button endless runner — tap, click, or press Space to jump over the spikes. Timing is everything, since the run only ends when you hit one. Along the way, hidden checkpoints let you collect the letters of VEXLOWHQ; get a letter once and it stays checked off across future runs, even if that specific run ends early.</p>
        <h2>Tips &amp; strategy</h2>
        <ul>
          <li>Spike groups get denser and faster as your score climbs, so the run genuinely gets harder in real time, not just longer — don't get comfortable with the opening pace.</li>
          <li>Letters spawn at fixed points along the run, not randomly. Miss one and you'll get another shot at it on your next attempt, since every run starts from the same beginning.</li>
          <li>Short, early taps clear spikes more reliably than holding the button down — the jump arc is tuned for quick presses, not long holds.</li>
        </ul>
        <h2>Tech specs</h2>
        <ul class="game-tech-specs">
          <li><b>Type</b>Endless runner</li>
          <li><b>Controls</b>Tap / click / Space</li>
          <li><b>Built with</b>HTML5 Canvas, Web Audio API</li>
          <li><b>Scoring</b>Global leaderboard, synced live</li>
        </ul>
      </section>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

    </article>

{footer_block}

  </main>
</div>

<script src="../{articulos_asset}"></script>
<script src="../js/script.js"></script>
<script src="../js/dash.js?v={cache_bust}"></script>
</body>
</html>
"""

PLAY_SNAKE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Neon Snake Survival — VexlowHQ Games</title>
<meta name="description" content="Classic snake with a neon glow. Swipe or use arrow keys, eat the orbs, don't hit yourself. Free to play, no download.">
<link rel="stylesheet" href="../css/style.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="play">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../index.html">Home</a><span class="sep">/</span><a href="index.html">Games</a><span class="sep">/</span><span class="current">Neon Snake Survival</span>
    </nav>

    <article class="article-page">
      <h1>🐍 Neon Snake Survival</h1>
      <p class="play-intro">Swipe or use the arrow keys. Eat the orbs, don't run into yourself. Tap once to start.</p>

      <div class="dash-wrap">
        <canvas id="snakeCanvas" width="800" height="360" aria-label="Neon Snake Survival game"></canvas>
        <div class="dash-hud">
          <span id="snakeScore">Score: 0</span>
          <span id="snakeBest">Best: 0</span>
          <button type="button" id="snakeMute" class="dash-mute" aria-label="Mute sound">🔊</button>
        </div>
        <div class="dash-overlay" id="snakeOverlay">
          <p id="snakeOverlayText">Tap or press Space to start</p>
        </div>
      </div>

      <div class="snake-dpad">
        <button type="button" class="snake-dpad-btn snake-dpad-up" data-dx="0" data-dy="-1" aria-label="Up"><img src="../img/snake/arrow-up.png" alt=""></button>
        <button type="button" class="snake-dpad-btn snake-dpad-left" data-dx="-1" data-dy="0" aria-label="Left"><img src="../img/snake/arrow-left.png" alt=""></button>
        <button type="button" class="snake-dpad-btn snake-dpad-right" data-dx="1" data-dy="0" aria-label="Right"><img src="../img/snake/arrow-right.png" alt=""></button>
        <button type="button" class="snake-dpad-btn snake-dpad-down" data-dx="0" data-dy="1" aria-label="Down"><img src="../img/snake/arrow-down.png" alt=""></button>
      </div>

      <div class="dash-name-modal hidden" id="snakeNameModal">
        <div class="dash-name-card">
          <h2>🏆 Enter your name</h2>
          <p>This is what shows up on the Neon Snake leaderboard.</p>
          <input type="text" id="snakeNameInput" class="dash-name-input" maxlength="14" placeholder="Player" autocomplete="off">
          <div class="dash-name-actions">
            <button type="button" id="snakeNameSkip" class="dash-name-skip">Skip</button>
            <button type="button" id="snakeNameSave" class="dash-name-save">Save &amp; Play</button>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="snakeAdBreak">
        <div class="dash-name-card">
          <h2>⏸️ Quick break</h2>
          <button type="button" id="snakeAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h2>🏆 Top Scores</h2>
        <ol class="dash-leaderboard-list" id="snakeLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="snakeYouRank" hidden></p>
      </div>

      <section class="game-guide">
        <h2>How to play</h2>
        <p>Classic snake with a neon glow. Swipe, use the arrow keys, or use the on-screen d-pad to steer. The snake moves on its own — guide it into the glowing orbs to grow and score. The walls are solid: hit the edge of the board, or run into your own tail, and the run ends immediately.</p>
        <h2>Tips &amp; strategy</h2>
        <ul>
          <li>Each orb is worth 10 points, and the snake's speed increases with every orb eaten — plan turns a few moves ahead once your snake gets long, since there's less time to react at higher speeds.</li>
          <li>Loop through the center of the board in short, deliberate passes rather than long spirals — long spirals are where most runs end up trapped in your own tail.</li>
          <li>Keep sound on if you can: the eat/turn cues make it easier to track your own pace without staring at the score counter.</li>
        </ul>
        <h2>Tech specs</h2>
        <ul class="game-tech-specs">
          <li><b>Type</b>Arcade / Snake</li>
          <li><b>Controls</b>Swipe, arrow keys, or on-screen d-pad</li>
          <li><b>Built with</b>HTML5 Canvas, Web Audio API</li>
          <li><b>Scoring</b>Global leaderboard, synced live</li>
        </ul>
      </section>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

    </article>

{footer_block}

  </main>
</div>

<script src="../{articulos_asset}"></script>
<script src="../js/script.js"></script>
<script src="../js/snake.js?v={cache_bust}"></script>
</body>
</html>
"""

PLAY_ORBIT_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Neon Orbit — VexlowHQ Games</title>
<meta name="description" content="Tap to flip your orbit direction and dodge the incoming blocks. Simple, fast, brutally addictive — free to play, no download.">
<link rel="stylesheet" href="../css/style.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="play">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../index.html">Home</a><span class="sep">/</span><a href="index.html">Games</a><span class="sep">/</span><span class="current">Neon Orbit</span>
    </nav>

    <article class="article-page">
      <h1>🌀 Neon Orbit</h1>
      <p class="play-intro">Tap to flip your orbit direction. Dodge the blocks closing in from the edge. Tap once to start.</p>

      <div class="dash-wrap">
        <canvas id="orbitCanvas" width="800" height="360" aria-label="Neon Orbit game"></canvas>
        <div class="dash-hud">
          <span id="orbitScore">Score: 0</span>
          <span id="orbitBest">Best: 0</span>
          <button type="button" id="orbitMute" class="dash-mute" aria-label="Mute sound">🔊</button>
        </div>
        <div class="dash-overlay" id="orbitOverlay">
          <p id="orbitOverlayText">Tap or press Space to start</p>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="orbitNameModal">
        <div class="dash-name-card">
          <h2>🏆 Enter your name</h2>
          <p>This is what shows up on the Neon Orbit leaderboard.</p>
          <input type="text" id="orbitNameInput" class="dash-name-input" maxlength="14" placeholder="Player" autocomplete="off">
          <div class="dash-name-actions">
            <button type="button" id="orbitNameSkip" class="dash-name-skip">Skip</button>
            <button type="button" id="orbitNameSave" class="dash-name-save">Save &amp; Play</button>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="orbitAdBreak">
        <div class="dash-name-card">
          <h2>⏸️ Quick break</h2>
          <button type="button" id="orbitAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h2>🏆 Top Scores</h2>
        <ol class="dash-leaderboard-list" id="orbitLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="orbitYouRank" hidden></p>
      </div>

      <section class="game-guide">
        <h2>How to play</h2>
        <p>A ball orbits a glowing core on its own — tap, or press Space, to flip its spin direction between clockwise and counter-clockwise. Blocks spawn from the outer edge and move inward; if one reaches your orbit exactly where you're standing, the run ends. It's a single-input game, so every decision is about timing, not aiming.</p>
        <h2>Tips &amp; strategy</h2>
        <ul>
          <li>The inward speed of incoming blocks ramps up the longer you survive, so early runs feel much calmer than late ones — don't get used to the opening pace.</li>
          <li>Each dodged block is worth 5 points, and you also earn a small, steady trickle of points just for staying alive — survival time matters as much as clean dodges.</li>
          <li>Watch a block's entry angle as soon as it spawns, not its current position as it closes in — by the time it's close, you've already committed to a direction.</li>
        </ul>
        <h2>Tech specs</h2>
        <ul class="game-tech-specs">
          <li><b>Type</b>Single-input arcade / reflex</li>
          <li><b>Controls</b>Tap or Space to flip direction</li>
          <li><b>Built with</b>HTML5 Canvas, Web Audio API</li>
          <li><b>Scoring</b>Global leaderboard, synced live</li>
        </ul>
      </section>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

    </article>

{footer_block}

  </main>
</div>

<script src="../{articulos_asset}"></script>
<script src="../js/script.js"></script>
<script src="../js/orbit.js?v={cache_bust}"></script>
</body>
</html>
"""

PLAY_GRAVITY_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gravity Flip — VexlowHQ Games</title>
<meta name="description" content="A rhythm platformer level: switch between cube, ship and ball, dodge spikes and saws, grab the key and secret coins, reach the finish. Free to play, no download.">
<link rel="stylesheet" href="../css/style.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="play">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../index.html">Home</a><span class="sep">/</span><a href="index.html">Games</a><span class="sep">/</span><span class="current">Gravity Flip</span>
    </nav>

    <article class="article-page">
      <h1>🔻 Gravity Flip</h1>
      <p class="play-intro">10 levels — tap/hold to control the cube, ship and ball. Dodge spikes and saws, grab the key and 3 secret coins, then reach the finish. Earn coins and diamonds to unlock new skins. Tap once to start.</p>

      <div class="dash-wrap">
        <canvas id="gravityCanvas" width="800" height="360" aria-label="Gravity Flip game"></canvas>
        <div class="dash-hud">
          <span id="gravityScore">Progress: 0%</span>
          <span id="gravityBest">Best: 0%</span>
          <span id="gravityCoins">⭐ 0/3</span>
          <span id="gravityKey"></span>
          <span id="gravityWallet" class="gravity-wallet">🪙 0  💎 0</span>
          <button type="button" id="gravityHomeBtn" class="dash-mute" aria-label="Home menu">🏠</button>
          <button type="button" id="gravityLevelBtn" class="dash-mute" aria-label="Choose level">🗺️</button>
          <button type="button" id="gravitySkinBtn" class="dash-mute" aria-label="Choose skin">🧑‍🚀</button>
          <button type="button" id="gravityMute" class="dash-mute" aria-label="Mute sound">🔊</button>
        </div>
        <div class="dash-overlay" id="gravityOverlay">
          <p id="gravityOverlayText">Tap or press Space to start</p>
        </div>

        <div class="gravity-home" id="gravityHomeMenu">
          <div class="gravity-home-bg-decor" aria-hidden="true">
            <img class="gravity-decor-cube" id="gravityHomeDecorCube" src="../img/gravitycover/sliced/skin_01.png" alt="">
            <img class="gravity-decor-portal" src="../img/gravitycover/sliced/home_portal.png" alt="">
            <img class="gravity-decor-gear" src="../img/gravitycover/sliced/home_gear.png" alt="">
          </div>
          <div class="gravity-home-topbar">
            <div class="gravity-player-card">
              <div class="gravity-player-avatar"><img id="gravityHomeAvatar" src="../img/gravitycover/sliced/skin_01.png" alt=""></div>
              <div class="gravity-player-info">
                <strong id="gravityHomeName">PLAYER</strong>
              </div>
            </div>
            <div class="gravity-home-icons">
              <button type="button" class="gravity-icon-btn" id="gravityHomeTrophyBtn" aria-label="Top scores">🏆</button>
              <button type="button" class="gravity-icon-btn" id="gravityHomeMuteBtn" aria-label="Mute sound">🔊</button>
            </div>
          </div>
          <h2 class="gravity-home-title"><span class="line line-1">GRAVITY</span><span class="line line-2">FLIP</span></h2>
          <div class="gravity-home-platform" style="background-image:url('../img/gravitycover/sliced/home_platform.png')"></div>
          <div class="gravity-home-bottombar">
            <div class="gravity-stats-pill">
              <span class="gravity-stat gravity-stat-stars">⭐ <b id="gravityHomeStars">0/30</b></span>
              <span class="gravity-stat gravity-stat-coins">🪙 <b id="gravityHomeCoins">0</b><button type="button" class="gravity-stat-add" id="gravityHomeCoinsAdd" aria-label="Get more coins">+</button></span>
              <span class="gravity-stat gravity-stat-diamonds">💎 <b id="gravityHomeDiamonds">0</b><button type="button" class="gravity-stat-add" id="gravityHomeDiamondsAdd" aria-label="Get more diamonds">+</button></span>
            </div>
            <div class="gravity-bottombar-row">
              <button type="button" class="gravity-level-card" id="gravityHomePlayBtn">
                <span class="gravity-level-card-top">
                  <span class="gravity-level-card-num" id="gravityHomeLvl">LEVEL 1</span>
                  <span class="gravity-level-card-stars" id="gravityHomeLvlStars">☆☆☆</span>
                </span>
                <span class="gravity-level-card-pct">LEVEL PROGRESS <b id="gravityHomeLvlPct">0%</b></span>
                <span class="gravity-player-progress-bar"><span class="gravity-player-progress-fill" id="gravityHomeProgressFill"></span></span>
              </button>
              <button type="button" class="gravity-navtab active" id="gravityHomeHomeTab" aria-label="Home">
                <span class="gravity-navtab-icon">🏠</span><span>HOME</span>
              </button>
              <button type="button" class="gravity-navtab" id="gravityHomeLevelsBtn" aria-label="Select level">
                <span class="gravity-navtab-icon">🗺️</span><span>LEVELS</span>
              </button>
              <button type="button" class="gravity-navtab" id="gravityHomeSkinsBtn" aria-label="Skin">
                <span class="gravity-navtab-icon">🧑‍🚀</span><span>SKIN</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="gravityLevelSelect">
        <div class="dash-name-card gravity-select-card gravity-level-card">
          <div class="gravity-screen-topbar">
            <button type="button" id="gravityLevelSelectClose" class="gravity-back-btn" aria-label="Back">◀</button>
            <h3>SELECT LEVEL</h3>
            <span class="gravity-chip" id="gravityLevelStarsChip">⭐ 0/30</span>
          </div>
          <div class="gravity-select-grid" id="gravityLevelGrid"></div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="gravitySkinSelect">
        <div class="dash-name-card gravity-select-card gravity-skin-card">
          <div class="gravity-screen-topbar">
            <button type="button" id="gravitySkinSelectClose" class="gravity-back-btn" aria-label="Back">◀</button>
            <h3 id="gravitySkinScreenTitle">SELECT SKIN</h3>
            <span class="gravity-chip" id="gravitySkinWalletLine">🪙 0 💎 0</span>
          </div>
          <div class="gravity-skin-tabs">
            <button type="button" class="gravity-tab active" id="gravitySkinTabCollection">COLLECTION</button>
            <button type="button" class="gravity-tab" id="gravitySkinTabShop">SHOP</button>
          </div>
          <div class="gravity-skin-rarities" id="gravitySkinRarities">
            <button type="button" class="gravity-rarity-tab active" data-rarity="all">ALL</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="basico">COMMON</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="raro">RARE</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="epico">EPIC</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="legendario">LEGENDARY</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="especial">SPECIAL</button>
          </div>
          <div class="gravity-skin-body">
            <div class="gravity-skin-preview" id="gravitySkinPreviewPanel">
              <div class="gravity-skin-preview-img"><img id="gravitySkinPreviewImg" src="../img/gravitycover/sliced/skin_01.png" alt=""></div>
              <strong id="gravitySkinPreviewName">NEON CLASSIC</strong>
              <span class="gravity-rarity-tag" id="gravitySkinPreviewRarity">COMMON</span>
              <button type="button" class="gravity-equip-btn" id="gravitySkinEquipBtn">EQUIPPED</button>
            </div>
            <div class="gravity-select-grid gravity-skin-grid" id="gravitySkinGrid"></div>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="gravityNameModal">
        <div class="dash-name-card">
          <h2>🏆 Enter your name</h2>
          <p>This is what shows up on the Gravity Flip leaderboard.</p>
          <input type="text" id="gravityNameInput" class="dash-name-input" maxlength="14" placeholder="Player" autocomplete="off">
          <div class="dash-name-actions">
            <button type="button" id="gravityNameSkip" class="dash-name-skip">Skip</button>
            <button type="button" id="gravityNameSave" class="dash-name-save">Save &amp; Play</button>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="gravityAdBreak">
        <div class="dash-name-card">
          <h2>⏸️ Quick break</h2>
          <button type="button" id="gravityAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h2>🏆 Top Scores</h2>
        <ol class="dash-leaderboard-list" id="gravityLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="gravityYouRank" hidden></p>
      </div>

      <section class="game-guide">
        <h2>How to play</h2>
        <p>A 10-level rhythm platformer in the style of Geometry Dash. Tap or hold to control your character, which switches between three forms as you move through each level: cube (jump), ship (fly), and ball (flip gravity). Dodge spikes and saws, ride moving platforms, and reach the finish to complete a level. Each level also hides a key and matching door, 3 secret coins, and — in later levels — an interruptor that opens a gate elsewhere on the map.</p>
        <h2>Tips &amp; strategy</h2>
        <ul>
          <li>Progress is scored by the percentage of the level you complete, and your best percentage per level is saved — so even a run that ends early still counts toward your personal best.</li>
          <li>Coins collected during a completed run go straight into your permanent wallet, and you can replay a finished level to earn more. Each level's diamond, once grabbed and the level finished, is credited exactly once and won't reappear on future runs.</li>
          <li>Spend coins and diamonds in the skin menu to unlock new looks for your character — purely cosmetic, it doesn't change the physics or hitboxes.</li>
          <li>Levels unlock in order: beat one to open the next. Difficulty comes from stacking more mechanics together, not just going faster, so a level that feels manageable early on can layer on a second or third obstacle type without much warning.</li>
        </ul>
        <h2>Tech specs</h2>
        <ul class="game-tech-specs">
          <li><b>Type</b>Rhythm platformer, 10 levels</li>
          <li><b>Controls</b>Tap / hold (jump, fly, or flip gravity, depending on form)</li>
          <li><b>Built with</b>HTML5 Canvas, Web Audio API</li>
          <li><b>Scoring</b>Per-level leaderboard by completion %, synced live</li>
          <li><b>Economy</b>Coins + diamonds, unlockable skins</li>
        </ul>
      </section>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

    </article>

{footer_block}

  </main>
</div>

<script src="../{articulos_asset}"></script>
<script src="../js/script.js"></script>
<script src="../js/gravity.js?v={cache_bust}"></script>
</body>
</html>
"""

PLAY_PULSE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Color Pulse — VexlowHQ Games</title>
<meta name="description" content="Tap to cycle your color and match each gate as it arrives. Simple, fast, and gets brutal once the speed ramps up. Free to play, no download.">
<link rel="stylesheet" href="../css/style.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="play">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../index.html">Home</a><span class="sep">/</span><a href="index.html">Games</a><span class="sep">/</span><span class="current">Color Pulse</span>
    </nav>

    <article class="article-page">
      <h1>🎨 Color Pulse</h1>
      <p class="play-intro">Tap to cycle your color: red → blue → green → yellow. Match the gate's color to pass through. Tap once to start.</p>

      <div class="dash-wrap">
        <canvas id="pulseCanvas" width="800" height="360" aria-label="Color Pulse game"></canvas>
        <div class="dash-hud">
          <span id="pulseScore">Score: 0</span>
          <span id="pulseBest">Best: 0</span>
          <button type="button" id="pulseMute" class="dash-mute" aria-label="Mute sound">🔊</button>
        </div>
        <div class="dash-overlay" id="pulseOverlay">
          <p id="pulseOverlayText">Tap or press Space to start</p>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="pulseNameModal">
        <div class="dash-name-card">
          <h2>🏆 Enter your name</h2>
          <p>This is what shows up on the Color Pulse leaderboard.</p>
          <input type="text" id="pulseNameInput" class="dash-name-input" maxlength="14" placeholder="Player" autocomplete="off">
          <div class="dash-name-actions">
            <button type="button" id="pulseNameSkip" class="dash-name-skip">Skip</button>
            <button type="button" id="pulseNameSave" class="dash-name-save">Save &amp; Play</button>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="pulseAdBreak">
        <div class="dash-name-card">
          <h2>⏸️ Quick break</h2>
          <button type="button" id="pulseAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h2>🏆 Top Scores</h2>
        <ol class="dash-leaderboard-list" id="pulseLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="pulseYouRank" hidden></p>
      </div>

      <section class="game-guide">
        <h2>How to play</h2>
        <p>A ball rolls forward on its own through a series of colored gates. Tap, or press Space, to cycle the ball's color through a fixed loop: red → blue → green → yellow → red. You can only pass through a gate if your color matches it at the exact moment you reach it — mismatch, and the run ends there.</p>
        <h2>Tips &amp; strategy</h2>
        <ul>
          <li>Speed climbs continuously from the moment you start, with no early plateau — the biggest skill jump is getting comfortable tapping faster without losing track of your current color.</li>
          <li>Because the color cycle is always in the same fixed order, you can count taps ahead of time for a gate that's still a few seconds out, instead of reacting at the last second.</li>
          <li>Matching a gate is worth 10 points, and surviving longer at higher speed adds up steadily too — smooth, evenly-timed taps beat panicked last-second ones.</li>
        </ul>
        <h2>Tech specs</h2>
        <ul class="game-tech-specs">
          <li><b>Type</b>Rhythm / reflex, single input</li>
          <li><b>Controls</b>Tap or Space to cycle color</li>
          <li><b>Built with</b>HTML5 Canvas, Web Audio API</li>
          <li><b>Scoring</b>Global leaderboard, synced live</li>
        </ul>
      </section>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

    </article>

{footer_block}

  </main>
</div>

<script src="../{articulos_asset}"></script>
<script src="../js/script.js"></script>
<script src="../js/pulse.js?v={cache_bust}"></script>
</body>
</html>
"""

PLAY_WORDSEARCH_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Word Search — VexlowHQ Games</title>
<meta name="description" content="A clean, fast word search — pick Easy through Expert (or Numbers), play in English or Spanish, and race the clock.">
<link rel="stylesheet" href="../css/style.css">
<link rel="icon" type="image/x-icon" href="../favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
{seo_head}
<!-- CONSENT_ADS_BLOCK:START -->
{consent_ads_block}<!-- CONSENT_ADS_BLOCK:END -->
</head>
<body data-static-slug="play">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../index.html">Home</a><span class="sep">/</span><a href="index.html">Games</a><span class="sep">/</span><span class="current">Word Search</span>
    </nav>

    <article class="article-page">
      <h1>🔤 Word Search</h1>
      <p class="play-intro">Pick a difficulty, drag to select words in any direction, and race the clock. Play in English or Spanish.</p>

      <div class="dash-wrap ws-wrap">
        <div class="dash-hud">
          <span id="wordsearchTimer">Time: 00:00</span>
          <span id="wordsearchBest">Best: --:--</span>
          <button type="button" id="wordsearchHintBtn" class="ws-btn">Hint (3)</button>
          <button type="button" id="wordsearchGiveUpBtn" class="ws-btn">Give Up</button>
          <button type="button" id="wordsearchNewGameBtn" class="ws-btn">New Game</button>
          <button type="button" id="wordsearchSettingsBtn" class="ws-btn">Settings</button>
        </div>

        <div class="ws-board">
          <div class="ws-grid-wrap"><div id="wordsearchGrid" class="ws-grid"></div></div>
          <div class="ws-words-wrap"><ul id="wordsearchWordList" class="ws-word-list"></ul></div>
        </div>
      </div>

      <div class="dash-name-modal" id="wordsearchStartModal">
        <div class="dash-name-card">
          <h3>🔤 Word Search</h3>
          <p id="wordsearchStartHint">Choose a difficulty to start</p>
          <div class="ws-lang-toggle">
            <button type="button" id="wordsearchLangEn" class="ws-lang-btn active">English</button>
            <button type="button" id="wordsearchLangEs" class="ws-lang-btn">Español</button>
          </div>
          <div class="ws-difficulty-grid" id="wordsearchDifficultyButtons">
            <button type="button" class="ws-difficulty-btn" data-difficulty="easy">Easy</button>
            <button type="button" class="ws-difficulty-btn" data-difficulty="medium">Medium</button>
            <button type="button" class="ws-difficulty-btn" data-difficulty="hard">Hard</button>
            <button type="button" class="ws-difficulty-btn" data-difficulty="expert">Expert</button>
            <button type="button" class="ws-difficulty-btn" data-difficulty="numbers">Numbers</button>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="wordsearchWinModal">
        <div class="dash-name-card">
          <h3>🎉 You solved it!</h3>
          <p>Your time: <strong id="wordsearchWinTime">00:00</strong></p>
          <button type="button" id="wordsearchWinPlayAgain" class="dash-name-save" style="width:100%;">Play Again</button>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="wordsearchRevealedModal">
        <div class="dash-name-card">
          <h3>👀 Puzzle revealed</h3>
          <p>Better luck next time — every word is shown on the grid.</p>
          <button type="button" id="wordsearchRevealedPlayAgain" class="dash-name-save" style="width:100%;">Play Again</button>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="wordsearchNameModal">
        <div class="dash-name-card">
          <h2>🏆 Enter your name</h2>
          <p>This is what shows up on the Word Search leaderboard.</p>
          <input type="text" id="wordsearchNameInput" class="dash-name-input" maxlength="14" placeholder="Player" autocomplete="off">
          <div class="dash-name-actions">
            <button type="button" id="wordsearchNameSkip" class="dash-name-skip">Skip</button>
            <button type="button" id="wordsearchNameSave" class="dash-name-save">Save &amp; Play</button>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="wordsearchAdBreak">
        <div class="dash-name-card">
          <h2>⏸️ Quick break</h2>
          <button type="button" id="wordsearchAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Best Times</h3>
        <ol class="dash-leaderboard-list" id="wordsearchLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="wordsearchYouRank" hidden></p>
      </div>

      <section class="game-guide">
        <h2>How to play</h2>
        <p>Pick a difficulty and language from the start screen — grid size and word count scale up from Easy to Expert, and Numbers mode swaps letters for digit sequences. Click or tap a letter and drag in a straight line (horizontal, vertical, or diagonal, either direction) to select a word. A correct match locks in with its own color and gets struck off the list; the clock keeps running until every word is found.</p>
        <h2>Tips &amp; strategy</h2>
        <ul>
          <li>Scan for uncommon letters first (Q, X, Z, J) — they narrow down where a word could start much faster than scanning row by row.</li>
          <li>Words can run in any of the 8 directions and can be found back-to-front, so don't rule out a match just because it reads backwards.</li>
          <li>Stuck? Hint reveals one full word's path for a few seconds (up to 3 per puzzle) without marking it found — you still have to trace it yourself.</li>
        </ul>
        <h2>Tech specs</h2>
        <ul class="game-tech-specs">
          <li><b>Type</b>Word search puzzle, timed</li>
          <li><b>Controls</b>Mouse drag or touch drag</li>
          <li><b>Difficulties</b>Easy, Medium, Hard, Expert, Numbers</li>
          <li><b>Languages</b>English, Spanish</li>
          <li><b>Scoring</b>Best time, global leaderboard per difficulty</li>
        </ul>
      </section>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

    </article>

{footer_block}

  </main>
</div>

<script src="../{articulos_asset}"></script>
<script src="../js/script.js"></script>
<script src="../js/wordsearch-data.js?v={cache_bust}"></script>
<script src="../js/wordsearch.js?v={cache_bust}"></script>
</body>
</html>
"""


def format_date(iso):
    y, m, d = iso.split("-")
    month = UI_STRINGS["months"][int(m) - 1]
    return UI_STRINGS["date_format"].format(d=int(d), month=month, y=y)


def _domain_label(url):
    """Fallback legible cuando un source no trae sourceTitle/label propio."""
    try:
        from urllib.parse import urlparse
        host = urlparse(url).netloc
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return url


def _accessed_suffix(retrieved_at):
    """"Accessed [date]" (pedido de Leonardo, 2026-09-24, punto 6) -- paridad
    exacta con accessedSuffix() en admin/pagegen.js: solo se muestra cuando el
    artículo ya trae el dato guardado (sourceRetrievedAt/retrievedAt), nunca
    se inventa ni se migra un artículo viejo que no lo tenga."""
    if not retrieved_at:
        return ""
    date_part = str(retrieved_at)[:10]
    import re
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_part):
        return ""
    try:
        return " (accessed " + format_date(date_part) + ")"
    except Exception:
        return ""


def localize(html, depth=2):
    """ Agrega el prefijo '../' que corresponda a los links entre páginas
        del mismo árbol, según qué tan adentro de la raíz esté la página
        que va a recibir este bloque compartido (sidebar/footer, siempre
        extraídos de index.html en la raíz). Las páginas de categoría/
        tema/artículo están 2 carpetas adentro (depth=2); las de play/
        están 1 carpeta adentro (depth=1); las páginas estáticas están
        en la raíz (depth=0, sin prefijo -- no hace falta llamar a esta
        función para esas). """
    prefix = "../" * depth
    html = html.replace('href="index.html"', 'href="{}index.html"'.format(prefix))
    html = html.replace('href="play/index.html"', 'href="{}play/index.html"'.format(prefix))
    html = html.replace('src="img/', 'src="{}img/'.format(prefix))
    html = html.replace("url('img/", "url('{}img/".format(prefix))
    for cat in CATEGORY_SLUGS:
        # OJO: no alcanza con matchear solo ".../index.html" -- el bloque
        # compartido (sidebar) ahora también trae, en "Latest Posts", links
        # directos a ARTÍCULOS dentro de cada categoría (no solo al índice
        # de la categoría). Hay que reescribir cualquier href que empiece
        # con "categoria/<slug>/", sea el índice o un artículo puntual,
        # o esos links quedan rotos (404) en toda página que no esté en
        # la raíz del sitio.
        slug = cat["slug"]
        html = re.sub(
            r'href="categoria/{}/([^"]*)"'.format(re.escape(slug)),
            'href="' + prefix + 'categoria/' + slug + '/\\1"',
            html,
        )
    for page in STATIC_PAGES:
        html = html.replace(
            'href="{}.html"'.format(page["slug"]),
            'href="{}{}.html"'.format(prefix, page["slug"]),
        )
    return html


def replace_div_content_by_id(html_text, div_id, new_inner):
    """ Reemplaza el contenido de un <div id="div_id">...</div> respetando
        el anidamiento (por si adentro hay otros <div>, como .body en cada
        tarjeta) -- a diferencia de un regex "no-greedy" simple, que
        cortaría en el primer </div> interno. Se usa para volcar contenido
        real (tarjetas de artículos) en los contenedores de la home que
        antes quedaban vacíos hasta que corría js/script.js. """
    m = re.search(r'<div[^>]*\bid="{}"[^>]*>'.format(re.escape(div_id)), html_text)
    if not m:
        raise ValueError("No se encontró el contenedor #{}".format(div_id))
    pos = m.end()
    depth = 1
    end = None
    while depth > 0:
        next_open = html_text.find("<div", pos)
        next_close = html_text.find("</div>", pos)
        if next_close == -1:
            raise ValueError("Contenedor #{} sin cierre".format(div_id))
        if next_open != -1 and next_open < next_close:
            depth += 1
            pos = next_open + 4
        else:
            depth -= 1
            pos = next_close + 6
            if depth == 0:
                end = next_close
    return html_text[: m.end()] + new_inner + html_text[end:]


EMPTY_RAIL_HTML = '<p class="latest-empty">Nothing published in this section yet.</p>\n'

# Categorías que arman los rieles fijos de la portada (últimos 4 de cada
# una) -- mismo listado que RAIL_CATEGORIES en js/script.js.
HOME_RAIL_CATEGORIES = ["ai", "technology", "science", "gaming", "entertainment", "sports"]


def build_latest_item_html(art, href):
    title_esc = html.escape(art.get("title", ""))
    meta = "{} · {} · {}".format(
        html.escape(art.get("categoryLabel", "")), format_date(art.get("date", "")), html.escape(art.get("readTime", ""))
    )
    return (
        '<a class="latest-item" href="{href}"><span class="ic">{icon}</span>'
        '<div class="txt"><span class="ttl">{title}</span><div class="meta">{meta}</div></div></a>\n'
    ).format(href=href, icon=art.get("icon", ""), title=title_esc, meta=meta)


def find_redirect_target(article, all_articles):
    """Resuelve redirectTo ("categoria/slug" o solo "slug") al artículo
    destino real. Espejo exacto de findRedirectTarget en pagegen.js (Node).
    No inventa un destino: si no encuentra ninguno, devuelve None."""
    target = article.get("redirectTo") if article else None
    if not target:
        return None
    for a in all_articles or []:
        if a is article:
            continue
        if "{}/{}".format(a.get("category"), a.get("slug")) == target or a.get("slug") == target:
            return a
    return None


def generate_redirect_file(article, all_articles, category_by_slug):
    """Genera un archivo de redirección permanente en la URL de ESTE
    artículo (misma ruta de siempre: categoria/<cat>/<slug>.html), que
    manda al lector y a los buscadores hacia el artículo canónico indicado
    en redirectTo. Espejo byte a byte de generateRedirectFile en
    pagegen.js (Node) -- misma estructura HTML, mismo orden de tags,
    html.escape() para el título (equivalente a escapeHtml() en Node) y
    json.dumps() para el literal del <script> (equivalente a
    JSON.stringify()). Nunca se lista en categorías/portada/sitemap."""
    cat = category_by_slug.get(article.get("category"))
    if not cat:
        raise ValueError("Categoría desconocida: {}".format(article.get("category")))
    target = find_redirect_target(article, all_articles)
    if not target:
        raise ValueError(
            "redirectTo inválido o no encontrado para {} ({})".format(
                article.get("slug"), article.get("redirectTo")
            )
        )
    target_cat = category_by_slug.get(target.get("category"))
    if not target_cat:
        raise ValueError("El destino del redirect tiene una categoría desconocida: {}".format(target.get("category")))

    relative_target = "../../categoria/{}/{}.html".format(target_cat["slug"], target["slug"])
    target_url = SITE_URL + "/categoria/{}/{}.html".format(target_cat["slug"], target["slug"])

    page = (
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
        '<meta charset="UTF-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        "<title>{}</title>\n"
        '<meta http-equiv="refresh" content="0; url={}">\n'
        '<link rel="canonical" href="{}">\n'
        '<meta name="robots" content="noindex,follow">\n'
        "</head>\n<body>\n"
        '<p>This article has moved. <a href="{}">Continue to the current version →</a></p>\n'
        "<script>location.replace({});</script>\n"
        "</body>\n</html>\n"
    ).format(
        html.escape(target.get("title") or cat["label"]) + " — VexlowHQ",
        relative_target,
        target_url,
        relative_target,
        json.dumps(relative_target),
    )

    cat_dir = os.path.join(CATEGORIA_DIR, cat["slug"])
    os.makedirs(cat_dir, exist_ok=True)
    out_path = os.path.join(cat_dir, article["slug"] + ".html")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(page)
    return out_path


def generate():
    strings = UI_STRINGS
    category_by_slug = {c["slug"]: dict(c, label=CATEGORY_LABELS[c["slug"]]) for c in CATEGORY_SLUGS}

    # Se carga acá arriba (antes se cargaba recién para la sección de
    # artículos) porque ahora la portada y las páginas de categoría
    # también necesitan la lista completa para volcar las grillas al
    # HTML crudo en vez de dejarlas vacías a la espera de JS.
    with open(ARTICULOS_JSON, "r", encoding="utf-8") as f:
        articles = json.load(f)
    # Solo status='published' (is_public_article, que resuelve la
    # compatibilidad con draftIncomplete y con los 169 artículos reales de
    # antes de este esquema -- ver effective_status más arriba) entra en
    # "publishable" -- mismo criterio que pagegen.js (Node). 'redirected'
    # nunca es publishable: se genera aparte, ver generate_redirect_file()
    # más abajo, después del loop de artículos normales.
    publishable = [
        a for a in articles
        if a.get("slug") and a.get("category") in category_by_slug
        and str(a.get("body") or "").strip() and is_public_article(a)
    ]
    redirect_articles = [
        a for a in articles
        if a.get("slug") and a.get("category") in category_by_slug and is_redirect_article(a)
    ]
    # Los artículos "noindex" (auditoría editorial en curso, contenido
    # retirado/redirigido, etc.) siguen generando su propia página HTML
    # -- navegable, con <meta robots noindex,follow> -- pero no deben
    # quedar enlazados desde ninguna grilla indexada (categoría propia,
    # portada, Latest, Trending). Antes solo se los sacaba del sitemap;
    # seguían apareciendo en las grillas, lo que contradecía el propio
    # noindex (fix 2026-09: auditoría global, punto 5 de validación de
    # redirects).
    articles_by_category = {}
    for a in publishable:
        if a.get("noindex"):
            continue
        articles_by_category.setdefault(a["category"], []).append(a)
    for lst in articles_by_category.values():
        lst.sort(key=lambda a: a.get("date", ""), reverse=True)

    # Categorías públicamente visibles en nav/footer/chips (auditoria
    # 2026-09-12): las que no tienen publicMinArticles se muestran siempre
    # (comportamiento de siempre); Cybersecurity/Guides (publicMinArticles=3)
    # solo se muestran -- y solo generan su propia categoria/<slug>/index.html
    # más abajo -- una vez que articles_by_category ya tiene al menos ese
    # mínimo de artículos publicados e indexables (no noindex) en esa
    # categoría. Mismo criterio, mismo nombre en espíritu, que
    # visibleCategorySlugs en pagegen.js (Node).
    visible_cats = [
        cat for cat in CATEGORY_SLUGS
        if is_category_publicly_visible(cat, {slug: len(lst) for slug, lst in articles_by_category.items()})
    ]

    # Menú principal (sidebar/footer/chips de filtro) -- auditoría
    # 2026-09-27, descubrimiento de tendencias + reorganización de
    # categorías: retiredForNewContent (hoy solo Science & Space) ahora
    # TAMBIÉN retira a la categoría del menú principal, sin sacarla de
    # visible_cats -- su propia categoria/<slug>/index.html se sigue
    # generando más abajo (el loop usa visible_cats, no esto), sus
    # artículos y URLs existentes quedan intactos, solo deja de aparecer
    # como opción en sidebar/footer/chips. Antes retiredForNewContent solo
    # controlaba CATEGORIES_ACCEPTING_NEW_CONTENT (selector del panel al
    # crear una nota nueva) y nunca afectaba el nav -- este es un cambio de
    # comportamiento explícitamente pedido para Science & Space. Mismo
    # criterio, mismo nombre en espíritu, que menuVisibleCategories() en
    # pagegen.js (Node) -- las dos listas tienen que coincidir exactamente.
    menu_visible_cats = [cat for cat in visible_cats if not cat.get("retired_for_new_content")]

    # Artículos con "editorialStatus" (ej.: contenido comercial pendiente
    # de prueba propia) siguen navegables en su propia página y en la
    # grilla normal de su categoría (articles_by_category, ya sin los
    # "noindex"), pero no deben aparecer en los espacios curados/destacados
    # de la portada -- trending strip, Latest Posts, ni los rieles por
    # categoría -- porque eso se leería como una recomendación editorial
    # aprobada que todavía no existe.
    featured_articles = [a for a in publishable if not a.get("editorialStatus") and not a.get("noindex")]
    featured_by_category = {}
    for a in featured_articles:
        featured_by_category.setdefault(a["category"], []).append(a)
    for lst in featured_by_category.values():
        lst.sort(key=lambda a: a.get("date", ""), reverse=True)

    trending_list = trending_articles(featured_articles)
    latest_sorted = sorted(featured_articles, key=lambda a: a.get("date", ""), reverse=True)

    def home_href(a):
        return "categoria/{}/{}.html".format(a["category"], a["slug"])

    with open(SOURCE_INDEX, "r", encoding="utf-8") as f:
        index_html = f.read()

    # La portada (index.html) no se regenera desde una plantilla como las
    # demas paginas -- se lee/reescribe in-place. Su bloque de Consent
    # Mode v2 + GA4 + AdSense vive entre estos dos marcadores HTML en el
    # <head> del archivo, y se sincroniza aca con la MISMA constante
    # CONSENT_ADS_BLOCK que usan las otras 11 plantillas, para que la
    # portada nunca quede desactualizada respecto al resto del sitio
    # (auditoria global, 2026-09-09; antes la portada ni siquiera tenia
    # el bloque de consentimiento -- adsbygoogle.js cargaba sin ningun
    # consent default previo).
    index_html = replace_between(
        index_html, "<!-- CONSENT_ADS_BLOCK:START -->", "<!-- CONSENT_ADS_BLOCK:END -->",
        CONSENT_ADS_BLOCK,
    )

    # Reconstruye el nav de categorías (sidebar, footer, chips de filtro)
    # desde data/categories.json y lo escribe de vuelta en index.html --
    # así queda como la fuente real para todas las páginas (ver más abajo,
    # sidebar_raw/footer_raw se extraen de acá mismo).
    index_html = replace_between(
        index_html, '<span class="side-label">Categories</span>', '</nav>',
        build_category_nav_html(menu_visible_cats),
    )
    index_html = replace_between(
        index_html,
        '<p>The most interesting stuff on the internet, every day. Discovery, not just news.</p>\n        </div>',
        '<div class="footer-col">\n          <h4>Trust</h4>',
        build_footer_categories_html(menu_visible_cats) + "\n",
    )
    index_html = replace_between(
        index_html, '<div class="filter-row" id="filterRow">', '</div>',
        build_filter_chips_html(menu_visible_cats),
    )

    # ---- Home: vuelca en el HTML inicial los rieles que antes quedaban
    # vacíos (Top 5 Trending, Latest Posts, y los 6 rieles por categoría)
    # a la espera de js/script.js -- así un rastreador que no ejecuta JS
    # (o lo hace con poca paciencia, como el evaluador de AdSense) ve
    # noticias reales, no contenedores vacíos con "Loading…". js/script.js
    # sigue corriendo encima (limpia el contenedor y repinta) para que
    # los filtros y el carrusel sigan funcionando -- ver el fix de
    # "innerHTML = ''" agregado ahí para no duplicar tarjetas.
    top5 = trending_list[:5]
    trend_html = "".join(build_feed_card_html(a, "", home_href(a), show_category=True) for a in top5) or EMPTY_RAIL_HTML
    index_html = replace_div_content_by_id(index_html, "trendStrip", trend_html)

    latest8 = latest_sorted[:8]
    latest_html = "".join(build_latest_item_html(a, home_href(a)) for a in latest8) or EMPTY_RAIL_HTML
    index_html = replace_div_content_by_id(index_html, "latestList", latest_html)

    for cat_slug in HOME_RAIL_CATEGORIES:
        items = featured_by_category.get(cat_slug, [])[:4]
        rail_html = "".join(build_feed_card_html(a, "", home_href(a)) for a in items) or EMPTY_RAIL_HTML
        index_html = replace_div_content_by_id(index_html, "rail-" + cat_slug, rail_html)

    with open(SOURCE_INDEX, "w", encoding="utf-8", newline="\n") as f:
        f.write(index_html)

    sidebar_start = index_html.index('<div class="mobile-topbar">')
    sidebar_end = index_html.index('</aside>') + len('</aside>')
    sidebar_raw = index_html[sidebar_start:sidebar_end]
    footer_start = index_html.index('    <footer class="site-footer">')
    footer_end = index_html.index('</footer>', footer_start) + len('</footer>')
    footer_raw = index_html[footer_start:footer_end]

    # Mismo bloque de sidebar/footer, pero con el prefijo de ruta correcto
    # según a qué profundidad va cada página -- antes se usaba SIEMPRE el
    # de 2 niveles (categoria/tema/artículo), incluso en páginas estáticas
    # (privacy, terms, etc., en la raíz) y en play/ (1 nivel adentro),
    # rompiendo el logo y todos los links del sidebar/footer en esas
    # páginas (apuntaban 1-2 carpetas más arriba de lo que correspondía).
    sidebar_block = localize(sidebar_raw, depth=2)     # categoria/<cat>/*.html
    footer_block = localize(footer_raw, depth=2)
    sidebar_block_play = localize(sidebar_raw, depth=1)  # play/*.html
    footer_block_play = localize(footer_raw, depth=1)
    sidebar_block_root = sidebar_raw                     # páginas estáticas en la raíz
    footer_block_root = footer_raw

    asset_prefix_page = "../../"  # para páginas de categoría/tema/artículo (2 niveles adentro)
    asset_prefix_root = ""  # para páginas estáticas / index (en la raíz)

    import datetime
    today = datetime.date.today().isoformat()
    sitemap_urls = [("/", today, "daily")]

    print("\nGenerando páginas de categoría y de tema...\n")
    os.makedirs(CATEGORIA_DIR, exist_ok=True)

    for cat in CATEGORY_SLUGS:
        slug = cat["slug"]
        if cat not in visible_cats:
            # Cybersecurity/Guides (publicMinArticles, auditoria
            # 2026-09-12) mientras no tengan el minimo de articulos
            # publicados e indexables: no se genera su categoria/<slug>/
            # index.html en absoluto (nunca un hub vacio o casi vacio) y
            # no aparecen en nav/footer/chips (ver visible_cats mas
            # arriba). Siguen disponibles en el panel/buscador para poder
            # asignarles articulos nuevos -- ver CATEGORIES_ACCEPTING_NEW_CONTENT.
            print("categoría {}: oculta (sin publicar aún -- faltan artículos para el mínimo público)".format(slug))
            continue
        label = CATEGORY_LABELS[slug]
        desc = DESCRIPTIONS[slug]
        note_html = ""
        if cat.get("has_note"):
            note_html = '    <p style="font-size:12.5px;color:var(--text-muted);margin:-14px 0 26px;max-width:60ch;">{}</p>\n'.format(strings["trending_note"])

        # Artículos propios de esta categoría -- "trending" es una vista
        # agregada (artículos marcados a mano desde el panel, de
        # cualquier categoría), el resto son los propios ordenados por
        # fecha. Esto es lo que antes quedaba vacío en el HTML crudo a la
        # espera de js/script.js -- ahora se vuelca acá directo.
        cat_items = trending_list if slug == "trending" else articles_by_category.get(slug, [])
        count = len(cat_items)
        cards_html = build_cards_grid_html(
            cat_items, asset_prefix_page,
            href_for=lambda a, s=slug: (a["slug"] + ".html") if a["category"] == s else "../{}/{}.html".format(a["category"], a["slug"]),
            show_category=(slug == "trending"),
        )

        feed_heading = strings["most_talked_about"] if slug == "trending" else strings["latest_news"]
        feed_html = (
            '    <div class="home-section" id="noticias">\n'
            '      <div class="section-head"><h2>{}</h2></div>\n'
            '      <div class="rail-grid" id="categoryGrid">{grid}</div>\n'
            '    </div>\n'
        ).format(feed_heading, grid=(cards_html or '<p class="latest-empty">No articles in this category yet.</p>'))

        # El sistema de temas/subtemas (grilla "Topics we cover" + páginas
        # de tema individuales) se retiró: la navegación quedó plana por
        # categoría, sin la capa intermedia de temas.
        topics_html = ""
        search_html = ""

        # Por debajo de MIN_CATEGORY_ARTICLES artículos propios, la
        # categoría se marca noindex,follow y se saca del sitemap -- para
        # no ofrecerle a Google/AdSense una página de listado casi vacía
        # como si fuera contenido completo. Sigue existiendo y siendo
        # navegable (follow), solo no se pide que se indexe todavía.
        is_thin = count < MIN_CATEGORY_ARTICLES
        robots_meta = '<meta name="robots" content="noindex,follow">\n' if is_thin else ""

        cat_url = SITE_URL + "/categoria/{}/".format(slug)
        seo_head = "\n".join([
            og_meta_block(cat_url, "{} — VexlowHQ".format(label), desc, None, page_type="website"),
            json_ld_script({
                "@context": "https://schema.org", "@type": "CollectionPage",
                "name": "{} — VexlowHQ".format(label), "description": desc, "url": cat_url,
            }),
            json_ld_script(breadcrumb_json_ld([("Home", SITE_URL + "/"), (label, cat_url)])),
        ])

        page = CATEGORY_PAGE_TEMPLATE.format(
            label=label, slug=slug, icon=cat["icon"], desc=desc,
            sidebar_block=sidebar_block, footer_block=footer_block,
            note_block=note_html, search_block=search_html, topics_block=topics_html, feed_block=feed_html,
            home=strings["home"], count_label=count_label_for(count),
            robots_meta=robots_meta, seo_head=seo_head,
            asset_prefix=asset_prefix_page, articulos_asset=ARTICULOS_ASSET,
            consent_ads_block=CONSENT_ADS_BLOCK,
        )
        cat_dir = os.path.join(CATEGORIA_DIR, slug)
        os.makedirs(cat_dir, exist_ok=True)
        out_path = os.path.join(cat_dir, "index.html")
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(page)
        print("categoría:", out_path, "({} artículos{})".format(count, ", noindex" if is_thin else ""))
        if not is_thin:
            sitemap_urls.append(("/categoria/{}/".format(slug), today, "daily"))

    print("\nGenerando artículos...\n")

    for art in publishable:
        cat = category_by_slug[art["category"]]
        cat_dir = os.path.join(CATEGORIA_DIR, cat["slug"])
        os.makedirs(cat_dir, exist_ok=True)

        # Las páginas de tema/subtema se retiraron junto con la navegación
        # por temas -- el breadcrumb y "Want more news about..." de cada
        # artículo apuntan directo a su categoría.
        topic_crumb = ""
        topic_href = "index.html"
        topic_label = cat["label"]

        title_short = art["title"] if len(art["title"]) <= 40 else art["title"][:37] + "..."
        body_blocks = art["body"]
        if isinstance(body_blocks, str):
            body_blocks = parse_simple_body(body_blocks)

        # "You might also like" nunca debe recomendar un artículo noindex
        # -- mismo criterio que las grillas de categoría/portada (ver
        # articles_by_category más arriba): se arma el pool de candidatos
        # sin ellos, aunque el propio "art" sea noindex (su página sigue
        # existiendo y puede mostrar sugerencias, solo no puede SER una).
        related_pool = [a for a in publishable if not a.get("noindex")]
        related = related_articles_for(art, related_pool)
        related_block = render_related_block(related, cat["slug"], asset_prefix_page, strings["you_might_also_like"])

        # Artículos marcados "noindex" desde el panel (en verificación
        # editorial, sin fuentes suficientes, pendientes de reescritura,
        # etc.) siguen generando su página y quedando en articulos.json
        # -- solo se les pide a los buscadores que no los indexen todavía
        # (noindex,follow: la página sigue siendo navegable) y se los
        # excluye del sitemap. Cuando se corrige el artículo y se destilda
        # el flag desde el panel, vuelve a aparecer normal en la próxima
        # publicación, sin necesidad de tocar el HTML a mano.
        art_is_noindex = bool(art.get("noindex"))
        robots_meta = '<meta name="robots" content="noindex,follow">\n' if art_is_noindex else ""

        # "Fecha de actualización" y "nota de corrección" -- para artículos
        # de la auditoría editorial que se reescriben con hechos
        # verificados: dejan constancia visible de cuándo y qué se corrigió,
        # sin alterar la fecha de publicación original.
        updated_html = ""
        if art.get("dateModified"):
            updated_html = '<span class="dot">·</span><span>Updated {}</span>'.format(format_date(art["dateModified"]))
        correction_html = ""
        if art.get("correctionNote"):
            correction_html = (
                '      <div class="correction-note" style="background:var(--surface-2,#f4f4f5);'
                'border-left:3px solid var(--accent,#666);padding:10px 14px;margin:14px 0;'
                'font-size:13px;color:var(--text-muted,#555);border-radius:4px;">'
                '<strong>Correction:</strong> {}</div>'
            ).format(art["correctionNote"])

        # Sourcing visible en el cuerpo del artículo -- fuente primaria
        # declarada (sourceUrl/sourceTitle) y, si existen, fuentes de
        # corroboración independiente (additionalSources: lista de
        # {url, label}). Antes esto solo vivía como metadato interno en
        # articulos.json y nunca se mostraba al lector.
        source_links = []
        if art.get("sourceUrl"):
            label = art.get("sourceTitle") or _domain_label(art["sourceUrl"])
            source_links.append((art["sourceUrl"], label, _accessed_suffix(art.get("sourceRetrievedAt"))))
        for extra in art.get("additionalSources") or []:
            if extra.get("url"):
                source_links.append((extra["url"], extra.get("label") or _domain_label(extra["url"]), _accessed_suffix(extra.get("retrievedAt"))))
        source_html = ""
        if source_links:
            # html.escape(label) -- paridad con pagegen.js (sourceHtmlFor() ahí
            # escapa el texto visible del link con escapeHtml()). Bug de
            # paridad encontrado el 2026-09-12 corriendo los 169 artículos
            # reales por ambos generadores: cuando sourceTitle/label traía un
            # apóstrofo (ej. "you've", "Here's"), Node lo convertía a &#x27;
            # y Python lo dejaba literal -- 21 de 169 páginas de artículo
            # salían con bytes distintos entre los dos generadores. No se
            # toca el href (tampoco se escapa del lado Node). accessed (ya
            # ascii, "(accessed Month D, YYYY)") no necesita escape propio.
            links_html = ", ".join(
                '<a href="{}" rel="nofollow noopener" target="_blank">{}</a>{}'.format(url, html.escape(label), html.escape(accessed))
                for url, label, accessed in source_links
            )
            label_txt = "Sources" if len(source_links) > 1 else "Source"
            source_html = (
                '      <p class="article-source" style="font-size:13px;color:var(--text-muted,#666);'
                'margin:10px 0 0;">' + label_txt + ": " + links_html + "</p>"
            )

        art_url = SITE_URL + "/categoria/{}/{}.html".format(cat["slug"], art["slug"])
        image_url = SITE_URL + "/" + art["image"] if art.get("image") else None
        seo_head = "\n".join([
            og_meta_block(art_url, "{} — VexlowHQ".format(art["title"]), art.get("dek", ""), image_url, page_type="article"),
            json_ld_script(article_json_ld(art, cat, art_url, image_url)),
            json_ld_script(breadcrumb_json_ld([
                ("Home", SITE_URL + "/"),
                (cat["label"], SITE_URL + "/categoria/{}/".format(cat["slug"])),
                (art["title"], art_url),
            ])),
        ])

        page = ARTICLE_PAGE_TEMPLATE.format(
            title=art["title"], title_short=title_short, slug=art["slug"], dek=art.get("dek", ""),
            cat_slug=cat["slug"], cat_label=cat["label"], cat_icon=cat["icon"],
            date_label=format_date(art["date"]), read_time=art.get("readTime", ""),
            banner_html=banner_html_for(art, cat, asset_prefix_page),
            body_html=render_article_body(body_blocks, asset_prefix_page),
            topic_crumb=topic_crumb, topic_label=topic_label, topic_href=topic_href,
            related_block=related_block,
            sidebar_block=sidebar_block, footer_block=footer_block,
            home=strings["home"], byline=strings["byline"], share=strings["share"],
            want_more=strings["want_more_about"].format(topic=topic_label),
            see_full_coverage=strings["see_full_coverage"],
            seo_head=seo_head, robots_meta=robots_meta,
            updated_html=updated_html, correction_html=correction_html, source_html=source_html,
            asset_prefix=asset_prefix_page, articulos_asset=ARTICULOS_ASSET,
            # Control de monetizacion (auditoria 2026-09-11): un articulo
            # noindex (auditoria editorial en curso o fusionado con redirect)
            # sigue con GA4/Consent Mode, pero nunca carga adsbygoogle.js --
            # no debe monetizarse aunque siga siendo navegable por URL directa.
            consent_ads_block=consent_block_for(not art_is_noindex),
        )
        out_path = os.path.join(cat_dir, art["slug"] + ".html")
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(page)
        print("artículo:", out_path, "(noindex)" if art_is_noindex else "")
        if not art_is_noindex:
            sitemap_urls.append(("/categoria/{}/{}.html".format(cat["slug"], art["slug"]), art.get("date", today), "monthly"))

    if redirect_articles:
        print("\nGenerando redirecciones...\n")
        for art in redirect_articles:
            # No se agrega a sitemap_urls -- nunca es contenido indexable,
            # solo el destino (ya incluido arriba si es publishable). Un
            # error acá (redirectTo roto) no debe tirar abajo toda la
            # regeneración del sitio -- server.js/pipeline.js ya lo
            # bloquean antes de guardar; esto es la segunda red de
            # seguridad para un regenerado completo directo.
            try:
                out_path = generate_redirect_file(art, articles, category_by_slug)
                print("redirect:", out_path, "->", art.get("redirectTo"))
            except ValueError as e:
                print("ERROR redirect:", art.get("slug"), "-", e)

    print("\nGenerando páginas estáticas...\n")
    for page in STATIC_PAGES:
        slug = page["slug"]
        page_url = SITE_URL + "/{}.html".format(slug)
        seo_head = og_meta_block(page_url, "{} — VexlowHQ".format(page["label"]), STATIC_PAGE_DESCRIPTIONS[slug], None, page_type="website")
        html_out = STATIC_PAGE_TEMPLATE.format(
            slug=slug, title=page["label"], desc=STATIC_PAGE_DESCRIPTIONS[slug],
            sidebar_block=sidebar_block_root, footer_block=footer_block_root,
            body_html=render_article_body(STATIC_PAGE_BODIES[slug]),
            home=strings["home"], asset_prefix=asset_prefix_root, articulos_asset=ARTICULOS_ASSET,
            seo_head=seo_head,
            # Privacy y Cookies nunca deben mostrar anuncios (auditoria
            # 2026-09-11) -- el resto de las paginas estaticas no cambia.
            consent_ads_block=consent_block_for(slug not in ("privacy", "cookies")),
        )
        out_path = os.path.join(PROJECT, slug + ".html")
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(html_out)
        print("página:", out_path)
        sitemap_urls.append(("/{}.html".format(slug), today, "yearly"))

    print("\nGenerando páginas de Games (hub, trivia, dash)...\n")
    play_dir = os.path.join(PROJECT, "play")
    os.makedirs(play_dir, exist_ok=True)
    # Cada juego versiona su(s) propio(s) .js -- ver js_asset_version() más
    # arriba. index.html/trivia.html no usan {cache_bust} en su plantilla
    # (.format() ignora el kwarg si no aparece), así que no hace falta
    # excluirlos acá.
    GAME_JS_FILES = {
        "dash.html": ("js/dash.js",),
        "snake.html": ("js/snake.js",),
        "orbit.html": ("js/orbit.js",),
        "gravity.html": ("js/gravity.js",),
        "pulse.html": ("js/pulse.js",),
        "wordsearch.html": ("js/wordsearch-data.js", "js/wordsearch.js"),
    }
    for filename, template, freq in (
        ("index.html", PLAY_HUB_TEMPLATE, "weekly"),
        ("trivia.html", PLAY_TRIVIA_TEMPLATE, "weekly"),
        ("dash.html", PLAY_DASH_TEMPLATE, "monthly"),
        ("snake.html", PLAY_SNAKE_TEMPLATE, "monthly"),
        ("orbit.html", PLAY_ORBIT_TEMPLATE, "monthly"),
        ("gravity.html", PLAY_GRAVITY_TEMPLATE, "monthly"),
        ("pulse.html", PLAY_PULSE_TEMPLATE, "monthly"),
        ("wordsearch.html", PLAY_WORDSEARCH_TEMPLATE, "monthly"),
    ):
        play_url = SITE_URL + "/play/" + filename
        seo_head = '<link rel="canonical" href="{}">'.format(play_url)
        js_files = GAME_JS_FILES.get(filename, ())
        cache_bust = js_asset_version(*js_files) if js_files else ""
        page_html = template.format(
            sidebar_block=sidebar_block_play, footer_block=footer_block_play, articulos_asset=ARTICULOS_ASSET,
            cache_bust=cache_bust, seo_head=seo_head,
            consent_ads_block=CONSENT_ADS_BLOCK,
        )
        page_path = os.path.join(play_dir, filename)
        with open(page_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(page_html)
        print("página:", page_path)
        sitemap_urls.append(("/play/{}".format(filename), today, freq))

    write_sitemap(sitemap_urls)


def write_sitemap(urls):
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for path, lastmod, changefreq in urls:
        lines.append("  <url>")
        lines.append("    <loc>{}{}</loc>".format(SITE_URL, path))
        lines.append("    <lastmod>{}</lastmod>".format(lastmod))
        lines.append("    <changefreq>{}</changefreq>".format(changefreq))
        lines.append("  </url>")
    lines.append("</urlset>")
    out_path = os.path.join(PROJECT, "sitemap.xml")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print("\nsitemap.xml:", out_path, "({} URLs)".format(len(urls)))


def parse_simple_body(text):
    """ Convierte el formato de texto simple del panel de admin (líneas en
        blanco = párrafo, '## ' = subtítulo, '- ' = lista) al mismo formato
        de bloques que usa render_article_body. Una línea '[publicidad]' se
        sigue reconociendo (por los artículos viejos que la tienen guardada
        en el texto) pero ya no genera nada al renderizar -- ver el caso
        "ad" en render_article_body. """
    blocks = []
    lines = text.replace("\r\n", "\n").split("\n")
    buf = []

    def flush():
        if buf:
            blocks.append(("p", " ".join(buf).strip()))
            buf.clear()

    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            flush()
            i += 1
            continue
        if line.startswith("## "):
            flush()
            blocks.append(("h2", line[3:]))
            i += 1
            continue
        if line.lower() == "[publicidad]":
            flush()
            blocks.append(("ad", None))
            i += 1
            continue
        img_match = re.match(r'^!\[(.*?)\]\((\S+)\)$', line)
        if img_match:
            flush()
            blocks.append(("img", (img_match.group(1), img_match.group(2))))
            i += 1
            continue
        if line.startswith("- "):
            flush()
            items = []
            while i < len(lines) and lines[i].strip().startswith("- "):
                items.append(lines[i].strip()[2:])
                i += 1
            blocks.append(("ul", items))
            continue
        buf.append(line)
        i += 1
    flush()
    return blocks


if __name__ == "__main__":
    generate()
    print("\nListo.")
