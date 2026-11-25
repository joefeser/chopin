import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageContract } from "../contract";
import { SqliteStorage } from "./adapter";

let dir = mkdtempSync(join(tmpdir(), "chopin-sqlite-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
storageContract("sqlite", () => new SqliteStorage(join(dir, `${crypto.randomUUID()}.sqlite`)));

it("persists acknowledgements across reopen and excludes another writer", async () => {
	let path = join(dir, "restart.sqlite");
	let first = new SqliteStorage(path);
	await first.migrate();
	await first.users.put({ id: "local-owner", login: "owner", avatarUrl: "", now: new Date() });
	let lease = await first.leases.acquire("chopin:writer", "first", 60_000);
	expect(lease).toBeDefined();
	let second = new SqliteStorage(path);
	await second.migrate();
	expect(await second.leases.acquire("chopin:writer", "second", 60_000)).toBeUndefined();
	await first.close();
	expect((await second.users.get("local-owner"))?.login).toBe("owner");
	await second.leases.release(lease!);
	expect(await second.leases.acquire("chopin:writer", "second", 60_000)).toBeDefined();
	await second.health();
	await second.close();
});

it("peeks a committed lease while another connection holds a write transaction", async () => {
	let { Database } = await import("bun:sqlite");
	let path = join(dir, "peek.sqlite");
	let storage = new SqliteStorage(path);
	await storage.migrate();
	let lease = await storage.leases.acquire("writer", "owner", 60_000);
	let blocker = new Database(path);
	blocker.exec("BEGIN IMMEDIATE");
	try {
		expect((await storage.leases.peek("writer"))?.lease.owner).toBe(lease?.owner);
	} finally {
		blocker.exec("ROLLBACK");
		blocker.close();
		await storage.close();
	}
});

it("refuses an incomplete checkpoint instead of silently forgetting a store", async () => {
	let { Database } = await import("bun:sqlite");
	let { serialize } = await import("node:v8");
	let path = join(dir, "corrupt.sqlite");
	let storage = new SqliteStorage(path);
	await storage.migrate();
	await storage.close();
	let db = new Database(path);
	db.query("INSERT INTO local_checkpoint VALUES (1, 1, ?, ?)").run(
		Bun.version,
		serialize({ users: new Map() }),
	);
	db.close();
	storage = new SqliteStorage(path);
	try {
		await expect(storage.migrate()).rejects.toMatchObject({ failure: "corrupt" });
	} finally {
		await storage.close();
	}
});
