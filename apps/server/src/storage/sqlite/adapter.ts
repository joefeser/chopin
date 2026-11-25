import { Database } from "bun:sqlite";
import { deserialize, serialize } from "node:v8";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStorage } from "../memory/adapter";
import { corrupt, unavailable } from "../errors";
import type { StorageAdapter } from "../port";

const FORMAT = 1;
const MAX_BYTES = 64 * 1024 * 1024;
type EngineState = ReturnType<MemoryStorage["checkpoint"]>;
type StoreName = Exclude<keyof StorageAdapter, "driver" | "migrate" | "health" | "close">;

function checkpointShape(value: unknown, template: unknown): boolean {
	if (template instanceof Map) return value instanceof Map;
	if (typeof template === "number") {
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	}
	if (!value || typeof value !== "object" || !template || typeof template !== "object") {
		return false;
	}
	let expected = Object.keys(template);
	return Object.keys(value).length === expected.length
		&& expected.every(key =>
			Object.hasOwn(value, key)
			&& checkpointShape(Reflect.get(value, key), Reflect.get(template, key))
		);
}

/**
 * Bounded local-workspace adapter. The existing contract engine supplies domain transitions;
 * SQLite owns the commit boundary. Every operation reloads the last committed checkpoint under
 * BEGIN IMMEDIATE, then commits its complete result before resolving. No operation replay and no
 * shutdown flush are needed for durability. This is deliberately a small-workspace format, not a
 * replacement for the indexed PostgreSQL backend. Checkpoints are private runtime data, not an
 * interchange format. A format/runtime change must explicitly migrate them.
 */
export class SqliteStorage implements StorageAdapter {
	readonly driver = "sqlite";
	#db: Database;
	#engine = new MemoryStorage();
	#tail: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path, { create: true, strict: true });
		if (path !== ":memory:") chmodSync(path, 0o600);
		this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0");
		this.#db.exec(`CREATE TABLE IF NOT EXISTS local_checkpoint (
			id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL,
			runtime TEXT NOT NULL, body BLOB NOT NULL)`);
	}

	#read(): MemoryStorage {
		let row = this.#db.query("SELECT format, runtime, body FROM local_checkpoint WHERE id=1")
			.get() as { format: number; runtime: string; body: Uint8Array } | null;
		let engine = new MemoryStorage();
		if (row) {
			if (row.format !== FORMAT || row.runtime !== Bun.version || row.body.length > MAX_BYTES) {
				throw corrupt("unsupported local checkpoint format, runtime, or size");
			}
			try {
				let state: unknown = deserialize(Buffer.from(row.body));
				if (!checkpointShape(state, engine.checkpoint())) {
					throw corrupt("checkpoint shape changed; migration required");
				}
				engine.restore(state as EngineState);
			} catch (error) {
				throw corrupt("invalid local checkpoint", error);
			}
		}
		return engine;
	}

	#enqueue<T>(action: () => Promise<T>): Promise<T> {
		let result = this.#tail.then(async () => {
			if (this.#closed) throw unavailable("SQLite storage is closed");
			return action();
		});
		this.#tail = result.catch(() => {});
		return result;
	}

	async #begin(): Promise<void> {
		let deadline = Date.now() + 5_000;
		for (;;) {
			try {
				this.#db.exec("BEGIN IMMEDIATE");
				return;
			} catch (error) {
				if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) {
					throw unavailable("SQLite transaction could not acquire its write lock", error);
				}
				await Bun.sleep(10);
			}
		}
	}

	#store<K extends StoreName>(name: K): StorageAdapter[K] {
		return new Proxy(this.#engine[name] as StorageAdapter[K], {
			get: (_target, key) => {
				if (name === "leases" && key === "peek") {
					return (leaseName: string) => this.#enqueue(() => this.#read().leases.peek(leaseName));
				}

				// These two contract methods count committed revocations in this writer process.
				if (
					(name === "aiCredentials" && key === "version")
					|| (name === "aiPlaceholders" && key === "cutoffs")
				) {
					return (...args: unknown[]) =>
						Reflect.apply(
							Reflect.get(this.#engine[name], key) as (...args: unknown[]) => unknown,
							this.#engine[name],
							args,
						);
				}
				if (typeof key !== "string" || typeof Reflect.get(this.#engine[name], key) !== "function") {
					return undefined;
				}
				return (...args: unknown[]) =>
					this.#enqueue(async () => {
						await this.#begin();
						try {
							let engine = this.#read();
							let result = await Reflect.apply(
								Reflect.get(engine[name], key) as (...args: unknown[]) => unknown,
								engine[name],
								args,
							);
							let body = serialize(engine.checkpoint());
							if (body.length > MAX_BYTES) throw unavailable("local checkpoint exceeds 64 MiB");
							this.#db.query("INSERT OR REPLACE INTO local_checkpoint VALUES (1, ?, ?, ?)")
								.run(FORMAT, Bun.version, body);
							this.#db.exec("COMMIT");
							this.#engine = engine;
							return result;
						} catch (error) {
							this.#db.exec("ROLLBACK");
							throw error;
						}
					});
			},
		});
	}

	async migrate(): Promise<void> {
		await this.#enqueue(async () => {
			this.#engine = this.#read();
		});
	}
	async health(): Promise<void> {
		await this.#enqueue(async () => {
			let row = this.#db.query("PRAGMA quick_check").get() as { quick_check: string };
			if (row.quick_check !== "ok") throw corrupt("SQLite integrity check failed");
			this.#read();
		});
	}
	async close(): Promise<void> {
		await this.#tail;
		if (!this.#closed) {
			this.#closed = true;
			this.#db.close();
		}
	}
	readonly experiments = this.#store("experiments");
	readonly users = this.#store("users");
	readonly sessions = this.#store("sessions");
	readonly navigation = this.#store("navigation");
	readonly channels = this.#store("channels");
	readonly collaboration = this.#store("collaboration");
	readonly leases = this.#store("leases");
	readonly jobs = this.#store("jobs");
	readonly research = this.#store("research");
	readonly images = this.#store("images");
	readonly chatAttachments = this.#store("chatAttachments");
	readonly decisionAnswers = this.#store("decisionAnswers");
	readonly versions = this.#store("versions");
	readonly machines = this.#store("machines");
	readonly plannerHolds = this.#store("plannerHolds");
	readonly plannerModelChoices = this.#store("plannerModelChoices");
	readonly plannerCatalogs = this.#store("plannerCatalogs");
	readonly chatThreads = this.#store("chatThreads");
	readonly plannerCredentials = this.#store("plannerCredentials");
	readonly machineDatabases = this.#store("machineDatabases");
	readonly aiCredentials = this.#store("aiCredentials");
	readonly aiPlaceholders = this.#store("aiPlaceholders");
	readonly aiUsage = this.#store("aiUsage");
	readonly mcpSessions = this.#store("mcpSessions");
	readonly mcpInvocations = this.#store("mcpInvocations");
	readonly deferredTurns = this.#store("deferredTurns");
}
