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

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(PROJECT, "img")
DATA_DIR = os.path.join(PROJECT, "data")
CATEGORIA_DIR = os.path.join(PROJECT, "categoria")
TOPICS_FILE = os.path.join(DATA_DIR, "topics.json")
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
<link rel="stylesheet" href="{asset_prefix}css/style.css">
<link rel="icon" type="image/x-icon" href="{asset_prefix}favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="{asset_prefix}favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="{asset_prefix}favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="{asset_prefix}apple-touch-icon.png">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>
</head>
<body data-category="{cat_slug}" data-topic="{topic_slug}">

{sidebar_block}

  <main>

    <nav class="breadcrumb">
      <a href="../../index.html">{home}</a><span class="sep">/</span><a href="index.html">{cat_label}</a><span class="sep">/</span><span class="current">{topic_label}</span>
    </nav>

    <div class="category-header">
      <span class="ic-badge">{cat_icon}</span>
      <div>
        <h1>{topic_label}</h1>
        <p>{everything_about}</p>
        <span class="count" id="categoryCount">{loading}</span>
      </div>
    </div>

    <div class="home-section" id="noticias">
      <div class="section-head"><h2>{latest_news}</h2></div>
      <div class="rail-grid" id="categoryGrid"></div>
    </div>

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


def thumb_or_icon_html(thumb, icon, asset_prefix):
    if thumb:
        return '<span class="ic" style="width:100%;height:64px;border-radius:8px;background-image:url(\'{}{}\');background-size:cover;background-position:center;display:block;margin-bottom:4px;"></span>'.format(asset_prefix, thumb)
    return '<span class="ic">{}</span>'.format(icon)


AD_SLOT_HTML_TPL = '      <div class="ad-slot" style="margin: 30px 0;">{}</div>\n'


def render_article_body(body, default_ad_text="Advertisement · in-article"):
    html = ""
    for block in body:
        kind, content = block[0], block[1]
        ad_text = block[2] if len(block) > 2 else default_ad_text
        if kind == "p":
            html += "      <p>{}</p>\n".format(content)
        elif kind == "h2":
            html += "      <h2>{}</h2>\n".format(content)
        elif kind == "ul":
            html += "      <ul>\n"
            for item in content:
                html += "        <li>{}</li>\n".format(item)
            html += "      </ul>\n"
        elif kind == "ad":
            html += AD_SLOT_HTML_TPL.format(ad_text)
    return html


def youtube_embed_url(url):
    if not url:
        return None
    m = re.search(r"(?:youtube\.com/(?:watch\?v=|embed/|shorts/)|youtu\.be/)([a-zA-Z0-9_-]{11})", url)
    return "https://www.youtube.com/embed/" + m.group(1) if m else None


def banner_html_for(art, cat, asset_prefix):
    embed_url = youtube_embed_url(art.get("videoUrl") or art.get("video"))
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


def format_date(iso):
    y, m, d = iso.split("-")
    month = UI_STRINGS["months"][int(m) - 1]
    return UI_STRINGS["date_format"].format(d=int(d), month=month, y=y)


def localize(html):
    """ Agrega '../../' a los links entre páginas del mismo árbol (siempre
        igual, las páginas de categoria/tema/artículo están 2 carpetas
        adentro de la raíz). """
    html = html.replace('href="index.html"', 'href="../../index.html"')
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

    def topic_label_for(cat_slug, topic_slug):
        for group_name, items in topic_groups.get(cat_slug, []):
            for slug, label in items:
                if slug == topic_slug:
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
            topic_page = TOPIC_PAGE_TEMPLATE.format(
                topic_label=t["label"], topic_slug=t["slug"],
                cat_label=label, cat_slug=slug, cat_icon=cat["icon"],
                sidebar_block=sidebar_block, footer_block=footer_block,
                home=strings["home"], loading=strings["loading"], ad_infeed=strings["ad_infeed"],
                latest_news=strings["latest_news"],
                everything_about=strings["everything_about"].format(topic=t["label"]),
                meta_desc=strings["all_coverage_of"].format(topic=t["label"]),
                asset_prefix=asset_prefix_page, articulos_asset=ARTICULOS_ASSET,
            )
            topic_path = os.path.join(cat_dir, t["slug"] + ".html")
            with open(topic_path, "w", encoding="utf-8") as f:
                f.write(topic_page)
            sitemap_urls.append(("/categoria/{}/{}.html".format(slug, t["slug"]), today, "weekly"))

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

        title_short = art["title"] if len(art["title"]) <= 40 else art["title"][:37] + "..."
        body_blocks = art["body"]
        if isinstance(body_blocks, str):
            body_blocks = parse_simple_body(body_blocks)

        page = ARTICLE_PAGE_TEMPLATE.format(
            title=art["title"], title_short=title_short, dek=art.get("dek", ""),
            cat_slug=cat["slug"], cat_label=cat["label"], cat_icon=cat["icon"],
            date_label=format_date(art["date"]), read_time=art.get("readTime", ""),
            banner_html=banner_html_for(art, cat, asset_prefix_page),
            body_html=render_article_body(body_blocks, strings["ad_inarticle"]),
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
