/**********************************************************************
 * src/gosterge/index.ts
 *
 * Gösterge - Cline Extension JIRA Task Automation System
 *
 * Bu sistem:
 * - Backend API'den görevleri alır
 * - Cline'a görevleri çözdürür
 * - Git branch yönetimini otomatik yapar
 * - Progress takibi ve hata yönetimi yapar
 * - Concurrent task kontrolü sağlar
 *********************************************************************/

import * as vscode from "vscode"
import fetch, { Headers, Response } from "node-fetch"
import { Controller } from "../core/controller"
import { GostergeError } from "./errors" // Import GostergeError
import { Watchdog } from "./watchdog" // Import Watchdog
import { ClineMessage, ClineIntegration } from "./cline" // Import ClineMessage and ClineIntegration from new file
import { Buffer } from "buffer" // Import Buffer for dynamic remote name
import { IssueControllerAPI } from "./issue-api"

/* ------------------------------------------------------------------ */
/* 1. Tip Tanımlamaları                                                */
/* ------------------------------------------------------------------ */

// Git extension tipleri
type GitExtension = {
	getAPI: (version: number) => GitAPI
}

type GitAPI = {
	repositories: Repository[]
}

type Repository = {
	state: {
		remotes: Remote[]
		refs: Ref[]
		workingTreeChanges: Change[]
		indexChanges: Change[] // Added
		HEAD?: {
			name?: string
			commit?: string
		}
	}
	rootUri: vscode.Uri // Added
	addRemote: (name: string, url: string) => Promise<void>
	removeRemote: (name: string) => Promise<void>
	checkout: (branch: string) => Promise<void>
	createBranch: (name: string, checkout: boolean) => Promise<void>
	deleteBranch: (name: string, force?: boolean) => Promise<void>
	add: (resources: string[]) => Promise<void>
	commit: (message: string) => Promise<void>
	push: (remoteName?: string, branchName?: string, setUpstream?: boolean) => Promise<void>
	pull: () => Promise<void>
	fetch: (remote?: string, ref?: string, depth?: number) => Promise<void>
	clean: (paths: string[]) => Promise<void>
	stage: (uri: vscode.Uri, contents: string) => Promise<void>
	inputBox: {
		value: string
	}
	status(): Promise<void> // Added
}

type Remote = {
	name: string
	fetchUrl?: string
	pushUrl?: string
}

type Ref = {
	type: number
	name?: string
	commit?: string
}

type Change = {
	uri: vscode.Uri
	status: number
}

/* ------------------------------------------------------------------ */
/* 2. Gösterge Veri Modelleri                                          */
/* ------------------------------------------------------------------ */

// GOSTERGE_CUSTOM_HEADERS artık headers.ts dosyasında tanımlı
export { GOSTERGE_CUSTOM_HEADERS } from "./headers"

export type UUID = string

export interface GostergeTask {
	id: UUID
	title: string
	description: string
	repoUrl: string
	branch: string
	baseBranch?: string // NEW: base branch for the task
	priority?: "low" | "medium" | "high" | "urgent"
	estimatedTime?: number // dakika
	tags?: string[]
	jiraTicket?: string
	assignee?: string
}

export interface TaskProgress {
	taskId: UUID
	percent: number
	message: string
	timestamp: number
	isError?: boolean
	errorMessage?: string
	details?: {
		filesChanged?: number
		testsRun?: number
		testsPassed?: number
		linesAdded?: number
		linesRemoved?: number
	}
}

export interface TaskResult {
	taskId: UUID
	branch: string
	commitHash?: string
	pullRequestUrl?: string
	stats?: {
		duration: number // ms
		filesChanged: number
		linesAdded: number
		linesRemoved: number
	}
}

export interface TaskFailure {
	taskId: UUID
	reason: string
	errorType?: "timeout" | "git" | "cline" | "api" | "unknown" | "internal" // Add "internal"
	stack?: string
	recoverable?: boolean
}

/* ------------------------------------------------------------------ */
/* 3. Konfigürasyon                                                    */
/* ------------------------------------------------------------------ */

interface GostergeConfig {
	endpoint: string
	token: string
	pollInterval: number
	taskTimeout: number
	maxRetries: number
	cleanWorkspace: boolean
	autoCommit: boolean
	branchPrefix: string
	commitPrefix: string
	enableHealthCheck: boolean
	healthCheckInterval: number
	logLevel?: "debug" | "info" | "warn" | "error" // Added
	retryBaseDelay: number // Added
	/** Cline’dan mesaj gelmezse iptal süresi (ms) */
	stallTimeout: number
	/** Yeni: mock yerine gerçek API kullanımı için anahtarlar */
	useMockBackend?: boolean
	defaultRepoUrl?: string
	defaultBaseBranch?: string
}

function loadConfig(context: vscode.ExtensionContext): GostergeConfig {
	const cfg = vscode.workspace.getConfiguration("gosterge")

	// Artık gerçek endpoint varsayılanı localhost
	const endpoint = cfg.get<string>("endpoint") ?? "http://localhost:5203/api"
	const token = cfg.get<string>("token") ?? ""

	return {
		endpoint,
		token,
		pollInterval: cfg.get<number>("pollInterval") ?? 60_000,
		taskTimeout: cfg.get<number>("taskTimeout") ?? 600_000, // 10 dakika
		maxRetries: cfg.get<number>("maxRetries") ?? 3,
		cleanWorkspace: cfg.get<boolean>("cleanWorkspace") ?? true,
		autoCommit: cfg.get<boolean>("autoCommit") ?? true,
		branchPrefix: cfg.get<string>("branchPrefix") ?? "gosterge/",
		commitPrefix: cfg.get<string>("commitPrefix") ?? "feat: ",
		enableHealthCheck: cfg.get<boolean>("enableHealthCheck") ?? true,
		healthCheckInterval: cfg.get<number>("healthCheckInterval") ?? 60_000,
		logLevel: cfg.get<"debug" | "info" | "warn" | "error">("logLevel"), // Added
		retryBaseDelay: cfg.get<number>("retryBaseDelay") ?? 5000, // Added
		stallTimeout: cfg.get<number>("stallTimeout") ?? 120_000,
		useMockBackend: cfg.get<boolean>("useMockBackend") ?? false,
		defaultRepoUrl: cfg.get<string>("defaultRepoUrl") ?? undefined,
		defaultBaseBranch: cfg.get<string>("defaultBaseBranch") ?? undefined,
	}
}

/* ------------------------------------------------------------------ */
/* 4. REST API İstemcisi                                                */
/* ------------------------------------------------------------------ */

import { mockAPI } from "./mock-api"
import { execSync } from "child_process"

/* Backend soyutlaması: mock ve gerçek aynı imzayı uygular */
type BackendApi = {
	getNextTask(): Promise<{ task: GostergeTask | null; status: number }>
	updateProgress(taskId: string, progress: Omit<TaskProgress, "taskId" | "timestamp">): Promise<{ status: number }>
	completeTask(taskId: string, result: Omit<TaskResult, "taskId">): Promise<{ status: number }>
	failTask(taskId: string, failure: Omit<TaskFailure, "taskId">): Promise<{ status: number }>
	health(): Promise<{ ok: boolean; status: number }>
}

/* Mock API'yi adaptörle aynı yüzeye getiriyoruz */
class MockBackendAdapter implements BackendApi {
	async getNextTask() {
		return mockAPI.getNextTask()
	}
	async updateProgress(taskId: string, progress: Omit<TaskProgress, "taskId" | "timestamp">) {
		return mockAPI.updateProgress(taskId, progress)
	}
	async completeTask(taskId: string, result: Omit<TaskResult, "taskId">) {
		return mockAPI.completeTask(taskId, result)
	}
	async failTask(taskId: string, failure: Omit<TaskFailure, "taskId">) {
		return mockAPI.failTask(taskId, failure)
	}
	async health() {
		return mockAPI.health()
	}
}

class TaskService {
	private retryCount = new Map<UUID, number>()
	private api: BackendApi

	constructor(
		private config: GostergeConfig,
		private logger: Logger,
		private storage: vscode.Memento,
	) {
		this.api = config.useMockBackend ? new MockBackendAdapter() : new IssueControllerAPI(config.endpoint, logger, storage)
	}

	async next(): Promise<GostergeTask | null> {
		const { task, status } = await this.api.getNextTask()
		if (status === 204) return null
		return task
	}

	async progress(taskId: UUID, progress: Omit<TaskProgress, "taskId" | "timestamp">): Promise<void> {
		// Network hatalarını handle et - retry mekanizması ile
		let lastError: Error | null = null
		const maxRetries = 3
		const retryDelay = 1000 // 1 saniye

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				await this.api.updateProgress(taskId, progress)
				return // Başarılı
			} catch (error: any) {
				lastError = error
				const isNetworkError =
					error?.message?.includes("fetch") ||
					error?.message?.includes("network") ||
					error?.message?.includes("ECONNREFUSED") ||
					error?.message?.includes("ETIMEDOUT") ||
					error?.kind === "api"

				if (isNetworkError && attempt < maxRetries - 1) {
					// Network hatası ve retry yapılabilir
					this.logger.warn(
						`Progress bildirimi başarısız (attempt ${attempt + 1}/${maxRetries}), ${retryDelay}ms sonra tekrar deneniyor...`,
					)
					await delay(retryDelay * (attempt + 1)) // Exponential backoff
					continue
				}
				// Network hatası değil veya max retry aşıldı
				throw error
			}
		}

		// Tüm retry'lar başarısız oldu
		if (lastError) {
			throw lastError
		}
	}

	async complete(taskId: UUID, result: Omit<TaskResult, "taskId">): Promise<void> {
		await this.api.completeTask(taskId, result)
	}

	async fail(taskId: UUID, failure: Omit<TaskFailure, "taskId">): Promise<void> {
		await this.api.failTask(taskId, failure)
	}

	async health(): Promise<boolean> {
		const { ok } = await this.api.health()
		return ok
	}

	shouldRetry(taskId: UUID): boolean {
		const count = this.retryCount.get(taskId) || 0
		return count < this.config.maxRetries
	}

	incrementRetry(taskId: UUID): number {
		const c = (this.retryCount.get(taskId) ?? 0) + 1
		this.retryCount.set(taskId, c)
		return c
	}

	resetRetry(taskId: UUID): void {
		this.retryCount.delete(taskId)
	}
}

/* ------------------------------------------------------------------ */
/* 5. Git Servisi - Gelişmiş Özellikler                                */
/* ------------------------------------------------------------------ */

class GitService {
	private api!: GitAPI
	private repo!: Repository
	private currentRepoUrl: string | undefined // Added to track the current repo URL

	private constructor(
		private readonly config: GostergeConfig,
		private readonly logger: Logger,
	) {}

	static async create(config: GostergeConfig, logger: Logger): Promise<GitService> {
		const svc = new GitService(config, logger)
		await svc.init()
		return svc
	}

	private async runGit<T>(action: () => Promise<T>, ctx: string): Promise<T> {
		this.logger.debug(`git-step: ${ctx}`)
		try {
			return await action()
		} catch (err: any) {
			const msg = err?.stderr?.toString?.() ?? err?.message ?? String(err)
			throw new GostergeError(`Git failed in ${ctx}: ${msg}`, "git")
		}
	}

	private async init(): Promise<void> {
		const gitExt =
			vscode.extensions.getExtension<GitExtension>("vscode.git") ??
			vscode.extensions.getExtension<GitExtension>("vscode.git-base")

		if (!gitExt) {
			throw new GostergeError("Git uzantısı bulunamadı (vscode.git)", "git")
		}

		await this.runGit(() => Promise.resolve(gitExt.activate()), "gitExtensionActivate") // Fixed Thenable to Promise
		this.api = gitExt.exports.getAPI(1)

		// Wait for Git repositories to be discovered
		for (let i = 0; i < 10 && this.api.repositories.length === 0; i++) {
			this.logger.info(`Git deposu bekleniyor... Deneme ${i + 1}/10`)
			await delay(1000)
		}

		if (this.api.repositories.length === 0) {
			throw new GostergeError("Çalışma alanında git deposu bulunamadı veya zaman aşımına uğradı.", "git")
		}

		// Initialize with the first repo, setActiveRepository will change it if needed
		this.repo = this.api.repositories[0]
		this.logger.info("✅ Git deposu bulundu: " + this.repo.rootUri.fsPath)
	}

	async setActiveRepository(repoUrl: string): Promise<void> {
		if (this.currentRepoUrl === repoUrl) {
			this.logger.debug(`Repo already active for URL: ${repoUrl}`)
			return
		}

		const targetRepo = this.api.repositories.find((r) =>
			r.state.remotes.some((remote) => remote.fetchUrl === repoUrl || remote.pushUrl === repoUrl),
		)

		if (targetRepo) {
			this.repo = targetRepo
			this.currentRepoUrl = repoUrl
			this.logger.info(`Active Git repo set to: ${this.repo.rootUri.fsPath} for URL: ${repoUrl}`)
		} else {
			this.logger.warn(`No Git repo found for URL: ${repoUrl}. Using default: ${this.repo.rootUri.fsPath}`)
			// Optionally throw an error or handle this case more robustly
		}
	}

	async ensureCleanWorkspace(): Promise<void> {
		this.logger.debug("🔍 checking workspace cleanliness...")
		const changes = this.repo.state.workingTreeChanges
		if (changes.length > 0) {
			if (this.config.cleanWorkspace) {
				this.logger.warn("⚠️ Değişiklikler tespit edildi, temizleniyor...")

				await this.runGit(() => {
					this.repo.inputBox.value = "" // Önce stage'deki değişiklikleri unstage yap
					return Promise.resolve()
				}, "unstageChanges")

				for (const change of changes) {
					try {
						await this.runGit(() => this.repo.clean([change.uri.fsPath]), `cleanFile:${change.uri.fsPath}`)
					} catch (error: any) {
						this.logger.error(`Dosya temizlenemedi: ${change.uri.fsPath} - ${error.message}`)
					}
				}
				this.logger.debug(`✅ workspace clean (${changes.length} changes cleaned)`)
			} else {
				throw new GostergeError("Çalışma alanında kaydedilmemiş değişiklikler var!", "git")
			}
		} else {
			this.logger.debug("✅ workspace clean (0 changes)")
		}
	}

	async ensureRemote(url: string): Promise<string> {
		// Mevcut remote'ları kontrol et
		const existing = this.repo.state.remotes.find((r: Remote) => r.fetchUrl === url || r.pushUrl === url)

		if (existing) {
			this.logger.debug(`🌐 remote reuse: ${existing.name} url=${url}`)
			return existing.name
		}

		// Remote ismi oluştur
		// Use a dynamic name based on the URL to avoid conflicts with multiple repos
		const remoteName = `gosterge-${Buffer.from(url)
			.toString("base64")
			.replace(/[^a-zA-Z0-9]/g, "")
			.slice(0, 8)}`

		await this.runGit(() => this.repo.addRemote(remoteName, url), `addRemote:${remoteName}`)
		await this.runGit(() => this.repo.fetch(remoteName), `fetchRemote:${remoteName}`)
		this.logger.debug(`🌐 remote add: ${remoteName} url=${url}`)
		return remoteName
	}

	async switchToBranch(branch: string, baseBranch: string): Promise<void> {
		const fullBranchName = `${this.config.branchPrefix}${branch}`
		this.logger.debug(`🌿 git checkout ${baseBranch} → create ${fullBranchName}`)

		// Önce base branch'e geç
		let actualBaseBranch = baseBranch
		try {
			await this.runGit(() => this.repo.checkout(baseBranch), `checkout:${baseBranch}`)
			await this.runGit(() => this.repo.pull(), `pull:${baseBranch}`)
		} catch (error: any) {
			// Fallback to current HEAD if configured baseBranch fails
			const headBranch = this.repo.state.HEAD?.name
			actualBaseBranch = headBranch || baseBranch // Use HEAD or original baseBranch if HEAD is also null
			this.logger.warn(
				`Base branch (${baseBranch}) bulunamadı veya pull hatası: ${error.message}. Mevcut branch (${actualBaseBranch}) kullanılıyor.`,
			)
			await this.runGit(() => this.repo.checkout(actualBaseBranch), `checkoutFallback:${actualBaseBranch}`)
		}

		// Fetch latest refs to ensure `exists` check is accurate
		await this.runGit(() => this.repo.fetch(), "fetchRefs")

		// 1️⃣ Varsayılan exist‑kontrolü (hala dursun)
		const exists = this.repo.state.refs.some((r) => r.name === fullBranchName || r.name === `refs/heads/${fullBranchName}`)
		if (exists) {
			await this.checkoutAndPull(fullBranchName)
			return
		}

		// 2️⃣ Branch yarat ─ ama 'already exists' hatasını YAKALA
		try {
			await this.runGit(() => this.repo.createBranch(fullBranchName, true), `createBranch:${fullBranchName}`)
		} catch (err: any) {
			const msg = err?.message || ""
			if (/already exists/i.test(msg) || /a branch named/i.test(msg)) {
				this.logger.warn(`Branch '${fullBranchName}' zaten var → checkout ediliyor.`)
				await this.checkoutAndPull(fullBranchName)
				return // ✔️ Kurtarıldı
			}
			throw err // 🚨 Başka bir Git hatasıysa yükselt
		}
	}

	/* Küçük yardımcı */
	private async checkoutAndPull(branch: string) {
		await this.runGit(() => this.repo.checkout(branch), `checkoutExisting:${branch}`)
		await this.runGit(() => this.repo.pull(), `pullExisting:${branch}`)
	}

	async commitChanges(message: string, stats?: any): Promise<string | undefined> {
		// 1) Durumu tazele
		await this.runGit(() => this.repo.status(), "refreshStatus")

		// 2) Henüz commitlenmemiş tüm değişiklikler
		const pending = [...this.repo.state.workingTreeChanges, ...this.repo.state.indexChanges]
		if (!pending.length) {
			this.logger.info("Commit yapılacak değişiklik yok")
			return undefined
		}

		/* ---------- DÜZELTME BAŞI ---------- */
		// 3) Stage edilecek dosyaların tam yollarını (string) çıkar
		const toStagePaths = this.repo.state.workingTreeChanges.map((c) => c.uri.fsPath) // string[]

		if (toStagePaths.length) {
			// DİREKT *DİZİ* OLARAK GÖNDER → git‑extension e.map kullanır
			await this.runGit(() => this.repo.add(toStagePaths), "stageChanges")
		}
		/* ----------  DÜZELTME SONU ---------- */

		// 4) Commit
		const fullMessage = this.buildCommitMessage(message, stats)
		await this.runGit(() => this.repo.commit(fullMessage), "commitChanges")

		return this.repo.state.HEAD?.commit
	}

	private buildCommitMessage(message: string, stats?: any): string {
		let fullMessage = `${this.config.commitPrefix}${message}`

		if (stats) {
			fullMessage += "\n\n"
			fullMessage += "Changes:\n"
			if (stats.filesChanged) fullMessage += `- Files changed: ${stats.filesChanged}\n`
			if (stats.linesAdded) fullMessage += `- Lines added: ${stats.linesAdded}\n`
			if (stats.linesRemoved) fullMessage += `- Lines removed: ${stats.linesRemoved}\n`
			if (stats.testsRun) fullMessage += `- Tests run: ${stats.testsRun}\n`
			if (stats.testsPassed) fullMessage += `- Tests passed: ${stats.testsPassed}\n`
		}

		return fullMessage
	}

	async push(remote: string, branch: string): Promise<void> {
		const fullBranchName = `${this.config.branchPrefix}${branch}`
		await this.runGit(() => this.repo.push(remote, fullBranchName, true), `push:${fullBranchName}`)
	}

	getCurrentBranch(): string | undefined {
		return this.repo.state.HEAD?.name
	}

	async getChangeStats(): Promise<any> {
		try {
			const output = execSync("git diff --shortstat", { cwd: vscode.workspace.workspaceFolders![0].uri.fsPath }).toString()
			const match = output.match(/(\d+) files changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)

			if (match) {
				const filesChanged = parseInt(match[1]) || 0
				const insertions = parseInt(match[2]) || 0
				const deletions = parseInt(match[3]) || 0

				return {
					filesChanged: filesChanged,
					linesAdded: insertions,
					linesRemoved: deletions,
				}
			}
		} catch (error: any) {
			this.logger.error(`Failed to get git change stats: ${error.message}`)
		}

		// Fallback if git command fails or output is not as expected
		const changes = this.repo.state.workingTreeChanges
		return {
			filesChanged: changes.length,
			linesAdded: 0,
			linesRemoved: 0,
		}
	}
}

/* ------------------------------------------------------------------ */
/* 6. Cline Controller Entegrasyonu                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7. Task Yöneticisi - Ana Orkestrasyon                               */
/* ------------------------------------------------------------------ */

class TaskManager {
	private config: GostergeConfig
	private taskService: TaskService
	private gitService!: GitService // "!" çünkü init'te atanacak
	private cline: ClineIntegration
	private logger: Logger // Change to logger

	private busy = false
	private currentTask: GostergeTask | null = null
	private taskStartTime = 0
	private healthCheckInterval: NodeJS.Timeout | null = null
	private abortController: AbortController | null = null
	private lastProgressUpdate = 0
	private lastProgressPercent: number = 0

	private queue = Promise.resolve() // Add queue

	private getTaskLogPrefix(): string {
		return this.currentTask ? `[task:${this.currentTask.id.slice(0, 8)}] ` : ""
	}

	constructor(
		config: GostergeConfig,
		logger: Logger,
		controller: Controller,
		private storage: vscode.Memento,
	) {
		this.config = config
		this.logger = logger // Assign logger
		this.taskService = new TaskService(config, logger, this.storage)
		this.cline = new ClineIntegration(controller, logger) // Pass logger
	}

	async initialize(context: vscode.ExtensionContext): Promise<void> {
		this.gitService = await GitService.create(this.config, this.logger) // GitService'i asenkron oluştur, pass logger
		// Health check başlat
		if (this.config.enableHealthCheck) {
			this.startHealthCheck()
		}
	}

	private startHealthCheck(): void {
		this.healthCheckInterval = setInterval(async () => {
			const healthy = await this.taskService.health()
			if (healthy) {
				this.logger.debug(`${this.getTaskLogPrefix()}backend health: ok`)
			} else {
				this.logger.warn(`${this.getTaskLogPrefix()}⚠️ Backend sağlık kontrolü başarısız!`)
			}
		}, this.config.healthCheckInterval)
	}

	async enqueue(fn: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(fn, fn) // hata olsa da kuyruğu kırma
		return this.queue
	}

	async processNextTask(): Promise<void> {
		// Wrap the internal processing in the queue
		await this.enqueue(() => this.processNextTaskInternal())
	}

	private async processNextTaskInternal(): Promise<void> {
		// Renamed from processNextTask
		if (this.busy) {
			this.logger.info("⏭️ Başka bir görev işleniyor, atlanıyor...") // Use logger
			return
		}

		try {
			// Backend'den görev al
			const task = await this.taskService.next()
			if (!task) {
				return // Kuyrukta görev yok
			}

			this.busy = true
			this.currentTask = task
			this.taskStartTime = Date.now()
			this.abortController = new AbortController()

			const retryCount = this.taskService["retryCount"].get(task.id) || 0
			const taskPrefix = retryCount > 0 ? `🔄 YENİDEN DENEYİŞ #${retryCount} ` : `🟢 YENİ GÖREV`

			this.logger.info(`${this.getTaskLogPrefix()}\n${"=".repeat(60)}`)
			this.logger.info(`${this.getTaskLogPrefix()}${taskPrefix}: ${task.title}`)
			this.logger.info(`${this.getTaskLogPrefix()}📋 ID: ${task.id}`)
			this.logger.info(`${this.getTaskLogPrefix()}🔗 JIRA: ${task.jiraTicket || "N/A"}`)
			this.logger.info(`${this.getTaskLogPrefix()}${"=".repeat(60)}\n`)

			// İlk progress bildirimi
			await this.taskService.progress(task.id, {
				percent: 0,
				message: "Görev başlatılıyor...",
			})

			// Git ortamını hazırla
			await this.prepareGitEnvironment(task)
			this.logger.info(`${this.getTaskLogPrefix()}🔧 Git ortamı hazırlanıyor...`)

			// Cline'a görevi ver
			await this.executeClineTask(task)

			// Sonuçları commit et ve push'la
			await this.finalizeTask(task)

			this.logger.info(`✅ Görev başarıyla tamamlandı: ${task.id}`)
		} catch (error: any) {
			await this.handleTaskError(error)
		} finally {
			this.busy = false
			this.currentTask = null
			this.abortController = null
		}
	}

	private async prepareGitEnvironment(task: GostergeTask): Promise<void> {
		// Progress: %10
		await this.taskService.progress(task.id, {
			percent: 10,
			message: "Git workspace temizleniyor...",
		})

		// Set the active repository based on task's repoUrl
		await this.gitService.setActiveRepository(task.repoUrl)

		// Workspace'i temizle
		await this.gitService.ensureCleanWorkspace()

		// Remote'u ekle/güncelle
		const remote = await this.gitService.ensureRemote(task.repoUrl)
		this.logger.info(`${this.getTaskLogPrefix()}📡 Remote ayarlandı: ${remote}`)

		// Progress: %20
		await this.taskService.progress(task.id, {
			percent: 20,
			message: "Yeni branch oluşturuluyor...",
		})

		// Branch'e geç
		await this.gitService.switchToBranch(task.branch, task.baseBranch!) // baseBranch is now guaranteed by the API contract
		this.logger.info(`${this.getTaskLogPrefix()}🌿 Branch oluşturuldu: ${this.config.branchPrefix}${task.branch}`)
	}

	private async executeClineTask(task: GostergeTask): Promise<void> {
		this.logger.info(`${this.getTaskLogPrefix()}🤖 Cline görevi işliyor...`)

		// Progress: %30
		await this.taskService.progress(task.id, {
			percent: 30,
			message: "Cline görevi analiz ediyor...",
		})

		// Create a watchdog to monitor Cline's progress
		const watchdog = new Watchdog(this.cline, this.config, this.logger)

		// Watchdog hata callback'i kaydet
		watchdog.setErrorCallback(async (error: GostergeError) => {
			// Watchdog'dan hata geldiğinde progress'e bildir
			this.logger.error(`${this.getTaskLogPrefix()}🚨 Watchdog hatası: ${error.message}`)
			await this.taskService.progress(task.id, {
				percent: this.lastProgressPercent || 50,
				message: `Hata tespit edildi: ${error.message}`,
				isError: true,
				errorMessage: error.message,
			})
		})

		// Watchdog completion check callback'i kaydet
		// completion_result mesajı gelmese bile görevin tamamlanmış olup olmadığını kontrol eder
		watchdog.setCompletionCheckCallback(async (): Promise<boolean> => {
			try {
				// 1. Cline zaten tamamlandı mı kontrol et
				if (this.cline.isTaskComplete()) {
					this.logger.debug(`${this.getTaskLogPrefix()}✅ Cline görevi tamamlandı (isTaskComplete)`)
					return true
				}

				// 2. Git değişiklikleri var mı kontrol et
				const stats = await this.gitService.getChangeStats()
				const hasChanges = stats.filesChanged > 0 || stats.linesAdded > 0 || stats.linesRemoved > 0

				if (!hasChanges) {
					// Değişiklik yok, henüz tamamlanmamış olabilir
					return false
				}

				// 3. Son aktiviteden ne kadar süre geçti?
				const timeSinceLastActivity = Date.now() - (this.lastProgressUpdate || Date.now())
				const quietPeriod = 60000 // 1 dakika

				// 4. Cline state kontrolü (streaming durdu mu?)
				const clineState: any = this.cline["controller"]?.task?.taskState
				const isStreaming = clineState?.isStreaming === true

				// Değişiklik var + uzun süre sessizlik + streaming durdu → muhtemelen tamamlandı
				if (hasChanges && timeSinceLastActivity > quietPeriod && !isStreaming) {
					this.logger.info(
						`${this.getTaskLogPrefix()}✅ Implicit completion detected: ${stats.filesChanged} files changed, ${Math.round(timeSinceLastActivity / 1000)}s quiet, streaming stopped`,
					)
					return true
				}

				return false
			} catch (error: any) {
				// Completion check hatası, false döndür (görev devam ediyor kabul et)
				this.logger.debug(`${this.getTaskLogPrefix()}⚠️ Completion check error: ${error.message}`)
				return false
			}
		})

		// Cline mesajlarını dinle (bu handler Watchdog'dan da mesaj alacak)
		const messageDisposable = this.cline.onMessage(async (msg: ClineMessage) => {
			await this.handleClineMessage(task.id, msg)
		})

		// Periyodik olarak Cline'dan mesajları çek ve Watchdog'a ilet
		const pollIntervalId = setInterval(() => {
			this.cline.pollAndDispatchMessages()
		}, this.config.pollInterval) // Use configured pollInterval

		await this.taskService.progress(task.id, {
			percent: 50,
			message: "Cline görevi işliyor...",
		})

		try {
			// Görevi başlat
			await this.cline.startTask(task)

			// Watchdog'ın sonuçlanmasını bekle
			// completionPromise resolve olursa → başarılı, catch'e düşmez
			// Hata durumlarında → catch'e düşer ve error callback çağrılır
			await watchdog.waitForResult(this.abortController!.signal)
		} catch (error) {
			// Watchdog'dan gelen hatalar burada yakalanır
			// Error callback zaten çağrılmış olacak, burada sadece fırlatıyoruz
			throw error
		} finally {
			messageDisposable.dispose()
			clearInterval(pollIntervalId) // Stop polling
			watchdog.dispose() // Ensure watchdog resources are cleaned up
		}
	}

	private async handleClineMessage(taskId: UUID, message: any): Promise<void> {
		// 🤖 Otomatik modda soru sorulduğunda veya buton çıktığında otomatik cevap gönder
		// Tüm buton tiplerini kontrol et: ask, primaryButton, secondaryButton, vb.
		const hasButton =
			message.ask ||
			message.primaryButton ||
			message.secondaryButton ||
			message.type === "button" ||
			(message.text && /process anyway|continue|proceed|yes|no/i.test(message.text))

		if (hasButton) {
			const askType = message.ask || message.type || "unknown_button"
			this.logger.info(`${this.getTaskLogPrefix()}❓ Cline buton/soru tespit edildi: ${askType}`)

			try {
				// Otomatik cevap gönder
				if (message.ask) {
					await this.cline.sendAutoResponse(askType, message.text)
				} else {
					// Ask tipi değilse, genel bir cevap gönder
					await this.cline.sendAutoResponse("followup", "Devam et, en iyi kararı sen ver.")
				}
				this.logger.info(`${this.getTaskLogPrefix()}✅ Otomatik cevap gönderildi: ${askType}`)

				// Progress güncelle (soru-cevap döngüsü)
				// await this.taskService.progress(taskId, {
				// 	percent: this.lastProgressPercent, // Mevcut progress'i koru
				// 	message: `Cline soru sordu, otomatik cevap verildi: ${askType}`,
				// })

				// Mesajı işlemeye devam et (hata fırlatma)
				return
			} catch (error: any) {
				this.logger.error(`${this.getTaskLogPrefix()}❌ Otomatik cevap gönderilemedi: ${error.message}`)
				// Hata durumunda eski davranışa geri dön (hata fırlat)
				throw new GostergeError(`Cline interaktif soru sordu ve otomatik cevap gönderilemedi: ${askType}`, "cline")
			}
		}

		// 🚨 Cline hata mesajlarını tespit et
		if (this.isErrorMessage(message)) {
			const errorText = this.extractErrorMessage(message)
			const errorType = this.categorizeError(errorText)

			this.logger.error(`${this.getTaskLogPrefix()}❌ Cline hatası: ${errorType} - ${errorText}`)

			// Hata mesajını throw et ki handleTaskError retry mekanizmasını tetiklesin
			throw new GostergeError(`Cline hatası: ${errorText}`, "cline")
		}

		// Progress hesapla
		// const percent = this.calculateProgress(message)
		// const progressMessage = this.getProgressMessage(message)

		// Backend'e bildir
		// await this.taskService.progress(taskId, {
		// 	percent,
		// 	message: progressMessage,
		// 	details: this.extractProgressDetails(message),
		// })

		// Log'a yaz
		// this.logger.info(`${this.getTaskLogPrefix()}📊 [%${percent}] ${progressMessage}`)
	}

	// private calculateProgress(message: any): number {
	// 	// Mesaj tipine göre progress hesapla
	// 	if (message.say === "completion_result" || message.ask === "completion_result") {
	// 		return 90
	// 	} else if (message.say === "api_req_started") {
	// 		return 40
	// 	} else if (message.say === "api_req_finished") {
	// 		return 50
	// 	} else if (message.say === "tool_use") {
	// 		return 60
	// 	} else if (message.type === "file_edit") {
	// 		return 70
	// 	} else if (message.type === "test_run") {
	// 		return 80
	// 	} else if (message.type === "waiting") {
	// 		// For "waiting" messages, compare with previous progress
	// 		return Math.max(this.lastProgressUpdate, 35) // Ensure progress doesn't go backward
	// 	}

	// 	const calculatedPercent = 35 // Default
	// 	if (message.type === "waiting") {
	// 		this.lastProgressUpdate = Date.now()
	// 		this.lastProgressPercent = Math.max(this.lastProgressPercent, 35)
	// 		return this.lastProgressPercent
	// 	}

	// 	this.lastProgressPercent = calculatedPercent
	// 	this.lastProgressUpdate = Date.now()
	// 	return calculatedPercent
	// }

	// private getProgressMessage(message: any): string {
	// 	//if (message.text) return message.text

	// 	if (message.say == "api_req_started") return "Görev Prompu Hazırlanıyor ve AI İşlemleri"
	// 	if (message.say == "api_req_finished") return "AI işlemleri Tamamlanıyor."

	// 	// Türkçe eşleştirme sözlüğü
	// 	const TR: Record<string, string> = {
	// 		api_req_started: "API isteği başlatıldı",
	// 		api_req_finished: "API isteği tamamlandı",
	// 		tool_use: "Araç (tool) kullanılıyor",
	// 		completion_result: "Tamamlama sonucu hazır",
	// 		file_edit: "Dosya düzenleniyor",
	// 		test_run: "Testler çalıştırılıyor",
	// 		waiting: "Bekleniyor",
	// 	}

	// 	// Cline'ın 'say' alanı için Türkçe karşılık varsa onu kullan
	// 	if (message.say && TR[message.say]) return `Cline: ${TR[message.say]}`
	// 	if (message.say) return `Cline: ${message.say}`

	// 	// (Normalde 'ask' yakalanıp hata atılıyor; yine de düşerse)
	// 	if (message.ask) return `Cline soruyor: ${message.ask}`

	// 	// Tip için Türkçe karşılık varsa onu kullan
	// 	if (message.type && TR[message.type]) return `İşlem: ${TR[message.type]}`
	// 	if (message.type) return `İşlem: ${message.type}`

	// 	return "Cline çalışıyor..."
	// }

	/**
	 * Mesajın hata mesajı olup olmadığını kontrol eder
	 */
	private isErrorMessage(message: any): boolean {
		// Cline'ın error mesajları genellikle şu şekillerde gelir:
		// - message.say === "error"
		// - message.type === "error"
		// - message.text içinde "Error" veya "error" kelimesi
		// - "Writing File" gibi spesifik hata mesajları

		if (message.say === "error" || message.type === "error") {
			return true
		}

		if (message.text) {
			const lowerText = message.text.toLowerCase()
			// Yaygın hata mesajlarını kontrol et
			if (
				lowerText.includes("error") ||
				lowerText.includes("writing file") ||
				lowerText.includes("failed") ||
				lowerText.includes("tool execution failed")
			) {
				return true
			}
		}

		return false
	}

	/**
	 * Hata mesajından hata metnini çıkarır
	 */
	private extractErrorMessage(message: any): string {
		if (message.text) {
			return message.text
		}
		if (message.say) {
			return message.say
		}
		if (message.type) {
			return `Error type: ${message.type}`
		}
		return "Bilinmeyen hata"
	}

	/**
	 * Hata tipini kategorize eder
	 */
	private categorizeError(errorText: string): string {
		const lower = errorText.toLowerCase()

		if (lower.includes("writing file") || lower.includes("write_to_file")) {
			return "file_write_error"
		}
		if (lower.includes("permission") || lower.includes("access denied")) {
			return "permission_error"
		}
		if (lower.includes("timeout") || lower.includes("timed out")) {
			return "timeout_error"
		}
		if (lower.includes("network") || lower.includes("connection")) {
			return "network_error"
		}

		return "unknown_error"
	}

	private extractProgressDetails(message: any): any {
		// Mesajdan detay bilgileri çıkar
		const details: any = {}

		if (message.filesChanged) details.filesChanged = message.filesChanged
		if (message.testsRun) details.testsRun = message.testsRun
		if (message.testsPassed) details.testsPassed = message.testsPassed

		return Object.keys(details).length > 0 ? details : undefined
	}

	private async finalizeTask(task: GostergeTask): Promise<void> {
		this.logger.info(`${this.getTaskLogPrefix()}📦 Görev sonuçları işleniyor...`)

		// Progress: %95
		await this.taskService.progress(task.id, {
			percent: 95,
			message: "Değişiklikler commit ediliyor...",
		})

		// Değişiklik istatistiklerini al
		const stats = await this.gitService.getChangeStats()

		// Commit yap
		const commitHash = await this.gitService.commitChanges(task.title, stats)

		if (!commitHash) {
			throw new GostergeError("Commit yapılacak değişiklik bulunamadı!", "git")
		}

		// Progress: %98
		await this.taskService.progress(task.id, {
			percent: 98,
			message: "Değişiklikler push ediliyor...",
		})

		// Push yap
		const remoteName = await this.gitService.ensureRemote(task.repoUrl)
		await this.gitService.push(remoteName, task.branch)

		// Progress: %100
		await this.taskService.progress(task.id, {
			percent: 100,
			message: "Görev tamamlandı!",
		})

		// Görevi tamamla
		const duration = Date.now() - this.taskStartTime
		await this.taskService.complete(task.id, {
			branch: `${this.config.branchPrefix}${task.branch}`,
			commitHash,
			stats: {
				duration,
				...stats,
			},
		})

		// Başarı özeti
		this.logger.info(`${this.getTaskLogPrefix()}\n${"=".repeat(60)}`)
		this.logger.info(`${this.getTaskLogPrefix()}✅ GÖREV TAMAMLANDI`)
		this.logger.info(`${this.getTaskLogPrefix()}📌 Commit: ${commitHash.substring(0, 8)}`)
		this.logger.info(`${this.getTaskLogPrefix()}🌿 Branch: ${this.config.branchPrefix}${task.branch}`)
		this.logger.info(`${this.getTaskLogPrefix()}⏱️ Süre: ${Math.round(duration / 1000)} saniye`)
		this.logger.info(`${this.getTaskLogPrefix()}📊 Değişiklikler: ${stats.filesChanged} dosya`)
		this.logger.info(`${this.getTaskLogPrefix()}${"=".repeat(60)}\n`)
	}

	private async handleTaskError(err: unknown): Promise<void> {
		// Change error type to unknown
		const task = this.currentTask
		if (!task) return

		const e = err instanceof GostergeError ? err : new GostergeError((err as Error).message, "internal")

		// (Opsiyonel) daha görünür log
		if (e.kind === "cline" && /sessiz kaldı/.test(e.message)) {
			this.logger.warn(`${this.getTaskLogPrefix()}⌛ Sessizlik zaman aşımı tetiklendi`)
		}
		this.logger.error(`${this.getTaskLogPrefix()}${e.kind.toUpperCase()} → ${e.message}`)
		if (e.stack) {
			this.logger.error(`${this.getTaskLogPrefix()}Stack: ${e.stack}`)
		}

		// Hata tipini belirle
		const errorType: TaskFailure["errorType"] = e.kind // Use GostergeError kind directly
		const recoverable = ["git", "api", "cline", "timeout"].includes(e.kind) // Use GostergeError kind

		// Retry kontrolü
		if (recoverable && this.taskService.shouldRetry(task.id)) {
			this.taskService.incrementRetry(task.id)
			const retryCount = this.taskService["retryCount"].get(task.id) || 1

			const n = retryCount
			const backoff = Math.min(2 ** n, 32) * this.config.retryBaseDelay // Use configured retryBaseDelay
			this.logger.warn(`${this.getTaskLogPrefix()}🔄 YENİDEN DENENİYOR #${n} in ${backoff / 1000}s (errorType=${e.kind})`)

			// Retry yapılacaksa progress'e bildir
			await this.taskService.progress(task.id, {
				percent: this.lastProgressPercent || 50,
				message: `Hata tespit edildi, yeniden deneniyor (#${n}): ${e.message}`,
				isError: true,
				errorMessage: e.message,
			})

			await delay(backoff)

			// Görevi sıfırla ve yeniden başlat
			this.busy = false
			await this.processNextTask()
			return
		}

		// Retry yapılmayacaksa progress'e hata bildir
		await this.taskService.progress(task.id, {
			percent: this.lastProgressPercent || 50,
			message: `Görev başarısız oldu: ${e.message}`,
			isError: true,
			errorMessage: e.message,
		})

		// Backend'e hata bildir
		await this.taskService.fail(task.id, {
			reason: e.message, // Use GostergeError message
			errorType,
			stack: e.stack, // Use GostergeError stack
			recoverable,
		})

		// Kullanıcıya hata mesajı göster
		const fullErrorMessage = `${this.getTaskLogPrefix()}${e.kind.toUpperCase()} → ${e.message}${e.stack ? `\nStack: ${e.stack}` : ""}`
		let userDisplayMessage = `Görev başarısız oldu: ${e.message}`

		if (e.kind === "git") {
			userDisplayMessage = `Git hatası: ${e.message}. Lütfen Git deponuzu kontrol edin.`
		}

		// Add stack details to user message if available and not already in main message
		if (e.stack && !userDisplayMessage.includes("Detaylar için Çıktı panelini kontrol edin.")) {
			userDisplayMessage += `\nDetaylar için Çıktı panelini kontrol edin.`
		}

		vscode.window.showErrorMessage(userDisplayMessage)

		// Retry sayacını sıfırla
		this.taskService.resetRetry(task.id)

		// Cline'ı durdur
		try {
			await this.cline.abortTask()
		} catch {
			// Ignore abort errors
		}
	}

	abort(): void {
		this.abortController?.abort() // Trigger abort signal
		this.cline.abortTask()
	}

	dispose(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval)
		}
		this.cline.dispose()
	}
}

/* ------------------------------------------------------------------ */
/* 8. Ana Başlatma Fonksiyonu                                          */
/* ------------------------------------------------------------------ */

import { checkGitBinary } from "./utils" // Import checkGitBinary
import { Logger } from "./logger"

let outputChannel: vscode.OutputChannel
let logger: Logger

export function initializeGosterge(
	context: vscode.ExtensionContext,
	controller: Controller, // Keep controller parameter here for now, as it's passed from extension.ts
): void {
	outputChannel = vscode.window.createOutputChannel("Cline")
	logger = new Logger(outputChannel) // Logger now reads level from config

	logger.info("🚀 Gösterge başlatılıyor...")
	logger.info("🚀 SEZERRRRR.")
	try {
		checkGitBinary() // Check for Git binary at startup
		// Konfigürasyonu yükle
		const config = loadConfig(context)
		logger.info(`⚙️ Endpoint: ${config.endpoint}`)
		logger.info(`⏱️ Poll Interval: ${config.pollInterval / 1000}s`)
		logger.info(`⏱️ Task Timeout: ${config.taskTimeout / 60000}m`)

		// Task manager oluştur
		const taskManager = new TaskManager(
			config,
			logger,
			controller,
			context.workspaceState, // storage: per-workspace
		)

		// Başlat
		taskManager
			.initialize(context)
			.then(() => {
				logger.info("✅ Gösterge başarıyla başlatıldı!")

				// Periyodik görev kontrolü
				const processTask = async () => {
					try {
						await taskManager.processNextTask() // Call the public method which uses enqueue
					} catch (error: any) {
						logger.error(`❌ Görev işleme hatası: ${error.message}`)
					}
				}

				// İlk kontrolü hemen yap
				processTask()

				// Periyodik kontrol başlat
				const intervalId = setInterval(processTask, config.pollInterval)

				// Cleanup
				context.subscriptions.push({
					dispose: () => {
						clearInterval(intervalId)
						taskManager.dispose()
						logger.info("👋 Gösterge kapatıldı")
					},
				})

				// Komutları kaydet
				context.subscriptions.push(
					vscode.commands.registerCommand("gosterge.checkNow", () => {
						logger.info("🔍 Manuel kontrol tetiklendi")
						processTask()
					}),
				)

				context.subscriptions.push(
					vscode.commands.registerCommand("gosterge.abort", () => {
						logger.info("🛑 Görev iptal ediliyor...")
						taskManager.abort()
					}),
				)

				// Removed: logger.show() is handled internally by Logger class for warnings/errors

				// --- Test Komutları (Mock API için) ---
				context.subscriptions.push(
					vscode.commands.registerCommand("gosterge.test.addSampleTask", async () => {
						const { addTestTask, resetMockAPI, simulateAPIFailure, simulateSlowAPI } = await import("./mock-api")
						resetMockAPI() // Her test görevi eklemede mock'u sıfırla
						addTestTask("Test Görevi 1: Login Formu", "Login formuna 'Beni Hatırla' özelliği ekle.")
						addTestTask("Test Görevi 2: Backend Optimizasyon", "Veritabanı sorgularını optimize et.")
						logger.info("✅ Mock test görevleri eklendi.")
						processTask() // Yeni görevleri kontrol et
					}),
				)

				context.subscriptions.push(
					vscode.commands.registerCommand("gosterge.test.simulateFailure", async () => {
						const { simulateAPIFailure } = await import("./mock-api")
						simulateAPIFailure()
						logger.warn("❌ Mock API hatası simüle ediliyor.")
					}),
				)

				context.subscriptions.push(
					vscode.commands.registerCommand("gosterge.test.simulateSlowAPI", async () => {
						const { simulateSlowAPI } = await import("./mock-api")
						simulateSlowAPI()
						logger.warn("⏳ Mock API yavaşlatılıyor.")
					}),
				)

				context.subscriptions.push(
					vscode.commands.registerCommand("gosterge.test.resetMockAPI", async () => {
						const { resetMockAPI } = await import("./mock-api")
						resetMockAPI()
						logger.info("🔄 Mock API sıfırlandı.")
					}),
				)
				// --- Test Komutları Sonu ---
			})
			.catch((error) => {
				logger.error(`❌ Başlatma hatası: ${error.message}`)
				vscode.window.showErrorMessage(`Gösterge başlatılamadı: ${error.message}`)
			})
	} catch (error: any) {
		logger.error(`❌ Kritik hata: ${error.message}`)
		vscode.window.showErrorMessage(`Gösterge kritik hata: ${error.message}`)
	}
}

/* ------------------------------------------------------------------ */
/* 9. Utility Fonksiyonlar                                              */
/* ------------------------------------------------------------------ */

export function deactivate(): void {
	// Extension kapatılırken çağrılır
	console.log("Gösterge deaktive ediliyor...")
}

export async function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
