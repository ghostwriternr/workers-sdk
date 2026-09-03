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

	it("shares preparation across sequential leases", async ({ expect }) => {
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
		expect(dispose).not.toHaveBeenCalled();
		await second?.release();
		const third = await prepareProjectContainers(
			config,
			"/project/wrangler.jsonc",
			"dev"
		);
		expect(createLocalContainerPlan).toHaveBeenCalledOnce();
		expect(prepareLocalContainers).toHaveBeenCalledOnce();
		await third?.release();
		await disposeAllProjectContainers();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("tracks project preparations independently", async ({ expect }) => {
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
		expect(disposeA).not.toHaveBeenCalled();
		expect(disposeB).not.toHaveBeenCalled();
		await projectB?.release();
		await disposeAllProjectContainers();
		expect(disposeA).toHaveBeenCalledOnce();
		expect(disposeB).toHaveBeenCalledOnce();
	});

	it("rebuilds an invalidated environment after active leases release", async ({
		expect,
	}) => {
		const dispose = vi.fn();
		vi.mocked(createLocalContainerPlan).mockReturnValue({
			containerBuildId: "build-id",
			containerEngine: { localDocker: { socketPath: "/docker.sock" } },
			dockerPath: "docker",
			containerOptions: [
				{
					class_name: "Container",
					dockerfile: "/project/Dockerfile",
					image_build_context: "/project",
					image_tag: "cloudflare-dev/container:build-id",
				},
			],
		});
		vi.mocked(prepareLocalContainers).mockResolvedValue({
			dockerPath: "docker",
			imageTags: new Set(),
			dispose,
		});

		const first = await prepareProjectContainers(
			config,
			"/project/wrangler.jsonc"
		);
		expect(first?.watch).toMatchObject({
			files: ["/project/Dockerfile"],
			directories: ["/project"],
		});

		first?.watch.invalidate();
		expect(dispose).not.toHaveBeenCalled();
		await first?.release();
		expect(dispose).toHaveBeenCalledOnce();

		const second = await prepareProjectContainers(
			config,
			"/project/wrangler.jsonc"
		);
		expect(createLocalContainerPlan).toHaveBeenCalledTimes(2);
		expect(prepareLocalContainers).toHaveBeenCalledTimes(2);
		await second?.release();
	});

	it("does not reuse preparation after container configuration changes", async ({
		expect,
	}) => {
		vi.mocked(createLocalContainerPlan).mockReturnValue({
			containerBuildId: "build-id",
			containerEngine: { localDocker: { socketPath: "/docker.sock" } },
			dockerPath: "docker",
			containerOptions: [],
		});
		vi.mocked(prepareLocalContainers).mockResolvedValue({
			dockerPath: "docker",
			imageTags: new Set(),
			dispose: vi.fn(),
		});
		const firstConfig = {
			...config,
			containers: [{ class_name: "Container", image: "./Dockerfile" }],
		} as Config;
		const secondConfig = {
			...config,
			containers: [{ class_name: "Container", image: "registry/image:two" }],
		} as Config;

		const first = await prepareProjectContainers(
			firstConfig,
			"/project/wrangler.jsonc"
		);
		await first?.release();
		const second = await prepareProjectContainers(
			secondConfig,
			"/project/wrangler.jsonc"
		);

		expect(createLocalContainerPlan).toHaveBeenCalledTimes(2);
		expect(prepareLocalContainers).toHaveBeenCalledTimes(2);
		await second?.release();
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
