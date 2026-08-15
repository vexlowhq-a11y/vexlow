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
    CATEGORY_SLUGS.append(_entry)
    CATEGORY_LABELS[_cat["slug"]] = _cat["label"]
    DESCRIPTIONS[_cat["slug"]] = _cat.get("description", "")

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


def _category_list_sentence():
    labels = _category_labels_list()
    if len(labels) > 1:
        joined = ", ".join(labels[:-1]) + ", and " + labels[-1]
    else:
        joined = labels[0] if labels else ""
    count_word = _NUMBER_WORDS.get(len(labels), str(len(labels)))
    return "We publish across {} categories: {}. Every day we add news, guides, and analysis built for readers who want to stay current without hunting across a dozen sites.".format(count_word, joined)


def _category_list_lowercase_sentence():
    labels = [l.lower() for l in _category_labels_list()]
    if len(labels) > 1:
        return ", ".join(labels[:-1]) + ", and " + labels[-1]
    return labels[0] if labels else ""


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
        ("p", "We use first-party and third-party cookies to run the site and to show advertising. In particular, we use or may use Google AdSense, which uses cookies to serve ads based on your prior visits to this and other websites."),
        ("ul", [
            "Essential cookies: needed for the site to work correctly.",
            "Analytics cookies: help us understand how the site is used, in aggregate and anonymously.",
            "Advertising cookies: used by Google AdSense and other providers to show relevant ads.",
        ]),
        ("h2", "Your choices"),
        ("p", "You can delete or block cookies from your browser settings at any time. You can also manage Google's personalized advertising at <a href=\"https://adssettings.google.com\" target=\"_blank\" rel=\"noopener\">adssettings.google.com</a>."),
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
            "Analytics: help us understand which content performs best, in aggregate.",
            "Advertising: used by Google AdSense and other ad providers to show relevant advertising based on your interests.",
        ]),
        ("h2", "Managing cookies"),
        ("p", "You can delete or block cookies from your browser settings. Note that blocking some cookies may affect how the site works. For Google's personalized advertising, you can adjust your preferences at <a href=\"https://adssettings.google.com\" target=\"_blank\" rel=\"noopener\">adssettings.google.com</a>."),
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

def build_category_nav_html():
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
    for cat in CATEGORY_SLUGS:
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


def build_footer_categories_html():
    mid = (len(CATEGORY_SLUGS) + 1) // 2
    first_half = CATEGORY_SLUGS[:mid]
    second_half = CATEGORY_SLUGS[mid:]

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


def build_filter_chips_html():
    chips = ['        <button type="button" class="filter-chip active" data-filter="all">All</button>']
    for cat in CATEGORY_SLUGS:
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


CATEGORY_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{label} — VexlowHQ</title>
<meta name="description" content="{desc}">
<link rel="stylesheet" href="{asset_prefix}css/style.css">
<link rel="icon" type="image/x-icon" href="{asset_prefix}favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="{asset_prefix}favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="{asset_prefix}favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="{asset_prefix}apple-touch-icon.png">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
</head>
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
        <span class="count" id="categoryCount">{loading}</span>
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


def banner_html_for(art, cat, asset_prefix):
    embed_url = video_embed_url(art.get("videoUrl") or art.get("video"))
    if embed_url:
        return (
            '      <div class="article-banner video-wrap">\n'
            '        <iframe src="{}" title="{}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>\n'
            '      </div>\n'
        ).format(embed_url, art["title"].replace('"', "&quot;"))
    if art.get("image"):
        return '      <div class="article-banner media {}" style="background-image:url(\'{}{}\');background-size:cover;background-position:center;"></div>\n'.format(cat["slug"], asset_prefix, art["image"])
    return '      <div class="article-banner media {}">{}</div>\n'.format(cat["slug"], cat["icon"])


ARTICLE_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — VexlowHQ</title>
<meta name="description" content="{dek}">
<link rel="stylesheet" href="{asset_prefix}css/style.css">
<link rel="icon" type="image/x-icon" href="{asset_prefix}favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="{asset_prefix}favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="{asset_prefix}favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="{asset_prefix}apple-touch-icon.png">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
</head>
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
        <span>{byline}</span><span class="dot">·</span><span>{date_label}</span><span class="dot">·</span><span>{read_time}</span>
      </div>

{banner_html}
      <div class="article-body">
{body_html}      </div>

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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
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
          <h3>🏆 Enter your name</h3>
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
          <h3>⏸️ Quick break</h3>
          <button type="button" id="dashAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
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
          <h3>🏆 Enter your name</h3>
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
          <h3>⏸️ Quick break</h3>
          <button type="button" id="snakeAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
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
          <h3>🏆 Enter your name</h3>
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
          <h3>⏸️ Quick break</h3>
          <button type="button" id="orbitAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
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
              <span class="gravity-stat gravity-stat-coins">🪙 <b id="gravityHomeCoins">0</b><button type="button" class="gravity-stat-add" id="gravityHomeCoinsAdd" aria-label="Conseguir más monedas">+</button></span>
              <span class="gravity-stat gravity-stat-diamonds">💎 <b id="gravityHomeDiamonds">0</b><button type="button" class="gravity-stat-add" id="gravityHomeDiamondsAdd" aria-label="Conseguir más diamantes">+</button></span>
            </div>
            <div class="gravity-bottombar-row">
              <button type="button" class="gravity-level-card" id="gravityHomePlayBtn">
                <span class="gravity-level-card-top">
                  <span class="gravity-level-card-num" id="gravityHomeLvl">NIVEL 1</span>
                  <span class="gravity-level-card-stars" id="gravityHomeLvlStars">☆☆☆</span>
                </span>
                <span class="gravity-level-card-pct">TOTAL DEL NIVEL <b id="gravityHomeLvlPct">0%</b></span>
                <span class="gravity-player-progress-bar"><span class="gravity-player-progress-fill" id="gravityHomeProgressFill"></span></span>
              </button>
              <button type="button" class="gravity-navtab active" id="gravityHomeHomeTab" aria-label="Home">
                <span class="gravity-navtab-icon">🏠</span><span>HOME</span>
              </button>
              <button type="button" class="gravity-navtab" id="gravityHomeLevelsBtn" aria-label="Seleccionar nivel">
                <span class="gravity-navtab-icon">🗺️</span><span>NIVELES</span>
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
            <h3>SELECCIONAR NIVEL</h3>
            <span class="gravity-chip" id="gravityLevelStarsChip">⭐ 0/30</span>
          </div>
          <div class="gravity-select-grid" id="gravityLevelGrid"></div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="gravitySkinSelect">
        <div class="dash-name-card gravity-select-card gravity-skin-card">
          <div class="gravity-screen-topbar">
            <button type="button" id="gravitySkinSelectClose" class="gravity-back-btn" aria-label="Back">◀</button>
            <h3 id="gravitySkinScreenTitle">SELECCIONAR SKIN</h3>
            <span class="gravity-chip" id="gravitySkinWalletLine">🪙 0 💎 0</span>
          </div>
          <div class="gravity-skin-tabs">
            <button type="button" class="gravity-tab active" id="gravitySkinTabCollection">COLECCIÓN</button>
            <button type="button" class="gravity-tab" id="gravitySkinTabShop">TIENDA</button>
          </div>
          <div class="gravity-skin-rarities" id="gravitySkinRarities">
            <button type="button" class="gravity-rarity-tab active" data-rarity="all">TODOS</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="basico">BÁSICOS</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="raro">RAROS</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="epico">ÉPICOS</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="legendario">LEGENDARIOS</button>
            <button type="button" class="gravity-rarity-tab" data-rarity="especial">ESPECIALES</button>
          </div>
          <div class="gravity-skin-body">
            <div class="gravity-skin-preview" id="gravitySkinPreviewPanel">
              <div class="gravity-skin-preview-img"><img id="gravitySkinPreviewImg" src="../img/gravitycover/sliced/skin_01.png" alt=""></div>
              <strong id="gravitySkinPreviewName">NEON CLASSIC</strong>
              <span class="gravity-rarity-tag" id="gravitySkinPreviewRarity">BÁSICO</span>
              <button type="button" class="gravity-equip-btn" id="gravitySkinEquipBtn">EQUIPADO</button>
            </div>
            <div class="gravity-select-grid gravity-skin-grid" id="gravitySkinGrid"></div>
          </div>
        </div>
      </div>

      <div class="dash-name-modal hidden" id="gravityNameModal">
        <div class="dash-name-card">
          <h3>🏆 Enter your name</h3>
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
          <h3>⏸️ Quick break</h3>
          <button type="button" id="gravityAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
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
          <h3>🏆 Enter your name</h3>
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
          <h3>⏸️ Quick break</h3>
          <button type="button" id="pulseAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
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


def format_date(iso):
    y, m, d = iso.split("-")
    month = UI_STRINGS["months"][int(m) - 1]
    return UI_STRINGS["date_format"].format(d=int(d), month=month, y=y)


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
        html = html.replace(
            'href="categoria/{}/index.html"'.format(cat["slug"]),
            'href="{}categoria/{}/index.html"'.format(prefix, cat["slug"]),
        )
    for page in STATIC_PAGES:
        html = html.replace(
            'href="{}.html"'.format(page["slug"]),
            'href="{}{}.html"'.format(prefix, page["slug"]),
        )
    return html


def generate():
    strings = UI_STRINGS
    category_by_slug = {c["slug"]: dict(c, label=CATEGORY_LABELS[c["slug"]]) for c in CATEGORY_SLUGS}

    with open(SOURCE_INDEX, "r", encoding="utf-8") as f:
        index_html = f.read()

    # Reconstruye el nav de categorías (sidebar, footer, chips de filtro)
    # desde data/categories.json y lo escribe de vuelta en index.html --
    # así queda como la fuente real para todas las páginas (ver más abajo,
    # sidebar_raw/footer_raw se extraen de acá mismo).
    index_html = replace_between(
        index_html, '<span class="side-label">Categories</span>', '</nav>',
        build_category_nav_html(),
    )
    index_html = replace_between(
        index_html,
        '<p>The most interesting stuff on the internet, every day. Discovery, not just news.</p>\n        </div>',
        '<div class="footer-col">\n          <h4>Trust</h4>',
        build_footer_categories_html() + "\n",
    )
    index_html = replace_between(
        index_html, '<div class="filter-row" id="filterRow">', '</div>',
        build_filter_chips_html(),
    )
    with open(SOURCE_INDEX, "w", encoding="utf-8") as f:
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
        label = CATEGORY_LABELS[slug]
        desc = DESCRIPTIONS[slug]
        note_html = ""
        if cat.get("has_note"):
            note_html = '    <p style="font-size:12.5px;color:var(--text-muted);margin:-14px 0 26px;max-width:60ch;">{}</p>\n'.format(strings["trending_note"])

        feed_heading = strings["most_talked_about"] if slug == "trending" else strings["latest_news"]
        feed_html = (
            '    <div class="home-section" id="noticias">\n'
            '      <div class="section-head"><h2>{}</h2></div>\n'
            '      <div class="rail-grid" id="categoryGrid"></div>\n'
            '    </div>\n'
        ).format(feed_heading)

        # El sistema de temas/subtemas (grilla "Topics we cover" + páginas
        # de tema individuales) se retiró: la navegación quedó plana por
        # categoría, sin la capa intermedia de temas.
        topics_html = ""
        search_html = ""
        flat_topics = []

        page = CATEGORY_PAGE_TEMPLATE.format(
            label=label, slug=slug, icon=cat["icon"], desc=desc,
            sidebar_block=sidebar_block, footer_block=footer_block,
            note_block=note_html, search_block=search_html, topics_block=topics_html, feed_block=feed_html,
            home=strings["home"], loading=strings["loading"],
            asset_prefix=asset_prefix_page, articulos_asset=ARTICULOS_ASSET,
        )
        cat_dir = os.path.join(CATEGORIA_DIR, slug)
        os.makedirs(cat_dir, exist_ok=True)
        out_path = os.path.join(cat_dir, "index.html")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(page)
        print("categoría:", out_path)
        sitemap_urls.append(("/categoria/{}/".format(slug), today, "daily"))

    print("\nGenerando artículos...\n")
    with open(ARTICULOS_JSON, "r", encoding="utf-8") as f:
        articles = json.load(f)

    for art in articles:
        if not art.get("slug") or not (art.get("body") and str(art.get("body")).strip()):
            continue
        cat = category_by_slug.get(art["category"])
        if not cat:
            continue
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

        page = ARTICLE_PAGE_TEMPLATE.format(
            title=art["title"], title_short=title_short, slug=art["slug"], dek=art.get("dek", ""),
            cat_slug=cat["slug"], cat_label=cat["label"], cat_icon=cat["icon"],
            date_label=format_date(art["date"]), read_time=art.get("readTime", ""),
            banner_html=banner_html_for(art, cat, asset_prefix_page),
            body_html=render_article_body(body_blocks, asset_prefix_page),
            topic_crumb=topic_crumb, topic_label=topic_label, topic_href=topic_href,
            sidebar_block=sidebar_block, footer_block=footer_block,
            home=strings["home"], byline=strings["byline"], share=strings["share"],
            want_more=strings["want_more_about"].format(topic=topic_label),
            see_full_coverage=strings["see_full_coverage"],
            asset_prefix=asset_prefix_page, articulos_asset=ARTICULOS_ASSET,
        )
        out_path = os.path.join(cat_dir, art["slug"] + ".html")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(page)
        print("artículo:", out_path)
        sitemap_urls.append(("/categoria/{}/{}.html".format(cat["slug"], art["slug"]), art.get("date", today), "monthly"))

    print("\nGenerando páginas estáticas...\n")
    for page in STATIC_PAGES:
        slug = page["slug"]
        html = STATIC_PAGE_TEMPLATE.format(
            slug=slug, title=page["label"], desc=STATIC_PAGE_DESCRIPTIONS[slug],
            sidebar_block=sidebar_block_root, footer_block=footer_block_root,
            body_html=render_article_body(STATIC_PAGE_BODIES[slug]),
            home=strings["home"], asset_prefix=asset_prefix_root, articulos_asset=ARTICULOS_ASSET,
        )
        out_path = os.path.join(PROJECT, slug + ".html")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        print("página:", out_path)
        sitemap_urls.append(("/{}.html".format(slug), today, "yearly"))

    print("\nGenerando páginas de Games (hub, trivia, dash)...\n")
    play_dir = os.path.join(PROJECT, "play")
    os.makedirs(play_dir, exist_ok=True)
    for filename, template, freq in (
        ("index.html", PLAY_HUB_TEMPLATE, "weekly"),
        ("trivia.html", PLAY_TRIVIA_TEMPLATE, "weekly"),
        ("dash.html", PLAY_DASH_TEMPLATE, "monthly"),
        ("snake.html", PLAY_SNAKE_TEMPLATE, "monthly"),
        ("orbit.html", PLAY_ORBIT_TEMPLATE, "monthly"),
        ("gravity.html", PLAY_GRAVITY_TEMPLATE, "monthly"),
        ("pulse.html", PLAY_PULSE_TEMPLATE, "monthly"),
    ):
        page_html = template.format(
            sidebar_block=sidebar_block_play, footer_block=footer_block_play, articulos_asset=ARTICULOS_ASSET,
            cache_bust=str(int(time.time())),
        )
        page_path = os.path.join(play_dir, filename)
        with open(page_path, "w", encoding="utf-8") as f:
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
    with open(out_path, "w", encoding="utf-8") as f:
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
