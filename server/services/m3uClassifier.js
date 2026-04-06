const VIDEO_EXTENSIONS = new Set([
    'mp4', 'mkv', 'avi', 'mov', 'wmv', 'm4v', 'webm', 'ts', 'm2ts', 'mpeg', 'mpg', 'flv'
]);

const MOVIE_KEYWORDS = [
    'movie', 'movies', 'vod', 'film', 'films', 'cinema', 'filme', 'filmes'
];

const SERIES_KEYWORDS = [
    'series', 'tv show', 'tv shows', 'show', 'shows', 'anime', 'novela', 'novelas',
    'season', 'seasons', 'temporada', 'temporadas', 'episode', 'episodes', 'episodio', 'episodios'
];

function stableHash(value) {
    const input = String(value || 'unknown');
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function normalizeText(value) {
    return String(value || '')
        .replace(/\.[a-z0-9]{2,4}(?=$|\?)/ig, '')
        .replace(/[._]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function includesKeyword(haystack, keywords) {
    const text = String(haystack || '').toLowerCase();
    return keywords.some(keyword => text.includes(keyword));
}

function getUrlPathname(url) {
    try {
        return new URL(url).pathname.toLowerCase();
    } catch {
        return String(url || '').toLowerCase();
    }
}

function getContainerExtension(url) {
    const pathname = getUrlPathname(url);
    const match = pathname.match(/\.([a-z0-9]{2,5})(?:$|\?)/i);
    return match ? match[1].toLowerCase() : null;
}

function extractYear(text) {
    const match = String(text || '').match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : null;
}

function parseEpisodeMetadata(name) {
    const cleaned = normalizeText(name);
    if (!cleaned) return null;

    const patterns = [
        /^(.*?)[\s\-_:]*s(\d{1,2})[\s\-_:]*e(\d{1,3})(?:[\s\-_:]+(.*))?$/i,
        /^(.*?)[\s\-_:]*(\d{1,2})x(\d{1,3})(?:[\s\-_:]+(.*))?$/i,
        /^(.*?)[\s\-_:]*(?:season|temporada)\s*(\d{1,2})[\s\-_:]*(?:episode|episodio|ep)\s*(\d{1,3})(?:[\s\-_:]+(.*))?$/i
    ];

    for (const pattern of patterns) {
        const match = cleaned.match(pattern);
        if (match) {
            const seriesTitle = normalizeText(match[1]);
            const seasonNum = parseInt(match[2], 10);
            const episodeNum = parseInt(match[3], 10);
            const remainder = normalizeText(match[4]);

            if (!seriesTitle || Number.isNaN(seasonNum) || Number.isNaN(episodeNum)) {
                continue;
            }

            return {
                seriesTitle,
                seasonNum,
                episodeNum,
                episodeTitle: remainder || `Episode ${episodeNum}`
            };
        }
    }

    return null;
}

function deriveSeriesFallback(name) {
    const cleaned = normalizeText(name);
    if (!cleaned) return null;

    return {
        seriesTitle: cleaned,
        seasonNum: 1,
        episodeNum: 1,
        episodeTitle: cleaned
    };
}

function makeCategoryId(type, groupTitle) {
    return `${type}:${normalizeText(groupTitle || 'Uncategorized') || 'Uncategorized'}`;
}

function makeSeriesId(groupTitle, seriesTitle) {
    return `m3u_series_${stableHash(`${groupTitle}|${seriesTitle}`)}`;
}

function classifyEntry(entry) {
    const groupTitle = normalizeText(entry.groupTitle || 'Uncategorized') || 'Uncategorized';
    const name = normalizeText(entry.name || entry.tvgName || '');
    const url = String(entry.url || '');
    const extension = getContainerExtension(url);
    const duration = Number(entry.duration);

    const groupLower = groupTitle.toLowerCase();
    const nameLower = name.toLowerCase();
    const urlLower = url.toLowerCase();

    const episodeMeta = parseEpisodeMetadata(name);
    const hasSeriesKeyword = includesKeyword(groupLower, SERIES_KEYWORDS)
        || urlLower.includes('/series/');
    const hasMovieKeyword = includesKeyword(groupLower, MOVIE_KEYWORDS)
        || urlLower.includes('/movie/')
        || urlLower.includes('/vod/');
    const hasVideoFileExtension = extension ? VIDEO_EXTENSIONS.has(extension) : false;
    const looksFiniteVod = Number.isFinite(duration) && duration > 0;

    if (episodeMeta) {
        return {
            mediaType: 'episode',
            groupTitle,
            containerExtension: extension || 'mp4',
            year: extractYear(name),
            seriesId: makeSeriesId(groupTitle, episodeMeta.seriesTitle),
            ...episodeMeta
        };
    }

    if (hasSeriesKeyword && (hasVideoFileExtension || looksFiniteVod || hasMovieKeyword)) {
        const fallback = deriveSeriesFallback(name);
        if (fallback) {
            return {
                mediaType: 'episode',
                groupTitle,
                containerExtension: extension || 'mp4',
                year: extractYear(name),
                seriesId: makeSeriesId(groupTitle, fallback.seriesTitle),
                ...fallback
            };
        }
    }

    if (hasMovieKeyword || hasVideoFileExtension || looksFiniteVod) {
        return {
            mediaType: 'movie',
            groupTitle,
            containerExtension: extension || 'mp4',
            year: extractYear(name)
        };
    }

    return {
        mediaType: 'live',
        groupTitle,
        containerExtension: extension
    };
}

module.exports = {
    classifyEntry,
    makeCategoryId,
    makeSeriesId,
    normalizeText,
    stableHash
};
