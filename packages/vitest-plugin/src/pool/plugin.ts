import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
	disposeAllProjectContainers,
	disposeProjectContainersOnProcessExit,
} from "./containers";
import { cloudflarePool } from "./pool";
import type { WorkersConfigPluginAPI, WorkersPoolOptions } from "./config";
import type { ProvidedContext } from "vitest";
import type { Vite, Vitest, VitestPluginContext } from "vitest/node";

type ProvidedContextKeys = keyof ProvidedContext & string;
declare const explicitInjectTypeArgumentRequired: unique symbol;
type ExplicitInjectTypeArgumentRequired = {
	readonly [explicitInjectTypeArgumentRequired]: never;
};
type WorkerPoolOptionsContextInject = [ProvidedContextKeys] extends [never]
	? <T = unknown>(key: string) => T
	: {
			<K extends ProvidedContextKeys>(key: K): ProvidedContext[K];
			<T = ExplicitInjectTypeArgumentRequired>(
				key: string &
					(T extends ExplicitInjectTypeArgumentRequired ? never : unknown)
			): T;
		};

const cloudflareTestPath = path.resolve(
	import.meta.dirname,
	"../worker/lib/cloudflare/test.mjs"
);

export interface WorkerPoolOptionsContext {
	/**
	 * Access values provided by `globalSetup()` (e.g. ports of servers started
	 * during setup) for use in Miniflare options (e.g. bindings, upstream,
	 * hyperdrives, ...).
	 *
	 * Known `ProvidedContext` keys preserve Vitest's inference and key checking
	 * when the consuming project's augmentation is visible. Use an explicit type
	 * argument for keys provided at runtime but not declared in `ProvidedContext`.
	 * If pnpm resolves a separate Vitest copy and the keys collapse to `never`,
	 * fall back to the wider inject signature instead.
	 */
	inject: WorkerPoolOptionsContextInject;
}

function ensureArrayIncludes<T>(array: T[], items: T[]) {
	for (const item of items) {
		if (!array.includes(item)) {
			array.push(item);
		}
	}
}

function ensureArrayExcludes<T>(array: T[], items: T[]) {
	for (let i = 0; i < array.length; i++) {
		if (items.includes(array[i])) {
			array.splice(i, 1);
			i--;
		}
	}
}

const requiredConditions = ["workerd", "worker", "module", "browser"];
const requiredMainFields = ["browser", "module", "jsnext:main", "jsnext"];
const cleanupRegisteredFor = new WeakSet<Vitest>();

interface ContainerInputHandler {
	onChange(changedPath: string): void;
	onDelete(changedPath: string): void;
}

const containerInputHandlersFor = new WeakMap<
	Vitest,
	Set<ContainerInputHandler>
>();
const containerInputHandlersRegisteredFor = new WeakSet<
	VitestPluginContext["project"]
>();
let processExitCleanupRegistered = false;

function registerContainerInputHandlers(
	project: VitestPluginContext["project"],
	onChange: (changedPath: string) => void,
	onDelete: (changedPath: string) => void
): void {
	if (containerInputHandlersRegisteredFor.has(project)) {
		return;
	}
	containerInputHandlersRegisteredFor.add(project);
	const { vitest } = project;
	let handlers = containerInputHandlersFor.get(vitest);
	if (handlers === undefined) {
		const registeredHandlers = new Set<ContainerInputHandler>();
		handlers = registeredHandlers;
		containerInputHandlersFor.set(vitest, registeredHandlers);
		const dispatchChange = (changedPath: string): void => {
			for (const handler of registeredHandlers) {
				handler.onChange(changedPath);
			}
		};
		const dispatchDelete = (changedPath: string): void => {
			for (const handler of registeredHandlers) {
				handler.onDelete(changedPath);
			}
		};
		vitest.vite.watcher.on("change", dispatchChange);
		vitest.vite.watcher.on("add", dispatchChange);
		vitest.vite.watcher.on("unlink", dispatchDelete);
		vitest.onClose(() => {
			vitest.vite.watcher.off("change", dispatchChange);
			vitest.vite.watcher.off("add", dispatchChange);
			vitest.vite.watcher.off("unlink", dispatchDelete);
			containerInputHandlersFor.delete(vitest);
		});
	}

	const handler = { onChange, onDelete };
	handlers.add(handler);
}

export function cloudflareTest(
	options:
		| WorkersPoolOptions
		| ((
				ctx: WorkerPoolOptionsContext
		  ) => Promise<WorkersPoolOptions> | WorkersPoolOptions)
): Vite.Plugin {
	// Use a unique ID for each `cloudflare:test` module so updates in one `main`
	// don't trigger re-runs in all other projects, just the one that changed.
	const uuid = crypto.randomUUID();
	let main: string | undefined;
	let project: VitestPluginContext["project"] | undefined;
	let containerWatch: Parameters<
		WorkersConfigPluginAPI["setContainerWatch"]
	>[0];
	const invalidateContainerInput = (changedPath: string): boolean => {
		const resolvedPath = path.resolve(changedPath);
		const matches =
			containerWatch?.files.includes(resolvedPath) ||
			containerWatch?.directories.some((directory) => {
				const relativePath = path.relative(directory, resolvedPath);
				return relativePath !== "" && !relativePath.startsWith(`..${path.sep}`);
			});
		if (matches) {
			containerWatch?.invalidate();
		}
		return matches === true;
	};
	const onContainerInputChange = (changedPath: string): void => {
		invalidateContainerInput(changedPath);
	};
	const onContainerInputDelete = (changedPath: string): void => {
		if (!invalidateContainerInput(changedPath) || project === undefined) {
			return;
		}
		const currentProject = project;

		// Vitest's forceRerunTriggers do not apply to unlink events. Use its
		// public project APIs to rerun this project's tests after a context file
		// is deleted, which will surface the resulting Docker build error.
		void currentProject
			.globTestFiles()
			.then(({ testFiles }) =>
				currentProject.vitest.rerunTestSpecifications(
					testFiles.map((testFile) =>
						currentProject.createSpecification(testFile)
					)
				)
			)
			.catch((error: unknown) => {
				currentProject.vitest.logger.error(
					"Failed to rerun tests after a container build-context file was deleted",
					error
				);
			});
	};
	return {
		name: "@cloudflare/vitest-plugin",
		api: {
			setMain(newMain?: string) {
				main = newMain;
			},
			setContainerWatch(
				newWatch: Parameters<WorkersConfigPluginAPI["setContainerWatch"]>[0]
			) {
				containerWatch = newWatch;
				if (newWatch === undefined || project === undefined) {
					return;
				}

				// Build contexts are not part of Vite's module graph, so watch them
				// explicitly and make changes rerun the suite. The synchronous watcher
				// callback above invalidates preparation before Vitest's debounced rerun.
				project.vitest.vite.watcher.add([
					...newWatch.files,
					...newWatch.directories,
				]);
				const triggers = project.vitest.config.forceRerunTriggers;
				for (const file of newWatch.files) {
					ensureArrayIncludes(triggers, [file.replaceAll(path.sep, "/")]);
				}
				for (const directory of newWatch.directories) {
					ensureArrayIncludes(triggers, [
						`${directory.replaceAll(path.sep, "/")}/**/*`,
					]);
				}
			},
		},
		configureVitest(context: VitestPluginContext) {
			project = context.project;
			if (!processExitCleanupRegistered) {
				process.once("exit", disposeProjectContainersOnProcessExit);
				processExitCleanupRegistered = true;
			}
			if (!cleanupRegisteredFor.has(context.project.vitest)) {
				cleanupRegisteredFor.add(context.project.vitest);
				context.project.vitest.onClose(disposeAllProjectContainers);
			}
			registerContainerInputHandlers(
				context.project,
				onContainerInputChange,
				onContainerInputDelete
			);
			context.project.config.poolRunner = cloudflarePool(options);
			context.project.config.pool = "cloudflare-pool";
			context.project.config.snapshotEnvironment = "cloudflare:snapshot";
		},
		// Run after `vitest:project` plugin:
		// https://github.com/vitest-dev/vitest/blob/v4.0.18/packages/vitest/src/node/plugins/workspace.ts#L122
		config(config) {
			config.resolve ??= {};
			config.resolve.conditions ??= [];
			config.resolve.mainFields ??= [];
			config.ssr ??= {};

			config.test ??= {};
			config.test.server ??= {};
			config.test.server.deps ??= {};

			// V8 coverage requires `node:inspector` to collect coverage data from
			// V8's profiler. workerd provides `node:inspector` as a non-functional
			// stub, so V8 coverage silently fails or crashes. Istanbul works because
			// it instruments source code at build time without needing V8 access.
			// See: https://github.com/cloudflare/workers-sdk/issues/5266
			const coverage = config.test.coverage;
			if (coverage && coverage.enabled) {
				const provider = "provider" in coverage ? coverage.provider : undefined;
				if (provider === "v8" || provider === undefined) {
					const lines = [
						'Coverage provider "v8" is not supported by `@cloudflare/vitest-plugin`.',
						"V8 native coverage requires `node:inspector` which is not functional in the Workers runtime.",
						"",
						"Use Istanbul instead — it works by instrumenting source code and runs on any JavaScript runtime:",
						"",
						"  1. Install: npm i -D @vitest/coverage-istanbul",
						'  2. Set `test.coverage.provider` to "istanbul" in your Vitest config',
						"",
						"See https://vitest.dev/guide/coverage#istanbul-provider for more details.",
					];
					throw new Error(lines.join("\n"));
				}
			}
			// See https://vitest.dev/config/server.html#inline
			// Without this Vitest delegates to native import() for external deps in node_modules
			config.test.server.deps.inline = true;

			// Remove "node" condition added by the `vitest:project` plugin. We're
			// running tests inside `workerd`, not Node.js, so "node" isn't needed.
			ensureArrayExcludes(config.resolve.conditions, ["node"]);

			// Use the same resolve conditions as `wrangler`, minus "import" as this
			// breaks Vite's `require()` resolve
			ensureArrayIncludes(config.resolve.conditions, requiredConditions);

			// Vitest sets this to an empty array if unset, so restore Vite defaults:
			// https://github.com/vitest-dev/vitest/blob/v4.0.18/packages/vitest/src/node/plugins/utils.ts#L121
			ensureArrayIncludes(config.resolve.mainFields, requiredMainFields);

			// Apply `package.json` `browser` field remapping in SSR mode:
			// https://github.com/vitejs/vite/blob/v5.1.4/packages/vite/src/node/plugins/resolve.ts#L175
			config.ssr.target = "webworker";
		},
		resolveId(id) {
			if (id === "cloudflare:test") {
				return `\0cloudflare:test-${uuid}`;
			}
		},
		async load(id) {
			if (id === `\0cloudflare:test-${uuid}`) {
				let contents = await fs.readFile(cloudflareTestPath, "utf8");

				if (main !== undefined) {
					// Inject a side-effect only import of the main entry-point into the test so that Vitest
					// knows to re-run tests when the Worker is modified.
					contents += `import ${JSON.stringify(main)};`;
				}
				return contents;
			}
		},
	};
}
