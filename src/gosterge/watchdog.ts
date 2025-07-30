import * as vscode from "vscode"
import { GostergeError } from "./errors" // Assuming GostergeError is exported from errors.ts
import { ClineIntegration, ClineMessage } from "./cline" // Import ClineIntegration and ClineMessage from new file
import { Logger } from "./logger" // Import Logger

interface GostergeConfig {
	stallTimeout: number
	taskTimeout: number
}

/**
 * Ensures that the given promise, if it rejects, first attempts to cancel the Cline task
 * before re-throwing the error. This is specifically for stall errors.
 */
function stalledCleanup(stallPromise: Promise<never>, cline: ClineIntegration, logger: Logger): Promise<never> {
	return stallPromise.catch(async (e) => {
		// Cline halen çalışıyor olabilir → iptal
		try {
			await cline.abortTask()
		} catch (cancelError: any) {
			// Add type for cancelError
			// Log the cancellation error using the provided logger
			logger.error(`Error during Cline task cancellation: ${cancelError.message || cancelError}`)
		}
		throw e // Re-throw the original stall error
	})
}

/**
 * Watchdog class is responsible for monitoring task progress,
 * detecting stalls, timeouts, and completions using Promise.race.
 */
export class Watchdog implements vscode.Disposable {
	private lastMsgAt: number = Date.now()
	private messageSubscription: vscode.Disposable
	private logger: Logger // Use Logger type
	private stallIntervalId: NodeJS.Timeout | undefined
	private taskTimeoutId: NodeJS.Timeout | undefined
	private completionDisposable: vscode.Disposable | undefined

	constructor(
		private cline: ClineIntegration,
		private cfg: GostergeConfig,
		logger: Logger,
	) {
		// Use Logger type
		this.logger = logger
		// Update timestamp whenever a message from Cline is received
		this.messageSubscription = this.cline.onMessage((msg: ClineMessage) => {
			this.lastMsgAt = Date.now()
			// This is where handleClineMessage logic from TaskManager should potentially be called
			// or the message passed through to TaskManager's handler.
		})
	}

	/**
	 * Waits for one of the following conditions to occur:
	 * - Task completion
	 * - Stall timeout
	 * - Global task timeout
	 * - User abortion
	 *
	 * @param abortSig The AbortSignal to listen for user cancellation.
	 * @returns A Promise that resolves on completion or rejects on error/timeout/abort.
	 */
	async waitForResult(abortSig: AbortSignal): Promise<void> {
		// Promise for stall detection
		const stallPromise = new Promise<never>((resolve, reject) => {
			this.stallIntervalId = setInterval(() => {
				if (Date.now() - this.lastMsgAt > this.cfg.stallTimeout) {
					reject(new GostergeError(`Cline ${this.cfg.stallTimeout / 1000}s sessiz kaldı`, "cline"))
				}
			}, 1000) // Check every second

			// Clean up interval if aborted
			abortSig.addEventListener(
				"abort",
				() => {
					if (this.stallIntervalId) clearInterval(this.stallIntervalId)
					this.stallIntervalId = undefined
				},
				{ once: true },
			)
		})

		// Promise for global task timeout
		const taskTimeoutPromise = new Promise<never>((resolve, reject) => {
			this.taskTimeoutId = setTimeout(() => {
				reject(new GostergeError(`Görev zaman aşımı ${this.cfg.taskTimeout / 60000} dk`, "timeout"))
			}, this.cfg.taskTimeout)

			// Clean up timeout if aborted
			abortSig.addEventListener(
				"abort",
				() => {
					if (this.taskTimeoutId) clearTimeout(this.taskTimeoutId)
					this.taskTimeoutId = undefined
				},
				{ once: true },
			)
		})

		// Promise for task completion
		const completionPromise = new Promise<void>((resolve) => {
			this.completionDisposable = this.cline.onMessage((msg: ClineMessage) => {
				if (msg.say === "completion_result" || msg.ask === "completion_result") {
					if (this.completionDisposable) {
						this.completionDisposable.dispose() // Dispose this specific listener
						this.completionDisposable = undefined
					}
					resolve()
				}
			})
		})

		// Promise for user abortion
		const abortedPromise = new Promise<never>((resolve, reject) => {
			abortSig.addEventListener(
				"abort",
				() => {
					reject(new GostergeError("Aborted by user", "timeout")) // Using "timeout" kind for user abort as per proposal example
				},
				{ once: true },
			)
		})

		try {
			// Race all promises
			await Promise.race([
				completionPromise,
				stalledCleanup(stallPromise, this.cline, this.logger), // Wrap stall promise for cleanup and pass logger
				taskTimeoutPromise,
				abortedPromise,
			])
		} finally {
			this.dispose() // Ensure all resources are cleaned up
		}
	}

	/**
	 * Disposes all internal subscriptions and timers.
	 */
	dispose(): void {
		if (this.messageSubscription) {
			this.messageSubscription.dispose()
		}
		if (this.stallIntervalId) {
			clearInterval(this.stallIntervalId)
			this.stallIntervalId = undefined
		}
		if (this.taskTimeoutId) {
			clearTimeout(this.taskTimeoutId)
			this.taskTimeoutId = undefined
		}
		if (this.completionDisposable) {
			this.completionDisposable.dispose()
			this.completionDisposable = undefined
		}
		this.logger.debug("Watchdog disposed.")
	}
}
