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

import json
import os
import re
import time

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(PROJECT, "img")
DATA_DIR = os.path.join(PROJECT, "data")
CATEGORIA_DIR = os.path.join(PROJECT, "categoria")
TOPICS_FILE = os.path.join(DATA_DIR, "topics.json")
SUBTOPICS_FILE = os.path.join(DATA_DIR, "subtopics.json")
ARTICULOS_JSON = os.path.join(DATA_DIR, "articulos.json")
ARTICULOS_ASSET = "data/articulos.js"
SOURCE_INDEX = os.path.join(PROJECT, "index.html")
SITE_URL = "https://vexlowhq.com"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".avif", ".svg"}

CATEGORY_SLUGS = [
    {"slug": "trending", "icon": "🌍", "has_note": True},
    {"slug": "ai", "icon": "🤖"},
    {"slug": "technology", "icon": "💻"},
    {"slug": "science", "icon": "🚀", "img_folder": "science-space"},
    {"slug": "gaming", "icon": "🎮"},
    {"slug": "entertainment", "icon": "🎬"},
    {"slug": "sports", "icon": "⚽"},
    {"slug": "world", "icon": "🌎"},
    {"slug": "curiosities", "icon": "💡"},
    {"slug": "guides", "icon": "📚"},
    {"slug": "social", "icon": "📱"},
    {"slug": "business", "icon": "💰"},
]

CATEGORY_LABELS = {
    "trending": "Trending", "ai": "AI", "technology": "Technology",
    "science": "Science & Space", "gaming": "Gaming", "entertainment": "Entertainment",
    "sports": "Sports", "world": "World", "curiosities": "Curiosities",
    "guides": "Guides", "social": "Social Media", "business": "Business",
}

DESCRIPTIONS = {
    "trending": "The most talked-about stories of the day: viral moments, records, major events, and social media trends.",
    "ai": "Everything about artificial intelligence: new models, tools, tutorials, comparisons, and prompts.",
    "technology": "Phones, computers, apps, software, and the gadgets that matter.",
    "science": "NASA, SpaceX, discoveries, medicine, and nature.",
    "gaming": "Releases, updates, guides, consoles, and mobile games.",
    "entertainment": "Movies, TV series, streaming, music, and celebrities.",
    "sports": "Soccer, the World Cup, NBA, Formula 1, and sports records.",
    "world": "Odd news, economy, major events, and culture.",
    "curiosities": "Did you know...? Rankings, surprising facts, inventions, and amazing places.",
    "guides": "Content that lasts for years: step-by-step tutorials and guides.",
    "social": "TikTok, Instagram, YouTube, X, Twitch, Discord, and everything happening on social media.",
    "business": "Startups, cryptocurrency, investing, marketing, and the world of business.",
}

UI_STRINGS = {
    "home": "Home", "loading": "Loading…",
    "trending_note": "These are the articles marked as Trending from the admin panel. If none are marked yet, you'll see the most recent stories across all categories.",
    "search_placeholder": "Search a topic by name...", "no_topic_results": "We couldn't find a topic with that name.",
    "see_full_coverage": "See full coverage →", "topics_we_cover": "📌 Topics we cover",
    "all_coverage_of": "All VexlowHQ coverage of {topic}.",
    "everything_about": "Everything we've published about {topic}, in one place.",
    "latest_news": "📰 Latest News", "most_talked_about": "📰 What's Trending",
    "ad_infeed": "Advertisement · in-feed responsive", "ad_inarticle": "Advertisement · in-article",
    "byline": "VexlowHQ Staff", "share": "Share",
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

STATIC_PAGE_BODIES = {
    "about-vexlowhq": [
        ("p", "VexlowHQ started with a simple idea: bring the most interesting things happening in the world into one place, whether that's artificial intelligence, a big game launch, a scientific discovery, or the story everyone's talking about on social media."),
        ("h2", "What we cover"),
        ("p", "We publish across eleven categories: AI, Technology, Science & Space, Gaming, Entertainment, Sports, World, Curiosities, Guides, Social Media, and Business. Every day we add news, guides, and analysis built for readers who want to stay current without hunting across a dozen sites."),
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
        ("p", "VexlowHQ is a content discovery site covering artificial intelligence, technology, science, gaming, entertainment, sports, world news, curiosities, guides, social media, and business — built for a general audience that wants to stay current."),
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


def img_thumbs_for(cat):
    folder = cat.get("img_folder", cat["slug"])
    base = os.path.join(IMG_DIR, folder)
    thumbs = {}
    if not os.path.isdir(base):
        return thumbs
    for entry in sorted(os.listdir(base)):
        full = os.path.join(base, entry)
        if not os.path.isdir(full):
            continue
        for f in sorted(os.listdir(full)):
            if os.path.splitext(f)[1].lower() in IMAGE_EXT:
                thumbs[entry.lower()] = "img/{}/{}/{}".format(folder, entry, f)
                break
    return thumbs


# Igual que img_thumbs_for, pero un nivel más adentro: img/{folder}/{topic_slug}/{subtopic_slug}/
def subtopic_img_thumbs_for(cat, topic_slug):
    folder = cat.get("img_folder", cat["slug"])
    base = os.path.join(IMG_DIR, folder, topic_slug)
    thumbs = {}
    if not os.path.isdir(base):
        return thumbs
    for entry in sorted(os.listdir(base)):
        full = os.path.join(base, entry)
        if not os.path.isdir(full):
            continue
        for f in sorted(os.listdir(full)):
            if os.path.splitext(f)[1].lower() in IMAGE_EXT:
                thumbs[entry.lower()] = "img/{}/{}/{}/{}".format(folder, topic_slug, entry, f)
                break
    return thumbs


def find_topics_auto(cat):
    thumbs = img_thumbs_for(cat)
    topics = []
    for slug, thumb in thumbs.items():
        if slug == "index":
            continue
        topics.append({"slug": slug, "label": camel_to_label(slug), "thumb": thumb})
    return topics


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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
    <div class="home-section" style="margin-top: 32px;">
      <div class="ad-slot">{ad_infeed}</div>
    </div>

{footer_block}

  </main>
</div>

<script src="{asset_prefix}{articulos_asset}"></script>
<script src="{asset_prefix}js/script.js"></script>
</body>
</html>
"""

TOPIC_CARD_TEMPLATE = """        <a class="guide-card" href="{slug}.html">{thumb_or_icon}<h3>{label}</h3><p>{view_more}</p></a>
"""

TOPICS_GROUP_SECTION_TEMPLATE = """    <div class="home-section" style="margin-top:0;">
      <div class="section-head"><h2>{group_name}</h2></div>
      <div class="guides-grid">
{topic_cards}      </div>
    </div>

"""

TOPIC_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{topic_label} — {cat_label} — VexlowHQ</title>
<meta name="description" content="{meta_desc}">
<meta name="robots" content="noindex, follow">
<link rel="stylesheet" href="{asset_prefix}css/style.css">
<link rel="icon" type="image/x-icon" href="{asset_prefix}favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="{asset_prefix}favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="{asset_prefix}favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="{asset_prefix}apple-touch-icon.png">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  gtag('config', 'G-20Z63KYZ3K');
</script>
</head>
<body data-category="{cat_slug}" data-topic="{topic_slug}"{subtopic_attr}>

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../../index.html">{home}</a><span class="sep">/</span><a href="index.html">{cat_label}</a>{parent_crumb}<span class="sep">/</span><span class="current">{topic_label}</span>
    </nav>

    <div class="category-header">
      <span class="ic-badge">{cat_icon}</span>
      <div>
        <h1>{topic_label}</h1>
        <p>{everything_about}</p>
        <span class="count" id="categoryCount">{loading}</span>
      </div>
    </div>

{content_block}
    <div class="home-section" style="margin-top: 32px;">
      <div class="ad-slot">{ad_infeed}</div>
    </div>

{footer_block}

  </main>
</div>

<script src="{asset_prefix}{articulos_asset}"></script>
<script src="{asset_prefix}js/script.js"></script>
</body>
</html>
"""

# Contenido por defecto de una página de tema/subtema: la grilla plana de
# artículos, llenada en el cliente por js/script.js según data-category/
# data-topic/data-subtopic. Se usa siempre en subtemas (nivel hoja) y en
# temas que todavía no tienen subtemas propios.
ARTICLES_GRID_BLOCK = (
    '    <div class="home-section" id="noticias">\n'
    '      <div class="section-head"><h2>{latest_news}</h2></div>\n'
    '      <div class="rail-grid" id="categoryGrid"></div>\n'
    '    </div>\n'
    '\n'
)


def thumb_or_icon_html(thumb, icon, asset_prefix):
    if thumb:
        return '<span class="ic" style="width:100%;height:64px;border-radius:8px;background-image:url(\'{}{}\');background-size:cover;background-position:center;display:block;margin-bottom:4px;"></span>'.format(asset_prefix, thumb)
    return '<span class="ic">{}</span>'.format(icon)


AD_SLOT_HTML_TPL = '      <div class="ad-slot" style="margin: 30px 0;">{}</div>\n'


def apply_inline(text):
    """ "**texto**" -> <strong>texto</strong>, dentro de párrafos, subtítulos,
        ítems de lista y pies de foto (nunca dentro del atributo alt). """
    return re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)


def render_article_body(body, default_ad_text="Advertisement · in-article", asset_prefix=""):
    html = ""
    for block in body:
        kind, content = block[0], block[1]
        ad_text = block[2] if len(block) > 2 else default_ad_text
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
            html += AD_SLOT_HTML_TPL.format(ad_text)
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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

      <div class="ad-slot" style="margin: 30px 0;">Advertisement · in-article</div>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
          <div class="ad-slot" style="margin: 4px 0 18px;">Advertisement</div>
          <button type="button" id="dashAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
        <ol class="dash-leaderboard-list" id="dashLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="dashYouRank" hidden></p>
      </div>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

      <div class="ad-slot" style="margin: 30px 0;">Advertisement · in-article</div>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
          <div class="ad-slot" style="margin: 4px 0 18px;">Advertisement</div>
          <button type="button" id="snakeAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
        <ol class="dash-leaderboard-list" id="snakeLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="snakeYouRank" hidden></p>
      </div>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

      <div class="ad-slot" style="margin: 30px 0;">Advertisement · in-article</div>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
          <div class="ad-slot" style="margin: 4px 0 18px;">Advertisement</div>
          <button type="button" id="orbitAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
        <ol class="dash-leaderboard-list" id="orbitLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="orbitYouRank" hidden></p>
      </div>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

      <div class="ad-slot" style="margin: 30px 0;">Advertisement · in-article</div>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
          <span id="gravityCoins">🪙 0/3</span>
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
          <div class="gravity-home-topbar">
            <div class="gravity-player-card">
              <div class="gravity-player-avatar"><img id="gravityHomeAvatar" src="../img/gravitycover/sliced/skin_01.png" alt=""></div>
              <div class="gravity-player-info">
                <strong id="gravityHomeName">PLAYER</strong>
                <div class="gravity-player-stars">⭐ <span id="gravityHomeStars">0/30</span></div>
              </div>
            </div>
            <div class="gravity-home-currency">
              <span class="gravity-chip">🪙 <span id="gravityHomeCoins">0</span></span>
              <span class="gravity-chip">💎 <span id="gravityHomeDiamonds">0</span></span>
            </div>
          </div>
          <h2 class="gravity-home-title">GRAVITY<br>FLIP</h2>
          <div class="gravity-home-actions">
            <button type="button" class="gravity-oct gravity-oct-side" id="gravityHomeLevelsBtn">
              <span class="gravity-oct-icon">🗺️</span><span>NIVELES</span>
            </button>
            <button type="button" class="gravity-oct gravity-oct-play" id="gravityHomePlayBtn">
              <span class="gravity-oct-icon">▶</span><span>JUGAR</span>
            </button>
            <button type="button" class="gravity-oct gravity-oct-side" id="gravityHomeSkinsBtn">
              <span class="gravity-oct-icon">🧑‍🚀</span><span>SKINS</span>
            </button>
          </div>
          <p class="gravity-home-tip">¡Completá niveles y conseguí recompensas!</p>
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
          <div class="ad-slot" style="margin: 4px 0 18px;">Advertisement</div>
          <button type="button" id="gravityAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
        <ol class="dash-leaderboard-list" id="gravityLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="gravityYouRank" hidden></p>
      </div>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

      <div class="ad-slot" style="margin: 30px 0;">Advertisement · in-article</div>
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
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
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
          <div class="ad-slot" style="margin: 4px 0 18px;">Advertisement</div>
          <button type="button" id="pulseAdBreakContinue" class="dash-name-save" style="width:100%;">Continue ▶</button>
        </div>
      </div>

      <div class="dash-leaderboard">
        <h3>🏆 Top Scores</h3>
        <ol class="dash-leaderboard-list" id="pulseLeaderboardList"><li class="dash-lb-empty">Loading…</li></ol>
        <p class="dash-lb-you" id="pulseYouRank" hidden></p>
      </div>

      <div class="play-more"><a href="index.html">← Back to all games</a></div>

      <div class="ad-slot" style="margin: 30px 0;">Advertisement · in-article</div>
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


def localize(html):
    """ Agrega '../../' a los links entre páginas del mismo árbol (siempre
        igual, las páginas de categoria/tema/artículo están 2 carpetas
        adentro de la raíz). """
    html = html.replace('href="index.html"', 'href="../../index.html"')
    html = html.replace('href="play/index.html"', 'href="../../play/index.html"')
    html = html.replace('src="img/', 'src="../../img/')
    html = html.replace("url('img/", "url('../../img/")
    for cat in CATEGORY_SLUGS:
        html = html.replace(
            'href="categoria/{}/index.html"'.format(cat["slug"]),
            'href="../../categoria/{}/index.html"'.format(cat["slug"]),
        )
    for page in STATIC_PAGES:
        html = html.replace(
            'href="{}.html"'.format(page["slug"]),
            'href="../../{}.html"'.format(page["slug"]),
        )
    return html


def generate():
    strings = UI_STRINGS
    category_by_slug = {c["slug"]: dict(c, label=CATEGORY_LABELS[c["slug"]]) for c in CATEGORY_SLUGS}

    with open(SOURCE_INDEX, "r", encoding="utf-8") as f:
        index_html = f.read()
    sidebar_start = index_html.index('<div class="mobile-topbar">')
    sidebar_end = index_html.index('</aside>') + len('</aside>')
    sidebar_block = localize(index_html[sidebar_start:sidebar_end])
    footer_start = index_html.index('    <footer class="site-footer">')
    footer_end = index_html.index('</footer>', footer_start) + len('</footer>')
    footer_block = localize(index_html[footer_start:footer_end])

    with open(TOPICS_FILE, "r", encoding="utf-8") as f:
        topic_groups = json.load(f)

    try:
        with open(SUBTOPICS_FILE, "r", encoding="utf-8") as f:
            subtopics_data = json.load(f)
    except (IOError, OSError):
        subtopics_data = {}

    def topic_label_for(cat_slug, topic_slug):
        for group_name, items in topic_groups.get(cat_slug, []):
            for slug, label in items:
                if slug == topic_slug:
                    return label
        return None

    def subtopics_for(cat_slug, topic_slug):
        return subtopics_data.get("{}/{}".format(cat_slug, topic_slug), [])

    def subtopic_label_for(cat_slug, topic_slug, subtopic_slug):
        for slug, label in subtopics_for(cat_slug, topic_slug):
            if slug == subtopic_slug:
                return label
        return None

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

        feed_html = ""
        if slug == "trending":
            feed_html = (
                '    <div class="home-section" id="noticias">\n'
                '      <div class="section-head"><h2>{}</h2></div>\n'
                '      <div class="rail-grid" id="categoryGrid"></div>\n'
                '    </div>\n'
            ).format(strings["most_talked_about"])

        topics_html = ""
        search_html = ""
        flat_topics = []

        if slug in topic_groups:
            thumbs = img_thumbs_for(cat)
            seen = set()
            for group_name, items in topic_groups[slug]:
                cards = ""
                for topic_slug, topic_label in items:
                    thumb = thumbs.get(topic_slug)
                    cards += TOPIC_CARD_TEMPLATE.format(
                        slug=topic_slug, label=topic_label,
                        thumb_or_icon=thumb_or_icon_html(thumb, cat["icon"], asset_prefix_page),
                        view_more=strings["view_more_cards"],
                    )
                    if topic_slug not in seen:
                        seen.add(topic_slug)
                        flat_topics.append({"slug": topic_slug, "label": topic_label, "thumb": thumb})
                topics_html += TOPICS_GROUP_SECTION_TEMPLATE.format(group_name=group_name, topic_cards=cards)
            search_html = (
                '    <div class="topic-search">\n'
                '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>\n'
                '      <input type="search" id="topicSearch" placeholder="{}">\n'
                '    </div>\n'
                '    <p class="topic-no-results" id="topicNoResults">{}</p>\n'
            ).format(strings["search_placeholder"], strings["no_topic_results"])
        else:
            auto_topics = find_topics_auto(cat)
            if auto_topics:
                cards = ""
                for t in auto_topics:
                    cards += TOPIC_CARD_TEMPLATE.format(
                        slug=t["slug"], label=t["label"],
                        thumb_or_icon=thumb_or_icon_html(t["thumb"], cat["icon"], asset_prefix_page),
                        view_more=strings["view_more_cards"],
                    )
                topics_html = TOPICS_GROUP_SECTION_TEMPLATE.format(group_name=strings["topics_we_cover"], topic_cards=cards)
                flat_topics = auto_topics

        page = CATEGORY_PAGE_TEMPLATE.format(
            label=label, slug=slug, icon=cat["icon"], desc=desc,
            sidebar_block=sidebar_block, footer_block=footer_block,
            note_block=note_html, search_block=search_html, topics_block=topics_html, feed_block=feed_html,
            home=strings["home"], loading=strings["loading"], ad_infeed=strings["ad_infeed"],
            asset_prefix=asset_prefix_page, articulos_asset=ARTICULOS_ASSET,
        )
        cat_dir = os.path.join(CATEGORIA_DIR, slug)
        os.makedirs(cat_dir, exist_ok=True)
        out_path = os.path.join(cat_dir, "index.html")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(page)
        print("categoría:", out_path, "({} temas)".format(len(flat_topics)))
        sitemap_urls.append(("/categoria/{}/".format(slug), today, "daily"))

        for t in flat_topics:
            sub_items = subtopics_for(slug, t["slug"])

            if sub_items:
                sub_thumbs = subtopic_img_thumbs_for(cat, t["slug"])
                sub_cards = ""
                for sub_slug, sub_label in sub_items:
                    sub_cards += TOPIC_CARD_TEMPLATE.format(
                        slug=t["slug"] + "-" + sub_slug, label=sub_label,
                        thumb_or_icon=thumb_or_icon_html(sub_thumbs.get(sub_slug), cat["icon"], asset_prefix_page),
                        view_more=strings["view_more_cards"],
                    )
                content_block = TOPICS_GROUP_SECTION_TEMPLATE.format(group_name=strings["topics_we_cover"], topic_cards=sub_cards)
            else:
                content_block = ARTICLES_GRID_BLOCK.format(latest_news=strings["latest_news"])

            topic_page = TOPIC_PAGE_TEMPLATE.format(
                topic_label=t["label"], topic_slug=t["slug"],
                cat_label=label, cat_slug=slug, cat_icon=cat["icon"],
                sidebar_block=sidebar_block, footer_block=footer_block,
                home=strings["home"], loading=strings["loading"], ad_infeed=strings["ad_infeed"],
                content_block=content_block, subtopic_attr="", parent_crumb="",
                everything_about=strings["everything_about"].format(topic=t["label"]),
                meta_desc=strings["all_coverage_of"].format(topic=t["label"]),
                asset_prefix=asset_prefix_page, articulos_asset=ARTICULOS_ASSET,
            )
            topic_path = os.path.join(cat_dir, t["slug"] + ".html")
            with open(topic_path, "w", encoding="utf-8") as f:
                f.write(topic_page)
            # noindex (ver TOPIC_PAGE_TEMPLATE): no tiene sentido sumarla al
            # sitemap si le pedimos a Google que no la indexe.

            parent_crumb_html = '<span class="sep">/</span><a href="{}.html">{}</a>'.format(t["slug"], t["label"])
            for sub_slug, sub_label in sub_items:
                sub_page = TOPIC_PAGE_TEMPLATE.format(
                    topic_label=sub_label, topic_slug=t["slug"],
                    cat_label=label, cat_slug=slug, cat_icon=cat["icon"],
                    sidebar_block=sidebar_block, footer_block=footer_block,
                    home=strings["home"], loading=strings["loading"], ad_infeed=strings["ad_infeed"],
                    content_block=ARTICLES_GRID_BLOCK.format(latest_news=strings["latest_news"]),
                    subtopic_attr=' data-subtopic="{}"'.format(sub_slug), parent_crumb=parent_crumb_html,
                    everything_about=strings["everything_about"].format(topic=sub_label),
                    meta_desc=strings["all_coverage_of"].format(topic=sub_label),
                    asset_prefix=asset_prefix_page, articulos_asset=ARTICULOS_ASSET,
                )
                sub_path = os.path.join(cat_dir, t["slug"] + "-" + sub_slug + ".html")
                with open(sub_path, "w", encoding="utf-8") as f:
                    f.write(sub_page)
                # noindex (ver TOPIC_PAGE_TEMPLATE): no la sumamos al sitemap.

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

        topic_slug = art.get("topic")
        topic_label = topic_label_for(art["category"], topic_slug) if topic_slug else None
        topic_crumb = ""
        topic_href = "index.html"
        if topic_slug and topic_label:
            topic_crumb = '<span class="sep">/</span><a href="{}.html">{}</a>'.format(topic_slug, topic_label)
            topic_href = topic_slug + ".html"
        elif not topic_label:
            topic_label = cat["label"]

        # Subtema (un nivel más adentro de un tema) — si está asignado, se
        # agrega como cuarto nivel del breadcrumb y pasa a ser el destino
        # de "Want more news about...".
        subtopic_slug = art.get("subtopic")
        subtopic_label = subtopic_label_for(art["category"], topic_slug, subtopic_slug) if (topic_slug and subtopic_slug) else None
        if topic_slug and subtopic_slug and subtopic_label:
            topic_crumb += '<span class="sep">/</span><a href="{}-{}.html">{}</a>'.format(topic_slug, subtopic_slug, subtopic_label)
            topic_label = subtopic_label
            topic_href = "{}-{}.html".format(topic_slug, subtopic_slug)

        title_short = art["title"] if len(art["title"]) <= 40 else art["title"][:37] + "..."
        body_blocks = art["body"]
        if isinstance(body_blocks, str):
            body_blocks = parse_simple_body(body_blocks)

        page = ARTICLE_PAGE_TEMPLATE.format(
            title=art["title"], title_short=title_short, slug=art["slug"], dek=art.get("dek", ""),
            cat_slug=cat["slug"], cat_label=cat["label"], cat_icon=cat["icon"],
            date_label=format_date(art["date"]), read_time=art.get("readTime", ""),
            banner_html=banner_html_for(art, cat, asset_prefix_page),
            body_html=render_article_body(body_blocks, strings["ad_inarticle"], asset_prefix_page),
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
            sidebar_block=sidebar_block, footer_block=footer_block,
            body_html=render_article_body(STATIC_PAGE_BODIES[slug], strings["ad_inarticle"]),
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
            sidebar_block=sidebar_block, footer_block=footer_block, articulos_asset=ARTICULOS_ASSET,
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
        blanco = párrafo, '## ' = subtítulo, '- ' = lista, '[publicidad]' =
        anuncio) al mismo formato de bloques que usa render_article_body. """
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
