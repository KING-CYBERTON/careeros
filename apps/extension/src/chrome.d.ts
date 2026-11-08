// CAREEROS (P5-T01): the few `chrome.*` calls the extension makes, declared here so the package needs no extra typings.
// Add to this file when a later task uses another API (see docs/questions.md Q233).
declare const chrome: {
	storage: {
		local: {
			get(keys: string | string[]): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
			remove(keys: string | string[]): Promise<void>;
		};
	};
	permissions: {
		request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
		getAll(): Promise<{ origins?: string[] }>;
		remove(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
	};
	// P5-T02: opens the member's approval page in a new tab. Creating a tab needs no extra permission.
	tabs: {
		create(properties: { url: string }): Promise<unknown>;
	};
	runtime: {
		getManifest(): { version: string; name: string };
	};
};
