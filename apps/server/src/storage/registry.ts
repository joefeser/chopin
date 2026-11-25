import { SqliteStorage } from "./sqlite/adapter";
import { PostgresStorage } from "./postgres/adapter";

import type { StorageAdapter } from "./port";

export type StorageConfig = { driver: "postgres"; url: string } | {
	driver: "sqlite";
	path: string;
};

/** Built-in adapters are selected here; domain services never import one. */
export function createStorage(config: StorageConfig): StorageAdapter {
	switch (config.driver) {
		case "sqlite":
			return new SqliteStorage(config.path);
		case "postgres":
			return new PostgresStorage(config.url);
	}
}
