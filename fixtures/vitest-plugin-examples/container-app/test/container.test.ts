import { exports } from "cloudflare:workers";
import { it, vi } from "vitest";

it("reaches a container through the Worker", async ({ expect }) => {
	const response = await exports.default.fetch("http://example.com/");
	expect(await response.text()).toBe(
		"Call /container to start the attached container"
	);

	await vi.waitFor(
		async () => {
			const containerResponse = await exports.default.fetch(
				"http://example.com/container"
			);
			expect(await containerResponse.text()).toBe(
				"Hello World! Have an env var! I was passed through ctx.container!"
			);
		},
		{ interval: 500, timeout: 30_000 }
	);
});
