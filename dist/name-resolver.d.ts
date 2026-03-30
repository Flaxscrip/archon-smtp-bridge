/**
 * Name Resolver - resolves archon.social names to DIDs
 */
export interface NameResolverOptions {
    apiUrl: string;
    cacheTtlMs?: number;
}
export declare class NameResolver {
    private apiUrl;
    private cache;
    private cacheTtlMs;
    constructor(options: NameResolverOptions);
    /**
     * Extract the name portion from an email address
     * Returns null if not a valid archon.social address
     */
    extractName(email: string, domain: string): string | null;
    /**
     * Resolve a name to its DID
     * Returns null if name doesn't exist
     */
    resolve(name: string): Promise<string | null>;
    /**
     * Clear the cache
     */
    clearCache(): void;
    /**
     * Get cache stats
     */
    getCacheStats(): {
        size: number;
        hits: number;
    };
}
//# sourceMappingURL=name-resolver.d.ts.map