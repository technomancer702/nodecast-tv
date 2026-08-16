(function () {
    const PLACEHOLDER = '/img/placeholder.png';

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        })[character]);
    }

    function safeUrl(value, fallback = '') {
        if (typeof value !== 'string' || !value.trim()) return fallback;
        try {
            const parsed = new URL(value, window.location.origin);
            if (!['http:', 'https:'].includes(parsed.protocol)) return fallback;
            if (parsed.origin === window.location.origin) {
                return `${parsed.pathname}${parsed.search}${parsed.hash}`;
            }
            return parsed.href;
        } catch {
            return fallback;
        }
    }

    function imageUrl(value, fallback = PLACEHOLDER) {
        const safe = safeUrl(value, fallback);
        if (!safe || safe === fallback || safe.startsWith('/')) return safe || fallback;
        return `/api/proxy/image?url=${encodeURIComponent(safe)}`;
    }

    document.addEventListener('error', event => {
        const target = event.target;
        if (target instanceof HTMLImageElement && !target.dataset.fallbackApplied) {
            target.dataset.fallbackApplied = 'true';
            target.src = target.dataset.fallback || PLACEHOLDER;
        }
    }, true);

    window.Security = Object.freeze({
        escapeHtml,
        escapeAttribute: escapeHtml,
        safeUrl,
        imageUrl,
        PLACEHOLDER
    });
})();
