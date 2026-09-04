import { exports } from "cloudflare:workers";
import { it } from "vitest";

it("runs without Docker when local containers are disabled", async ({
	expect,
}) => {
	const response = await exports.default.fetch("http://example.com/");

	expect(await response.text()).toBe(
		"Call /container to start the attached container"
	);
	await expect(
		exports.default.fetch("http://example.com/container")
	).rejects.toThrow("Expected an attached container");
});
