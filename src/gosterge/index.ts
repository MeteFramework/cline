import * as vscode from "vscode"
import { Controller } from "../core/controller"

// This function will be called from the extension's activate method.
export function initializeGosterge(context: vscode.ExtensionContext, controller: Controller) {
	// Start the interval to send a message every 30 seconds.

	let locked = false
	setInterval(() => {
		if (locked) {
			console.warn("Şuan task devam ediyor...")
			return
		}
		// This is a static message that will be sent to the Cline UI.
		const messageToSend = "bir tane basit bir hello world index.html i yaz"

		// We need to simulate the user typing in the chat box and clicking the send button.
		// The controller's `initTask` method starts a new task, which is what happens when a user sends a message.
		// We run this in an async IIFE because initTask is async.
		;(async () => {
			try {
				locked = true

				// Task'ı başlat
				await controller.initTask(messageToSend)

				console.log("Task başlatıldı, tamamlanmasını bekliyoruz...")

				// Task'ın gerçekten tamamlanmasını bekle
				await waitForTaskCompletion(controller)

				console.log("Task başarıyla tamamlandı")
			} catch (error) {
				console.error("Gosterge module failed to send message:", error)
			} finally {
				// Her durumda lock'u kaldır
				locked = false
			}
		})()
	}, 30000) // 30 seconds interval
}

/**
 * Task'ın gerçekten tamamlanmasını bekler (attempt_completion çağrılana kadar)
 * @param controller Controller instance
 */
async function waitForTaskCompletion(controller: Controller): Promise<void> {
	return new Promise((resolve, reject) => {
		const checkInterval = 1000 // 1 saniyede bir kontrol et
		const maxWaitTime = 600000 // 10 dakika maksimum bekleme süresi (task'lar uzun sürebilir)
		let elapsedTime = 0
		let lastMessageCount = 0

		const intervalId = setInterval(() => {
			elapsedTime += checkInterval

			// Maksimum bekleme süresini aştık
			if (elapsedTime >= maxWaitTime) {
				clearInterval(intervalId)
				reject(new Error("Task completion timeout after 10 minutes"))
				return
			}

			// Task instance'ı var mı kontrol et
			if (!controller.task) {
				// Task yok, bu genellikle task'ın tamamlandığı anlamına gelir
				clearInterval(intervalId)
				resolve()
				return
			}

			// Task state'ini kontrol et
			const taskState = controller.task.taskState

			// Task abort edildi mi?
			if (taskState.abort) {
				clearInterval(intervalId)
				resolve() // Abort da bir tür completion
				return
			}

			// Cline messages'ları kontrol et - completion_result var mı?
			const clineMessages = controller.task.messageStateHandler?.getClineMessages() || []
			const hasCompletionResult = clineMessages.some(
				(msg) => msg.ask === "completion_result" || msg.say === "completion_result",
			)

			if (hasCompletionResult) {
				// Task gerçekten tamamlandı!
				console.log("Task tamamlandı: completion_result mesajı bulundu")
				clearInterval(intervalId)
				resolve()
				return
			}

			// Progress tracking - mesaj sayısı artıyor mu?
			const currentMessageCount = clineMessages.length
			if (currentMessageCount > lastMessageCount) {
				lastMessageCount = currentMessageCount
				elapsedTime = 0 // Progress var, timer'ı reset et
				console.log(
					`Task devam ediyor: ${currentMessageCount} mesaj, son mesaj: ${clineMessages[clineMessages.length - 1]?.say || "unknown"}`,
				)
			}

			// Task'ın durumunu logla
			const lastMessage = clineMessages[clineMessages.length - 1]
			console.log(
				`Task durumu: streaming=${taskState.isStreaming}, initialized=${taskState.isInitialized}, abort=${taskState.abort}, son mesaj: ${lastMessage?.say || "none"}, toplam mesaj: ${currentMessageCount}`,
			)

			// Eğer task user input bekliyor ve uzun süredir bekliyor ise, bu bir problem olabilir
			if (taskState.askResponse === undefined && taskState.lastMessageTs) {
				const timeSinceLastMessage = Date.now() - taskState.lastMessageTs
				if (timeSinceLastMessage > 30000) {
					// 30 saniye
					console.warn(`Task 30 saniyedir user input bekliyor, bu bir problem olabilir`)
				}
			}
		}, checkInterval)
	})
}
