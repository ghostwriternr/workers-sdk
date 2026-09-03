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
	watch: {
		files: string[];
		directories: string[];
		invalidate(): void;
	};
	release(): Promise<void>;
}

interface SharedProjectContainerEnvironment {
	containerBuildId: string;
	containerEngine: NonNullable<Config["dev"]["container_engine"]>;
	watchFiles: string[];
	watchDirectories: string[];
	prepared: PreparedLocalContainers | undefined;
}

interface EnvironmentEntry {
	references: number;
	invalidated: boolean;
	preparation: Promise<SharedProjectContainerEnvironment | undefined>;
}

const environments = new Map<string, EnvironmentEntry>();
const environmentEntries = new Set<EnvironmentEntry>();
let managedRegistryPreparationQueue = Promise.resolve();

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
	const key = getEnvironmentKey(config, configPath, environment);
	let entry = environments.get(key);
	if (entry === undefined) {
		entry = {
			references: 0,
			invalidated: false,
			preparation: prepare(config, configPath),
		};
		environments.set(key, entry);
		environmentEntries.add(entry);
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
				watch: {
					files: preparedEnvironment.watchFiles,
					directories: preparedEnvironment.watchDirectories,
					invalidate() {
						void invalidateEnvironment(key, entry);
					},
				},
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

function getEnvironmentKey(
	config: Config,
	configPath: string,
	environment?: string
): string {
	// A config reload may reuse the same path and environment in watch mode.
	// Include every input that affects planning so it cannot reuse a stale image
	// mapping or engine after the Worker configuration changes.
	return JSON.stringify([
		configPath,
		environment,
		config.containers,
		config.exports,
		config.dev.enable_containers,
		config.dev.container_engine,
		config.account_id,
		getCloudflareApiBaseUrl(config),
		getDockerPath(),
		process.env.WRANGLER_DOCKER_HOST,
		process.env.DOCKER_HOST,
	]);
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

	const prepareImages = () =>
		prepareLocalContainers({
			dockerPath: plan.dockerPath,
			containerOptions: plan.containerOptions,
			logger,
			complianceConfig: config,
			dockerUnavailable: {
				operation: "running tests",
				hint: "If these tests do not exercise container instances, set dev.enable_containers to false in your Worker configuration.",
			},
		});
	const prepared = usesManagedRegistry(config, plan.containerOptions)
		? await queueManagedRegistryPreparation(() => {
				configureManagedRegistry(config);
				return prepareImages();
			})
		: await prepareImages();

	return {
		containerBuildId: plan.containerBuildId,
		containerEngine: plan.containerEngine,
		watchFiles: [
			...new Set(
				plan.containerOptions.flatMap((option) =>
					"dockerfile" in option ? [option.dockerfile] : []
				)
			),
		],
		watchDirectories: [
			...new Set(
				plan.containerOptions.flatMap((option) =>
					"dockerfile" in option ? [option.image_build_context] : []
				)
			),
		],
		prepared,
	};
}

async function releaseEnvironment(
	key: string,
	entry: EnvironmentEntry
): Promise<void> {
	entry.references--;
	if (entry.references > 0) {
		return;
	}
	if (entry.invalidated) {
		await disposeEnvironment(entry);
		return;
	}
	if (environments.get(key) !== entry) {
		return;
	}

	const environment = await entry.preparation.catch(() => undefined);
	// Keep successful preparations cached until Vitest closes so ordinary watch
	// reruns reuse the same build ID and image. Failed or inactive plans may be
	// retried because they own no resources.
	if (environment === undefined) {
		environments.delete(key);
		environmentEntries.delete(entry);
	}
}

async function invalidateEnvironment(
	key: string,
	entry: EnvironmentEntry
): Promise<void> {
	if (entry.invalidated) {
		return;
	}
	entry.invalidated = true;
	if (environments.get(key) === entry) {
		environments.delete(key);
	}
	if (entry.references === 0) {
		await disposeEnvironment(entry);
	}
}

async function disposeEnvironment(entry: EnvironmentEntry): Promise<void> {
	environmentEntries.delete(entry);
	const environment = await entry.preparation.catch(() => undefined);
	await environment?.prepared?.dispose();
}

function usesManagedRegistry(
	config: Config,
	containerOptions: readonly ContainerDevOptions[]
): boolean {
	const registry = getCloudflareContainerRegistry(config);
	return containerOptions.some(
		(option) =>
			"image_uri" in option &&
			new URL(`http://${option.image_uri}`).hostname === registry
	);
}

function configureManagedRegistry(config: Config): void {
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

function queueManagedRegistryPreparation<T>(
	callback: () => Promise<T>
): Promise<T> {
	const preparation = managedRegistryPreparationQueue.then(callback, callback);
	managedRegistryPreparationQueue = preparation.then(
		() => undefined,
		() => undefined
	);
	return preparation;
}

/** Disposes all prepared environments when the Vitest process closes. */
export async function disposeAllProjectContainers(): Promise<void> {
	const pending = [...environmentEntries].map(({ preparation }) => preparation);
	environments.clear();
	environmentEntries.clear();
	const results = await Promise.allSettled(pending);
	await Promise.all(
		results.map((result) =>
			result.status === "fulfilled"
				? result.value?.prepared?.dispose()
				: undefined
		)
	);
}
