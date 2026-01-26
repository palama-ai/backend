/**
 * 🗄️ In-Memory Cache for Performance
 * Caches frequently accessed data to reduce database queries
 */

class Cache {
    constructor(defaultTTL = 300000) { // 5 minutes default
        this.cache = new Map();
        this.defaultTTL = defaultTTL;
    }

    /**
     * Get item from cache
     * @param {string} key 
     * @returns {any|null}
     */
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;

        // Check if expired
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }

        return item.value;
    }

    /**
     * Set item in cache
     * @param {string} key 
     * @param {any} value 
     * @param {number} ttl - Time to live in ms
     */
    set(key, value, ttl = this.defaultTTL) {
        this.cache.set(key, {
            value,
            expiry: Date.now() + ttl
        });
    }

    /**
     * Delete item from cache
     * @param {string} key 
     */
    delete(key) {
        this.cache.delete(key);
    }

    /**
     * Delete items matching pattern
     * @param {string} pattern - Prefix pattern
     */
    deletePattern(pattern) {
        for (const key of this.cache.keys()) {
            if (key.startsWith(pattern)) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Clear all cache
     */
    clear() {
        this.cache.clear();
    }

    /**
     * Get cache stats
     */
    stats() {
        let active = 0;
        let expired = 0;
        const now = Date.now();

        for (const item of this.cache.values()) {
            if (now > item.expiry) {
                expired++;
            } else {
                active++;
            }
        }

        return { total: this.cache.size, active, expired };
    }
}

// Create global cache instances
const cache = new Cache(300000); // 5 minutes
const shortCache = new Cache(60000); // 1 minute
const longCache = new Cache(3600000); // 1 hour

// Cache keys
const CACHE_KEYS = {
    PRODUCTS_ALL: 'products:all',
    PRODUCTS_PUBLISHED: 'products:published',
    CATEGORIES: 'categories:all',
    PRODUCT_BY_ID: (id) => `product:${id}`,
    SELLER_PRODUCTS: (sellerId) => `seller:${sellerId}:products`,
    STATS: 'admin:stats'
};

module.exports = {
    cache,
    shortCache,
    longCache,
    CACHE_KEYS
};
