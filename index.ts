import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AuthenticationError,
	CCSwitchClient,
	type CCSwitchConfig,
	type CCSwitchStore,
	DEFAULT_REFRESH_INTERVAL_MS,
	emptyStore,
	formatBalance,
	formatSiteLabel,
	loadStore,
	normalizeBaseUrl,
	readActivePiProvider,
	removeConfig,
	removeConfigTemporary,
	removeSiteConfig,
	resolveQueryConfig,
	sameCredentials,
	saveStore,
	shouldRestorePeriodicRefresh,
	UnsupportedUsageError,
	upsertSiteConfig,
} from "./core.ts";
import { LifecycleOperationOwner } from "./lifecycle-operation-owner.ts";
import { RefreshCoordinator } from "./refresh-coordinator.ts";

const STATUS_ID = "ccswitch-balance";
const FOLLOW_UP_DELAYS_MS = [1_000, 3_000, 6_000] as const;
const DEDUCTION_ANIMATION_MS = 800;
const DEDUCTION_DISPLAY_MS = 3_000;
const DEDUCTION_FRAME_MS = 50;
const LOGIN_PROMPT_TITLES = {
	baseUrl: "CCSwitch 接入（1/2）：网站地址",
	apiKey: "CCSwitch 接入（2/2）：API Key",
} as const;
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const configPath = join(agentDir, "ccswitch-balance.json");
const modelsPath = join(agentDir, "models.json");
const settingsPath = join(agentDir, "settings.json");
const DISK_WATCH_DEBOUNCE_MS = 400;

/** 把未知异常收成短错误字符串，供通知和页脚使用。 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 仅提取 Node 文件错误码，避免把任意对象字段拼进用户可见文案。 */
function fileErrorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}

function configReadError(error: unknown): string {
	return `配置读取失败${fileErrorCode(error)}`;
}

function configWriteError(error: unknown): string {
	return `配置保存失败${fileErrorCode(error)}`;
}

function formatTime(value: Date | undefined): string {
	return value ? value.toLocaleString("zh-CN", { hour12: false }) : "尚未成功刷新";
}

/** 在 TUI 里收集 API Key，只显示掩码，避免明文落在输入行。 */
async function promptApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value) => done(value);
		input.onEscape = () => done(undefined);
		return {
			render: (width) => {
				const label = theme.fg("accent", `${LOGIN_PROMPT_TITLES.apiKey}  `);
				const masked = "*".repeat(input.getValue().length);
				return [truncateToWidth(label + masked, width)];
			},
			handleInput: (data) => {
				input.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => input.invalidate(),
		};
	});
}

/** Pi 扩展入口：注册 CCSwitch 接入命令，并在页脚展示 /v1/usage 余额。 */
export default function (pi: ExtensionAPI) {
	const client = new CCSwitchClient();
	let store: CCSwitchStore = emptyStore();
	let activeSite: string | undefined;
	let siteLabel: string | undefined;
	let config: CCSwitchConfig | undefined;
	let sessionContext: ExtensionContext | undefined;
	let balanceYuan: number | undefined;
	/** 当前站点第一次成功读到的余额，用来累计本次 Pi 会话消耗。 */
	let sessionStartBalanceYuan: number | undefined;
	/** Agent 开跑前的余额快照，用来汇总本轮实际扣款。 */
	let balanceBeforeTurn: number | undefined;
	/** 上一轮已确认的消耗，常驻页脚，不随扣款动画一起消失。 */
	let lastTurnCostYuan: number | undefined;
	let modelsWatcher: FSWatcher | undefined;
	let settingsWatcher: FSWatcher | undefined;
	let diskWatchTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSuccessfulRefreshAt: Date | undefined;
	let lastError: string | undefined;
	let authInvalid = false;
	let usageUnsupported = false;
	let periodicRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let deductionAnimationTimer: ReturnType<typeof setInterval> | undefined;
	let deductionClearTimer: ReturnType<typeof setTimeout> | undefined;
	let deduction: { fromCents: number; toCents: number; amountCents: number; startedAt: number } | undefined;
	let followUpTimers: Array<ReturnType<typeof setTimeout>> = [];
	let sessionActive = false;
	const accountOperations = new LifecycleOperationOwner();
	let refreshCoordinator: RefreshCoordinator;

	/** 扣款动画进行中返回插值余额，否则返回最近一次查询结果。 */
	function displayedBalance(): number | undefined {
		if (!deduction) return balanceYuan;
		const progress = Math.min(1, (Date.now() - deduction.startedAt) / DEDUCTION_ANIMATION_MS);
		const cents = Math.round(deduction.fromCents + (deduction.toCents - deduction.fromCents) * progress);
		return cents / 100;
	}

	/** 根据接入状态、刷新结果和扣款动画生成扩展状态行文案。 */
	function balanceStatusText(): string {
		const visibleBalance = displayedBalance();
		let text: string;
		if (!activeSite && !config) {
			text = `${sitePrefix()}余额: 无供应商`;
		} else if (!config) {
			text = `${sitePrefix()}余额: 未接入 /ccswitch-login`;
		} else if (authInvalid) {
			text = `${sitePrefix()}余额: 密钥失效 /ccswitch-login`;
		} else if (usageUnsupported) {
			text = `${sitePrefix()}余额: 该站无用量接口`;
		} else if (visibleBalance !== undefined && lastError) {
			text = `${sitePrefix()}余额: ${formatBalance(visibleBalance)} (更新失败)`;
		} else if (visibleBalance !== undefined) {
			text = `${sitePrefix()}余额: ${formatBalance(visibleBalance)}`;
		} else if (lastError) {
			text = `${sitePrefix()}余额: ${lastError}`;
		} else {
			text = `${sitePrefix()}余额: 更新中...`;
		}
		const costs = costSegments().join(" ");
		return costs ? `${text}  ${costs}` : text;
	}

	/** 页脚余额前缀：供应商显示名，没有名称时用站点域名。 */
	function sitePrefix(): string {
		return siteLabel ? `${siteLabel} ` : "";
	}

	/** 会话累计消耗：当前站点本次打开 Pi 以来相对起始余额的扣款。 */
	function sessionCostYuan(): number | undefined {
		const current = displayedBalance();
		if (sessionStartBalanceYuan === undefined || current === undefined) return undefined;
		const cost = Math.round((sessionStartBalanceYuan - current) * 100) / 100;
		return cost > 0 ? cost : undefined;
	}

	/** 拼上轮消耗和本会话累计，空段不输出。 */
	function costSegments(): string[] {
		const segments: string[] = [];
		if (lastTurnCostYuan !== undefined && lastTurnCostYuan > 0) {
			segments.push(`上轮 -${formatBalance(lastTurnCostYuan)}`);
		}
		const sessionCost = sessionCostYuan();
		if (sessionCost !== undefined) segments.push(`会话 -${formatBalance(sessionCost)}`);
		return segments;
	}

	/** 把余额写进扩展状态行；不调用 setFooter，避免覆盖 pi-open-tui 等页脚扩展。 */
	function renderStatus(): void {
		if (!sessionActive || !sessionContext || sessionContext.mode !== "tui") return;
		sessionContext.ui.setStatus(STATUS_ID, balanceStatusText());
	}

	function clearPeriodicRefresh(): void {
		if (periodicRefreshTimer) clearTimeout(periodicRefreshTimer);
		periodicRefreshTimer = undefined;
	}

	function clearDeduction(): void {
		if (deductionAnimationTimer) clearInterval(deductionAnimationTimer);
		if (deductionClearTimer) clearTimeout(deductionClearTimer);
		deductionAnimationTimer = undefined;
		deductionClearTimer = undefined;
		deduction = undefined;
	}

	/** 清掉内存中的站点和余额，可选留下错误文案给页脚。 */
	function clearAccountState(error?: string): void {
		config = undefined;
		balanceYuan = undefined;
		lastSuccessfulRefreshAt = undefined;
		lastError = error;
		authInvalid = false;
		usageUnsupported = false;
		balanceBeforeTurn = undefined;
		lastTurnCostYuan = undefined;
		sessionStartBalanceYuan = undefined;
		siteLabel = undefined;
		clearDeduction();
	}

	/** 从 Pi 当前供应商的模型配置里取出 Base URL 和 API Key，作为未单独接入时的 CCSwitch 回退。 */
	async function resolveLiveConfig(ctx: ExtensionContext, providerId: string): Promise<CCSwitchConfig | undefined> {
		let apiKey: string | undefined;
		try {
			apiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
		} catch {
			return undefined;
		}
		if (!apiKey?.trim()) return undefined;
		let baseUrl = ctx.model?.provider === providerId ? ctx.model.baseUrl : undefined;
		if (!baseUrl) {
			baseUrl = ctx.modelRegistry.getAvailable().find((model) => model.provider === providerId)?.baseUrl;
		}
		if (!baseUrl) baseUrl = ctx.modelRegistry.getRegisteredProviderConfig(providerId)?.baseUrl;
		if (!baseUrl) return undefined;
		try {
			return { baseUrl: normalizeBaseUrl(baseUrl), apiKey: apiKey.trim() };
		} catch {
			return undefined;
		}
	}

	/** 余额下降时滚动数字；上轮消耗由 lastTurnCostYuan 常驻展示，不在动画结束后清掉。 */
	function startDeduction(previousBalanceYuan: number, nextBalanceYuan: number): void {
		clearDeduction();
		const fromCents = Math.round(previousBalanceYuan * 100);
		const toCents = Math.round(nextBalanceYuan * 100);
		if (toCents >= fromCents) return;
		deduction = {
			fromCents,
			toCents,
			amountCents: fromCents - toCents,
			startedAt: Date.now(),
		};
		deductionAnimationTimer = setInterval(() => {
			if (!sessionActive || !deduction) return;
			renderStatus();
			if (Date.now() - deduction.startedAt >= DEDUCTION_ANIMATION_MS) {
				clearInterval(deductionAnimationTimer);
				deductionAnimationTimer = undefined;
			}
		}, DEDUCTION_FRAME_MS);
		deductionClearTimer = setTimeout(() => {
			clearDeduction();
			renderStatus();
		}, DEDUCTION_DISPLAY_MS);
	}

	/** 用本轮开始时的余额计算这一轮花了多少，直接覆盖页脚上的上轮消耗。 */
	function recordTurnCost(nextBalanceYuan: number): void {
		if (balanceBeforeTurn === undefined) return;
		const cost = Math.round((balanceBeforeTurn - nextBalanceYuan) * 100) / 100;
		if (cost <= 0) return;
		lastTurnCostYuan = cost;
		renderStatus();
	}

	/** 写入新余额；余额下降时播放滚动动画，并按本轮快照更新上轮消耗。 */
	function applyBalance(nextBalanceYuan: number): boolean {
		const previousBalanceYuan = balanceYuan;
		balanceYuan = nextBalanceYuan;
		if (sessionStartBalanceYuan === undefined) sessionStartBalanceYuan = nextBalanceYuan;
		recordTurnCost(nextBalanceYuan);
		if (previousBalanceYuan === undefined) return false;
		const previousCents = Math.round(previousBalanceYuan * 100);
		const nextCents = Math.round(nextBalanceYuan * 100);
		if (nextCents < previousCents) {
			startDeduction(previousBalanceYuan, nextBalanceYuan);
			return false;
		}
		if (nextCents > previousCents) clearDeduction();
		return false;
	}

	function clearFollowUpTimers(): void {
		for (const followUpTimer of followUpTimers) clearTimeout(followUpTimer);
		followUpTimers = [];
	}

	function cancelSettledFollowUps(): void {
		clearFollowUpTimers();
		refreshCoordinator.cancelTrailing();
	}

	/** 在当前刷新代际上安排 5 分钟后的下一次自动查询。 */
	function schedulePeriodicRefresh(): void {
		clearPeriodicRefresh();
		if (!sessionActive || !config) return;
		const scheduledGeneration = refreshCoordinator.currentGeneration();
		periodicRefreshTimer = setTimeout(() => {
			if (!refreshCoordinator.isCurrent(scheduledGeneration)) return;
			void requestRefresh();
		}, DEFAULT_REFRESH_INTERVAL_MS);
	}

	/** 拉取 /v1/usage 并更新页脚与本轮消耗；不因扣款取消 1/3/6 秒补查。 */
	async function performRefresh(refreshGeneration: number, signal: AbortSignal): Promise<boolean> {
		if (!config || !refreshCoordinator.isCurrent(refreshGeneration)) {
			renderStatus();
			return false;
		}
		const currentConfig = config;
		lastError = undefined;
		authInvalid = false;
		usageUnsupported = false;
		renderStatus();
		try {
			const refreshed = await client.refresh(currentConfig, signal);
			if (!refreshCoordinator.isCurrent(refreshGeneration) || signal.aborted) return false;
			config = refreshed.config;
			const decreased = applyBalance(refreshed.result.balance);
			lastSuccessfulRefreshAt = new Date();
			lastError = undefined;
			authInvalid = false;
			usageUnsupported = false;
			return decreased;
		} catch (error) {
			if (!refreshCoordinator.isCurrent(refreshGeneration) || signal.aborted) return false;
			authInvalid = error instanceof AuthenticationError;
			usageUnsupported = error instanceof UnsupportedUsageError;
			lastError = errorMessage(error);
			if (authInvalid || usageUnsupported) balanceYuan = undefined;
			return false;
		} finally {
			if (refreshCoordinator.isCurrent(refreshGeneration) && !signal.aborted) renderStatus();
		}
	}

	refreshCoordinator = new RefreshCoordinator(performRefresh, () => {});

	/** 发起一次余额刷新，结束后若会话仍有效则重新挂上周期刷新。 */
	async function requestRefresh(queueTrailingIfBusy = false): Promise<void> {
		clearPeriodicRefresh();
		const requestedGeneration = refreshCoordinator.currentGeneration();
		await refreshCoordinator.request(queueTrailingIfBusy);
		if (sessionActive && config && refreshCoordinator.isCurrent(requestedGeneration)) schedulePeriodicRefresh();
	}

	/** 停掉周期刷新、补查和账户操作，避免切换会话后后台继续打接口。 */
	async function stopAsyncWork(): Promise<void> {
		clearPeriodicRefresh();
		cancelSettledFollowUps();
		clearDeduction();
		await Promise.all([accountOperations.deactivate(), refreshCoordinator.deactivate()]);
		clearPeriodicRefresh();
	}

	async function restartRefreshLifecycle(): Promise<number> {
		clearPeriodicRefresh();
		cancelSettledFollowUps();
		const generation = await refreshCoordinator.restart();
		clearPeriodicRefresh();
		return generation;
	}

	async function cleanTemporaryCredentials(): Promise<boolean> {
		try {
			await removeConfigTemporary(configPath);
			return true;
		} catch {
			return false;
		}
	}

	/** 停掉对 models.json / settings.json 的监听，避免退出后空跑。 */
	function stopDiskWatch(): void {
		if (diskWatchTimer) clearTimeout(diskWatchTimer);
		diskWatchTimer = undefined;
		modelsWatcher?.close();
		settingsWatcher?.close();
		modelsWatcher = undefined;
		settingsWatcher = undefined;
	}

	/** 监听 CCSwitch 写入的 Pi 配置，切供应商后不用重开 Pi 也能换站点。 */
	function startDiskWatch(): void {
		stopDiskWatch();
		const onDiskChange = (filename: string | Buffer | null | undefined) => {
			const name = typeof filename === "string" ? filename : "";
			if (name && name !== "models.json" && name !== "settings.json") return;
			if (diskWatchTimer) clearTimeout(diskWatchTimer);
			diskWatchTimer = setTimeout(() => {
				diskWatchTimer = undefined;
				if (!sessionActive || !sessionContext) return;
				void syncLiveFromDisk(sessionContext);
			}, DISK_WATCH_DEBOUNCE_MS);
		};
		try {
			modelsWatcher = watch(agentDir, { persistent: false }, (_event, filename) => onDiskChange(filename));
		} catch {
			try {
				modelsWatcher = watch(modelsPath, { persistent: false }, () => onDiskChange("models.json"));
				settingsWatcher = watch(settingsPath, { persistent: false }, () => onDiskChange("settings.json"));
			} catch {
				return;
			}
		}
	}

	/** CCSwitch 热切换：凭据没变只刷新站点名；变了才整段切换并重查余额。 */
	async function syncLiveFromDisk(ctx: ExtensionContext): Promise<void> {
		if (!sessionActive) return;
		const disk = await readActivePiProvider(agentDir);
		if (disk?.label) siteLabel = disk.label;
		if (sameCredentials(config, disk?.config)) {
			renderStatus();
			return;
		}
		const switched = config !== undefined;
		await applyCurrentEndpoint(ctx);
		if (switched && sessionActive && disk?.label) ctx.ui.notify(`已切换到 ${disk.label}`, "info");
	}

	/**
	 * 按磁盘上当前 Pi 供应商查询用量。CCSwitch 切换供应商时会改 models.json，
	 * 必须以文件里的 Base URL + API Key 为准。
	 */
	async function applyCurrentEndpoint(ctx: ExtensionContext): Promise<void> {
		sessionContext = ctx;
		const providerId = ctx.model?.provider;
		const modelBaseUrl = ctx.model?.baseUrl;
		clearPeriodicRefresh();
		cancelSettledFollowUps();
		clearDeduction();
		await refreshCoordinator.restart();
		clearPeriodicRefresh();
		balanceYuan = undefined;
		balanceBeforeTurn = undefined;
		lastTurnCostYuan = undefined;
		sessionStartBalanceYuan = undefined;
		lastSuccessfulRefreshAt = undefined;
		lastError = undefined;
		authInvalid = false;
		usageUnsupported = false;
		config = undefined;
		activeSite = undefined;
		renderStatus();

		const accountGeneration = accountOperations.currentGeneration();
		type Resolved = { store: CCSwitchStore; config: CCSwitchConfig | undefined; site?: string; label?: string };
		try {
			const resolved = await accountOperations.run<Resolved>(accountGeneration, async (signal) => {
				const nextStore = await loadStore(configPath);
				if (signal.aborted || !accountOperations.isCurrent(accountGeneration)) {
					return { store: nextStore, config: undefined };
				}
				const disk = await readActivePiProvider(agentDir);
				const live = disk?.config ?? (providerId ? await resolveLiveConfig(ctx, providerId) : undefined);
				if (signal.aborted || !accountOperations.isCurrent(accountGeneration)) {
					return { store: nextStore, config: undefined };
				}
				const nextConfig = resolveQueryConfig(nextStore, live, modelBaseUrl);
				const label =
					disk?.label ??
					(nextConfig
						? formatSiteLabel(
								providerId ? ctx.modelRegistry.getProviderDisplayName(providerId) : undefined,
								nextConfig.baseUrl,
							)
						: undefined);
				return { store: nextStore, config: nextConfig, site: nextConfig?.baseUrl, label };
			});
			if (!resolved || !sessionActive || !accountOperations.isCurrent(accountGeneration)) return;
			store = resolved.store;
			config = resolved.config;
			activeSite = resolved.site;
			siteLabel = resolved.label;
			renderStatus();
			if (config) await requestRefresh();
		} catch (error) {
			if (!accountOperations.isCurrent(accountGeneration)) return;
			clearAccountState(configReadError(error));
			renderStatus();
		}
	}

	/** Agent 完全结束后立刻刷新，并在 1/3/6 秒补查异步结算。 */
	async function startSettledRefreshes(): Promise<void> {
		cancelSettledFollowUps();
		if (!config || !sessionActive) return;
		const settledGeneration = refreshCoordinator.currentGeneration();
		followUpTimers = FOLLOW_UP_DELAYS_MS.map((delay) =>
			setTimeout(() => {
				if (!refreshCoordinator.isCurrent(settledGeneration)) return;
				void requestRefresh(true);
			}, delay),
		);
		await requestRefresh();
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionActive = true;
		sessionContext = ctx;
		activeSite = undefined;
		store = emptyStore();
		clearAccountState();
		await stopAsyncWork();
		if (!sessionActive) return;
		await accountOperations.activate();
		await refreshCoordinator.activate();
		if (!sessionActive) return;
		await cleanTemporaryCredentials();
		await applyCurrentEndpoint(ctx);
		if (sessionActive) startDiskWatch();
	});

	pi.on("model_select", async (event, ctx) => {
		sessionContext = ctx;
		if (!sessionActive) return;
		let nextSite: string | undefined;
		try {
			nextSite = event.model.baseUrl ? normalizeBaseUrl(event.model.baseUrl) : undefined;
		} catch {
			nextSite = undefined;
		}
		if (nextSite && nextSite === activeSite && config) return;
		await applyCurrentEndpoint(ctx);
	});

	pi.on("before_agent_start", async () => {
		balanceBeforeTurn = balanceYuan;
		const refreshGeneration = await restartRefreshLifecycle();
		if (shouldRestorePeriodicRefresh(config, sessionActive, refreshCoordinator.isCurrent(refreshGeneration))) {
			schedulePeriodicRefresh();
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sessionContext = ctx;
		await syncLiveFromDisk(ctx);
		await startSettledRefreshes();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionActive = false;
		sessionContext = undefined;
		stopDiskWatch();
		ctx.ui.setStatus(STATUS_ID, undefined);
		clearAccountState();
		await stopAsyncWork();
		await cleanTemporaryCredentials();
	});

	pi.registerCommand("ccswitch-login", {
		description: "为当前 Pi 供应商保存 CCSwitch 用量凭据（Base URL + API Key）",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("当前模式不支持交互接入", "error");
				return;
			}
			if (!ctx.model?.provider) {
				ctx.ui.notify("请先选择模型，再接入余额", "warning");
				return;
			}
			type LoginTransactionResult = { store: CCSwitchStore; config: CCSwitchConfig } | { saveError: unknown };
			const commandGeneration = await accountOperations.activate();
			if (!sessionActive || !accountOperations.isCurrent(commandGeneration)) return;
			const currentBaseUrl = config?.baseUrl ?? ctx.model?.baseUrl;
			const baseUrlInput = await ctx.ui.input(
				LOGIN_PROMPT_TITLES.baseUrl,
				currentBaseUrl ? `留空沿用 ${currentBaseUrl}` : "例如 https://api.example.com",
			);
			if (!accountOperations.isCurrent(commandGeneration) || baseUrlInput === undefined) return;
			if (!baseUrlInput.trim() && !currentBaseUrl) {
				ctx.ui.notify("请输入中转站的 Base URL", "warning");
				return;
			}
			let baseUrl: string;
			try {
				baseUrl = normalizeBaseUrl(baseUrlInput.trim() || currentBaseUrl!);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			const apiKey = await promptApiKey(ctx);
			if (!accountOperations.isCurrent(commandGeneration) || apiKey === undefined || apiKey.trim() === "") return;
			const candidate: CCSwitchConfig = { baseUrl, apiKey: apiKey.trim() };
			clearPeriodicRefresh();
			cancelSettledFollowUps();
			clearDeduction();
			await refreshCoordinator.deactivate();
			clearPeriodicRefresh();
			if (!sessionActive || !accountOperations.isCurrent(commandGeneration)) return;
			const accountGeneration = commandGeneration;
			await refreshCoordinator.activate();
			if (!sessionActive || !accountOperations.isCurrent(accountGeneration)) return;
			try {
				const loginResult = await accountOperations.run<LoginTransactionResult>(accountGeneration, async (signal) => {
					await client.getBalance(candidate, signal);
					if (signal.aborted || !accountOperations.isCurrent(accountGeneration)) return { store, config: candidate };
					try {
						const nextStore = upsertSiteConfig(store, candidate);
						await saveStore(configPath, nextStore);
						return { store: nextStore, config: candidate };
					} catch (saveError) {
						return { saveError };
					}
				});
				if (!loginResult || !sessionActive || !accountOperations.isCurrent(accountGeneration)) return;
				if ("saveError" in loginResult) {
					const message = configWriteError(loginResult.saveError);
					lastError = message;
					renderStatus();
					if (shouldRestorePeriodicRefresh(config, sessionActive, accountOperations.isCurrent(accountGeneration))) {
						schedulePeriodicRefresh();
					}
					ctx.ui.notify(`接入失败: ${message}`, "error");
					return;
				}
				store = loginResult.store;
				activeSite = loginResult.config.baseUrl;
				config = loginResult.config;
				balanceYuan = undefined;
				balanceBeforeTurn = undefined;
				lastTurnCostYuan = undefined;
				lastSuccessfulRefreshAt = undefined;
				lastError = undefined;
				authInvalid = false;
				usageUnsupported = false;
				await requestRefresh();
				if (!accountOperations.isCurrent(accountGeneration)) return;
				if (authInvalid) {
					ctx.ui.notify("接入失败: API Key 无效，页脚已改为去登录", "error");
				} else if (lastError || balanceYuan === undefined) {
					ctx.ui.notify(`已保存 ${candidate.baseUrl} 的凭据，但余额刷新失败${lastError ? `: ${lastError}` : ""}`, "warning");
				} else {
					ctx.ui.notify(`已接入 ${candidate.baseUrl}，余额已更新`, "info");
				}
			} catch (error) {
				if (!accountOperations.isCurrent(accountGeneration)) return;
				const message = errorMessage(error);
				authInvalid = error instanceof AuthenticationError;
				usageUnsupported = error instanceof UnsupportedUsageError;
				lastError = message;
				renderStatus();
				if (config) schedulePeriodicRefresh();
				ctx.ui.notify(`接入失败: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("ccswitch-refresh", {
		description: "立即刷新 CCSwitch 余额",
		handler: async (_args, ctx) => {
			if (!config) {
				ctx.ui.notify("尚未接入，请先运行 /ccswitch-login", "warning");
				return;
			}
			const manualRefreshGeneration = await restartRefreshLifecycle();
			if (!refreshCoordinator.isCurrent(manualRefreshGeneration) || !config) {
				if (sessionActive) ctx.ui.notify("刷新已取消：当前未接入", "warning");
				return;
			}
			await requestRefresh();
			if (!refreshCoordinator.isCurrent(manualRefreshGeneration)) return;
			ctx.ui.notify(
				lastError || balanceYuan === undefined
					? `刷新失败: ${lastError ?? "未返回有效余额"}`
					: `当前余额 ${formatBalance(balanceYuan)}`,
				lastError || balanceYuan === undefined ? "error" : "info",
			);
		},
	});

	pi.registerCommand("ccswitch-logout", {
		description: "清除当前站点的 CCSwitch 凭据，不影响其他站点",
		handler: async (_args, ctx) => {
			let site = activeSite;
			if (!site && ctx.model?.baseUrl) {
				try {
					site = normalizeBaseUrl(ctx.model.baseUrl);
				} catch {
					site = undefined;
				}
			}
			if (!site) {
				ctx.ui.notify("当前没有站点，无需退出", "warning");
				return;
			}
			await stopAsyncWork();
			clearAccountState();
			activeSite = site;
			renderStatus();
			if (!sessionActive) return;
			const cleanupGeneration = await accountOperations.activate();
			const cleanupResult = await accountOperations.run(cleanupGeneration, async () => {
				try {
					const nextStore = removeSiteConfig(store, site);
					if (Object.keys(nextStore.sites).length === 0) {
						await removeConfig(configPath);
					} else {
						await saveStore(configPath, nextStore);
					}
					return { ok: true as const, store: nextStore };
				} catch {
					return { ok: false as const, store };
				}
			});
			if (!sessionActive || !accountOperations.isCurrent(cleanupGeneration) || cleanupResult === undefined) return;
			store = cleanupResult.store;
			await refreshCoordinator.activate();
			if (!accountOperations.isCurrent(cleanupGeneration)) return;
			await applyCurrentEndpoint(ctx);
			if (!cleanupResult.ok) {
				ctx.ui.notify(`已退出 ${site}，但本地凭据删除失败`, "warning");
			} else {
				ctx.ui.notify(`已清除站点 ${site} 的凭据`, "info");
			}
		},
	});

	pi.registerCommand("ccswitch-status", {
		description: "查看当前供应商的 CCSwitch 余额与刷新状态",
		handler: async (_args, ctx) => {
			const status = authInvalid
				? "密钥失效，请 /ccswitch-login"
				: usageUnsupported
					? "该站无用量接口"
					: config
						? lastError
							? "更新失败"
							: "已接入"
						: "未接入，请 /ccswitch-login";
			const sessionCost = sessionCostYuan();
			const lines = [
				`供应商: ${ctx.model?.provider ?? "无"}`,
				`站点名: ${siteLabel ?? "无"}`,
				`站点: ${config?.baseUrl ?? activeSite ?? "未配置"}`,
				`状态: ${status}`,
				`余额: ${balanceYuan === undefined ? "未知" : formatBalance(balanceYuan)}`,
				`上轮消耗: ${lastTurnCostYuan !== undefined && lastTurnCostYuan > 0 ? `-${formatBalance(lastTurnCostYuan)}` : "无"}`,
				`会话消耗: ${sessionCost !== undefined ? `-${formatBalance(sessionCost)}` : "无"}`,
				`最近更新: ${formatTime(lastSuccessfulRefreshAt)}`,
			];
			if (lastError) lines.push(`错误: ${lastError}`);
			ctx.ui.notify(lines.join("\n"), lastError || authInvalid ? "warning" : "info");
		},
	});
}
