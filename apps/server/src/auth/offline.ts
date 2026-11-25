import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { GitHubError } from "../github/client";
import type { GitHub, GitHubTokenGrant, Repository } from "../github/client";
import type { AuthConfig } from "./config";
import type { Router } from "../http/router";
import type { HostedAuth } from "./routes";

export type LocalPrincipal = {
	id: string;
	kind: "human" | "machine";
	secretHash: string;
	workspaces: Record<string, "read" | "write">;
};
export type OfflineDirectory = {
	principals: LocalPrincipal[];
	workspaces: { name: string; path: string; branch: string }[];
};

export function loadOfflineDirectory(path: string): OfflineDirectory {
	if ((statSync(path).mode & 0o077) !== 0) {
		throw new Error("offline identity file must be private (0600)");
	}
	let value = JSON.parse(readFileSync(path, "utf8")) as OfflineDirectory;
	if (!Array.isArray(value.principals) || !Array.isArray(value.workspaces)) {
		throw new Error("invalid offline directory");
	}
	let names = new Set<string>();
	for (let workspace of value.workspaces) {
		if (
			!/^local\/[a-z0-9][a-z0-9-]*$/.test(workspace.name) || names.has(workspace.name)
			|| !workspace.branch || !statSync(workspace.path).isDirectory()
		) throw new Error("invalid local workspace");
		workspace.path = realpathSync(workspace.path);
		names.add(workspace.name);
	}
	let ids = new Set<string>();
	for (let principal of value.principals) {
		if (
			!/^[a-z][a-z0-9-]{1,63}$/.test(principal.id) || ids.has(principal.id)
			|| !["human", "machine"].includes(principal.kind)
			|| !/^[a-f0-9]{64}$/.test(principal.secretHash)
			|| !principal.workspaces || typeof principal.workspaces !== "object"
			|| Object.entries(principal.workspaces).some(([key, role]) =>
				!names.has(key) || !["read", "write"].includes(role)
			)
		) {
			throw new Error("invalid local principal");
		}
		ids.add(principal.id);
	}
	return value;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function equal(a: string, b: string): boolean {
	let left = Buffer.from(a);
	let right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function denied(): never {
	throw new GitHubError("local authorization denied", 401);
}

/** Adapter for the existing identity/repository port. No method performs network I/O. */
export class OfflineIdentity implements GitHub {
	constructor(readonly directory: OfflineDirectory, private key: Uint8Array) {}
	#sign(value: string): string {
		return createHmac("sha256", this.key).update(`chopin-offline:${value}`).digest("hex");
	}
	#principal(token: string): LocalPrincipal {
		if (token.startsWith("local-session.")) {
			if (token.split(".").length !== 5) return denied();
			let [, id, expires, fingerprint, signature] = token.split(".");
			let principal = this.directory.principals.find(p => p.id === id && p.kind === "human");
			let body = `${id}.${expires}.${fingerprint}`;
			if (
				principal && Number(expires) > Date.now()
				&& fingerprint === digest(JSON.stringify(principal))
				&& signature && equal(signature, this.#sign(body))
			) return principal;
			return denied();
		}
		let hash = digest(token);
		return this.directory.principals.find(p => p.kind === "machine" && equal(p.secretHash, hash))
			?? denied();
	}
	login(id: string, secret: string): GitHubTokenGrant {
		let principal = this.directory.principals.find(p => p.kind === "human" && p.id === id);
		if (!principal || !equal(principal.secretHash, digest(secret))) return denied();
		let body = `${id}.${Date.now() + 12 * 60 * 60 * 1000}.${digest(JSON.stringify(principal))}`;
		return {
			accessToken: `local-session.${body}.${this.#sign(body)}`,
			accessExpiresIn: 43_200,
			refreshToken: "offline-session-does-not-refresh",
			refreshExpiresIn: 43_200,
		};
	}
	async user(token: string) {
		let principal = this.#principal(token);
		return { id: `local:${principal.kind}:${principal.id}`, login: principal.id, avatarUrl: "" };
	}
	authorize(): never {
		return denied();
	}
	async exchange(): Promise<GitHubTokenGrant> {
		return denied();
	}
	async refresh(): Promise<GitHubTokenGrant> {
		return denied();
	}
	async organizationMembership() {
		return undefined;
	}
	invalidate(): void {}
	async installations(token: string, page: number) {
		this.#principal(token);
		return {
			installations: page === 1
				? [{
					id: "local",
					account: { login: "local", avatarUrl: "", type: "organization" as const },
					repositorySelection: "selected" as const,
					configureUrl: "/auth/offline",
					suspended: false,
					permissions: {
						contents: true,
						pullRequests: false,
						checks: false,
						statuses: false,
						issues: false,
					},
				}]
				: [],
			nextPage: undefined,
		};
	}
	async installationRepositories(token: string, installationId: string, page: number) {
		let principal = this.#principal(token);
		let repositories = installationId === "local" && page === 1
			? await Promise.all(
				Object.keys(principal.workspaces).map(name =>
					this.repository(token, ...name.split("/") as [string, string])
				),
			)
			: [];
		return { repositories, nextPage: undefined };
	}
	async repository(token: string, owner: string, name: string): Promise<Repository> {
		let principal = this.#principal(token);
		let fullName = `${owner}/${name}`;
		let workspace = this.directory.workspaces.find(w => w.name === fullName);
		let role = principal.workspaces[fullName];
		if (!workspace || !role) throw new GitHubError("local workspace access denied", 403);
		return {
			id: fullName,
			owner,
			name,
			fullName,
			private: true,
			url: "",
			defaultBranch: workspace.branch,
			permissions: { pull: true, push: role === "write", admin: false },
		};
	}
	async repositoryAccess(token: string, owner: string, name: string) {
		return this.repository(token, owner, name);
	}
}

/** Read at most the local route budget, including chunked requests. */
export async function offlineRequestText(
	request: Request,
	maximum: number,
): Promise<string | undefined> {
	let reader = request.body?.getReader();
	if (!reader) return "";
	let chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			let { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			length += value.byteLength;
			if (length > maximum) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function registerOfflineLogin(
	router: Router,
	auth: HostedAuth,
	identity: OfflineIdentity,
): void {
	router.on(
		"GET",
		"/auth/github",
		() => Response.redirect(`${auth.config.origin}/auth/offline`, 303),
	);
	router.on(
		"GET",
		"/auth/offline",
		() =>
			new Response(
				`<!doctype html><meta charset="utf-8"><title>Local Chopin sign-in</title>
<h1>Local Chopin sign-in</h1><form method="post" action="/auth/offline"><label>Local user <input name="id" required autocomplete="username"></label>
<label>Passcode <input name="secret" type="password" required autocomplete="current-password"></label><button>Sign in</button></form>`,
				{
					headers: {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
						"content-security-policy":
							"default-src 'none'; form-action 'self'; frame-ancestors 'none'",
					},
				},
			),
	);
	router.on("POST", "/auth/offline", async request => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return new Response("forbidden", { status: 403 });
		}
		if (Number(request.headers.get("content-length") ?? 0) > 4096) {
			return new Response("too large", { status: 413 });
		}
		try {
			let text = await offlineRequestText(request, 4096);
			if (text === undefined) return new Response("too large", { status: 413 });
			let data = new URLSearchParams(text);
			let grant = identity.login(data.get("id") ?? "", data.get("secret") ?? "");
			let user = await identity.user(grant.accessToken);
			await auth.storage.users.put({ ...user, now: auth.clock() });
			let session = await auth.sessions.issue(user.id, grant);
			return new Response(null, {
				status: 303,
				headers: { location: "/", "set-cookie": session.cookie, "cache-control": "no-store" },
			});
		} catch {
			return new Response("local sign-in failed", {
				status: 401,
				headers: { "cache-control": "no-store" },
			});
		}
	});
}

export function offlineAuthConfig(
	origin: string,
	key: Uint8Array,
	directory: OfflineDirectory,
): AuthConfig {
	return {
		origin,
		encryptionKey: key,
		appSlug: "offline",
		clientId: "offline",
		offline: directory,
	};
}
