import { DurableObject } from "cloudflare:workers";

export class MyContainer extends DurableObject {
	async fetch(): Promise<Response> {
		const container = this.ctx.container;
		if (container === undefined) {
			throw new Error("Expected an attached container");
		}
		if (!container.running) {
			container.start({
				entrypoint: ["node", "app.js"],
				enableInternet: false,
				env: { MESSAGE: "I was passed through ctx.container!" },
			});
		}

		return container.getTcpPort(8787).fetch("http://container/");
	}
}

export default {
	async fetch(
		request: Request,
		env: { MY_CONTAINER: DurableObjectNamespace<MyContainer> }
	): Promise<Response> {
		if (new URL(request.url).pathname.startsWith("/container")) {
			const id = env.MY_CONTAINER.idFromName("integration-test");
			return env.MY_CONTAINER.get(id).fetch(request);
		}

		return new Response("Call /container to start the attached container");
	},
};
