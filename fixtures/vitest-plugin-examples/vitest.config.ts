// Root vitest config for the vitest-plugin-examples fixture.
// Per the Vitest 4 docs, only `globalSetup`, `reporters`, `coverage`, and
// other "global" options are inherited from this root config; project test
// options (testTimeout, retry, etc.) are NOT inherited. Each project under
// `*/vitest.*config.*ts` extends `vitest.shared.ts` directly via mergeConfig.
import { defineConfig } from "vitest/config";

const excludeDockerContainerProject =
	process.platform === "win32" ||
	(process.platform === "darwin" && process.env.CI === "true");
const excludeDisabledContainerProject = process.platform === "win32";

export default defineConfig({
	test: {
		reporters: ["default"],
		projects: [
			"*/vitest.*config.*ts",
			// The positive container project needs a running Docker daemon. GitHub's
			// hosted Linux runners provide one; Windows is unsupported and hosted
			// macOS runners do not. The disabled-container project still runs on macOS.
			...(excludeDockerContainerProject
				? ["!container-app/vitest.config.ts"]
				: []),
			// This project exercises a SQLite-backed container DO. Keep it off Windows
			// for the same workerd VFS issue as the durable-objects fixture below.
			...(excludeDisabledContainerProject
				? ["!container-app/vitest.disabled.config.ts"]
				: []),
			// workerd's Windows SQLite VFS uses kj::Path::toString() (Unix-style
			// paths) with the win32 VFS, causing SQLITE_CANTOPEN for disk-backed
			// SQLite DOs. Exclude until workerd ships the fix (cloudflare/workerd#6110).
			...(process.platform === "win32"
				? ["!durable-objects/vitest.*config.*ts"]
				: []),
		],
		globalSetup: ["./vitest.global.ts"],
	},
});
