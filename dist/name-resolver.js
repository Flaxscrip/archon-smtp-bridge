/**
 * Name Resolver - resolves archon.social names to DIDs
 */
export class NameResolver {
    apiUrl;
    cache = new Map();
    cacheTtlMs;
    constructor(options) {
        this.apiUrl = options.apiUrl.replace(/\/$/, '');
        this.cacheTtlMs = options.cacheTtlMs || 5 * 60 * 1000; // 5 min default
    }
    /**
     * Extract the name portion from an email address
     * Returns null if not a valid archon.social address
     */
    extractName(email, domain) {
        const emailLower = email.toLowerCase().trim();
        const domainLower = domain.toLowerCase();
        // Handle formats: "name@domain" or "<name@domain>"
        const match = emailLower.match(/<?([^<>@]+)@([^<>@]+)>?/);
        if (!match)
            return null;
        const [, name, emailDomain] = match;
        if (emailDomain !== domainLower) {
            return null;
        }
        return name;
    }
    /**
     * Resolve a name to its DID
     * Returns null if name doesn't exist
     */
    async resolve(name) {
        const nameLower = name.toLowerCase().trim();
        // Check cache
        const cached = this.cache.get(nameLower);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.did;
        }
        try {
            // Query archon.social API
            const response = await fetch(`${this.apiUrl}/api/name/${nameLower}`);
            if (!response.ok) {
                if (response.status === 404) {
                    // Cache negative result (shorter TTL)
                    this.cache.set(nameLower, {
                        did: null,
                        expiresAt: Date.now() + 60_000 // 1 minute for not-found
                    });
                    return null;
                }
                throw new Error(`API error: ${response.status}`);
            }
            const data = await response.json();
            const did = data.did || null;
            // Cache result
            this.cache.set(nameLower, {
                did,
                expiresAt: Date.now() + this.cacheTtlMs
            });
            return did;
        }
        catch (error) {
            console.error(`[Resolver] Failed to resolve ${name}:`, error);
            return null;
        }
    }
    /**
     * Clear the cache
     */
    clearCache() {
        this.cache.clear();
    }
    /**
     * Get cache stats
     */
    getCacheStats() {
        return {
            size: this.cache.size,
            hits: 0 // Would need to track this separately
        };
    }
}
//# sourceMappingURL=name-resolver.js.map