import util from "node:util";
import { beforeEach, describe, it, vi } from "vitest";
import { CloudflarePoolWorker } from "../src/pool/cloudflare-pool-worker";
import {
	disposeAllRemoteProxySessions,
	remoteProxySessionsDataMap,
} from "../src/pool/config";
import { poolWorkerStarted } from "../src/pool/pages";
import type { RemoteProxySessionData } from "@cloudflare/remote-bindings";
import type { RemoteProxyConnectionString } from "miniflare";

function fakeSessionData(dispose: () => Promise<void>): RemoteProxySessionData {
	return {
		session: {
			ready: Promise.resolve(),
			dispose,
			updateBindings: vi.fn(),
			remoteProxyConnectionString: new URL(
				"http://localhost"
			) as RemoteProxyConnectionString,
		},
		remoteBindings: {},
	};
}

// Bypasses the constructor's version check; socket/miniflare are undefined and
// stop() exercises only shared-resource disposal.
function createPoolWorker(
	releaseContainerEnvironment?: () => Promise<void>
): CloudflarePoolWorker {
	const worker = Object.create(
		CloudflarePoolWorker.prototype
	) as CloudflarePoolWorker;
	Object.defineProperty(worker, "debug", {
		value: util.debuglog("vitest-plugin"),
	});
	Object.defineProperty(worker, "countedAsStarted", {
		value: true,
		writable: true,
	});
	Object.defineProperty(worker, "releaseContainerEnvironment", {
		value: releaseContainerEnvironment,
		writable: true,
	});
	return worker;
}

describe("remote proxy session disposal", () => {
	beforeEach(() => {
		remoteProxySessionsDataMap.clear();
	});

	it("disposes every session and clears the map", async ({ expect }) => {
		const a = vi.fn(async () => {});
		const b = vi.fn(async () => {});
		remoteProxySessionsDataMap.set("/a/wrangler.toml", fakeSessionData(a));
		remoteProxySessionsDataMap.set("/b/wrangler.toml", fakeSessionData(b));

		await disposeAllRemoteProxySessions();

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
		expect(remoteProxySessionsDataMap.size).toBe(0);
	});

	it("keeps the shared session alive until the last worker using it stops", async ({
		expect,
	}) => {
		const dispose = vi.fn(async () => {});
		const configPath = "/shared/wrangler.toml";
		remoteProxySessionsDataMap.set(configPath, fakeSessionData(dispose));

		// Two overlapping pool workers share one session.
		poolWorkerStarted();
		poolWorkerStarted();

		const workerA = createPoolWorker();
		const workerB = createPoolWorker();

		await workerA.stop();
		expect(dispose).not.toHaveBeenCalled();

		await workerB.stop();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(remoteProxySessionsDataMap.has(configPath)).toBe(false);
	});

	it("releases a pool worker's container environment once", async ({
		expect,
	}) => {
		const release = vi.fn(async () => {});
		poolWorkerStarted();
		const worker = createPoolWorker(release);

		await worker.stop();
		await worker.stop();

		expect(release).toHaveBeenCalledOnce();
	});
});
