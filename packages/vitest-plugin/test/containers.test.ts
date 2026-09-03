import {
	createLocalContainerPlan,
	prepareLocalContainers,
} from "@cloudflare/containers-shared";
import { afterEach, describe, it, vi } from "vitest";
import {
	disposeAllProjectContainers,
	prepareProjectContainers,
} from "../src/pool/containers";
import type { Config } from "@cloudflare/workers-utils";

vi.mock("@cloudflare/containers-shared", () => ({
	configureOpenAPIForContainerPull: vi.fn(),
	createLocalContainerPlan: vi.fn(),
	getCloudflareContainerRegistry: vi.fn(() => "registry.cloudflare.com"),
	prepareLocalContainers: vi.fn(),
}));

const config = { dev: { enable_containers: true } } as Config;

describe("project container environments", () => {
	afterEach(async () => {
		await disposeAllProjectContainers();
		vi.clearAllMocks();
	});

	it("does not prepare images for an inactive plan", async ({ expect }) => {
		vi.mocked(createLocalContainerPlan).mockReturnValue(undefined);

		await expect(
			prepareProjectContainers(config, "/project/wrangler.jsonc")
		).resolves.toBeUndefined();
		expect(prepareLocalContainers).not.toHaveBeenCalled();
	});

	it("shares preparation and disposes it once", async ({ expect }) => {
		const dispose = vi.fn();
		vi.mocked(createLocalContainerPlan).mockReturnValue({
			containerBuildId: "build-id",
			containerEngine: { localDocker: { socketPath: "/docker.sock" } },
			dockerPath: "docker",
			containerOptions: [],
		});
		vi.mocked(prepareLocalContainers).mockResolvedValue({
			dockerPath: "docker",
			imageTags: new Set(),
			dispose,
		});

		const [first, second] = await Promise.all([
			prepareProjectContainers(config, "/project/wrangler.jsonc", "dev"),
			prepareProjectContainers(config, "/project/wrangler.jsonc", "dev"),
		]);

		expect(first?.containerBuildId).toBe(second?.containerBuildId);
		expect(createLocalContainerPlan).toHaveBeenCalledOnce();
		expect(prepareLocalContainers).toHaveBeenCalledOnce();

		await first?.release();
		expect(dispose).not.toHaveBeenCalled();
		await second?.release();
		expect(dispose).toHaveBeenCalledOnce();
		await second?.release();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("disposes projects independently", async ({ expect }) => {
		const disposeA = vi.fn();
		const disposeB = vi.fn();
		vi.mocked(createLocalContainerPlan).mockReturnValue({
			containerBuildId: "build-id",
			containerEngine: { localDocker: { socketPath: "/docker.sock" } },
			dockerPath: "docker",
			containerOptions: [],
		});
		vi.mocked(prepareLocalContainers)
			.mockResolvedValueOnce({
				dockerPath: "docker",
				imageTags: new Set(),
				dispose: disposeA,
			})
			.mockResolvedValueOnce({
				dockerPath: "docker",
				imageTags: new Set(),
				dispose: disposeB,
			});

		const [projectA, projectB] = await Promise.all([
			prepareProjectContainers(config, "/project-a/wrangler.jsonc"),
			prepareProjectContainers(config, "/project-b/wrangler.jsonc"),
		]);

		await projectA?.release();
		expect(disposeA).toHaveBeenCalledOnce();
		expect(disposeB).not.toHaveBeenCalled();
		await projectB?.release();
		expect(disposeB).toHaveBeenCalledOnce();
	});

	it("retries after preparation fails", async ({ expect }) => {
		vi.mocked(createLocalContainerPlan).mockReturnValue({
			containerBuildId: "build-id",
			containerEngine: { localDocker: { socketPath: "/docker.sock" } },
			dockerPath: "docker",
			containerOptions: [],
		});
		vi.mocked(prepareLocalContainers)
			.mockRejectedValueOnce(new Error("Docker unavailable"))
			.mockResolvedValueOnce({
				dockerPath: "docker",
				imageTags: new Set(),
				dispose: vi.fn(),
			});

		await expect(
			prepareProjectContainers(config, "/project/wrangler.jsonc")
		).rejects.toThrow("Docker unavailable");
		await expect(
			prepareProjectContainers(config, "/project/wrangler.jsonc")
		).resolves.toMatchObject({ containerBuildId: "build-id" });
		expect(prepareLocalContainers).toHaveBeenCalledTimes(2);
	});
});
