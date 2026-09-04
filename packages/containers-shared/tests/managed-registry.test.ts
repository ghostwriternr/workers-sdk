import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { OpenAPI } from "../src/client";
import {
	runWithCloudflareManagedRegistry,
	usesCloudflareManagedRegistry,
} from "../src/managed-registry";
import type { CloudflareManagedRegistryOptions } from "../src/managed-registry";
import type { ContainerDevOptions } from "../src/types";

const managedImage: ContainerDevOptions = {
	class_name: "Container",
	image_uri: "registry.cloudflare.com/image:latest",
	image_tag: "cloudflare-dev/container:test",
};

function configureManagedRegistry(
	options: CloudflareManagedRegistryOptions
): Promise<void> {
	return runWithCloudflareManagedRegistry(options, async () => {});
}

describe("Cloudflare-managed registry configuration", () => {
	beforeEach(() => {
		vi.stubEnv("CLOUDFLARE_API_BASE_URL", undefined);
		vi.stubEnv("CF_API_BASE_URL", undefined);
		vi.stubEnv("CLOUDFLARE_COMPLIANCE_REGION", undefined);
		vi.stubEnv("WRANGLER_API_ENVIRONMENT", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		OpenAPI.BASE = "";
		OpenAPI.HEADERS = undefined;
		OpenAPI.TOKEN = undefined;
		OpenAPI.CREDENTIALS = "include";
	});

	it("detects only images from the selected managed registry", ({ expect }) => {
		expect(usesCloudflareManagedRegistry([managedImage])).toBe(true);
		expect(
			usesCloudflareManagedRegistry([
				{ ...managedImage, image_uri: "example.com/image:latest" },
			])
		).toBe(false);
	});

	it("does not require credentials for external images", async ({ expect }) => {
		await expect(
			configureManagedRegistry({
				containerOptions: [
					{ ...managedImage, image_uri: "example.com/image:latest" },
				],
				consumerName: "test consumer",
			})
		).resolves.toBeUndefined();
	});

	it("reports missing credentials for the calling integration", async ({
		expect,
	}) => {
		vi.stubEnv("CLOUDFLARE_API_TOKEN", undefined);
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined);

		await expect(
			configureManagedRegistry({
				containerOptions: [managedImage],
				consumerName: "test consumer",
			})
		).rejects.toThrow(
			"To use images from the Cloudflare-managed registry with the test consumer"
		);
	});

	it("configures the generated client for managed image pulls", async ({
		expect,
	}) => {
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "environment-account");
		vi.stubEnv("CLOUDFLARE_API_BASE_URL", "https://api.example.com/client/v4");

		await configureManagedRegistry({
			containerOptions: [managedImage],
			accountId: "configured-account",
			consumerName: "test consumer",
		});

		expect(OpenAPI.BASE).toBe(
			"https://api.example.com/client/v4/accounts/configured-account/containers"
		);
		expect(OpenAPI.HEADERS).toMatchObject({
			Authorization: "Bearer token",
		});
	});

	it("uses the compliance-region API for managed image pulls", async ({
		expect,
	}) => {
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");

		await configureManagedRegistry({
			containerOptions: [
				{
					...managedImage,
					image_uri: "registry.fed.cloudflare.com/image:latest",
				},
			],
			accountId: "account",
			complianceConfig: { compliance_region: "fedramp_high" },
			consumerName: "test consumer",
		});

		expect(OpenAPI.BASE).toBe(
			"https://api.fed.cloudflare.com/client/v4/accounts/account/containers"
		);
	});

	it("uses the staging compliance-region API for managed image pulls", async ({
		expect,
	}) => {
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
		vi.stubEnv("WRANGLER_API_ENVIRONMENT", "staging");

		await configureManagedRegistry({
			containerOptions: [
				{
					...managedImage,
					image_uri: "staging.registry.fed.cloudflare.com/image:latest",
				},
			],
			accountId: "account",
			complianceConfig: { compliance_region: "fedramp_high" },
			consumerName: "test consumer",
		});

		expect(OpenAPI.BASE).toBe(
			"https://api.fed.staging.cloudflare.com/client/v4/accounts/account/containers"
		);
	});

	it("serializes operations that share generated client credentials", async ({
		expect,
	}) => {
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
		let activeOperations = 0;
		let maximumActiveOperations = 0;
		const operation = async (): Promise<void> => {
			activeOperations++;
			maximumActiveOperations = Math.max(
				maximumActiveOperations,
				activeOperations
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			activeOperations--;
		};
		const options = {
			containerOptions: [managedImage],
			consumerName: "test consumer",
		};

		await Promise.all([
			runWithCloudflareManagedRegistry(options, operation),
			runWithCloudflareManagedRegistry(options, operation),
		]);

		expect(maximumActiveOperations).toBe(1);
	});
});
