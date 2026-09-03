import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_API_MESSAGE_LENGTH = 240;
export const DEFAULT_USAGE_PATH = "/v1/usage";
/** 余额低于该值时页脚改为警告色。 */
export const BALANCE_WARN_YUAN = 1;
/** 余额低于该值时页脚改为错误色。 */
export const BALANCE_DANGER_YUAN = 0.2;

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

export interface CCSwitchConfig {
	baseUrl: string;
	apiKey: string;
}

export interface ActivePiProvider {
	providerId: string;
	label: string;
	config: CCSwitchConfig;
}

export interface BalanceResult {
	balance: number;
	mode?: string;
}

export class AuthenticationError extends Error {
	constructor(message = "API Key 无效或已失效") {
		super(message);
		this.name = "AuthenticationError";
	}
}

export class UnsupportedUsageError extends Error {
	constructor(message = "该站不支持用量查询") {
		super(message);
		this.name = "UnsupportedUsageError";
	}
}

export const STORE_VERSION = 2;

export interface CCSwitchStore {
	version: typeof STORE_VERSION;
	sites: Record<string, CCSwitchConfig>;
}

/** 将余额格式化为美元金额。 */
export function formatBalance(balance: number): string {
	return `$${balance.toFixed(2)}`;
}

/** 按余额高低选择页脚颜色：正常绿、低于 $1 黄、低于 $0.2 红。 */
export function balanceColor(balance: number): "success" | "warning" | "error" {
	if (balance <= BALANCE_DANGER_YUAN) return "error";
	if (balance <= BALANCE_WARN_YUAN) return "warning";
	return "success";
}

/** 判断两组用量凭据是否指向同一站点同一把 Key。 */
export function sameCredentials(left: CCSwitchConfig | undefined, right: CCSwitchConfig | undefined): boolean {
	return left !== undefined && right !== undefined && left.baseUrl === right.baseUrl && left.apiKey === right.apiKey;
}

/** 页脚站点名优先用 CCSwitch/Pi 配置里的 name，否则用域名。 */
export function formatSiteLabel(name: string | undefined, baseUrl: string): string {
	const trimmed = name?.trim().replace(/\s+/g, " ");
	if (trimmed) return trimmed.slice(0, 24);
	try {
		return new URL(baseUrl).hostname.replace(/^www\./i, "");
	} catch {
		return "站点";
	}
}

/** 规范化站点根地址：去掉末尾斜杠和 /v1，拒绝账号、查询参数与片段。 */
export function normalizeBaseUrl(value: string): string {
	const input = value.trim();
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Base URL 格式无效");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Base URL 仅支持 http:// 或 https://");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Base URL 不能包含账号、查询参数或片段");
	}
	const normalizedPath = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
	url.pathname = normalizedPath || "/";
	return url.toString().replace(/\/$/, "");
}

/** 只接受有限数字，拒绝 NaN / Infinity，避免把无效额度写进页脚。 */
function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 把未知 JSON 收窄成普通对象，数组和 null 都视为无效。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		return asRecord(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** 从 Pi 的 settings.json / models.json 读出 CCSwitch 当前正在用的供应商。 */
export async function readActivePiProvider(agentDirectory: string): Promise<ActivePiProvider | undefined> {
	const settings = await readJsonObject(join(agentDirectory, "settings.json"));
	const models = await readJsonObject(join(agentDirectory, "models.json"));
	const providers = asRecord(models?.providers);
	if (!providers) return undefined;
	const ids = Object.keys(providers);
	if (ids.length === 0) return undefined;
	const defaultProvider = typeof settings?.defaultProvider === "string" ? settings.defaultProvider : undefined;
	const defaultModel = typeof settings?.defaultModel === "string" ? settings.defaultModel : undefined;
	let providerId = defaultProvider && providers[defaultProvider] ? defaultProvider : undefined;
	if (!providerId && ids.length === 1) providerId = ids[0];
	if (!providerId && defaultModel) {
		providerId = ids.find((id) => {
			const modelsField = asRecord(providers[id])?.models;
			return Array.isArray(modelsField) && modelsField.some((item) => asRecord(item)?.id === defaultModel);
		});
	}
	if (!providerId) providerId = ids[0];
	const record = asRecord(providers[providerId]);
	if (!record || typeof record.baseUrl !== "string" || typeof record.apiKey !== "string" || !record.apiKey.trim()) {
		return undefined;
	}
	try {
		const config = { baseUrl: normalizeBaseUrl(record.baseUrl), apiKey: record.apiKey.trim() };
		const name = typeof record.name === "string" ? record.name : undefined;
		return { providerId, config, label: formatSiteLabel(name, config.baseUrl) };
	} catch {
		return undefined;
	}
}

/**
 * 从 CCSwitch / TokenRouter 用量响应中取出当前可展示余额。
 * 套餐 Key 优先用 quota.remaining；按量 Key 用 wallet balance / remaining。
 */
export function parseUsageBalance(payload: unknown): BalanceResult {
	const root = asRecord(payload);
	if (!root) throw new Error("用量响应不是有效 JSON 对象");
	const data = asRecord(root.data);
	const sources = data ? [root, data] : [root];

	for (const source of sources) {
		if (source.mode !== "quota_limited") continue;
		const quota = asRecord(source.quota);
		const remaining = asFiniteNumber(quota?.remaining);
		if (remaining !== undefined) {
			return { balance: remaining, mode: "quota_limited" };
		}
	}

	for (const source of sources) {
		const balance = asFiniteNumber(source.balance);
		if (balance !== undefined) return { balance, mode: typeof source.mode === "string" ? source.mode : "balance" };
		const remaining = asFiniteNumber(source.remaining);
		if (remaining !== undefined) return { balance: remaining, mode: "remaining" };
		const available = asFiniteNumber(source.available_balance);
		if (available !== undefined) return { balance: available, mode: "available_balance" };
	}

	throw new Error("用量响应缺少有效余额");
}

/** 生成空的按站点凭据表。 */
export function emptyStore(): CCSwitchStore {
	return { version: STORE_VERSION, sites: {} };
}

/** 把一条凭据收进 sites 表，键为规范化后的 Base URL。 */
function addSite(sites: Record<string, CCSwitchConfig>, raw: unknown): void {
	const record = asRecord(raw);
	if (!record || typeof record.baseUrl !== "string" || typeof record.apiKey !== "string" || !record.apiKey.trim()) return;
	try {
		const baseUrl = normalizeBaseUrl(record.baseUrl);
		sites[baseUrl] = { baseUrl, apiKey: record.apiKey };
	} catch {
		return;
	}
}

/** 把磁盘上的单站点、按 provider 分表或按站点分表解析成统一结构。 */
export function parseStore(value: unknown): CCSwitchStore {
	const root = asRecord(value);
	if (!root) return emptyStore();
	const sites: Record<string, CCSwitchConfig> = {};
	if (typeof root.baseUrl === "string" && typeof root.apiKey === "string") {
		addSite(sites, root);
	}
	const providers = asRecord(root.providers);
	if (providers) {
		for (const raw of Object.values(providers)) addSite(sites, raw);
	}
	const storedSites = asRecord(root.sites);
	if (storedSites) {
		for (const raw of Object.values(storedSites)) addSite(sites, raw);
	}
	return { version: STORE_VERSION, sites };
}

/** 读取按站点凭据表；文件不存在时返回空表。 */
export async function loadStore(path: string): Promise<CCSwitchStore> {
	try {
		return parseStore(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
		throw error;
	}
}

/**
 * CCSwitch 会覆写同一个 Pi provider 槽，用量必须跟当前 live 站点走。
 * 有 models.json / 注册表里的 Key 就用它；没有才回退该站点已保存的 /ccswitch-login 凭据。
 */
export function resolveQueryConfig(
	store: CCSwitchStore,
	live: CCSwitchConfig | undefined,
	modelBaseUrl?: string,
): CCSwitchConfig | undefined {
	if (live) return live;
	if (!modelBaseUrl) return undefined;
	try {
		return store.sites[normalizeBaseUrl(modelBaseUrl)];
	} catch {
		return undefined;
	}
}

/** 写入或覆盖某个站点的 CCSwitch 凭据。 */
export function upsertSiteConfig(store: CCSwitchStore, config: CCSwitchConfig): CCSwitchStore {
	const baseUrl = normalizeBaseUrl(config.baseUrl);
	return {
		version: STORE_VERSION,
		sites: { ...store.sites, [baseUrl]: { baseUrl, apiKey: config.apiKey } },
	};
}

/** 删除某个站点的 CCSwitch 凭据，不影响其他站点。 */
export function removeSiteConfig(store: CCSwitchStore, baseUrl: string): CCSwitchStore {
	const key = normalizeBaseUrl(baseUrl);
	if (!(key in store.sites)) return store;
	const sites = { ...store.sites };
	delete sites[key];
	return { version: STORE_VERSION, sites };
}

function canonicalizeSensitiveValue(value: string): string {
	return value.replace(CONTROL_CHARACTERS, "");
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chooseRedactionMarker(sensitiveValues: readonly string[]): string {
	const sensitiveCodePoints = new Set(sensitiveValues.flatMap((value) => Array.from(value)));
	const candidates = ["[REDACTED]", "●", "■", "◆", "※"];
	for (const candidate of candidates) {
		if (Array.from(candidate).every((codePoint) => !sensitiveCodePoints.has(codePoint))) return candidate;
	}
	for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++) {
		const candidate = String.fromCodePoint(codePoint);
		if (!sensitiveCodePoints.has(candidate)) return candidate;
	}
	return "";
}

/** 清洗接口错误文案并打码 API Key，避免把凭据写进页脚或通知。 */
export function sanitizeApiMessage(
	value: unknown,
	fallback: string,
	sensitiveValues: ReadonlyArray<string | undefined> = [],
): string {
	if (typeof value !== "string") return fallback;
	const values = [...new Set(
		sensitiveValues
			.filter((item): item is string => typeof item === "string")
			.map(canonicalizeSensitiveValue)
			.filter((item) => item.length > 0),
	)].sort((a, b) => Array.from(b).length - Array.from(a).length || a.localeCompare(b));
	let sanitized = value;
	if (values.length > 0) {
		const controlsBetweenCodePoints = String.raw`[\p{Cc}\p{Cf}]*`;
		const alternatives = values.map((sensitiveValue) =>
			Array.from(sensitiveValue).map(escapeRegularExpression).join(controlsBetweenCodePoints),
		);
		const sensitivePattern = new RegExp(alternatives.join("|"), "gu");
		const marker = chooseRedactionMarker(values);
		sanitized = sanitized.replace(sensitivePattern, () => marker);
	}
	sanitized = sanitized.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
	if (!sanitized) return fallback;
	const codePoints = Array.from(sanitized);
	return codePoints.length > MAX_API_MESSAGE_LENGTH
		? `${codePoints.slice(0, MAX_API_MESSAGE_LENGTH - 3).join("")}...`
		: sanitized;
}

/** 有本地配置且会话仍有效时，恢复 5 分钟周期刷新。 */
export function shouldRestorePeriodicRefresh(
	currentConfig: CCSwitchConfig | undefined,
	sessionActive: boolean,
	operationIsCurrent: boolean,
): boolean {
	return currentConfig !== undefined && sessionActive && operationIsCurrent;
}

/** 以 0600 权限原子写入多供应商凭据表，避免半截 JSON 留在磁盘上。 */
export async function saveStore(path: string, store: CCSwitchStore): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
		await chmod(path, 0o600).catch(() => undefined);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

/** 删除写入过程中可能残留的临时凭据文件。 */
export async function removeConfigTemporary(path: string): Promise<void> {
	await rm(`${path}.tmp`, { force: true });
}

/** 删除主配置和临时凭据文件。 */
export async function removeConfig(path: string): Promise<void> {
	const results = await Promise.allSettled([rm(path, { force: true }), removeConfigTemporary(path)]);
	const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (rejected) throw rejected.reason;
}

/** 从 TokenRouter / CCSwitch 常见错误体中取出可读 message。 */
function extractApiMessage(payload: unknown): string | undefined {
	const root = asRecord(payload);
	if (!root) return undefined;
	if (typeof root.message === "string") return root.message;
	const error = asRecord(root.error);
	if (typeof error?.message === "string") return error.message;
	if (typeof root.error === "string") return root.error;
	return undefined;
}

/** 生成可展示的错误文案，并打码 API Key。 */
function apiMessage(payload: unknown, fallback: string, config: CCSwitchConfig): string {
	return sanitizeApiMessage(extractApiMessage(payload), fallback, [config.apiKey]);
}

/** 判断用量接口是否按密钥失败返回，避免把 401 当成普通查询错误。 */
function isAuthenticationFailure(response: Response, payload: unknown): boolean {
	if (response.status === 401 || response.status === 403) return true;
	const root = asRecord(payload);
	const code = root?.code;
	if (code === "API_KEY_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") return true;
	return /invalid api key|api key is required|unauthorized|未授权|密钥无效/i.test(extractApiMessage(payload) ?? "");
}

/** 给请求加上默认超时，并与调用方传入的 AbortSignal 合并。 */
async function withTimeout<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	return operation(combinedSignal);
}

export class CCSwitchClient {
	private readonly fetchImpl: typeof fetch;

	constructor(fetchImpl: typeof fetch = fetch) {
		this.fetchImpl = fetchImpl;
	}

	/**
	 * 按 CCSwitch 方式用 API Key 查询用量：GET {baseUrl}/v1/usage。
	 * 成功返回钱包余额或套餐剩余；401/403 视为密钥失效。
	 */
	async getBalance(config: CCSwitchConfig, signal?: AbortSignal): Promise<BalanceResult> {
		if (!config.apiKey.trim()) throw new AuthenticationError();
		const baseUrl = normalizeBaseUrl(config.baseUrl);
		const response = await withTimeout(signal, (requestSignal) =>
			this.fetchImpl(`${baseUrl}${DEFAULT_USAGE_PATH}`, {
				headers: {
					accept: "application/json, text/plain, */*",
					"cache-control": "no-store",
					authorization: `Bearer ${config.apiKey}`,
					"user-agent": "pi-balance/1.0",
				},
				redirect: "error",
				signal: requestSignal,
			}),
		);
		const payload: unknown = await response.json().catch(() => ({}));
		if (response.status === 404) {
			throw new UnsupportedUsageError(apiMessage(payload, "该站不支持用量查询", config));
		}
		if (isAuthenticationFailure(response, payload)) {
			throw new AuthenticationError(apiMessage(payload, "API Key 无效或已失效", config));
		}
		if (!response.ok) {
			throw new Error(apiMessage(payload, `余额请求失败 (HTTP ${response.status})`, config));
		}
		return parseUsageBalance(payload);
	}

	/** 刷新余额；CCSwitch 无 Session，失败时不会用账号密码重登。 */
	async refresh(config: CCSwitchConfig, signal?: AbortSignal): Promise<{ config: CCSwitchConfig; result: BalanceResult }> {
		return { config, result: await this.getBalance(config, signal) };
	}
}
