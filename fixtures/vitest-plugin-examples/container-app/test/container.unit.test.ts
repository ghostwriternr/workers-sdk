import { env } from "cloudflare:workers";
import { it, vi } from "vitest";

it("reaches a container through a Durable Object stub", async ({ expect }) => {
	const id = env.MY_CONTAINER.idFromName("unit-test");
	const stub = env.MY_CONTAINER.get(id);

	await vi.waitFor(
		async () => {
			const response = await stub.fetch("http://example.com/");
			expect(await response.text()).toContain(
				"I was passed through ctx.container!"
			);
		},
		{ interval: 500, timeout: 30_000 }
	);
});
