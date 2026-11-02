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
		remove(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
	};
	runtime: {
		getManifest(): { version: string; name: string };
	};
};
