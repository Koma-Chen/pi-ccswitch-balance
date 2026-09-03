/** 串行化登录/清凭据等账户操作，切换会话时中止上一轮请求。 */
export type LifecycleOperation<T> = (signal: AbortSignal) => Promise<T>;

interface ActiveOperation {
	generation: number;
	controller: AbortController;
	promise: Promise<unknown>;
}

export class LifecycleOperationOwner {
	private generation = 0;
	private active = false;
	private current: ActiveOperation | undefined;
	private transition = Promise.resolve();

	async activate(): Promise<number> {
		return this.transitionTo(true);
	}

	async deactivate(): Promise<void> {
		await this.transitionTo(false);
	}

	isCurrent(generation: number): boolean {
		return this.active && generation === this.generation;
	}

	currentGeneration(): number {
		return this.generation;
	}

	async run<T>(generation: number, operation: LifecycleOperation<T>): Promise<T | undefined> {
		if (!this.isCurrent(generation) || this.current) return undefined;
		const controller = new AbortController();
		const activeOperation: ActiveOperation = {
			generation,
			controller,
			promise: Promise.resolve(),
		};
		const promise = operation(controller.signal);
		activeOperation.promise = promise;
		this.current = activeOperation;
		try {
			const result = await promise;
			return this.isCurrent(generation) && !controller.signal.aborted ? result : undefined;
		} catch (error) {
			if (!this.isCurrent(generation) || controller.signal.aborted) return undefined;
			throw error;
		} finally {
			if (this.current === activeOperation) this.current = undefined;
		}
	}

	private async transitionTo(activate: boolean): Promise<number> {
		const generation = ++this.generation;
		this.active = false;
		const pending = this.detachAndAbortCurrent();
		const transition = this.transition.then(async () => {
			await pending?.catch(() => undefined);
		});
		this.transition = transition.catch(() => undefined);
		await transition;
		if (activate && this.generation === generation) this.active = true;
		return generation;
	}

	private detachAndAbortCurrent(): Promise<unknown> | undefined {
		const activeOperation = this.current;
		this.current = undefined;
		activeOperation?.controller.abort();
		return activeOperation?.promise;
	}
}
