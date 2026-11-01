// CAREEROS (P2-T06): an in-memory Cloudflare for SaaS for tests. It is handed to the client as its `fetch`, so no test
// touches the network. Not imported by application code.

type FakeHost = { id: string; hostname: string; status: string; sslStatus: string };
export type FakeRequest = { method: string; url: string; authorization: string | null; body: unknown };

export type FakeFailure = {
	/** Matches the request, e.g. `(r) => r.method === "DELETE"`. */
	match: (request: FakeRequest) => boolean;
	status: number;
	codes?: number[];
	/** Echoed into the response body, to prove the client never logs a body. */
	echo?: string;
	/** How many times to fail; default once. */
	times?: number;
};

export class FakeCloudflare {
	hosts = new Map<string, FakeHost>();
	requests: FakeRequest[] = [];
	failures: FakeFailure[] = [];
	private counter = 0;

	/** Sets the status Cloudflare reports for a hostname. */
	setStatus(hostname: string, status: string, sslStatus: string) {
		const host = [...this.hosts.values()].find((entry) => entry.hostname === hostname);
		if (!host) throw new Error(`No fake custom hostname ${hostname}`);
		host.status = status;
		host.sslStatus = sslStatus;
	}

	find(hostname: string) {
		return [...this.hosts.values()].find((entry) => entry.hostname === hostname);
	}

	calls(method: string) {
		return this.requests.filter((request) => request.method === method);
	}

	private json(status: number, body: unknown) {
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}

	private shape(host: FakeHost) {
		return { id: host.id, hostname: host.hostname, status: host.status, ssl: { status: host.sslStatus } };
	}

	fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const request: FakeRequest = {
			method,
			url: url.pathname + url.search,
			authorization: headers.get("authorization"),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		this.requests.push(request);

		const failure = this.failures.find((entry) => entry.match(request));
		if (failure) {
			failure.times = (failure.times ?? 1) - 1;
			if (failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
			return Promise.resolve(
				this.json(failure.status, {
					success: false,
					errors: (failure.codes ?? []).map((code) => ({ code, message: failure.echo ?? "failure" })),
					messages: failure.echo ? [failure.echo] : [],
					result: null,
				}),
			);
		}

		const match = /\/zones\/[^/]+\/custom_hostnames(?:\/([^/?]+))?$/.exec(url.pathname);
		if (!match) return Promise.resolve(this.json(404, { success: false, errors: [{ code: 7003 }] }));
		const id = match[1];
		if (method === "POST" && !id) {
			const body = request.body as { hostname: string };
			if (this.find(body.hostname))
				return Promise.resolve(this.json(409, { success: false, errors: [{ code: 1406 }], result: null }));
			const host: FakeHost = {
				id: `cf-${++this.counter}`,
				hostname: body.hostname,
				status: "pending",
				sslStatus: "pending_validation",
			};
			this.hosts.set(host.id, host);
			return Promise.resolve(this.json(200, { success: true, errors: [], result: this.shape(host) }));
		}
		if (method === "GET" && !id) {
			const wanted = url.searchParams.get("hostname");
			const list = [...this.hosts.values()].filter((host) => !wanted || host.hostname === wanted);
			return Promise.resolve(
				this.json(200, { success: true, errors: [], result: list.map((host) => this.shape(host)) }),
			);
		}
		const host = id ? this.hosts.get(id) : undefined;
		if (!host) return Promise.resolve(this.json(404, { success: false, errors: [{ code: 1551 }], result: null }));
		if (method === "GET")
			return Promise.resolve(this.json(200, { success: true, errors: [], result: this.shape(host) }));
		if (method === "DELETE") {
			this.hosts.delete(host.id);
			return Promise.resolve(this.json(200, { success: true, errors: [], result: { id: host.id } }));
		}
		return Promise.resolve(this.json(405, { success: false, errors: [] }));
	};
}
