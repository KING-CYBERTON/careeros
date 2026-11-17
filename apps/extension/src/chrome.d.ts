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
		// P5-T03: the tab the member is looking at. Its `url` is visible only after the member invokes the extension
		// (`activeTab`), and the reader runs only in that tab.
		query(query: { active: boolean; currentWindow: boolean }): Promise<{ id?: number; url?: string }[]>;
	};
	// P5-T03: injects the one small reader into the active tab (`scripting` + `activeTab`). The function is serialized, so
	// it must not use anything outside itself.
	scripting: {
		executeScript<Result>(injection: { target: { tabId: number }; func: () => Result }): Promise<{ result?: Result }[]>;
	};
	runtime: {
		getManifest(): { version: string; name: string };
	};
};
