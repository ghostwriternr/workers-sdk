import {
	COMPLIANCE_REGION_CONFIG_UNKNOWN,
	getCloudflareApiBaseUrl,
} from "@cloudflare/workers-utils/compliance";
import { UserError } from "@cloudflare/workers-utils/errors";
import { getCloudflareContainerRegistry } from "./knobs";
import { configureOpenAPIForContainerPull } from "./login";
import type { ContainerDevOptions } from "./types";
import type { ComplianceConfig } from "@cloudflare/workers-utils/compliance";

/** Inputs needed to authenticate a local managed-registry image pull. */
export interface CloudflareManagedRegistryOptions {
	containerOptions: readonly ContainerDevOptions[];
	accountId?: string;
	complianceConfig?: ComplianceConfig;
	consumerName: string;
}

let managedRegistryOperationQueue = Promise.resolve();

/**
 * Checks whether a local preparation plan pulls from Cloudflare's managed
 * container registry.
 *
 * @param containerOptions - Normalized local container image options.
 * @param complianceConfig - Configuration used to select the registry.
 * @returns Whether any option pulls from the selected managed registry.
 */
export function usesCloudflareManagedRegistry(
	containerOptions: readonly ContainerDevOptions[],
	complianceConfig?: ComplianceConfig
): boolean {
	const registry = getCloudflareContainerRegistry(complianceConfig);
	return containerOptions.some(
		(option) =>
			"image_uri" in option &&
			new URL(`http://${option.image_uri}`).hostname === registry
	);
}

/**
 * Configures credentials for local pulls from Cloudflare's managed registry.
 *
 * @param options - Pull options, account configuration, and consumer name used
 *   for an actionable authentication error.
 */
function configureCloudflareManagedRegistry(
	options: CloudflareManagedRegistryOptions
): void {
	if (
		!usesCloudflareManagedRegistry(
			options.containerOptions,
			options.complianceConfig
		)
	) {
		return;
	}

	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!apiToken || !accountId) {
		throw new UserError(
			`To use images from the Cloudflare-managed registry with the ${options.consumerName}, ` +
				"set the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID environment variables.\n" +
				"The API token requires Containers:Edit and Workers Scripts:Edit permissions.\n" +
				"Alternatively, use a Dockerfile that references the image via FROM.",
			{ telemetryMessage: false }
		);
	}

	configureOpenAPIForContainerPull(
		accountId,
		apiToken,
		getCloudflareApiBaseUrl(
			options.complianceConfig ?? COMPLIANCE_REGION_CONFIG_UNKNOWN
		)
	);
}

/**
 * Runs an image operation after configuring managed-registry credentials.
 * Operations that use the process-global generated API client are serialized;
 * external-registry and Dockerfile operations run immediately.
 *
 * @param options - Managed-registry authentication inputs.
 * @param operation - Image preparation operation to run.
 * @returns The result of the image preparation operation.
 */
export function runWithCloudflareManagedRegistry<T>(
	options: CloudflareManagedRegistryOptions,
	operation: () => Promise<T>
): Promise<T> {
	if (
		!usesCloudflareManagedRegistry(
			options.containerOptions,
			options.complianceConfig
		)
	) {
		return operation();
	}

	const run = () => {
		configureCloudflareManagedRegistry(options);
		return operation();
	};
	const pending = managedRegistryOperationQueue.then(run, run);
	managedRegistryOperationQueue = pending.then(
		() => undefined,
		() => undefined
	);
	return pending;
}
