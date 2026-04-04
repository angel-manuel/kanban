import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LockedFileSystem } from "../../src/fs/locked-file-system";
import { createTempDir } from "../utilities/temp-dir";

describe("LockedFileSystem", () => {
	it("serializes concurrent writes to the same path", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			const order: number[] = [];
			const p1 = lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {
				order.push(1);
				await new Promise((r) => setTimeout(r, 50));
				order.push(2);
			});
			const p2 = lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {
				order.push(3);
			});
			await Promise.all([p1, p2]);

			// p2 must wait for p1 to finish
			expect(order).toEqual([1, 2, 3]);
		} finally {
			tempDir.cleanup();
		}
	});

	it("allows concurrent access to different paths", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const lockedFileSystem = new LockedFileSystem();

			const order: string[] = [];
			const p1 = lockedFileSystem.withLock({ path: join(tempDir.path, "a.json"), type: "file" }, async () => {
				order.push("a-start");
				await new Promise((r) => setTimeout(r, 50));
				order.push("a-end");
			});
			const p2 = lockedFileSystem.withLock({ path: join(tempDir.path, "b.json"), type: "file" }, async () => {
				order.push("b-start");
				await new Promise((r) => setTimeout(r, 10));
				order.push("b-end");
			});
			await Promise.all([p1, p2]);

			// b should start before a finishes (parallel execution)
			expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
		} finally {
			tempDir.cleanup();
		}
	});

	it("writeTextFileAtomic creates file with correct content", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "test.txt");
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.writeTextFileAtomic(filePath, "hello world");

			const content = await readFile(filePath, "utf8");
			expect(content).toBe("hello world");
		} finally {
			tempDir.cleanup();
		}
	});
});
