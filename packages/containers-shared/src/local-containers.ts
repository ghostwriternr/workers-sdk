import { prepareContainerImagesForDev } from "./images";
import { cleanupContainers } from "./utils";
import type { ContainerDevOptions, ViteLogger, WranglerLogger } from "./types";
import type { ComplianceConfig } from "@cloudflare/workers-utils/compliance";

export interface PreparedLocalContainers {
	readonly dockerPath: string;
	readonly imageTags: ReadonlySet<string>;
	dispose(): Promise<void>;
}

interface LocalContainerPreparationCallbacks {
	onContainerImagePreparationStart?: (args: {
		containerOptions: ContainerDevOptions;
		abort: () => void;
	}) => void;
	onContainerImagePreparationEnd?: (args: {
		containerOptions: ContainerDevOptions;
	}) => void;
}

/**
 * Builds or pulls the images required by a local container runtime and returns
 * an idempotent cleanup handle for containers created from those images.
 *
 * Image layers and tags remain cached. Disposal only removes runtime containers
 * derived from the prepared image tags.
 *
 * @param options - Local image options, Docker settings, and cancellation state.
 * @returns A cleanup handle, or `undefined` when no images require preparation.
 */
export async function prepareLocalContainers(
	options: {
		dockerPath: string;
		containerOptions: Iterable<ContainerDevOptions>;
		logger: WranglerLogger | ViteLogger;
		complianceConfig?: ComplianceConfig;
		signal?: AbortSignal;
	} & LocalContainerPreparationCallbacks
): Promise<PreparedLocalContainers | undefined> {
	const containerOptions = Array.from(
		new Map(
			Array.from(options.containerOptions, (option) => [
				option.image_tag,
				option,
			])
		).values()
	);
	if (containerOptions.length === 0) {
		return undefined;
	}

	options.signal?.throwIfAborted();
	let abortActivePreparation: (() => void) | undefined;
	const abort = () => abortActivePreparation?.();
	options.signal?.addEventListener("abort", abort);
	try {
		await prepareContainerImagesForDev({
			dockerPath: options.dockerPath,
			containerOptions,
			onContainerImagePreparationStart: (event) => {
				const abortPreparation = event.abort;
				abortActivePreparation = abortPreparation;
				options.onContainerImagePreparationStart?.(event);
				if (options.signal?.aborted) {
					abortPreparation();
				}
			},
			onContainerImagePreparationEnd: (event) => {
				abortActivePreparation = undefined;
				options.onContainerImagePreparationEnd?.(event);
			},
			logger: options.logger,
			complianceConfig: options.complianceConfig,
		});
		options.signal?.throwIfAborted();
	} finally {
		options.signal?.removeEventListener("abort", abort);
	}

	const imageTags = new Set(containerOptions.map(({ image_tag }) => image_tag));
	let disposed = false;
	return {
		dockerPath: options.dockerPath,
		imageTags,
		dispose() {
			if (!disposed) {
				disposed = true;
				cleanupContainers(options.dockerPath, imageTags);
			}
			return Promise.resolve();
		},
	};
}
