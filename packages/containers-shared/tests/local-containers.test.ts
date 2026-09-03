import { describe, it, vi } from "vitest";
import { prepareContainerImagesForDev } from "../src/images";
import { prepareLocalContainers } from "../src/local-containers";
import { cleanupContainers } from "../src/utils";
import type { ContainerDevOptions, ViteLogger } from "../src/types";

vi.mock("../src/images", () => ({
	prepareContainerImagesForDev: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/utils", () => ({ cleanupContainers: vi.fn() }));

const logger: ViteLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

const container: ContainerDevOptions = {
	dockerfile: "/project/Dockerfile",
	image_build_context: "/project",
	class_name: "Browser",
	image_tag: "cloudflare-dev/browser:build-123",
};

describe("prepareLocalContainers", () => {
	it("does not probe Docker when there are no container options", async ({
		expect,
	}) => {
		await expect(
			prepareLocalContainers({
				dockerPath: "docker",
				containerOptions: [],
				logger,
			})
		).resolves.toBeUndefined();
		expect(prepareContainerImagesForDev).not.toHaveBeenCalled();
	});

	it("deduplicates preparation and returns an idempotent cleanup handle", async ({
		expect,
	}) => {
		const onContainerImagePreparationStart = vi.fn();
		const onContainerImagePreparationEnd = vi.fn();
		const dockerUnavailable = {
			operation: "running tests",
			hint: "Disable containers for this test project.",
		};
		const prepared = await prepareLocalContainers({
			dockerPath: "docker",
			containerOptions: [container, container],
			logger,
			onContainerImagePreparationStart,
			onContainerImagePreparationEnd,
			dockerUnavailable,
		});

		expect(prepareContainerImagesForDev).toHaveBeenCalledWith(
			expect.objectContaining({
				dockerPath: "docker",
				containerOptions: [container],
				logger,
				dockerUnavailable,
			})
		);
		const preparationCallbacks = vi.mocked(prepareContainerImagesForDev).mock
			.calls[0]?.[0];
		preparationCallbacks?.onContainerImagePreparationStart({
			containerOptions: container,
			abort: vi.fn(),
		});
		preparationCallbacks?.onContainerImagePreparationEnd({
			containerOptions: container,
		});
		expect(onContainerImagePreparationStart).toHaveBeenCalledOnce();
		expect(onContainerImagePreparationEnd).toHaveBeenCalledOnce();
		expect(prepared?.imageTags).toEqual(
			new Set(["cloudflare-dev/browser:build-123"])
		);

		await prepared?.dispose();
		await prepared?.dispose();
		expect(cleanupContainers).toHaveBeenCalledOnce();
		expect(cleanupContainers).toHaveBeenCalledWith(
			"docker",
			new Set(["cloudflare-dev/browser:build-123"])
		);
	});

	it("aborts the active image preparation", async ({ expect }) => {
		const abortPreparation = vi.fn();
		vi.mocked(prepareContainerImagesForDev).mockImplementationOnce(
			async ({ onContainerImagePreparationStart }) => {
				onContainerImagePreparationStart({
					containerOptions: container,
					abort: abortPreparation,
				});
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		);
		const controller = new AbortController();
		const preparation = prepareLocalContainers({
			dockerPath: "docker",
			containerOptions: [container],
			logger,
			signal: controller.signal,
		});

		controller.abort();
		await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
		expect(abortPreparation).toHaveBeenCalledOnce();
	});
});
