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

	/** Aktif görev için “tamamlandı” bayrağı */
	private completed = false

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

	/** Aktif görevi iptal eder */
	async abortTask(): Promise<void> {
		await this.controller.cancelTask()
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
