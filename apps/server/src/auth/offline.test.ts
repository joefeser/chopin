import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offlineAuthConfig, type OfflineDirectory, OfflineIdentity } from "./offline";
import { registerAuthRoutes } from "./routes";
import { Router } from "../http/router";
import { SqliteStorage } from "../storage/sqlite/adapter";

let hash = (text: string) => createHash("sha256").update(text).digest("hex");
let directory: OfflineDirectory = {
	workspaces: [{ name: "local/proof", path: tmpdir(), branch: "dev" }],
	principals: [
		{
			id: "operator",
			kind: "human",
			secretHash: hash("synthetic-human"),
			workspaces: { "local/proof": "write" },
		},
		{
			id: "bridge",
			kind: "machine",
			secretHash: hash("synthetic-machine"),
			workspaces: { "local/proof": "write" },
		},
		{
			id: "reader",
			kind: "machine",
			secretHash: hash("synthetic-reader"),
			workspaces: { "local/proof": "read" },
		},
	],
};
let key = new Uint8Array(32).fill(17);
let dir = mkdtempSync(join(tmpdir(), "chopin-local-auth-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("local human and machine principals have separate credentials and workspace grants", async () => {
	let provider = new OfflineIdentity(directory, key);
	expect(() => provider.login("bridge", "synthetic-machine")).toThrow();
	await expect(provider.user("synthetic-human")).rejects.toThrow();
	await expect(provider.repository("synthetic-machine", "local", "other")).rejects.toThrow();
	expect((await provider.repository("synthetic-reader", "local", "proof")).permissions.push).toBe(
		false,
	);
	expect((await provider.user("synthetic-machine")).id).toBe("local:machine:bridge");
	let grant = provider.login("operator", "synthetic-human");
	expect((await provider.user(grant.accessToken)).id).toBe("local:human:operator");
	await expect(provider.user(`${grant.accessToken}.tampered`)).rejects.toThrow();
	let rotated = structuredClone(directory);
	rotated.principals[0]!.secretHash = hash("rotated");
	await expect(new OfflineIdentity(rotated, key).user(grant.accessToken)).rejects.toThrow();
});

test("real login persists its encrypted browser session through a fresh router and SQLite reopen", async () => {
	let path = join(dir, "auth.sqlite");
	let config = offlineAuthConfig("http://127.0.0.1:8798", key, directory);
	let storage = new SqliteStorage(path);
	await storage.migrate();
	let router = new Router();
	registerAuthRoutes(router, { config, storage, agent: false });
	let denied = await router.handle(
		new Request(`${config.origin}/auth/offline`, {
			method: "POST",
			body: "id=operator&secret=synthetic-human",
		}),
	);
	expect(denied?.status).toBe(403);
	let login = await router.handle(
		new Request(`${config.origin}/auth/offline`, {
			method: "POST",
			headers: { origin: config.origin },
			body: "id=operator&secret=synthetic-human",
		}),
	);
	expect(login?.status).toBe(303);
	let cookie = login!.headers.get("set-cookie")!.split(";")[0]!;
	await storage.close();
	storage = new SqliteStorage(path);
	await storage.migrate();
	router = new Router();
	registerAuthRoutes(router, { config, storage, agent: false });
	let restored = await router.handle(
		new Request(`${config.origin}/api/session`, { headers: { cookie } }),
	);
	expect(await restored!.json()).toMatchObject({
		auth: "offline",
		user: { id: "local:human:operator" },
	});
	// Exercise the browser picker through the actual route, not only the provider port.
	let listing = await router.handle(
		new Request(
			`${config.origin}/api/github/installations/local/repositories`,
			{ headers: { cookie } },
		),
	);
	expect(listing?.status).toBe(200);
	expect(await listing!.json()).toMatchObject({ repositories: [{ fullName: "local/proof" }] });
	let anonymous = await router.handle(
		new Request(
			`${config.origin}/api/github/installations/local/repositories`,
		),
	);
	expect(anonymous?.status).toBe(401);
	for (let id of ["other", "123"]) {
		let foreign = await router.handle(
			new Request(
				`${config.origin}/api/github/installations/${id}/repositories`,
				{ headers: { cookie } },
			),
		);
		expect(foreign?.status).toBe(404);
	}
	let install = await router.handle(new Request(`${config.origin}/auth/github/install`));
	expect(install?.status).toBe(404);
	let logout = await router.handle(
		new Request(`${config.origin}/auth/logout`, {
			method: "POST",
			headers: { cookie, origin: config.origin },
		}),
	);
	expect(logout?.status).toBe(204);
	await storage.close();
});
