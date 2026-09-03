import fs from "node:fs/promises";
import path from "node:path";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { describe, test } from "vitest";
import {
	createContainerDevOptions,
	createLocalContainerPlan,
} from "../src/dev-options";
import type { ContainerApp, Exports } from "@cloudflare/workers-utils";

function container(props: Partial<ContainerApp>): ContainerApp {
	return { image: "./Dockerfile", ...props };
}

describe("createContainerDevOptions", () => {
	runInTempDir();

	test("returns undefined when no containers are configured", ({ expect }) => {
		expect(
			createContainerDevOptions({
				containers: undefined,
				exports: {},
				containerBuildId: "build-123",
			})
		).toBeUndefined();
	});

	test("creates Dockerfile build options", async ({ expect }) => {
		const dockerfile = path.resolve("Dockerfile");
		await fs.writeFile(dockerfile, "FROM scratch");

		expect(
			createContainerDevOptions({
				containers: [
					container({
						class_name: "Browser",
						image: dockerfile,
						image_vars: { VERSION: "1" },
					}),
				],
				exports: {},
				containerBuildId: "build-123",
				configPath: path.resolve("wrangler.jsonc"),
			})
		).toEqual([
			{
				dockerfile,
				image_build_context: process.cwd(),
				image_vars: { VERSION: "1" },
				class_name: "Browser",
				image_tag: "cloudflare-dev/browser:build-123",
			},
		]);
	});

	test("creates registry pull options from export associations", ({
		expect,
	}) => {
		const exports: Exports = {
			Browser: {
				type: "durable-object",
				storage: "sqlite",
				container: "browser-container",
			},
		};

		expect(
			createContainerDevOptions({
				containers: [
					container({
						name: "browser-container",
						image: "docker.io/example/browser:latest",
					}),
				],
				exports,
				containerBuildId: "build-123",
			})
		).toEqual([
			{
				image_uri: "docker.io/example/browser:latest",
				class_name: "Browser",
				image_tag: "cloudflare-dev/browser:build-123",
			},
		]);
	});

	test("drops containers with no Durable Object association", ({ expect }) => {
		expect(
			createContainerDevOptions({
				containers: [container({ name: "unassociated" })],
				exports: {},
				containerBuildId: "build-123",
			})
		).toEqual([]);
	});
});

describe("createLocalContainerPlan", () => {
	runInTempDir();

	test("does not resolve an engine for inactive containers", ({ expect }) => {
		expect(
			createLocalContainerPlan({
				containers: [container({ class_name: "Browser" })],
				exports: {},
				enableContainers: false,
				dockerPath: "/missing/docker",
			})
		).toBeUndefined();
	});

	test("creates a plan with caller-provided runtime identifiers", ({
		expect,
	}) => {
		const containerEngine = {
			localDocker: { socketPath: "unix:///custom/docker.sock" },
		};
		const plan = createLocalContainerPlan({
			containers: [
				container({
					class_name: "Browser",
					image: "docker.io/example/browser:latest",
				}),
			],
			exports: {},
			enableContainers: true,
			dockerPath: "docker",
			containerBuildId: "build-123",
			containerEngine,
		});

		expect(plan).toEqual({
			containerBuildId: "build-123",
			containerEngine,
			containerOptions: [
				{
					image_uri: "docker.io/example/browser:latest",
					class_name: "Browser",
					image_tag: "cloudflare-dev/browser:build-123",
				},
			],
			dockerPath: "docker",
		});
	});
});
