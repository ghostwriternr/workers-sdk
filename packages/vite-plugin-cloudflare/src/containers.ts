import type { ContainerDevOptions } from "@cloudflare/containers-shared";

/**
 * Returns the path to the Docker executable as defined by the
 * `WRANGLER_DOCKER_BIN` environment variable, or the default value
 * `"docker"`
 */
export function getDockerPath(): string {
	const defaultDockerPath = "docker";
	const dockerPathEnvVar = "WRANGLER_DOCKER_BIN";

	return process.env[dockerPathEnvVar] || defaultDockerPath;
}

export type ContainerTagToOptionsMap = Map<string, ContainerDevOptions>;
