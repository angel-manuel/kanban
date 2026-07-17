import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
	isKanbanRemoteHost,
	isKanbanRuntimeHttps,
} from "../core/runtime-endpoint";

export type CorsDecision =
	| { kind: "allow"; origin: string | null }
	| { kind: "preflight"; origin: string }
	| { kind: "reject"; origin: string };

export interface CorsGateInput {
	method: string | undefined;
	originHeader: string | undefined;
	allowedOrigins: ReadonlySet<string>;
}

const isDev = process.env.NODE_ENV === "development";
const TRUSTED_ORIGINS_ENV = "KANBAN_TRUSTED_ORIGINS";

interface TrustedOriginEntries {
	origins: Set<string>;
	hosts: Set<string>;
}

/**
 * Parse the `KANBAN_TRUSTED_ORIGINS` env var (comma-separated full origins
 * like `https://kanban.example.com` or `http://kanban.example.com:8080`).
 * Each entry contributes its origin to the CORS allowlist and its host
 * (host[:port]) to the Host header allowlist, so a reverse proxy fronting
 * Kanban on its own DNS name can forward requests through.
 */
function parseTrustedOrigins(): TrustedOriginEntries {
	const raw = process.env[TRUSTED_ORIGINS_ENV]?.trim();
	const result: TrustedOriginEntries = { origins: new Set(), hosts: new Set() };
	if (!raw) {
		return result;
	}
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			continue;
		}
		// `URL.host` already omits the port when it's the default for the scheme,
		// matching what browsers put in the Host header through a standard-port proxy.
		result.origins.add(`${url.protocol}//${url.host}`.toLowerCase());
		result.hosts.add(url.host.toLowerCase());
	}
	return result;
}

export function evaluateCors(input: CorsGateInput): CorsDecision {
	const origin = input.originHeader || null;
	const isPreflight = input.method === "OPTIONS";

	if (origin === null) {
		return { kind: "allow", origin: null };
	}

	if (!input.allowedOrigins.has(origin.toLowerCase())) {
		return { kind: "reject", origin };
	}

	if (isPreflight) {
		return { kind: "preflight", origin };
	}

	return { kind: "allow", origin };
}

export interface HostGateInput {
	hostHeader: string | undefined;
	allowedHosts: ReadonlySet<string>;
}

export type HostDecision = { kind: "allow" } | { kind: "reject"; host: string | null };

export function evaluateHost(input: HostGateInput): HostDecision {
	if (!input.hostHeader) {
		return { kind: "reject", host: null };
	}

	if (!input.allowedHosts.has(input.hostHeader.toLowerCase())) {
		return { kind: "reject", host: input.hostHeader };
	}

	return { kind: "allow" };
}

export function getAllowedHostHeaders(): ReadonlySet<string> {
	const port = getKanbanRuntimePort();
	const boundHost = getKanbanRuntimeHost().toLowerCase();
	const allowed = new Set<string>();
	const addHostPort = (host: string) => {
		allowed.add(`${host}:${port}`);
	};

	if (isKanbanRemoteHost()) {
		addHostPort(boundHost);
	} else {
		// Localhost binding: accept both common loopback hostnames so SSH port
		// forwarding works whether the user types localhost or 127.0.0.1.
		addHostPort("localhost");
		addHostPort("127.0.0.1");
		if (isDev) {
			// Vite's default dev server host:port
			allowed.add("localhost:4173");
			allowed.add("127.0.0.1:4173");
		}
	}

	for (const host of parseTrustedOrigins().hosts) {
		allowed.add(host);
	}
	return allowed;
}

export function getAllowedOrigins(): ReadonlySet<string> {
	const port = getKanbanRuntimePort();
	const scheme = isKanbanRuntimeHttps() ? "https" : "http";
	const boundHost = getKanbanRuntimeHost().toLowerCase();
	const allowed = new Set<string>();

	if (isKanbanRemoteHost()) {
		allowed.add(`${scheme}://${boundHost}:${port}`);
	} else {
		allowed.add(`${scheme}://localhost:${port}`);
		allowed.add(`${scheme}://127.0.0.1:${port}`);
	}

	if (isDev) {
		allowed.add("http://localhost:4173");
		allowed.add("http://127.0.0.1:4173");
	}

	for (const origin of parseTrustedOrigins().origins) {
		allowed.add(origin);
	}
	return allowed;
}

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].join(", ");
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Kanban-Workspace-Id"].join(", ");
const PREFLIGHT_MAX_AGE_SECONDS = "600";

function applyAllowedOriginHeaders(res: ServerResponse, origin: string): void {
	res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Vary", "Origin");
	res.setHeader("Access-Control-Allow-Credentials", "true");
}

function rejectRequest(res: ServerResponse, message: string): { end: boolean } {
	res.writeHead(403, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify({ error: message }));
	return { end: true };
}

function rejectSocket(socket: Duplex): { end: boolean } {
	socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
	socket.destroy();
	return { end: true };
}

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: req.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectRequest(res, "Host not allowed.");
	}

	const corsDecision = evaluateCors({
		method: req.method,
		originHeader: req.headers.origin,
		allowedOrigins: getAllowedOrigins(),
	});

	switch (corsDecision.kind) {
		case "allow": {
			if (corsDecision.origin !== null) {
				applyAllowedOriginHeaders(res, corsDecision.origin);
			}
			return { end: false };
		}
		case "preflight": {
			applyAllowedOriginHeaders(res, corsDecision.origin);
			res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
			res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
			res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
			res.writeHead(204);
			res.end();
			return { end: true };
		}
		case "reject": {
			return rejectRequest(res, "Origin not allowed.");
		}
	}
}

export function handleSocketUpgrade(request: IncomingMessage, socket: Duplex): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: request.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectSocket(socket);
	}

	const corsDecision = evaluateCors({
		method: request.method,
		originHeader: request.headers.origin,
		allowedOrigins: getAllowedOrigins(),
	});
	if (corsDecision.kind === "reject") {
		return rejectSocket(socket);
	}

	return { end: false };
}
