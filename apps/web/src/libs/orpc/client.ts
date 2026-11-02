import type { InferRouterOutputs, RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { BatchLinkPlugin } from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
// CAREEROS (P3-T03): the 80% AI allowance notice
import { noticeAiQuotaExceeded, noticeAiQuotaWarning } from "./ai-quota";
import { rpcFetch } from "./fetch";
// CAREEROS: a user who is not a member of this address's organization sees the join or switch page (P2-T03)
import { handleOrgHostError } from "./org-host";

const getRpcUrl = () => `${window.location.origin}/api/rpc`;

export const client: RouterClient<typeof router> = createORPCClient(
	new RPCLink({
		url: getRpcUrl,
		fetch: rpcFetch,
		plugins: [
			new BatchLinkPlugin({
				mode: "streaming",
				groups: [{ condition: () => true, context: {} }],
			}),
		],
		// CAREEROS (P3-T03): the 80% AI allowance notice rides on the response headers of each call.
		clientInterceptors: [
			async (options) => {
				try {
					const response = await options.next();
					noticeAiQuotaWarning(response.headers);
					return response;
				} catch (error) {
					noticeAiQuotaExceeded(error);
					throw error;
				}
			},
		],
		interceptors: [
			onError((error) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				handleOrgHostError(error);
				console.warn("[oRPC client]", error);
			}),
		],
	}),
);

export const streamClient: RouterClient<typeof router> = createORPCClient(
	new RPCLink({
		url: getRpcUrl,
		fetch: rpcFetch,
		// CAREEROS (P3-T03): the 80% AI allowance notice
		clientInterceptors: [
			async (options) => {
				try {
					const response = await options.next();
					noticeAiQuotaWarning(response.headers);
					return response;
				} catch (error) {
					noticeAiQuotaExceeded(error);
					throw error;
				}
			},
		],
		interceptors: [
			onError((error) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				handleOrgHostError(error);
				console.warn("[oRPC stream client]", error);
			}),
		],
	}),
);

export const orpc = createTanstackQueryUtils(client);

export type RouterOutput = InferRouterOutputs<typeof router>;
