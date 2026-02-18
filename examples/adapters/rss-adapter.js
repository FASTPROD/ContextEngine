/**
 * Example ContextEngine Adapter — RSS/Atom Feed
 *
 * A minimal adapter that fetches RSS/Atom feeds and indexes them
 * as searchable chunks. Good starting point for simple adapters.
 *
 * Usage in contextengine.json:
 * {
 *   "adapters": [{
 *     "name": "feeds",
 *     "module": "./adapters/rss-adapter.js",
 *     "config": {
 *       "feeds": [
 *         "https://blog.example.com/rss.xml",
 *         "https://changelog.example.com/feed.atom"
 *       ],
 *       "maxItems": 20
 *     }
 *   }]
 * }
 *
 * @module
 */

export function createAdapter(config) {
  const maxItems = config?.maxItems || 10;

  return {
    name: "rss-feed",
    description: `RSS/Atom feed indexer (max ${maxItems} items per feed)`,

    validate(cfg) {
      if (!cfg?.feeds || !Array.isArray(cfg.feeds) || cfg.feeds.length === 0) {
        return "Missing 'feeds' array in config. Provide at least one RSS/Atom URL.";
      }
      return null;
    },

    async collect(cfg) {
      const feeds = cfg?.feeds || [];
      const chunks = [];

      for (const feedUrl of feeds) {
        try {
          const response = await fetch(feedUrl);
          if (!response.ok) continue;
          const text = await response.text();

          // Simple XML parsing — extract <item> or <entry> elements
          const items = text.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];

          for (const item of items.slice(0, maxItems)) {
            const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")?.trim() || "Untitled";
            const description = item.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")?.replace(/<[^>]+>/g, "")?.trim() || "";
            const pubDate = item.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i)?.[1]?.trim();

            if (title || description) {
              chunks.push({
                source: new URL(feedUrl).hostname,
                section: `## ${title}`,
                content: description.slice(0, 2000),
                lineStart: 1,
                lineEnd: 1,
                indexedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
              });
            }
          }
        } catch {
          // Skip failed feeds silently
        }
      }

      return chunks;
    },
  };
}
