import fetch from "node-fetch"
import * as vscode from "vscode"
import * as os from "os"
import { execSync } from "child_process"
import type { GostergeTask, TaskProgress, TaskResult, TaskFailure } from "./index"
import { GOSTERGE_CUSTOM_HEADERS } from "./headers"
import { GostergeError } from "./errors"
import { Logger } from "./logger"

/* ---------------------- Backend DTO'ları ---------------------- */
type GostergeTaskDto = {
	atrTaskId: number
	title: string
	summary?: string
	domainInfo?: string
	branch?: string
	tags?: string
}

type ClinePingRequest = {
	clineWorkerId?: number | null
	machineName?: string | null
	projectPath?: string | null
}

type ClinePingResponse = {
	clineWorkerId?: number | null
	nextPingTime?: string | null
	errorMessage?: string | null
}

type ClineProggressRequest = {
	clineWorkerId: number
	atrTaskId: number
	message?: string | null
	isFinished?: boolean | null
	isQuestion?: boolean | null
	isError?: boolean | null
	errorMessage?: string | null
}

/* ---------------------- Yardımcı ---------------------- */
function workspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

/* ---------------------- IssueController API ---------------------- */
export class IssueControllerAPI {
	private clineWorkerId: number | undefined
	private stepNo = 0
	private readonly storage: vscode.Memento
	private readonly workerKey: string
	private static readonly STORAGE_PREFIX = "gosterge.clineWorkerId"

	constructor(
		private baseUrl: string,
		private logger: Logger,
		storage: vscode.Memento,
	) {
		this.storage = storage
		// workspacePath endpoint ile birlikte key'i benzersiz yapalım
		const ws = workspaceRoot() ?? ""
		this.workerKey = `${IssueControllerAPI.STORAGE_PREFIX}::${this.baseUrl}::${ws}`
		const saved = this.storage.get<number>(this.workerKey)
		if (typeof saved === "number" && saved > 0) {
			this.clineWorkerId = saved
			this.logger.debug(`Restored ClineWorkerId=${saved} from storage`)
			// Storage'dan restore edilen değeri GOSTERGE_CUSTOM_HEADERS'a da yaz
			this.updateGostergeHeaders()
		}
	}

	async health(): Promise<{ ok: boolean; status: number }> {
		try {
			await this.ping()
			return { ok: true, status: 200 }
		} catch {
			return { ok: false, status: 503 }
		}
	}

	async ping(attempt = 1): Promise<void> {
		const body: ClinePingRequest = {
			clineWorkerId: this.clineWorkerId ?? this.storage.get<number>(this.workerKey) ?? null,
			machineName: os.hostname(),
			projectPath: workspaceRoot() ?? null,
		}

		const resp = await fetch(`${this.baseUrl}/issue/ping`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		})

		if (!resp.ok) {
			throw new GostergeError(`Ping failed: ${resp.status} ${await resp.text()}`, "api")
		}

		const data = (await resp.json()) as ClinePingResponse
		if (data.errorMessage) {
			const msg = data.errorMessage.toLowerCase()
			// Sunucu: "İlgili Worker Bulunamadı." vb. → ID'yi unut ve 1 kez ID'siz ping ile yeniden kaydol
			if ((/worker/.test(msg) || /bulunamad/.test(msg)) && attempt < 2) {
				this.logger.warn(`Ping error with workerId=${this.clineWorkerId}: ${data.errorMessage} → clearing & retrying`)
				await this.clearWorkerId()
				return this.ping(attempt + 1)
			}
			throw new GostergeError(`Ping error: ${data.errorMessage}`, "api")
		}
		if (typeof data.clineWorkerId === "number" && data.clineWorkerId > 0) {
			await this.saveWorkerId(data.clineWorkerId)
		}
	}

	async getNextTask(): Promise<{ task: GostergeTask | null; status: number }> {
		if (!this.clineWorkerId) await this.ping()

		const url = new URL(`${this.baseUrl}/issue/getNextTask`)
		url.searchParams.set("workerId", String(this.clineWorkerId))

		const resp = await fetch(url.toString(), { method: "GET" })
		if (resp.status === 204) {
			return { task: null, status: 204 }
		}

		const dto = (await resp.json()) as GostergeTaskDto
		// DTO dolu geldiğinde atrTaskId'yi GOSTERGE_CUSTOM_HEADERS'a ata
		if (dto && dto.atrTaskId) {
			this.updateGostergeHeaders(dto.atrTaskId)
		}
		const task = this.mapTask(dto)
		this.stepNo = 0
		return { task, status: 200 }
	}

	async updateProgress(taskId: string, progress: Omit<TaskProgress, "taskId" | "timestamp">): Promise<{ status: number }> {
		if (!this.clineWorkerId) await this.ping()
		this.stepNo += 1

		const messagePayload = {
			StepName: progress.message,
			StepPercent: progress.percent,
			StepFinishedDate: new Date().toISOString(),
			StepIsSuccess: progress.percent >= 100 && !progress.isError,
			StepNo: this.stepNo,
			...(progress.details ?? {}),
			// Hata durumunda ek bilgiler
			...(progress.isError
				? {
						isError: true,
						errorMessage: progress.errorMessage,
					}
				: {}),
		}

		const req: ClineProggressRequest = {
			clineWorkerId: this.clineWorkerId!,
			atrTaskId: Number(taskId),
			message: JSON.stringify(messagePayload),
			isFinished: progress.percent >= 100,
			isError: progress.isError ?? false,
			errorMessage: progress.errorMessage ?? null,
		}

		const resp = await fetch(`${this.baseUrl}/issue/ClineProgress`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(req),
		})
		if (!resp.ok) {
			throw new GostergeError(`issue/progress failed: ${resp.status} ${await resp.text()}`, "api")
		}
		return { status: resp.status }
	}

	async completeTask(taskId: string, result: Omit<TaskResult, "taskId">): Promise<{ status: number }> {
		// Ayrı complete endpoint yok → son progress ile finalize ediyoruz
		return this.updateProgress(taskId, {
			percent: 100,
			message: `Görev tamamlandı. Branch: ${result.branch}`,
			details: result.stats,
		})
	}

	async failTask(taskId: string, failure: Omit<TaskFailure, "taskId">): Promise<{ status: number }> {
		if (!this.clineWorkerId) await this.ping()
		this.stepNo += 1

		const messagePayload = {
			StepName: "failed",
			StepPercent: 0,
			StepFinishedDate: new Date().toISOString(),
			StepIsSuccess: false,
			StepNo: this.stepNo,
			errorType: failure.errorType ?? "unknown",
			reason: failure.reason,
			recoverable: failure.recoverable ?? false,
			...(failure.stack ? { stack: failure.stack } : {}),
		}

		const req: ClineProggressRequest = {
			clineWorkerId: this.clineWorkerId!,
			atrTaskId: Number(taskId),
			message: JSON.stringify(messagePayload),
			isFinished: false,
			isError: true,
			errorMessage: failure.reason,
		}

		// updateProgress ile aynı endpoint'i kullan (tutarlılık için)
		const resp = await fetch(`${this.baseUrl}/issue/ClineProgress`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(req),
		})
		if (!resp.ok) {
			throw new GostergeError(`issue/ClineProgress (fail) failed: ${resp.status} ${await resp.text()}`, "api")
		}
		return { status: resp.status }
	}

	/* ---------------------- DTO → Internal mapping ---------------------- */
	private mapTask(dto: GostergeTaskDto): GostergeTask {
		const tags = (dto.tags ?? "")
			.split(/[;, ]+/)
			.map((t) => t.trim())
			.filter(Boolean)

		const description = dto.summary || dto.domainInfo || dto.title
		const branch = (dto.branch ?? `feature/${dto.atrTaskId}`).replace(/^refs\/heads\//, "")

		const repoUrl =
			this.extractFromDomainInfo(dto.domainInfo, "repo") ??
			this.configDefault("defaultRepoUrl") ??
			this.originRemoteUrl() ??
			""

		const baseBranch =
			this.extractFromDomainInfo(dto.domainInfo, "baseBranch") ?? this.configDefault("defaultBaseBranch") ?? "dev"

		if (!repoUrl) {
			this.logger.warn("Repo URL bulunamadı. Lütfen gosterge.defaultRepoUrl ayarını yapın.")
		}

		return {
			id: String(dto.atrTaskId),
			title: dto.title,
			description,
			repoUrl,
			branch,
			baseBranch,
			tags,
			// Jira/assignee backend DTO’sunda yok, boş bırakıyoruz.
		}
	}

	private extractFromDomainInfo(di?: string, key?: string): string | undefined {
		if (!di || !key) return undefined
		// JSON ise
		try {
			const o = JSON.parse(di)
			return typeof o?.[key] === "string" ? String(o[key]) : undefined
		} catch {
			// "repo: https://...; baseBranch: dev" gibi düz metni de destekleyelim
			const m = di.match(new RegExp(`${key}\\s*:\\s*([^;\\n]+)`, "i"))
			return m?.[1]?.trim()
		}
	}

	private configDefault(key: "defaultRepoUrl" | "defaultBaseBranch"): string | undefined {
		const cfg = vscode.workspace.getConfiguration("gosterge")
		return cfg.get<string>(key) ?? undefined
	}

	private originRemoteUrl(): string | undefined {
		try {
			const cwd = workspaceRoot()
			if (!cwd) return undefined
			return execSync("git remote get-url origin", { cwd }).toString().trim()
		} catch {
			return undefined
		}
	}

	/* ---------- workerId storage helpers ---------- */
	private async saveWorkerId(id: number): Promise<void> {
		this.clineWorkerId = id
		await this.storage.update(this.workerKey, id)
		this.logger.debug(`Saved ClineWorkerId=${id} to storage`)
		// GOSTERGE_CUSTOM_HEADERS'ı güncelle
		this.updateGostergeHeaders()
	}

	/**
	 * GOSTERGE_CUSTOM_HEADERS içindeki clineWorkerId ve AtrTaskId değerlerini günceller
	 */
	private updateGostergeHeaders(atrTaskId?: number): void {
		if (this.clineWorkerId !== undefined) {
			GOSTERGE_CUSTOM_HEADERS.clineWorkerId = String(this.clineWorkerId)
			this.logger.debug(`Updated GOSTERGE_CUSTOM_HEADERS.clineWorkerId=${this.clineWorkerId}`)
		}
		if (atrTaskId !== undefined) {
			GOSTERGE_CUSTOM_HEADERS.AtrTaskId = String(atrTaskId)
			this.logger.debug(`Updated GOSTERGE_CUSTOM_HEADERS.AtrTaskId=${atrTaskId}`)
		}
	}

	/**
	 * Mevcut clineWorkerId değerini döndürür
	 */
	getClineWorkerId(): number | undefined {
		return this.clineWorkerId
	}
	private async clearWorkerId(): Promise<void> {
		this.clineWorkerId = undefined
		await this.storage.update(this.workerKey, undefined)
		this.logger.debug(`Cleared ClineWorkerId from storage`)
	}
}
