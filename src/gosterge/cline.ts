import * as vscode from "vscode"
import { Controller } from "../core/controller"
import { Logger } from "./logger" // Assuming Logger is exported from logger.ts
import type { UUID, GostergeTask } from "./index" // Assuming UUID and GostergeTask are exported from index.ts

// Cline mesaj tipi
export interface ClineMessage {
	say?: string
	ask?: string
	type?: string
	text?: string
	filesChanged?: number
	testsRun?: number
	testsPassed?: number
}

export class ClineIntegration implements vscode.Disposable {
	private controller: Controller
	private logger: Logger

	private messageHandlers: ((msg: ClineMessage) => void)[] = []
	private lastPolledMessageCount = 0

	/** Şu anda izlenen görevin kimliği (null => aktif görev yok) */
	private activeTaskId: UUID | null = null

	/** Aktif görev için "tamamlandı" bayrağı */
	private completed = false

	/** Plan içeriğini saklamak için */
	private planContent: string = ""

	/** Plan tamamlandı mı? */
	private planCompleted: boolean = false

	constructor(controller: Controller, logger: Logger) {
		this.controller = controller
		this.logger = logger
	}

	/* ------------------------------------------------------------------ */
	/* Görev Yaşam Döngüsü                                                */
	/* ------------------------------------------------------------------ */

	/**
	 * Yeni bir görev başlatır ve Cline’a prompt gönderir.
	 *  - activeTaskId / completed bayraklarını sıfırlar
	 *  - abort flag’ini temizler
	 */
	async startTask(task: GostergeTask): Promise<void> {
		this.activeTaskId = task.id
		this.completed = false

		const prompt = this.buildTaskPrompt(task)

		await this.controller.initTask(prompt)

		// Eski bir abort bayrağı kalmış olabilir; temizleyelim
		if (this.controller.task?.taskState) {
			this.controller.task.taskState.abort = false
		}

		this.lastPolledMessageCount = 0
	}

	/**
	 * Registers a handler for Cline messages.
	 * The handler will be called whenever new messages are available from Cline.
	 * Returns a Disposable to unregister the handler.
	 */
	onMessage(handler: (msg: ClineMessage) => void): vscode.Disposable {
		this.messageHandlers.push(handler)
		return {
			dispose: () => {
				this.messageHandlers = this.messageHandlers.filter((h) => h !== handler)
			},
		}
	}

	/**
	 * Manually polls for new Cline messages and dispatches them to registered handlers.
	 * This method should be called periodically by an external entity (e.g., Watchdog).
	 */
	pollAndDispatchMessages(): void {
		const newMessages = this.getNewMessages()
		for (const msg of newMessages) {
			// Update completion status if relevant message arrives
			if (this.activeTaskId && (msg.say === "completion_result" || msg.ask === "completion_result")) {
				this.completed = true
			}
			// Dispatch to all registered handlers
			for (const handler of this.messageHandlers) {
				handler(msg)
			}
		}
	}

	/**
	 *  Aktif görevin “tamamlandı” durumunu döndürür.
	 *  Kalıcı completed bayrağını kullanır.
	 */
	isTaskComplete(): boolean {
		return this.completed
	}

	/**
	 * Aktif görevin “abort” olup olmadığına bakar.
	 * (Başka görevlerin eski abort bayrağını dikkate almaz.)
	 */
	isTaskAborted(): boolean {
		const ct: any = this.controller.task
		return !!ct?.taskState?.abort && ct?.id === this.activeTaskId
	}

	/** Aktif görevi iptal eder */
	async abortTask(): Promise<void> {
		await this.controller.cancelTask()
	}

	/* ------------------------------------------------------------------ */
	/* Plan Mode İşlemleri                                                */
	/* ------------------------------------------------------------------ */

	/**
	 * Plan mode'da görev başlatır
	 */
	async startTaskInPlanMode(task: GostergeTask): Promise<void> {
		this.activeTaskId = task.id
		this.completed = false
		this.planCompleted = false
		this.planContent = ""

		// Plan mode'da başlatmak için mode'u plan olarak ayarla
		const prompt = this.buildTaskPromptForPlanMode(task)

		// Controller'ın mevcut mode'unu plan olarak ayarla
		await this.setPlanMode()

		await this.controller.initTask(prompt)

		if (this.controller.task?.taskState) {
			this.controller.task.taskState.abort = false
		}

		this.lastPolledMessageCount = 0
	}

	/**
	 * Act mode'a geçer ve planı uygular
	 */
	async switchToActModeAndExecute(plan: string): Promise<void> {
		if (!this.controller.task) {
			throw new Error("Aktif görev yok")
		}

		// Plan içeriğini sakla
		this.planContent = plan

		// Act mode'a geç
		await this.setActMode()

		// Plan'ı context olarak ekleyip uygulat
		const executionPrompt = this.buildExecutionPrompt(plan)
		await this.controller.task.handleWebviewAskResponse("messageResponse", executionPrompt, [])
	}

	/**
	 * Plan mode'a geçer
	 */
	private async setPlanMode(): Promise<void> {
		if (!this.controller.task) {
			// Task yoksa, global state'i güncelle
			const { updateGlobalState } = await import("../core/storage/state")
			await updateGlobalState(this.controller.context, "mode", "plan")
			return
		}

		// Task varsa mode'u değiştir
		const chatSettings = {
			mode: "plan" as const,
			preferredLanguage: this.controller.task.chatSettings?.preferredLanguage,
		}
		await this.controller.togglePlanActModeWithChatSettings(chatSettings)
	}

	/**
	 * Act mode'a geçer
	 */
	private async setActMode(): Promise<void> {
		if (!this.controller.task) {
			throw new Error("Aktif görev yok, Act mode'a geçilemez")
		}

		const chatSettings = {
			mode: "act" as const,
			preferredLanguage: this.controller.task.chatSettings?.preferredLanguage,
		}

		// Plan içeriğini chat content olarak gönder
		const chatContent = {
			message: this.buildExecutionPrompt(this.planContent),
			images: [],
			files: [],
		}

		await this.controller.togglePlanActModeWithChatSettings(chatSettings, chatContent)
	}

	/**
	 * Plan mode için prompt oluşturur
	 */
	private buildTaskPromptForPlanMode(t: GostergeTask): string {
		const lines = [
			"",
			"Task Info:",
			`- Title: ${t.title}`,
			"- Description: " + t.description,
			t.tags?.length ? `- Etiketler: ${t.tags.join(", ")}` : "",
			t.estimatedTime ? `- Tahmini süre: ${t.estimatedTime} dk` : "",
			"",
			"System instruction:",
			"- You are in PLAN MODE. Create a detailed implementation plan for this task.",
			"- Analyze the codebase, identify dependencies, and break down the task into steps.",
			"- When your plan is complete, clearly indicate it by saying 'PLAN_COMPLETE' or 'Plan is ready for implementation'.",
			"- Do not implement anything yet, only plan.",
			"- This session is fully automated. Do not ask questions to the user.",
			"- Extract necessary information yourself; if unable to find it, terminate the task with an error.",
		]
		return lines.filter(Boolean).join("\n")
	}

	/**
	 * Plan'ı uygulamak için prompt oluşturur
	 */
	private buildExecutionPrompt(plan: string): string {
		return `Now implement the following plan:\n\n${plan}\n\nExecute the plan step by step.`
	}

	/**
	 * Plan tamamlandı mı kontrol eder
	 */
	isPlanCompleted(): boolean {
		return this.planCompleted
	}

	/**
	 * Plan tamamlandı olarak işaretle
	 */
	setPlanCompleted(completed: boolean): void {
		this.planCompleted = completed
	}

	/**
	 * Plan içeriğini alır
	 */
	getPlanContent(): string {
		return this.planContent
	}

	/**
	 * Plan içeriğini günceller (mesajlardan çıkarılan plan)
	 */
	updatePlanContent(content: string): void {
		this.planContent = content
	}

	/**
	 * Mevcut mode'u kontrol eder
	 */
	getCurrentMode(): "plan" | "act" | undefined {
		return this.controller.task?.chatSettings?.mode
	}

	/* ------------------------------------------------------------------ */
	/* Yardımcılar                                                        */
	/* ------------------------------------------------------------------ */

	/**
	 * Cline'ın sorduğu soruya otomatik cevap gönderir
	 * @param askType Soru tipi (resume_task, followup, vb.)
	 * @param autoResponse Otomatik cevap metni (opsiyonel)
	 */
	async sendAutoResponse(askType: string, autoResponse?: string): Promise<void> {
		if (!this.controller.task) {
			this.logger.warn("ClineIntegration: Aktif görev yok, otomatik cevap gönderilemedi")
			return
		}

		// resume_task için "yesButtonClicked" gönder
		if (askType === "resume_task" || askType === "resume_completed_task") {
			this.logger.info(`🤖 Otomatik cevap: ${askType} → yesButtonClicked`)
			await this.controller.task.handleWebviewAskResponse("yesButtonClicked", "", [])
			return
		}

		// Diğer soru tipleri için otomatik mesaj gönder
		const responseText = autoResponse || "Devam et, en iyi kararı sen ver.Tüm yetkiler var sende."
		this.logger.info(`🤖 Otomatik cevap: ${askType} → "${responseText}"`)
		await this.controller.task.handleWebviewAskResponse("messageResponse", responseText, [])
	}

	/**
	 * Cline mesajlarını (webview state'inden) getirir.
	 * Yalnızca yeni gelen(ler)i döndürür.
	 */
	private getNewMessages(): ClineMessage[] {
		const msgs = this.controller?.task?.messageStateHandler?.getClineMessages() ?? []

		if (msgs.length > this.lastPolledMessageCount) {
			const diff = msgs.slice(this.lastPolledMessageCount)
			this.lastPolledMessageCount = msgs.length
			return diff
		}

		return []
	}

	/**
	 * Resume task butonunu kontrol eder ve varsa otomatik basar
	 * Plan'dan Act'e geçişte kullanılır
	 * @param maxAttempts Maksimum kontrol denemesi sayısı
	 * @param delayMs Her deneme arası bekleme süresi (ms)
	 * @returns Resume task butonu bulunup basıldıysa true
	 */
	async checkAndAutoResumeTask(maxAttempts: number = 10, delayMs: number = 500): Promise<boolean> {
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			// Mesajları poll et
			this.pollAndDispatchMessages()

			// Tüm mesajları kontrol et (sadece yeni mesajlar değil, tüm mesajlar)
			// Çünkü resume_task butonu daha önceki bir mesajda olabilir
			const allMessages = this.controller?.task?.messageStateHandler?.getClineMessages() ?? []

			// Önce yeni mesajları kontrol et
			const newMessages = this.getNewMessages()
			const messagesToCheck = newMessages.length > 0 ? newMessages : allMessages.slice(-5) // Son 5 mesajı kontrol et

			for (const msg of messagesToCheck) {
				if (msg.ask === "resume_task" || msg.ask === "resume_completed_task") {
					this.logger.info(
						`🔄 Resume task butonu tespit edildi (deneme ${attempt + 1}/${maxAttempts}), otomatik basılıyor...`,
					)
					try {
						await this.sendAutoResponse(msg.ask, msg.text)
						this.logger.info(`✅ Resume task otomatik cevap gönderildi`)
						return true
					} catch (error: any) {
						this.logger.error(`❌ Resume task otomatik cevap gönderilemedi: ${error.message}`)
						return false
					}
				}
			}

			// Bekle ve tekrar dene
			if (attempt < maxAttempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, delayMs))
			}
		}

		return false
	}

	/** Prompt metnini oluşturur */
	private buildTaskPrompt(t: GostergeTask): string {
		const lines = [
			"",
			"Task Info :",
			`- Title: ${t.title}`,
			"- Description : " + t.description,
			t.tags?.length ? `- Etiketler: ${t.tags.join(", ")}` : "",
			t.estimatedTime ? `- Tahmini süre: ${t.estimatedTime} dk` : "",
			"",
			"System instruction:",
			"- This session is fully automated. Do not ask questions to the user.",
			"- Extract necessary information yourself; if unable to find it, terminate the task with an error.",
			"Please pay attention to code quality and tests.",
		]
		return lines.filter(Boolean).join("\n")
	}

	/* ------------------------------------------------------------------ */
	/* Temizlik                                                           */
	/* ------------------------------------------------------------------ */

	/** ClineIntegration nesnesini temiz kapatır */
	dispose(): void {
		// No internal poller to clear anymore
	}
}
