import { GitHubIcon } from "@chopin/icons";

import { LocalLoginShell } from "./local-login-shell";

export function HostedLogin({ offline = false }: { offline?: boolean }) {
	let href = offline
		? "/auth/offline"
		: githubLoginHref(location.pathname, location.search, location.hash);
	return (
		<LocalLoginShell>
			<p className="mt-2 text-sm text-text-secondary">
				{offline
					? "Sign in locally to open your workspaces and documents."
					: "Sign in with GitHub to open your projects and documents."}
			</p>
			<a className="btn btn-md btn-primary mt-6 w-full" href={href}>
				{!offline && <GitHubIcon />}
				{offline ? "Continue locally" : "Continue with GitHub"}
			</a>
		</LocalLoginShell>
	);
}

export function githubLoginHref(pathname: string, search = "", hash = ""): string {
	let parameters = new URLSearchParams({ return_to: `${pathname}${search}${hash}` });
	return `/auth/github?${parameters}`;
}
