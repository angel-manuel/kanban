/**
 * A keyed async mutex for in-process concurrency control.
 * Each key has an independent lock queue — holders of different keys don't block each other.
 * Uses promise chaining to guarantee mutual exclusion even when multiple acquires
 * are called synchronously in the same microtask.
 */
export class AsyncKeyedMutex {
	private chains = new Map<string, Promise<void>>();

	async acquire(key: string): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});

		const prev = this.chains.get(key) ?? Promise.resolve();
		this.chains.set(key, next);
		await prev;

		return () => {
			if (this.chains.get(key) === next) {
				this.chains.delete(key);
			}
			release();
		};
	}
}
