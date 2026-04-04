import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AsyncKeyedMutex } from "./async-mutex";

interface BaseLockRequest {
	path: string;
}

export interface FileLockRequest extends BaseLockRequest {
	type?: "file";
	lockfilePath?: string;
}

export interface DirectoryLockRequest extends BaseLockRequest {
	type: "directory";
	lockfileName?: string;
	lockfilePath?: string;
}

export type LockRequest = FileLockRequest | DirectoryLockRequest;

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
	executable?: boolean;
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

function getLockKey(request: LockRequest): string {
	if (request.type === "directory") {
		return request.lockfilePath ?? join(request.path, request.lockfileName ?? ".lock");
	}
	return request.lockfilePath ?? `${request.path}.lock`;
}

export class LockedFileSystem {
	private mutex = new AsyncKeyedMutex();

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		// Sort by lock key to prevent deadlocks when acquiring multiple locks
		const sortedRequests = requests.slice().sort((a, b) => getLockKey(a).localeCompare(getLockKey(b)));

		// Ensure directories exist
		for (const request of sortedRequests) {
			if (request.type === "directory") {
				await mkdir(request.path, { recursive: true });
			} else {
				await mkdir(dirname(request.path), { recursive: true });
			}
		}

		const releases: Array<() => void> = [];
		try {
			for (const request of sortedRequests) {
				releases.push(await this.mutex.acquire(getLockKey(request)));
			}
			return await operation();
		} finally {
			for (const release of releases.reverse()) {
				release();
			}
		}
	}

	async writeTextFileAtomic(path: string, content: string, options: AtomicTextWriteOptions = {}): Promise<void> {
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		const writeOperation = async () => {
			const existingContent = await readFileIfExists(path);
			if (existingContent === content) {
				if (options.executable) {
					await chmod(path, 0o755);
				}
				return;
			}
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
			if (options.executable) {
				await chmod(path, 0o755);
			}
		};
		if (lockRequest) {
			await this.withLock(lockRequest, writeOperation);
			return;
		}
		await writeOperation();
	}

	async writeJsonFileAtomic(
		path: string,
		payload: unknown,
		options: Omit<AtomicTextWriteOptions, "executable"> = {},
	): Promise<void> {
		await this.writeTextFileAtomic(path, JSON.stringify(payload, null, 2), options);
	}

	async removePath(path: string, options: { lock: LockRequest; recursive?: boolean; force?: boolean }): Promise<void> {
		await this.withLock(options.lock, async () => {
			await rm(path, {
				recursive: options.recursive,
				force: options.force,
			});
		});
	}
}

export const lockedFileSystem = new LockedFileSystem();
