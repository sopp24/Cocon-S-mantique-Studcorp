const TIME_ZONE = "Europe/Paris";
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_STORIES = 10;

const SOURCES = [
  { domain: "lemonde.fr", queryDomain: "lemonde.fr", name: "Le Monde" },
  { domain: "liberation.fr", queryDomain: "liberation.fr", name: "Libération" },
  { domain: "lesechos.fr", queryDomain: "lesechos.fr", name: "Les Échos" },
  { domain: "franceinfo.fr", queryDomain: "franceinfo.fr", name: "franceinfo" },
  { domain: "sudouest.fr", queryDomain: "sudouest.fr", name: "Sud Ouest" },
  { domain: "brut.media", queryDomain: "brut.media", name: "Brut" },
  { domain: "lepoint.fr", queryDomain: "lepoint.fr", name: "Le Point" },
  { domain: "mediapart.fr", queryDomain: "mediapart.fr", name: "Mediapart" },
  { domain: "lexpress.fr", queryDomain: "lexpress.fr", name: "L'Express" },
  { domain: "lefigaro.fr", queryDomain: "etudiant.lefigaro.fr", name: "Le Figaro Étudiant" },
  { domain: "leparisien.fr", queryDomain: "leparisien.fr", name: "Le Parisien Étudiant" },
  { domain: "letudiant.fr", queryDomain: "letudiant.fr", name: "L'Étudiant" },
  { domain: "ouest-france.fr", queryDomain: "ouest-france.fr", name: "Ouest-France" },
  { domain: "france24.com", queryDomain: "france24.com", name: "France 24" },
  { domain: "nouvelobs.com", queryDomain: "nouvelobs.com", name: "Le Nouvel Obs" }
];

const SEARCH_TERMS = [
  '"étudiant"', '"étudiants"', '"vie étudiante"', '"enseignement supérieur"',
  "université", "campus", "CROUS", "alternance", "apprentissage",
  '"logement étudiant"', '"bourse étudiante"', "licence", "master",
  "doctorat", '"jeune diplômé"', '"école supérieure"'
].join(" OR ");

const POST_BAC_SIGNALS = [
  /\betudiant(?:e)?s?\b/g, /enseignement superieur/g, /\buniversit\w*/g,
  /\bcampus\b/g, /\bcrous\b/g, /\blicence\b/g, /\bmaster\b/g,
  /\bdoctorat\b/g, /\balternance\b/g, /\bapprentiss\w*/g,
  /vie etudiante/g, /jeunes? diplomes?/g, /ecole d ingenieurs?/g
];

const RELEVANCE_SIGNALS = [
  [/\betudiant(?:e)?s?\b/g, 7], [/enseignement superieur/g, 7],
  [/\buniversit\w*/g, 5], [/\bcampus\b/g, 4], [/\bcrous\b/g, 6],
  [/\blicence\b/g, 4], [/\bmaster\b/g, 4], [/\bdoctorat\b/g, 4],
  [/\balternance\b/g, 5], [/\bapprentiss\w*/g, 4], [/vie etudiante/g, 5],
  [/jeunes? diplomes?/g, 4], [/ecole d ingenieurs?/g, 3],
  [/logement etudiant/g, 4], [/bourses? etudiantes?/g, 4], [/\bstages?\b/g, 2]
];

const HIGH_SCHOOL_ONLY = /\b(lycee|colleges?|brevet|terminale|seconde|premiere|bac general|bac professionnel)\b/;
const NON_NEWS_TITLE = /\b(offre d emploi|offres? (?:d emploi|de stage)|job dating|forum jeunesse|forum emploi|salon de l emploi|stage alternance auxiliaire|h\/f)\b/;
const STOP_WORDS = new Set([
  "avec","dans","pour","sans","sous","chez","entre","leurs","leur","cette",
  "cela","mais","plus","moins","apres","avant","contre","depuis","selon",
  "dont","elle","elles","ils","sur","les","des","une","aux","que","qui",
  "quoi","est","sont","etre","avoir","tout","tous","toute","toutes","alors",
  "aussi","comme","quand","fait","faire","ses","son","sa"
]);

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); });
}

function cleanXmlText(value) {
  return decodeEntities(String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ").trim();
}

function tagValue(block, tag) {
  const expression = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
  const match = block.match(expression);
  return match ? cleanXmlText(match[1]) : "";
}

function sourceForItem(item, expectedSource) {
  const match = item.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
  if (!match) return expectedSource.name;
  const urlMatch = match[1].match(/\burl=["']([^"']+)["']/i);
  if (!urlMatch) return expectedSource.name;
  try {
    const host = new URL(urlMatch[1]).hostname.toLowerCase().replace(/^www\./, "");
    const allowed = host === expectedSource.domain || host.endsWith("." + expectedSource.domain);
    return allowed ? expectedSource.name : null;
  } catch {
    return null;
  }
}

function topicFor(text) {
  const value = normalize(text);
  const topics = [
    ["Logement étudiant", /\b(logement|residence|loyer|hebergement|crous)\b/],
    ["Aides et pouvoir d'achat", /\b(bourse|aide|budget|inflation|precarite|frais inscription|frais scolarite)\b/],
    ["Alternance et apprentissage", /\b(alternance|apprentissage|apprenti|contrat pro)\b/],
    ["Stages et premier emploi", /\b(stage|emploi|recrutement|diplome|salaire|carriere)\b/],
    ["Santé et études", /\b(sante|medecine|internat|pass|las|soins)\b/],
    ["Mobilité internationale", /\b(international|erasmus|etranger|mobilite|visa)\b/],
    ["Examens et droits étudiants", /\b(examen|concours|fraude|droit|discrimination|egalite)\b/],
    ["Numérique et intelligence artificielle", /\b(ia|intelligence artificielle|numerique|cyber)\b/],
    ["Formations et admissions", /\b(parcoursup|admission|candidature|inscription|licence|master|doctorat|formation)\b/],
    ["Enseignement supérieur", /\b(universit|enseignement superieur|financement|budget|effectif|demographie)\b/],
    ["Vie étudiante et campus", /\b(campus|vie etudiante|association|mobilisation|etudiant|journalisme)\b/]
  ];
  const found = topics.find(function (entry) { return entry[1].test(value); });
  return found ? found[0] : "Enseignement supérieur";
}

function makeScore(title, summary, publishedAt, position) {
  const text = normalize(title + " " + summary);
  let postBac = false;
  for (const pattern of POST_BAC_SIGNALS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) postBac = true;
    pattern.lastIndex = 0;
  }
  if (!postBac) return null;

  const clearlyPostBac = /\betudiant(?:e)?s?\b|enseignement superieur|\buniversit\w*|\bcampus\b|\bcrous\b|\blicence\b|\bmaster\b|\bdoctorat\b|\balternance\b|\bapprentiss\w*|vie etudiante|jeunes? diplomes?/.test(text);
  if (HIGH_SCHOOL_ONLY.test(text) && !clearlyPostBac) return null;

  let relevance = 0;
  for (const entry of RELEVANCE_SIGNALS) {
    entry[0].lastIndex = 0;
    if (entry[0].test(text)) relevance += entry[1];
  }
  const ageHours = Math.max(0, (Date.now() - publishedAt.getTime()) / 3600000);
  return relevance + Math.max(0, 12 - ageHours / 24) + Math.max(0, 3 - position * 0.25);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric", month: "short", year: "numeric", timeZone: TIME_ZONE
  }).format(date).replace(/\s+/g, " ");
}

function parseFeed(xml, expectedSource, now) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(function (match) { return match[1]; });
  const stories = [];

  items.forEach(function (item, position) {
    let title = tagValue(item, "title").trim();
    const sourceSuffixes = [expectedSource.name, expectedSource.name.replace(" Étudiant", ""), expectedSource.name + " Emploi"];
    for (const suffix of sourceSuffixes) {
      const ending = " - " + suffix;
      if (title.toLowerCase().endsWith(ending.toLowerCase())) title = title.slice(0, -ending.length).trim();
    }
    if (NON_NEWS_TITLE.test(normalize(title))) return;
    const link = tagValue(item, "link");
    const publishedAt = new Date(tagValue(item, "pubDate"));
    const source = sourceForItem(item, expectedSource);

    if (!title || !link || !source || Number.isNaN(publishedAt.getTime())) return;
    if (publishedAt.getTime() > now.getTime() + 6 * 3600000) return;
    if (now.getTime() - publishedAt.getTime() > WINDOW_MS) return;

    let summary = tagValue(item, "description")
      .replace(/\b(lire la suite|lire l'article|en savoir plus)\b.*$/i, "").trim();
    const summaryNorm = normalize(summary);
    const titleNorm = normalize(title);
    const sourceNorm = normalize(source);
    if (!summary || summaryNorm === titleNorm || (summaryNorm.startsWith(titleNorm) && summaryNorm.slice(titleNorm.length).trim() === sourceNorm)) {
      summary = "";
    }
    if (summary.length > 260) summary = summary.slice(0, 257).trimEnd() + "…";

    const score = makeScore(title, summary, publishedAt, position);
    if (score === null) return;

    stories.push({
      source: source,
      date: formatDate(publishedAt),
      topic: topicFor(title + " " + summary),
      title: title,
      summary: summary,
      url: link,
      publishedAt: publishedAt.toISOString(),
      score: score
    });
  });
  return stories;
}

async function fetchOneQuery(source, now, searchTerm) {
  const query = "site:" + (source.queryDomain || source.domain) + " " + searchTerm + " when:7d";
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "fr");
  url.searchParams.set("gl", "FR");
  url.searchParams.set("ceid", "FR:fr");

  const response = await fetch(url, {
    headers: {
      "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "User-Agent": "STUDCORP-Student-News-Monitor/1.0"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(source.name + ": réponse HTTP " + response.status);
  return parseFeed(await response.text(), source, now);
}

async function fetchSource(source, now) {
  const results = await Promise.allSettled([
    fetchOneQuery(source, now, '"étudiant"'),
    fetchOneQuery(source, now, "université")
  ]);
  return results.filter(function (result) { return result.status === "fulfilled"; })
    .flatMap(function (result) { return result.value; });
}

function metaContent(html, propertyName) {
  const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map(function (match) { return match[0]; });
  for (const tag of tags) {
    const name = (tag.match(/\b(?:name|property)=["']([^"']+)["']/i) || [])[1] || "";
    if (name.toLowerCase() !== propertyName.toLowerCase()) continue;
    const content = (tag.match(/\bcontent=["']([^"']*)["']/i) || [])[1] || "";
    if (content) return cleanXmlText(content);
  }
  return "";
}

async function enrichSummary(story) {
  try {
    const response = await fetch(story.url, {
      headers: { "User-Agent": "STUDCORP-Student-News-Monitor/1.0", "Accept": "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(12000),
      redirect: "follow"
    });
    if (response.ok) {
      const html = await response.text();
      const description = metaContent(html, "og:description") ||
        metaContent(html, "description") || metaContent(html, "twitter:description");
      if (description && normalize(description) !== normalize(story.title)) {
        story.summary = description.length > 260 ? description.slice(0, 257).trimEnd() + "…" : description;
        return story;
      }
    }
  } catch (error) {
    console.warn("Résumé indisponible pour " + story.source + " : " + (error?.message || error));
  }
  if (!story.summary) {
    story.summary = "Actualité retenue pour sa pertinence avec les études supérieures. Consulte l’article source pour les informations détaillées.";
  }
  return story;
}

function articleTokens(title) {
  return new Set(normalize(title).split(/\s+/).filter(function (word) {
    return word.length > 2 && !STOP_WORDS.has(word);
  }));
}

function isDuplicate(candidate, chosen) {
  const candidateTokens = articleTokens(candidate.title);
  for (const existing of chosen) {
    if (candidate.url === existing.url) return true;
    const existingTokens = articleTokens(existing.title);
    const intersection = [...candidateTokens].filter(function (word) { return existingTokens.has(word); }).length;
    const union = new Set([...candidateTokens, ...existingTokens]).size;
    if (union && intersection / union >= 0.72) return true;
  }
  return false;
}

function chooseStories(candidates) {
  const ordered = candidates.sort(function (a, b) {
    return b.score - a.score || b.publishedAt.localeCompare(a.publishedAt);
  });
  const chosen = [];
  const sourceCounts = new Map();
  const topicCounts = new Map();

  for (const limits of [
    { source: 2, topic: 1 },
    { source: 3, topic: 2 },
    { source: Infinity, topic: Infinity }
  ]) {
    for (const story of ordered) {
      if (chosen.length >= MIN_STORIES) break;
      if (isDuplicate(story, chosen)) continue;
      if ((sourceCounts.get(story.source) || 0) >= limits.source) continue;
      if ((topicCounts.get(story.topic) || 0) >= limits.topic) continue;
      chosen.push(story);
      sourceCounts.set(story.source, (sourceCounts.get(story.source) || 0) + 1);
      topicCounts.set(story.topic, (topicCounts.get(story.topic) || 0) + 1);
    }
  }
  return chosen.slice(0, MIN_STORIES).map(function (story) {
    const copy = Object.assign({}, story);
    delete copy.score;
    delete copy.publishedAt;
    return copy;
  });
}

async function main() {
  const now = new Date();
  const results = await Promise.allSettled(SOURCES.map(function (source) { return fetchSource(source, now); }));
  const candidates = [];

  results.forEach(function (result, index) {
    if (result.status === "fulfilled") {
      candidates.push(...result.value);
      console.log(SOURCES[index].name + ": " + result.value.length + " article(s) pertinents");
    } else {
      console.warn("Flux indisponible — " + SOURCES[index].name + ": " + (result.reason?.message || result.reason));
    }
  });

  const selected = chooseStories(candidates);
  console.log(candidates.length + " article(s) analysés, " + selected.length + " retenus.");

  if (selected.length < MIN_STORIES) {
    throw new Error("Seulement " + selected.length + " actualités exploitables. news.js est conservé sans modification.");
  }

  const enriched = await Promise.all(selected.map(enrichSummary));
  const output = [
    "window.STUDCORP_WEEKLY_NEWS_UPDATED_AT = " + JSON.stringify(now.toISOString()) + ";",
    "window.STUDCORP_WEEKLY_NEWS = " + JSON.stringify(enriched, null, 2) + ";",
    ""
  ].join("\n");

  const fs = await import("node:fs/promises");
  await fs.writeFile("news.js", output, "utf8");
  console.log("news.js actualisé avec 10 actualités des sept derniers jours.");
}

await main();
