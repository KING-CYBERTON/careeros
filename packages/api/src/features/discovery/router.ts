import z from "zod";
import { protectedProcedure } from "../../context";
import { requireFeature } from "../../middleware/entitlements";
import { accountRateLimit } from "../../middleware/rate-limit";
import {
	acceptResultSchema,
	jobListInputSchema,
	jobSchema,
	jobSummarySchema,
	runSchema,
	runSummarySchema,
	sourceCreateSchema,
	sourceSchema,
	sourceUpdateSchema,
} from "./schemas";
import { discoveryService } from "./service";

const route = { tags: ["Discovery"] };
const id = z.object({ id: z.string().min(1) });

// CAREEROS (P4-T01): job discovery. Every procedure requires the plan feature `job_discovery` and reads or writes only
// the caller's own rows in the current organization.
// CAREEROS (P3-T02): the gate is the shared requireFeature middleware (it replaced P4-T01's temporary gate.ts).
const discoveryProcedure = protectedProcedure.use(requireFeature("job_discovery"));

export const discoveryRouter = {
	sources: {
		list: discoveryProcedure
			.route({
				...route,
				method: "GET",
				path: "/discovery/sources",
				operationId: "listDiscoverySources",
				summary: "List job discovery automations",
				description:
					"Returns the caller's saved discovery automations in the current organization: what to look for and which public job boards to read. Requires authentication and the job discovery plan feature.",
			})
			.input(z.object({}).optional())
			.output(z.array(sourceSchema))
			.handler(({ context }) => discoveryService.sources.list(context.user.id)),

		create: discoveryProcedure
			.route({
				...route,
				method: "POST",
				path: "/discovery/sources",
				operationId: "createDiscoverySource",
				summary: "Create a job discovery automation",
				description:
					"Saves an automation: titles, skills, keywords, locations, a remote preference and up to 100 job boards. A board is a source (greenhouse, lever, lever_eu or ashby) and a token (letters, digits, hyphens, underscores), never a URL. Requires authentication and the job discovery plan feature.",
			})
			.input(sourceCreateSchema)
			.use(accountRateLimit)
			.output(sourceSchema)
			.handler(({ context, input }) => discoveryService.sources.create(context.user.id, input)),

		update: discoveryProcedure
			.route({
				...route,
				method: "PATCH",
				path: "/discovery/sources/{id}",
				operationId: "updateDiscoverySource",
				summary: "Update a job discovery automation",
				description:
					"Changes the given fields of one of the caller's automations. NOT_FOUND when it is not theirs. Requires authentication and the job discovery plan feature.",
			})
			.input(sourceUpdateSchema)
			.use(accountRateLimit)
			.output(sourceSchema)
			.handler(({ context, input }) => discoveryService.sources.update(context.user.id, input)),

		delete: discoveryProcedure
			.route({
				...route,
				method: "DELETE",
				path: "/discovery/sources/{id}",
				operationId: "deleteDiscoverySource",
				summary: "Delete a job discovery automation",
				description:
					"Deletes the automation and its run history. The jobs it found stay, with their dismissed or accepted status, so they do not come back. Requires authentication and the job discovery plan feature.",
			})
			.input(id)
			.use(accountRateLimit)
			.output(z.void())
			.handler(({ context, input }) => discoveryService.sources.delete(context.user.id, input.id)),
	},

	runNow: discoveryProcedure
		.route({
			...route,
			method: "POST",
			path: "/discovery/sources/{jobSourceId}/run",
			operationId: "runDiscoverySource",
			summary: "Run a job discovery automation now",
			description:
				"Starts a run: it fetches every board of the automation, scores the postings, saves the new ones and sends the best of them to the AI match. Answers as soon as the run is recorded as running (status running, counts zero); the run continues in the background and its progress is in the run list. One manual run per automation every 10 minutes (scheduled runs do not count); TOO_MANY_REQUESTS otherwise. Requires authentication and the job discovery plan feature.",
		})
		.input(z.object({ jobSourceId: z.string().min(1) }))
		.output(runSummarySchema)
		.handler(({ context, input }) => discoveryService.runNow(context.user.id, input.jobSourceId)),

	runs: {
		list: discoveryProcedure
			.route({
				...route,
				method: "GET",
				path: "/discovery/sources/{jobSourceId}/runs",
				operationId: "listDiscoveryRuns",
				summary: "List the runs of a job discovery automation",
				description:
					"Returns the latest 20 runs of one of the caller's automations, newest first, with their counts, how each started (manual or scheduled), the AI match counts and why the AI step was skipped, if it was. A run still running shows its progress so far. NOT_FOUND when the automation is not theirs. Requires authentication and the job discovery plan feature.",
			})
			.input(z.object({ jobSourceId: z.string().min(1) }))
			.output(z.array(runSchema))
			.handler(({ context, input }) => discoveryService.runs.list(context.user.id, input.jobSourceId)),
	},

	jobs: {
		list: discoveryProcedure
			.route({
				...route,
				method: "GET",
				path: "/discovery/jobs",
				operationId: "listDiscoveredJobs",
				summary: "List discovered jobs",
				description:
					"Returns the review queue: the postings discovery found for the caller, best match first (AI score, then local score, then newest), without their descriptions. Filter by status (new, accepted, dismissed) or by automation. Page with limit and offset. Requires authentication and the job discovery plan feature.",
			})
			.input(jobListInputSchema)
			.output(z.array(jobSummarySchema))
			.handler(({ context, input }) => discoveryService.jobs.list(context.user.id, input)),

		get: discoveryProcedure
			.route({
				...route,
				method: "GET",
				path: "/discovery/jobs/{id}",
				operationId: "getDiscoveredJob",
				summary: "Get a discovered job",
				description:
					"Returns one of the caller's discovered postings with its sanitized description (a short HTML subset: headings, paragraphs, lists, bold, italic, line breaks and https links). NOT_FOUND when it is not theirs. Requires authentication and the job discovery plan feature.",
			})
			.input(id)
			.output(jobSchema)
			.handler(({ context, input }) => discoveryService.jobs.get(context.user.id, input.id)),

		accept: discoveryProcedure
			.route({
				...route,
				method: "POST",
				path: "/discovery/jobs/{id}/accept",
				operationId: "acceptDiscoveredJob",
				summary: "Accept a discovered job into the tracker",
				description:
					"Creates an application in the tracker (first stage, company, role, location, link and the description as plain text, source discovery, the board as a tag), marks the posting accepted and answers with the application id. Accepting twice answers with the same application. A dismissed posting can be accepted. A write: refused for a suspended organization. Requires authentication and the job discovery plan feature.",
			})
			.input(id)
			.use(accountRateLimit)
			.output(acceptResultSchema)
			.handler(({ context, input }) => discoveryService.jobs.accept(context.user.id, input.id)),

		dismiss: discoveryProcedure
			.route({
				...route,
				method: "POST",
				path: "/discovery/jobs/{id}/dismiss",
				operationId: "dismissDiscoveredJob",
				summary: "Dismiss a discovered job",
				description:
					"Marks the posting dismissed. It is kept, not deleted, so later runs never bring it back. CONFLICT when it was already accepted. Requires authentication and the job discovery plan feature.",
			})
			.input(id)
			.use(accountRateLimit)
			.output(jobSchema)
			.handler(({ context, input }) => discoveryService.jobs.dismiss(context.user.id, input.id)),
	},
};
