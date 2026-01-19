/**
 * EPG (XMLTV) Parser (Streaming)
 * Parses XMLTV format EPG data and extracts channel/programme information using streaming XML parser
 */

const sax = require('sax');
const zlib = require('zlib');
const { Readable } = require('stream');

/**
 * Parse XMLTV date format (YYYYMMDDHHmmss +ZZZZ)
 * @param {string} dateStr - XMLTV format date string
 * @returns {Date}
 */
function parseXmltvDate(dateStr) {
    if (!dateStr) return null;

    // Format: 20231225120000 +0000
    const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
    if (!match) {
        // Try ISO format fallback
        return new Date(dateStr);
    }

    const [, year, month, day, hour, minute, second, tz] = match;
    let isoStr = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

    if (tz) {
        const tzHours = tz.substring(0, 3);
        const tzMins = tz.substring(3);
        isoStr += `${tzHours}:${tzMins}`;
    } else {
        isoStr += 'Z';
    }

    return new Date(isoStr);
}

/**
 * Parse XMLTV content (Stream or String)
 * @param {Readable|string} input - XMLTV content as Stream or String
 * @returns {Promise<{ channels: Array, programmes: Array }>}
 */
function parse(input) {
    return new Promise((resolve, reject) => {
        const channels = [];
        const programmes = [];

        const saxStream = sax.createStream(true, { trim: true, normalize: true }); // strict mode

        let currentTag = null;
        let currentObject = null;
        let textBuffer = '';

        saxStream.on('error', function (e) {
            // clear the error
            this._parser.error = null;
            this._parser.resume();
            console.warn('XML Parse Warning:', e.message);
        });

        saxStream.on('opentag', function (node) {
            currentTag = node.name;
            const attr = node.attributes;

            if (currentTag === 'channel') {
                currentObject = {
                    id: attr.id,
                    name: null, // Will be populated by display-name tag
                    icon: null,
                    url: null
                };
            } else if (currentTag === 'programme') {
                currentObject = {
                    channelId: attr.channel,
                    start: parseXmltvDate(attr.start),
                    stop: parseXmltvDate(attr.stop),
                    title: null,
                    subtitle: null,
                    description: null,
                    category: [],
                    icon: null,
                    date: null,
                    episodeNum: null
                };
            } else if (currentTag === 'icon') {
                if (currentObject) {
                    currentObject.icon = attr.src;
                }
            }
            textBuffer = '';
        });

        saxStream.on('text', function (text) {
            textBuffer += text;
        });

        saxStream.on('cdata', function (text) {
            textBuffer += text;
        });

        saxStream.on('closetag', function (tagName) {
            if (tagName === 'channel') {
                if (currentObject) channels.push(currentObject);
                currentObject = null;
            } else if (tagName === 'programme') {
                if (currentObject) programmes.push(currentObject);
                currentObject = null;
            } else if (currentObject) {
                // Handle properties within objects
                switch (tagName) {
                    case 'display-name': // channel name
                        if (!currentObject.name) currentObject.name = textBuffer;
                        break;
                    case 'url': // channel url
                        currentObject.url = textBuffer;
                        break;
                    case 'title':
                        currentObject.title = textBuffer;
                        break;
                    case 'sub-title':
                        currentObject.subtitle = textBuffer;
                        break;
                    case 'desc':
                        currentObject.description = textBuffer;
                        break;
                    case 'category':
                        if (textBuffer && currentObject.category) currentObject.category.push(textBuffer);
                        break;
                    case 'date':
                        currentObject.date = textBuffer;
                        break;
                    case 'episode-num':
                        // Prefer system "xmltv_ns" or just take text
                        // Complex episode parsing logic can go here if needed
                        currentObject.episodeNum = textBuffer;
                        break;
                }
            }
        });

        saxStream.on('end', function () {
            resolve({ channels, programmes });
        });

        // Handle input type
        if (typeof input === 'string') {
            const inputStream = Readable.from([input]);
            inputStream.pipe(saxStream);
        } else {
            input.pipe(saxStream);
        }
    });
}

/**
 * Get programmes for a specific channel
 */
function getProgrammesForChannel(programmes, channelId) {
    return programmes.filter(p => p.channelId === channelId);
}

/**
 * Get current and upcoming programmes for a channel
 */
function getCurrentAndUpcoming(programmes, channelId, count = 5) {
    const now = new Date();
    const channelProgrammes = getProgrammesForChannel(programmes, channelId);

    // Sort by start time
    channelProgrammes.sort((a, b) => a.start - b.start);

    // Find current and upcoming
    const current = channelProgrammes.find(p => p.start <= now && p.stop > now);
    const upcoming = channelProgrammes
        .filter(p => p.start > now)
        .slice(0, count);

    return { current, upcoming };
}

/**
 * Fetch and parse XMLTV from URL
 */
async function fetchAndParse(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }

    let stream;
    if (response.body && typeof response.body.pipe === 'function') {
        stream = response.body;
    } else if (response.body) {
        stream = Readable.fromWeb(response.body);
    } else {
        stream = Readable.from([]);
    }

    // Check for GZIP
    // Note: We can't easily check for magic bytes on a stream without buffering.
    // We'll rely on response headers or file extension mostly, or try to peek.
    // For now, let's assume if content-encoding is gzip OR url ends in .gz

    // However, undici/fetch usually handles 'Content-Encoding: gzip' automatically transparently.
    // We only need to manually gunzip if the server serves it as application/octet-stream but it's actually gzipped, 
    // or if it's a .gz file download.

    // A robust way for streams is checking magic bytes, but that requires peeking.
    // Simplified approach: try to pipe through gunzip if the URL indicates it.

    const isGzipped = url.endsWith('.gz') || (response.headers.get('content-type') || '').includes('gzip');

    if (isGzipped) {
        const gunzip = zlib.createGunzip();
        stream.pipe(gunzip);
        return parse(gunzip);
    }

    // In the previous version we read magic bytes. 
    // To support that with streams we'd need a peek stream.
    // For now let's trust the transparent decompression of fetch or the URL.

    return parse(stream);
}

/**
 * Streaming EPG parser that yields batches of programmes (memory-efficient)
 * Channels are collected and returned with the first batch, then programmes are yielded in batches.
 * 
 * @param {string} url - XMLTV URL
 * @param {number} batchSize - Number of programmes per batch (default: 1000)
 * @yields {{ channels: Array|null, programmes: Array, isLast: boolean }}
 */
async function* fetchAndParseStreaming(url, batchSize = 1000) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }

    let stream;
    if (response.body && typeof response.body.pipe === 'function') {
        stream = response.body;
    } else if (response.body) {
        stream = Readable.fromWeb(response.body);
    } else {
        stream = Readable.from([]);
    }

    const isGzipped = url.endsWith('.gz') || (response.headers.get('content-type') || '').includes('gzip');

    if (isGzipped) {
        const gunzip = zlib.createGunzip();
        stream.pipe(gunzip);
        stream = gunzip;
    }

    // Use async iterator pattern with SAX
    yield* parseStreaming(stream, batchSize);
}

/**
 * Parse XMLTV as streaming async generator
 * @param {Readable} input - XMLTV stream
 * @param {number} batchSize - Number of programmes per batch
 * @yields {{ channels: Array|null, programmes: Array, isLast: boolean }}
 */
async function* parseStreaming(input, batchSize = 1000) {
    const channels = [];
    let programmeBatch = [];
    let channelsYielded = false;

    // We need to convert SAX events to an async iterator
    // This requires collecting events and yielding when batch is full

    const saxStream = sax.createStream(true, { trim: true, normalize: true });

    let currentTag = null;
    let currentObject = null;
    let textBuffer = '';
    let resolveNext = null;
    let pendingBatch = null;
    let ended = false;
    let error = null;

    saxStream.on('error', function (e) {
        this._parser.error = null;
        this._parser.resume();
        console.warn('XML Parse Warning:', e.message);
    });

    saxStream.on('opentag', function (node) {
        currentTag = node.name;
        const attr = node.attributes;

        if (currentTag === 'channel') {
            currentObject = {
                id: attr.id,
                name: null,
                icon: null,
                url: null
            };
        } else if (currentTag === 'programme') {
            currentObject = {
                channelId: attr.channel,
                start: parseXmltvDate(attr.start),
                stop: parseXmltvDate(attr.stop),
                title: null,
                subtitle: null,
                description: null,
                category: [],
                icon: null,
                date: null,
                episodeNum: null
            };
        } else if (currentTag === 'icon') {
            if (currentObject) {
                currentObject.icon = attr.src;
            }
        }
        textBuffer = '';
    });

    saxStream.on('text', function (text) {
        textBuffer += text;
    });

    saxStream.on('cdata', function (text) {
        textBuffer += text;
    });

    saxStream.on('closetag', function (tagName) {
        if (tagName === 'channel') {
            if (currentObject) channels.push(currentObject);
            currentObject = null;
        } else if (tagName === 'programme') {
            if (currentObject) {
                programmeBatch.push(currentObject);

                // Check if we should yield a batch
                if (programmeBatch.length >= batchSize) {
                    const batch = {
                        channels: !channelsYielded ? channels : null,
                        programmes: programmeBatch,
                        isLast: false
                    };
                    channelsYielded = true;
                    programmeBatch = [];

                    if (resolveNext) {
                        resolveNext(batch);
                        resolveNext = null;
                    } else {
                        pendingBatch = batch;
                    }
                }
            }
            currentObject = null;
        } else if (currentObject) {
            switch (tagName) {
                case 'display-name':
                    if (!currentObject.name) currentObject.name = textBuffer;
                    break;
                case 'url':
                    currentObject.url = textBuffer;
                    break;
                case 'title':
                    currentObject.title = textBuffer;
                    break;
                case 'sub-title':
                    currentObject.subtitle = textBuffer;
                    break;
                case 'desc':
                    currentObject.description = textBuffer;
                    break;
                case 'category':
                    if (textBuffer && currentObject.category) currentObject.category.push(textBuffer);
                    break;
                case 'date':
                    currentObject.date = textBuffer;
                    break;
                case 'episode-num':
                    currentObject.episodeNum = textBuffer;
                    break;
            }
        }
    });

    saxStream.on('end', function () {
        ended = true;
        // Yield final batch
        const batch = {
            channels: !channelsYielded ? channels : null,
            programmes: programmeBatch,
            isLast: true
        };
        if (resolveNext) {
            resolveNext(batch);
            resolveNext = null;
        } else {
            pendingBatch = batch;
        }
    });

    saxStream.on('error', function (e) {
        error = e;
        if (resolveNext) {
            resolveNext(null);
        }
    });

    // Start piping
    input.pipe(saxStream);

    // Yield batches as they become available
    while (!ended || pendingBatch) {
        if (pendingBatch) {
            const batch = pendingBatch;
            pendingBatch = null;
            yield batch;
            if (batch.isLast) break;
        } else if (!ended) {
            // Wait for next batch
            const batch = await new Promise(resolve => {
                resolveNext = resolve;
            });
            if (batch) {
                yield batch;
                if (batch.isLast) break;
            }
        }
    }

    if (error) {
        throw error;
    }
}

module.exports = {
    parse,
    parseXmltvDate,
    fetchAndParse,
    fetchAndParseStreaming,
    parseStreaming,
    getProgrammesForChannel,
    getCurrentAndUpcoming
};

