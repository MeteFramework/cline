import * as vscode from "vscode"

export enum LogLevel {
	ERROR = 0,
	WARN = 1,
	INFO = 2,
	DEBUG = 3,
}

export class Logger {
	private chan: vscode.OutputChannel
	private configLevel: LogLevel = LogLevel.INFO // Initialize with a default value

	constructor(chan: vscode.OutputChannel) {
		this.chan = chan
		this.updateLogLevel()
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("gosterge.logLevel")) {
				// Corrected method name
				this.updateLogLevel()
			}
		})
	}

	private updateLogLevel(): void {
		const config = vscode.workspace.getConfiguration("gosterge")
		const logLevelString = config.get<string>("logLevel", "info")
		switch (logLevelString.toLowerCase()) {
			case "debug":
				this.configLevel = LogLevel.DEBUG
				break
			case "info":
				this.configLevel = LogLevel.INFO
				break
			case "warn":
				this.configLevel = LogLevel.WARN
				break
			case "error":
				this.configLevel = LogLevel.ERROR
				break
			default:
				this.configLevel = LogLevel.INFO
				break
		}
	}

	private out(level: LogLevel, tag: string, msg: string): void {
		if (level > this.configLevel) return

		const ts = new Date().toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			fractionalSecondDigits: 3,
			hour12: false,
		})
		const formattedMsg = `[${ts} ${tag}] ${msg}`

		this.chan.appendLine(formattedMsg)
		if (level !== LogLevel.DEBUG) {
			// Only log to console for non-DEBUG levels
			console.log(formattedMsg)
		}

		if (level <= LogLevel.WARN) {
			this.chan.show(true) // Bring focus on errors/warnings
		}
	}

	info(msg: string): void {
		this.out(LogLevel.INFO, "INFO", msg)
	}
	warn(msg: string): void {
		this.out(LogLevel.WARN, "WARN", msg)
	}
	error(msg: string): void {
		this.out(LogLevel.ERROR, "ERROR", msg)
	}
	debug(msg: string): void {
		this.out(LogLevel.DEBUG, "DEBUG", msg)
	}
}
