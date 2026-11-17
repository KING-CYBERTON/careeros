import { describe, expect, it, vi } from "vite-plus/test";
import {
	approvalUrl,
	formatUserCode,
	nextPollDelaySeconds,
	pollDeviceFlow,
	startDeviceFlow,
	type DeviceFlow,
} from "./device-flow";

const origin = "https://careers.example.org";
const flow: DeviceFlow = { origin, deviceCode: "dev-code", userCode: "ABCD2345", interval: 5, expiresAt: 1_000_000 };
const reply = (status: number, body: unknown) =>
	vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("startDeviceFlow", () => {
	it("asks for a code with the clipper client id and no cookies", async () => {
		const fetcher = reply(200, { device_code: "d", user_code: "ABCD2345", interval: 5, expires_in: 600 });
		const result = await startDeviceFlow(origin, fetcher as never, 0);
		expect(result).toEqual({
			ok: true,
			flow: { origin, deviceCode: "d", userCode: "ABCD2345", interval: 5, expiresAt: 600_000 },
		});
		const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${origin}/api/auth/device/code`);
		expect(JSON.parse(String(init.body))).toEqual({ client_id: "careeros-job-clipper" });
		expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
	});
	it("tells an unsupported address from an unreachable one", async () => {
		expect(await startDeviceFlow(origin, reply(400, { error: "unauthorized_client" }) as never)).toEqual({
			ok: false,
			reason: "unsupported",
		});
		expect(await startDeviceFlow(origin, reply(500, {}) as never)).toEqual({ ok: false, reason: "unreachable" });
		expect(await startDeviceFlow(origin, vi.fn().mockRejectedValue(new TypeError("offline")) as never)).toEqual({
			ok: false,
			reason: "unreachable",
		});
	});
});

describe("pollDeviceFlow", () => {
	it("maps the server's answers", async () => {
		expect(await pollDeviceFlow(flow, reply(400, { error: "authorization_pending" }) as never, 0)).toEqual({
			kind: "pending",
		});
		expect(await pollDeviceFlow(flow, reply(400, { error: "slow_down" }) as never, 0)).toEqual({ kind: "slow_down" });
		expect(await pollDeviceFlow(flow, reply(400, { error: "access_denied" }) as never, 0)).toEqual({ kind: "denied" });
		expect(await pollDeviceFlow(flow, reply(400, { error: "expired_token" }) as never, 0)).toEqual({ kind: "expired" });
		expect(await pollDeviceFlow(flow, reply(400, { error: "invalid_grant" }) as never, 0)).toEqual({ kind: "failed" });
		expect(
			await pollDeviceFlow(
				flow,
				reply(200, { access_token: "cos_clip_x", user_name: "Ada", expires_in: 100 }) as never,
				0,
			),
		).toEqual({
			kind: "approved",
			token: "cos_clip_x",
			userName: "Ada",
			expiresInSeconds: 100,
		});
		expect(await pollDeviceFlow(flow, reply(200, {}) as never, 0)).toEqual({ kind: "failed" });
	});
	it("keeps waiting through a dropped connection and stops at the deadline without asking", async () => {
		expect(await pollDeviceFlow(flow, vi.fn().mockRejectedValue(new TypeError("offline")) as never, 0)).toEqual({
			kind: "pending",
		});
		const fetcher = vi.fn();
		expect(await pollDeviceFlow(flow, fetcher as never, flow.expiresAt)).toEqual({ kind: "expired" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("posts to the connected origin with the device code, never a cookie", async () => {
		const fetcher = reply(400, { error: "authorization_pending" });
		await pollDeviceFlow(flow, fetcher as never, 0);
		const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${origin}/api/auth/device/clipper/token`);
		expect(JSON.parse(String(init.body))).toMatchObject({ device_code: "dev-code", client_id: "careeros-job-clipper" });
		expect(init.credentials).toBe("omit");
	});
});

describe("slow_down", () => {
	it("adds 5 seconds to the interval each time", () => {
		expect(nextPollDelaySeconds(5, 0)).toBe(5);
		expect(nextPollDelaySeconds(5, 1)).toBe(10);
		expect(nextPollDelaySeconds(5, 3)).toBe(20);
		expect(nextPollDelaySeconds(0, 0)).toBe(1);
	});
});

describe("approval page address", () => {
	it("is the connected origin's /device with the code", () => {
		expect(approvalUrl(origin, "ABCD2345")).toBe(`${origin}/device?user_code=ABCD2345`);
		expect(formatUserCode("abcd2345")).toBe("ABCD-2345");
	});
});
