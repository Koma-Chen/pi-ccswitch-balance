/** 协调余额刷新：同代请求去重、忙碌时排队、余额下降时取消补查。 */
export type RefreshOperation = (generation: number, signal: AbortSignal) => Promise<boolean>;

interface ActiveRefresh {
	generation: number;
	controller: AbortController;
	promise: Promise<void>;
}

export class RefreshCoordinator {
	private readonly operation: RefreshOperation;
	private readonly onCurrentDecrease: () => void;
	private generation = 0;
	private active = false;
	private current: ActiveRefresh | undefined;
	private queuedRefreshGeneration: number | undefined;
	private transition = Promise.resolve();

	constructor(operation: RefreshOperation, onCurrentDecrease: () => void) {
		this.operation = operation;
		this.onCurrentDecrease = onCurrentDecrease;
	}

	async activate(): Promise<number> {
		return this.startNewGeneration();
	}

	async restart(): Promise<number> {
		return this.startNewGeneration();
	}

	async deactivate(): Promise<void> {
		await this.startNewGeneration(false);
	}

	currentGeneration(): number {
		return this.generation;
	}

	isCurrent(generation: number): boolean {
		return this.active && generation === this.generation;
	}

	cancelTrailing(): void {
		this.queuedRefreshGeneration = undefined;
	}

	request(queueTrailingIfBusy = false): Promise<void> {
		if (!this.active) return Promise.resolve();
		const generation = this.generation;
		if (this.current?.generation === generation) {
			if (queueTrailingIfBusy) this.queuedRefreshGeneration = generation;
			return this.current.promise;
		}
		return this.launch(generation);
	}

	private async startNewGeneration(activate = true): Promise<number> {
		const generation = ++this.generation;
		this.active = false;
		this.queuedRefreshGeneration = undefined;
		const pending = this.detachAndAbortCurrent();
		const transition = this.transition.then(async () => {
			await pending?.catch(() => undefined);
		});
		this.transition = transition.catch(() => undefined);
		await transition;
		if (activate && this.generation === generation) this.active = true;
		return generation;
	}

	private launch(generation: number): Promise<void> {
		if (!this.isCurrent(generation)) return Promise.resolve();
		const controller = new AbortController();
		const activeRefresh = {} as ActiveRefresh;
		activeRefresh.generation = generation;
		activeRefresh.controller = controller;
		activeRefresh.promise = this.operation(generation, controller.signal)
			.then((decreased) => {
				if (!decreased || !this.isCurrent(generation) || controller.signal.aborted) return;
				this.queuedRefreshGeneration = undefined;
				this.onCurrentDecrease();
			})
			.finally(() => {
				if (this.current !== activeRefresh) return;
				this.current = undefined;
				if (!this.isCurrent(generation) || this.queuedRefreshGeneration !== generation) return;
				this.queuedRefreshGeneration = undefined;
				void this.launch(generation).catch(() => undefined);
			});
		this.current = activeRefresh;
		return activeRefresh.promise;
	}

	private detachAndAbortCurrent(): Promise<void> | undefined {
		const activeRefresh = this.current;
		this.current = undefined;
		activeRefresh?.controller.abort();
		return activeRefresh?.promise;
	}
}
