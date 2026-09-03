import {
	configureOpenAPIForContainerPull,
	createLocalContainerPlan,
	getCloudflareContainerRegistry,
	prepareLocalContainers,
} from "@cloudflare/containers-shared";
import {
	getCloudflareApiBaseUrl,
	getDockerPath,
	UserError,
} from "@cloudflare/workers-utils";
import type {
	ContainerDevOptions,
	PreparedLocalContainers,
} from "@cloudflare/containers-shared";
import type { Config } from "@cloudflare/workers-utils";

export interface ProjectContainerEnvironment {
	containerBuildId: string;
	containerEngine: NonNullable<Config["dev"]["container_engine"]>;
	release(): Promise<void>;
}

interface SharedProjectContainerEnvironment {
	containerBuildId: string;
	containerEngine: NonNullable<Config["dev"]["container_engine"]>;
	prepared: PreparedLocalContainers | undefined;
}

interface EnvironmentEntry {
	references: number;
	preparation: Promise<SharedProjectContainerEnvironment | undefined>;
}

const environments = new Map<string, EnvironmentEntry>();

const logger = {
	debug: console.debug,
	debugWithSanitization: console.debug,
	log: console.log,
	info: console.info,
	warn: console.warn,
	error: console.error,
};

/**
 * Prepares the local container environment shared by pool workers for one
 * resolved Worker configuration.
 *
 * @param config - Normalized Worker configuration.
 * @param configPath - Absolute path to the selected configuration file.
 * @param environment - Selected Wrangler environment, if any.
 * @returns Runtime identifiers and a prepared image handle when containers are enabled.
 */
export function prepareProjectContainers(
	config: Config,
	configPath: string,
	environment?: string
): Promise<ProjectContainerEnvironment | undefined> {
	const key = `${configPath}\0${environment ?? ""}`;
	let entry = environments.get(key);
	if (entry === undefined) {
		entry = {
			references: 0,
			preparation: prepare(config, configPath),
		};
		environments.set(key, entry);
	}
	entry.references++;

	return entry.preparation.then(
		(preparedEnvironment) => {
			if (preparedEnvironment === undefined) {
				return releaseEnvironment(key, entry).then(() => undefined);
			}

			let released = false;
			return {
				containerBuildId: preparedEnvironment.containerBuildId,
				containerEngine: preparedEnvironment.containerEngine,
				release() {
					if (released) {
						return Promise.resolve();
					}
					released = true;
					return releaseEnvironment(key, entry);
				},
			};
		},
		async (error: unknown) => {
			await releaseEnvironment(key, entry);
			throw error;
		}
	);
}

async function prepare(
	config: Config,
	configPath: string
): Promise<SharedProjectContainerEnvironment | undefined> {
	const plan = createLocalContainerPlan({
		containers: config.containers,
		exports: config.exports,
		enableContainers: config.dev.enable_containers,
		configPath,
		dockerPath: getDockerPath(),
		containerEngine: config.dev.container_engine,
	});
	if (plan === undefined) {
		return undefined;
	}

	configureManagedRegistry(config, plan.containerOptions);
	const prepared = await prepareLocalContainers({
		dockerPath: plan.dockerPath,
		containerOptions: plan.containerOptions,
		logger,
		complianceConfig: config,
		dockerUnavailable: {
			operation: "running tests",
			hint: "If these tests do not exercise container instances, set dev.enable_containers to false in your Worker configuration.",
		},
	});

	return {
		containerBuildId: plan.containerBuildId,
		containerEngine: plan.containerEngine,
		prepared,
	};
}

async function releaseEnvironment(
	key: string,
	entry: EnvironmentEntry
): Promise<void> {
	entry.references--;
	if (entry.references > 0 || environments.get(key) !== entry) {
		return;
	}

	environments.delete(key);
	const environment = await entry.preparation.catch(() => undefined);
	await environment?.prepared?.dispose();
}

function configureManagedRegistry(
	config: Config,
	containerOptions: readonly ContainerDevOptions[]
): void {
	const registry = getCloudflareContainerRegistry(config);
	const usesManagedRegistry = containerOptions.some(
		(option) =>
			"image_uri" in option &&
			new URL(`http://${option.image_uri}`).hostname === registry
	);
	if (!usesManagedRegistry) {
		return;
	}

	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	const accountId = config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!apiToken || !accountId) {
		throw new UserError(
			"To use images from the Cloudflare-managed registry with the Vitest plugin, " +
				"set the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID environment variables.\n" +
				"The API token requires Containers:Edit and Workers Scripts:Edit permissions.\n" +
				"Alternatively, use a Dockerfile that references the image via FROM.",
			{ telemetryMessage: false }
		);
	}

	configureOpenAPIForContainerPull(
		accountId,
		apiToken,
		getCloudflareApiBaseUrl(config)
	);
}

/** Disposes all prepared environments after the final pool worker stops. */
export async function disposeAllProjectContainers(): Promise<void> {
	const pending = [...environments.values()].map(
		({ preparation }) => preparation
	);
	environments.clear();
	const results = await Promise.allSettled(pending);
	await Promise.all(
		results.map((result) =>
			result.status === "fulfilled"
				? result.value?.prepared?.dispose()
				: undefined
		)
	);
}
