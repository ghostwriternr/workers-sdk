import path from "node:path";
import {
	isDockerfile,
	resolveContainerClassName,
} from "@cloudflare/workers-utils";
import { getDevContainerImageName } from "./knobs";
import { generateContainerBuildId, resolveDockerHost } from "./utils";
import type { ContainerDevOptions } from "./types";
import type { Config, ContainerEngine } from "@cloudflare/workers-utils";

export interface LocalContainerPlan {
	readonly containerBuildId: string;
	readonly containerEngine: ContainerEngine;
	readonly containerOptions: readonly ContainerDevOptions[];
	readonly dockerPath: string;
}

/**
 * Creates the local-runtime plan for one normalized Worker configuration.
 * Docker is not inspected when containers are disabled or absent.
 *
 * @param options - Worker configuration and local Docker settings.
 * @returns A local container plan, or `undefined` when containers are inactive.
 */
export function createLocalContainerPlan(options: {
	containers: Config["containers"];
	exports: Config["exports"];
	enableContainers: boolean;
	configPath?: string;
	dockerPath: string;
	containerBuildId?: string;
	containerEngine?: ContainerEngine;
}): LocalContainerPlan | undefined {
	if (!options.enableContainers || !options.containers?.length) {
		return undefined;
	}

	const containerBuildId =
		options.containerBuildId ?? generateContainerBuildId();
	return {
		containerBuildId,
		containerEngine:
			options.containerEngine ?? resolveDockerHost(options.dockerPath),
		containerOptions:
			createContainerDevOptions({
				containers: options.containers,
				exports: options.exports,
				containerBuildId,
				configPath: options.configPath,
			}) ?? [],
		dockerPath: options.dockerPath,
	};
}

/**
 * Converts normalized Worker container configuration into local image build or
 * pull options.
 *
 * @param options - Worker container configuration and generated build ID.
 * @returns Local image options, or `undefined` when no containers are configured.
 */
export function createContainerDevOptions(options: {
	containers: Config["containers"];
	exports: Config["exports"];
	containerBuildId: string;
	configPath?: string;
}): ContainerDevOptions[] | undefined {
	const { containers, exports, containerBuildId, configPath } = options;

	if (!containers?.length) {
		return undefined;
	}

	return containers.flatMap((container): ContainerDevOptions[] => {
		const className = resolveContainerClassName(container, exports);
		if (className === undefined) {
			return [];
		}

		const imageTag = getDevContainerImageName(className, containerBuildId);
		if (isDockerfile(container.image, configPath)) {
			return [
				{
					dockerfile: container.image,
					image_build_context:
						container.image_build_context ?? path.dirname(container.image),
					image_vars: container.image_vars,
					class_name: className,
					image_tag: imageTag,
				},
			];
		}

		return [
			{
				image_uri: container.image,
				class_name: className,
				image_tag: imageTag,
			},
		];
	});
}
